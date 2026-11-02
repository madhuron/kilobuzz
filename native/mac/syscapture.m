// kilobuzz-capture — захват системного звука macOS через Core Audio process tap (macOS 14.2+).
//
// Создаёт глобальный стерео-tap, исключая процессы самого Kilobuzz (иначе обработанный звук
// попал бы обратно в захват), и глушит оригинал, пока идёт захват (CATapMutedWhenTapped):
// пользователь слышит только обработанную версию. Если Kilobuzz упадёт — звук сразу вернётся.
//
// Использование: kilobuzz-capture <pid приложения>
//   stdout — PCM float32, interleaved stereo
//   stderr — строки JSON со статусом: {"event":"ready","sampleRate":48000} / {"event":"error",...}

#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <AppKit/AppKit.h>
#include <sys/sysctl.h>
#include <signal.h>
#include <unistd.h>

static pid_t gAppPid = 0;
static AudioObjectID gTapID = kAudioObjectUnknown;
static AudioObjectID gAggID = kAudioObjectUnknown;
static AudioDeviceIOProcID gProcID = NULL;
static CATapDescription *gDesc = nil;
static dispatch_queue_t gWriteQueue;

static void emit(NSDictionary *obj) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  fwrite(d.bytes, 1, d.length, stderr);
  fputc('\n', stderr);
  fflush(stderr);
}

static void fail(NSString *msg, OSStatus st) {
  emit(@{ @"event" : @"error", @"message" : msg, @"status" : @(st) });
  exit(1);
}

static pid_t parentOf(pid_t pid) {
  struct kinfo_proc info;
  size_t len = sizeof(info);
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  if (sysctl(mib, 4, &info, &len, NULL, 0) != 0 || len == 0) return 0;
  return info.kp_eproc.e_ppid;
}

static BOOL belongsToApp(pid_t pid) {
  for (int depth = 0; pid > 1 && depth < 8; depth++) {
    if (pid == gAppPid || pid == getpid()) return YES;
    pid = parentOf(pid);
  }
  return NO;
}

// Аудио-объекты процессов Kilobuzz (главный процесс и его helper'ы, включая аудиосервис Chromium).
static NSArray<NSNumber *> *ownProcessObjects(void) {
  AudioObjectPropertyAddress addr = {kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size) != noErr) return @[];
  UInt32 n = size / sizeof(AudioObjectID);
  AudioObjectID *ids = calloc(n, sizeof(AudioObjectID));
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, ids);
  NSMutableArray *out = [NSMutableArray array];
  for (UInt32 i = 0; i < n; i++) {
    pid_t pid = 0;
    UInt32 psz = sizeof(pid);
    AudioObjectPropertyAddress pa = {kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(ids[i], &pa, 0, NULL, &psz, &pid) == noErr && belongsToApp(pid)) [out addObject:@(ids[i])];
  }
  free(ids);
  return out;
}

static NSString *defaultOutputUID(void) {
  AudioObjectID dev = kAudioObjectUnknown;
  UInt32 size = sizeof(dev);
  AudioObjectPropertyAddress addr = {kAudioHardwarePropertyDefaultSystemOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, &dev);
  CFStringRef uid = NULL;
  size = sizeof(uid);
  AudioObjectPropertyAddress ua = {kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (AudioObjectGetPropertyData(dev, &ua, 0, NULL, &size, &uid) != noErr || !uid) return nil;
  return CFBridgingRelease(uid);
}

// Bundle ID Kilobuzz и его helper'ов (macOS 26+ умеет исключать по ним — надёжнее, чем по PID).
static NSArray<NSString *> *ownBundleIDs(void) {
  NSString *bid = [NSRunningApplication runningApplicationWithProcessIdentifier:gAppPid].bundleIdentifier;
  if (!bid) return @[];
  return @[ bid, [bid stringByAppendingString:@".helper"], [bid stringByAppendingString:@".helper.Renderer"],
            [bid stringByAppendingString:@".helper.GPU"], [bid stringByAppendingString:@".helper.Plugin"] ];
}

static Float64 nominalRate(AudioObjectID dev) {
  Float64 sr = 0;
  UInt32 size = sizeof(sr);
  AudioObjectPropertyAddress a = {kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, &sr);
  return sr;
}

static void updateExclusions(void) {
  NSArray *own = ownProcessObjects();
  if ([own isEqualToArray:gDesc.processes]) return;
  gDesc.processes = own;
  AudioObjectPropertyAddress addr = {kAudioTapPropertyDescription, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  CFTypeRef ref = (__bridge CFTypeRef)gDesc;
  OSStatus st = AudioObjectSetPropertyData(gTapID, &addr, 0, NULL, sizeof(ref), &ref);
  emit(@{ @"event" : @"exclude", @"count" : @(own.count), @"status" : @(st) });
}

static void teardown(void) {
  if (gAggID != kAudioObjectUnknown && gProcID) {
    AudioDeviceStop(gAggID, gProcID);
    AudioDeviceDestroyIOProcID(gAggID, gProcID);
  }
  if (gAggID != kAudioObjectUnknown) AudioHardwareDestroyAggregateDevice(gAggID);
  if (gTapID != kAudioObjectUnknown) AudioHardwareDestroyProcessTap(gTapID);
}

static void onSignal(int sig) {
  teardown();
  _exit(0);
}

// ---------- устройства вывода: список с частотами и смена частоты (как в «Настройке Audio-MIDI») ----------
static NSString *strProp(AudioObjectID dev, AudioObjectPropertySelector sel) {
  CFStringRef v = NULL;
  UInt32 size = sizeof(v);
  AudioObjectPropertyAddress a = {sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, &v) != noErr || !v) return @"";
  return CFBridgingRelease(v);
}

static BOOL hasOutput(AudioObjectID dev) {
  AudioObjectPropertyAddress a = {kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  return AudioObjectGetPropertyDataSize(dev, &a, 0, NULL, &size) == noErr && size > 0;
}

static NSArray<NSNumber *> *availableRates(AudioObjectID dev) {
  AudioObjectPropertyAddress a = {kAudioDevicePropertyAvailableNominalSampleRates, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(dev, &a, 0, NULL, &size) != noErr || !size) return @[];
  UInt32 n = size / sizeof(AudioValueRange);
  AudioValueRange *r = calloc(n, sizeof(AudioValueRange));
  AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, r);
  NSMutableOrderedSet *set = [NSMutableOrderedSet orderedSet];
  const double std[] = {22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000};
  for (UInt32 i = 0; i < n; i++) {
    if (r[i].mMinimum == r[i].mMaximum) [set addObject:@(r[i].mMinimum)];
    else for (int k = 0; k < 9; k++) if (std[k] >= r[i].mMinimum && std[k] <= r[i].mMaximum) [set addObject:@(std[k])];
  }
  free(r);
  return [[set array] sortedArrayUsingSelector:@selector(compare:)];
}

static int listDevices(void) {
  AudioObjectPropertyAddress a = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &size);
  UInt32 n = size / sizeof(AudioObjectID);
  AudioObjectID *ids = calloc(n, sizeof(AudioObjectID));
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, ids);
  AudioObjectID def = kAudioObjectUnknown;
  UInt32 ds = sizeof(def);
  AudioObjectPropertyAddress da = {kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &da, 0, NULL, &ds, &def);
  NSMutableArray *list = [NSMutableArray array];
  for (UInt32 i = 0; i < n; i++) {
    if (!hasOutput(ids[i])) continue;
    NSString *uid = strProp(ids[i], kAudioDevicePropertyDeviceUID);
    if ([uid hasPrefix:@"kilobuzz-agg"]) continue;
    [list addObject:@{ @"uid" : uid, @"name" : strProp(ids[i], kAudioObjectPropertyName), @"rate" : @(nominalRate(ids[i])),
                       @"rates" : availableRates(ids[i]), @"default" : @(ids[i] == def) }];
  }
  free(ids);
  NSData *d = [NSJSONSerialization dataWithJSONObject:list options:0 error:nil];
  fwrite(d.bytes, 1, d.length, stdout);
  return 0;
}

static int setRate(NSString *uid, Float64 rate) {
  AudioObjectID dev = kAudioObjectUnknown;
  CFStringRef cf = (__bridge CFStringRef)uid;
  AudioValueTranslation t = {&cf, sizeof(cf), &dev, sizeof(dev)};
  UInt32 size = sizeof(t);
  AudioObjectPropertyAddress a = {kAudioHardwarePropertyDeviceForUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, &t) != noErr || dev == kAudioObjectUnknown) { printf("{\"ok\":false}"); return 1; }
  AudioObjectPropertyAddress ra = {kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  OSStatus st = AudioObjectSetPropertyData(dev, &ra, 0, NULL, sizeof(rate), &rate);
  usleep(300000);  // устройство переключается не мгновенно
  printf("{\"ok\":%s,\"rate\":%.0f}", st == noErr ? "true" : "false", nominalRate(dev));
  return st == noErr ? 0 : 1;
}

int main(int argc, const char *argv[]) {
  if (argc > 1 && strcmp(argv[1], "devices") == 0) { @autoreleasepool { return listDevices(); } }
  if (argc > 3 && strcmp(argv[1], "setrate") == 0) { @autoreleasepool { return setRate([NSString stringWithUTF8String:argv[2]], atof(argv[3])); } }
  @autoreleasepool {
    if (@available(macOS 14.2, *)) {
    } else {
      fail(@"Нужна macOS 14.2 или новее", 0);
    }
    gAppPid = argc > 1 ? (pid_t)atoi(argv[1]) : getppid();
    signal(SIGTERM, onSignal);
    signal(SIGINT, onSignal);
    signal(SIGPIPE, onSignal);
    gWriteQueue = dispatch_queue_create("kilobuzz.write", DISPATCH_QUEUE_SERIAL);

    gDesc = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:ownProcessObjects()];
    gDesc.name = @"Kilobuzz";
    gDesc.privateTap = YES;
    gDesc.muteBehavior = CATapMutedWhenTapped;
    if (@available(macOS 26.0, *)) gDesc.bundleIDs = ownBundleIDs();
    OSStatus st = AudioHardwareCreateProcessTap(gDesc, &gTapID);
    if (st != noErr) fail(@"Не удалось создать захват системного звука", st);

    CFStringRef tapUID = NULL;
    UInt32 size = sizeof(tapUID);
    AudioObjectPropertyAddress ua = {kAudioTapPropertyUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioObjectGetPropertyData(gTapID, &ua, 0, NULL, &size, &tapUID);

    AudioStreamBasicDescription fmt = {0};
    size = sizeof(fmt);
    AudioObjectPropertyAddress fa = {kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioObjectGetPropertyData(gTapID, &fa, 0, NULL, &size, &fmt);

    NSString *outUID = defaultOutputUID();
    NSString *aggUID = [NSString stringWithFormat:@"kilobuzz-agg-%d", getpid()];
    NSMutableDictionary *agg = [@{
      @kAudioAggregateDeviceNameKey : @"Kilobuzz capture",
      @kAudioAggregateDeviceUIDKey : aggUID,
      @kAudioAggregateDeviceIsPrivateKey : @YES,
      @kAudioAggregateDeviceIsStackedKey : @NO,
      @kAudioAggregateDeviceTapAutoStartKey : @YES,
      @kAudioAggregateDeviceTapListKey : @[ @{@kAudioSubTapUIDKey : (__bridge NSString *)tapUID, @kAudioSubTapDriftCompensationKey : @YES} ],
    } mutableCopy];
    if (outUID) {
      agg[@kAudioAggregateDeviceMainSubDeviceKey] = outUID;
      agg[@kAudioAggregateDeviceSubDeviceListKey] = @[ @{@kAudioSubDeviceUIDKey : outUID} ];
    }
    st = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)agg, &gAggID);
    if (st != noErr) fail(@"Не удалось создать агрегатное устройство", st);

    const BOOL nonInterleaved = (fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    st = AudioDeviceCreateIOProcIDWithBlock(&gProcID, gAggID, NULL, ^(const AudioTimeStamp *now, const AudioBufferList *in, const AudioTimeStamp *inTime, AudioBufferList *out, const AudioTimeStamp *outTime) {
      if (!in || in->mNumberBuffers == 0) return;
      NSMutableData *pcm;
      if (nonInterleaved || in->mNumberBuffers > 1) {
        const float *L = in->mBuffers[0].mData;
        const float *R = in->mNumberBuffers > 1 ? in->mBuffers[1].mData : L;
        UInt32 frames = in->mBuffers[0].mDataByteSize / sizeof(float);
        pcm = [NSMutableData dataWithLength:frames * 2 * sizeof(float)];
        float *dst = pcm.mutableBytes;
        for (UInt32 i = 0; i < frames; i++) { dst[2 * i] = L[i]; dst[2 * i + 1] = R[i]; }
      } else {
        const AudioBuffer *b = &in->mBuffers[0];
        if (b->mNumberChannels == 2) {
          pcm = [NSMutableData dataWithBytes:b->mData length:b->mDataByteSize];
        } else {
          UInt32 ch = MAX(1, b->mNumberChannels), frames = b->mDataByteSize / sizeof(float) / ch;
          const float *src = b->mData;
          pcm = [NSMutableData dataWithLength:frames * 2 * sizeof(float)];
          float *dst = pcm.mutableBytes;
          for (UInt32 i = 0; i < frames; i++) { dst[2 * i] = src[i * ch]; dst[2 * i + 1] = src[i * ch + (ch > 1 ? 1 : 0)]; }
        }
      }
      dispatch_async(gWriteQueue, ^{
        fwrite(pcm.bytes, 1, pcm.length, stdout);
        fflush(stdout);
      });
    });
    if (st != noErr) fail(@"Не удалось подключиться к устройству захвата", st);
    st = AudioDeviceStart(gAggID, gProcID);
    if (st != noErr) fail(@"Не удалось запустить захват (нет разрешения на запись системного звука?)", st);

    // Новые аудиопроцессы Kilobuzz (например, аудиосервис после смены устройства) тоже исключаем.
    AudioObjectPropertyAddress pl = {kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &pl, dispatch_get_main_queue(), ^(UInt32 n, const AudioObjectPropertyAddress *a) { updateExclusions(); });

    // Данные в IOProc приходят с частотой агрегатного устройства (оно тактируется от вывода),
    // а не с частотой формата tap'а — для Bluetooth-наушников это часто 44.1 против 48 кГц.
    Float64 aggRate = nominalRate(gAggID);
    emit(@{ @"event" : @"ready", @"sampleRate" : @(aggRate > 0 ? aggRate : (fmt.mSampleRate ?: 48000)), @"tapRate" : @(fmt.mSampleRate),
            @"channels" : @(fmt.mChannelsPerFrame), @"output" : outUID ?: @"", @"excluded" : @(gDesc.processes.count) });

    // Завершаемся, если приложение закрылось (stdin родителя закрыт).
    dispatch_source_t watch = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, gAppPid, DISPATCH_PROC_EXIT, dispatch_get_main_queue());
    dispatch_source_set_event_handler(watch, ^{ teardown(); exit(0); });
    dispatch_resume(watch);
    dispatch_main();
  }
  return 0;
}
