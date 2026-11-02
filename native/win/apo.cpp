// Kilobuzz APO — модуль обработки звука, который звуковая система Windows (audiodg.exe)
// загружает для устройств вывода. Через него проходит звук всех приложений.
// Работает в пользовательском режиме (это не драйвер ядра), поэтому подпись Microsoft не нужна.
// Пока приложение Kilobuzz не подключилось (или закрылось) — модуль прозрачен.
#include "apo_api.h"
#include "shared.h"
#include "kbstatus.h"
#include "dsp.h"
#include <ks.h>
#include <ksmedia.h>
#include <sddl.h>
#include <mmdeviceapi.h>
#include <string>
#include <shlobj.h>
#include <stdio.h>
#include <stdarg.h>
#include <new>
#include <vector>

// {6B9E5B7C-3F2A-4C1D-9E8F-1A2B3C4D5E6F}
extern "C" const CLSID CLSID_KilobuzzApo = {0x6b9e5b7c, 0x3f2a, 0x4c1d, {0x9e, 0x8f, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f}};

static volatile LONG g_objects = 0, g_locks = 0;

extern "C" __declspec(dllexport) KbStatus KbStatusBlock = {KB_STATUS_MAGIC};

// ---------- журнал модуля: C:\\ProgramData\\Kilobuzz\\apo.log (только вне потока реального времени) ----------
static std::wstring dataDir() {
  wchar_t pd[MAX_PATH] = L"C:\\ProgramData";
  SHGetFolderPathW(nullptr, CSIDL_COMMON_APPDATA, nullptr, 0, pd);
  return std::wstring(pd) + L"\\Kilobuzz";
}

static void kbLog(const char *fmt, ...) {
  char msg[512];
  va_list a;
  va_start(a, fmt);
  vsnprintf(msg, sizeof msg, fmt, a);
  va_end(a);
  SYSTEMTIME t;
  GetLocalTime(&t);
  char line[600];
  int n = snprintf(line, sizeof line, "%02d.%02d %02d:%02d:%02d [%lu] %s\r\n", t.wDay, t.wMonth, t.wHour, t.wMinute, t.wSecond, GetCurrentProcessId(), msg);
  OutputDebugStringA(line);
  {
    LONG i = InterlockedIncrement(&KbStatusBlock.lineIdx) - 1;
    lstrcpynA(KbStatusBlock.lines[i % KB_STATUS_LINES], line, sizeof KbStatusBlock.lines[0]);
  }
  CreateDirectoryW(dataDir().c_str(), nullptr);  // если папку не создала установка
  std::wstring path = dataDir() + L"\\apo.log";
  HANDLE f = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  DWORD e1 = f == INVALID_HANDLE_VALUE ? GetLastError() : 0, e2 = 0;
  KbStatusBlock.errLogFile = e1;
  if (f == INVALID_HANDLE_VALUE) {
    // у звуковой службы урезанные права — пишем в её собственную временную папку
    wchar_t tmp[MAX_PATH];
    if (GetTempPathW(MAX_PATH, tmp)) {
      path = std::wstring(tmp) + L"kilobuzz-apo.log";
      f = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (f == INVALID_HANDLE_VALUE) e2 = GetLastError();
    }
    KbStatusBlock.errTempFile = e2;
  }
  // журнал событий Windows (Приложение, источник Kilobuzz) — доступен любой службе, даже без права на файлы
  HANDLE ev = RegisterEventSourceW(nullptr, L"Kilobuzz");
  KbStatusBlock.errEventLog = ev ? 0 : GetLastError();
  if (ev) {
    char full[700];
    if (e1) snprintf(full, sizeof full, "[%lu] %s (файл журнала: ошибка %lu/%lu)", GetCurrentProcessId(), msg, e1, e2);
    else snprintf(full, sizeof full, "[%lu] %s", GetCurrentProcessId(), msg);
    wchar_t wmsg[700];
    MultiByteToWideChar(CP_UTF8, 0, full, -1, wmsg, 700);
    const wchar_t *strs[] = {wmsg};
    if (!ReportEventW(ev, EVENTLOG_INFORMATION_TYPE, 0, 1, nullptr, 1, 0, strs, nullptr)) KbStatusBlock.errEventLog = GetLastError();
    DeregisterEventSource(ev);
  }
  if (f == INVALID_HANDLE_VALUE) return;
  if (GetFileSize(f, nullptr) > 512 * 1024) { CloseHandle(f); f = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, 0, nullptr); }
  DWORD w;
  if (f != INVALID_HANDLE_VALUE) { WriteFile(f, line, n, &w, nullptr); CloseHandle(f); }
}

static std::string narrow(const std::wstring &w) {
  std::string s(w.size() * 3 + 1, '\0');
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], (int)s.size(), nullptr, nullptr);
  s.resize(n > 0 ? n : 0);
  return s;
}
// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
static const GUID kFormatFloat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

class KilobuzzApo final : public IAudioProcessingObject,
                          public IAudioProcessingObjectRT,
                          public IAudioProcessingObjectConfiguration,
                          public IAudioSystemEffects2 {
 public:
  // Звуковая система Windows создаёт эффекты «внутри» своего объекта (COM-агрегация): тогда
  // IUnknown модуля — внутренний (inner_), а все остальные интерфейсы пересылают вызовы внешнему.
  explicit KilobuzzApo(IUnknown *outer) : inner_(this) {
    outer_ = outer ? outer : &inner_;
    InterlockedIncrement(&g_objects);
  }
  ~KilobuzzApo() {
    closeShared();
    releaseChild();
    InterlockedDecrement(&g_objects);
  }

  // IUnknown — пересылаем внешнему объекту (или своему inner_, если модуль создан сам по себе)
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override { return outer_->QueryInterface(riid, ppv); }
  ULONG STDMETHODCALLTYPE AddRef() override { return outer_->AddRef(); }
  ULONG STDMETHODCALLTYPE Release() override { return outer_->Release(); }

  // внутренний IUnknown: единственный, кто считает ссылки и выдаёт интерфейсы
  struct Inner final : IUnknown {
    KilobuzzApo *self;
    explicit Inner(KilobuzzApo *s) : self(s) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override { return self->innerQuery(riid, ppv); }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&self->ref_); }
    ULONG STDMETHODCALLTYPE Release() override {
      LONG r = InterlockedDecrement(&self->ref_);
      if (r == 0) delete self;
      return r;
    }
  } inner_;

  HRESULT innerQuery(REFIID riid, void **ppv) {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown)) { *ppv = &inner_; inner_.AddRef(); return S_OK; }
    if (riid == __uuidof(IAudioProcessingObject)) *ppv = static_cast<IAudioProcessingObject *>(this);
    else if (riid == __uuidof(IAudioProcessingObjectRT)) *ppv = static_cast<IAudioProcessingObjectRT *>(this);
    else if (riid == __uuidof(IAudioProcessingObjectConfiguration)) *ppv = static_cast<IAudioProcessingObjectConfiguration *>(this);
    else if (riid == __uuidof(IAudioSystemEffects) || riid == __uuidof(IAudioSystemEffects2)) *ppv = static_cast<IAudioSystemEffects2 *>(this);
    else { *ppv = nullptr; return E_NOINTERFACE; }
    AddRef();  // по правилам агрегации ссылка берётся на внешний объект
    return S_OK;
  }

  // IAudioProcessingObject
  HRESULT STDMETHODCALLTYPE Reset() override { return child_ ? child_->Reset() : S_OK; }
  HRESULT STDMETHODCALLTYPE GetLatency(HNSTIME *t) override {
    if (!t) return E_POINTER;
    HNSTIME c = 0;
    if (child_) child_->GetLatency(&c);
    // 5 мс — look-ahead лимитера + разбор на дорожки (окно 2048) + задержка эффекта производителя
    *t = 50000 + (HNSTIME)(kb::Stems::N * 1e7 / (rate_ > 0 ? rate_ : 48000.f)) + c;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetRegistrationProperties(APO_REG_PROPERTIES **pp) override {
    if (!pp) return E_POINTER;
    auto *r = (APO_REG_PROPERTIES *)CoTaskMemAlloc(sizeof(APO_REG_PROPERTIES));
    if (!r) return E_OUTOFMEMORY;
    ZeroMemory(r, sizeof(*r));
    r->clsid = CLSID_KilobuzzApo;
    r->Flags = APO_FLAG_DEFAULT;
    lstrcpynW(r->szFriendlyName, L"Kilobuzz", 256);
    lstrcpynW(r->szCopyrightInfo, L"Kilobuzz", 256);
    r->u32MajorVersion = 1;
    r->u32MinInputConnections = r->u32MaxInputConnections = 1;
    r->u32MinOutputConnections = r->u32MaxOutputConnections = 1;
    r->u32MaxInstances = 0xFFFFFFFF;
    r->u32NumAPOInterfaces = 1;
    r->iidAPOInterfaceList[0] = __uuidof(IAudioProcessingObject);
    *pp = r;
    return S_OK;
  }
  // Если в этом слоте у устройства уже был эффект производителя (Realtek, Dolby, Nahimic…),
  // установщик записал его CLSID — создаём его внутри себя и пропускаем звук сначала через него.
  // Так эффекты звуковой карты продолжают работать как раньше, а Kilobuzz добавляется после них.
  HRESULT STDMETHODCALLTYPE Initialize(UINT32 cb, BYTE *data) override {
    InterlockedIncrement(&KbStatusBlock.initialize);
    if (!data || cb < sizeof(APOInitSystemEffects) || child_) { kbLog("Initialize: без данных устройства (cb=%u)", cb); return S_OK; }
    auto *ini = reinterpret_cast<APOInitSystemEffects *>(data);
    UINT idx = cb >= sizeof(APOInitSystemEffects2) ? reinterpret_cast<APOInitSystemEffects2 *>(data)->nSoftwareIoDeviceInCollection : 0;
    CLSID orig;
    std::wstring guid = endpointGuid(ini->pDeviceCollection, idx);
    endpoint_ = narrow(guid);
    if (guid.empty() || !wrappedClsid(guid, &orig) || orig == CLSID_KilobuzzApo) { kbLog("Initialize: устройство %s, без цепочки", endpoint_.c_str()); return S_OK; }
    HRESULT hc = CoCreateInstance(orig, nullptr, CLSCTX_INPROC_SERVER, __uuidof(IAudioProcessingObject), (void **)&child_);
    if (FAILED(hc)) { child_ = nullptr; kbLog("Initialize: устройство %s, эффект производителя не создан (0x%08lx) — работаю без него", endpoint_.c_str(), hc); return S_OK; }
    initCopy_.assign(data, data + cb);
    reinterpret_cast<APOInitBaseStruct *>(initCopy_.data())->clsid = orig;  // эффект ждёт свой CLSID
    if (FAILED(child_->Initialize(cb, initCopy_.data())) ||
        FAILED(child_->QueryInterface(__uuidof(IAudioProcessingObjectRT), (void **)&childRT_)) ||
        FAILED(child_->QueryInterface(__uuidof(IAudioProcessingObjectConfiguration), (void **)&childCfg_)))
      releaseChild();
    kbLog("Initialize: устройство %s, цепочка с эффектом производителя: %s", endpoint_.c_str(), child_ ? "да" : "не удалось");
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE IsInputFormatSupported(IAudioMediaType *opp, IAudioMediaType *req, IAudioMediaType **sup) override { return fwdFormat(true, opp, req, sup); }
  HRESULT STDMETHODCALLTYPE IsOutputFormatSupported(IAudioMediaType *opp, IAudioMediaType *req, IAudioMediaType **sup) override { return fwdFormat(false, opp, req, sup); }
  HRESULT STDMETHODCALLTYPE GetInputChannelCount(UINT32 *n) override {
    if (!n) return E_POINTER;
    *n = channels_;
    return S_OK;
  }

  // IAudioProcessingObjectConfiguration
  HRESULT STDMETHODCALLTYPE LockForProcess(UINT32 nIn, APO_CONNECTION_DESCRIPTOR **in, UINT32 nOut, APO_CONNECTION_DESCRIPTOR **out) override {
    InterlockedIncrement(&KbStatusBlock.lockForProcess);
    if (locked_) return APOERR_APO_LOCKED;
    if (nIn != 1 || nOut != 1 || !in || !out || !in[0] || !in[0]->pFormat) return APOERR_INVALID_CONNECTION_FORMAT;
    if (child_ && FAILED(childCfg_->LockForProcess(nIn, in, nOut, out))) releaseChild();  // не смог — работаем без него
    // Kilobuzz обрабатывает то, что выдал эффект производителя, т.е. формат выхода
    IAudioMediaType *fmt = child_ && out[0]->pFormat ? out[0]->pFormat : in[0]->pFormat;
    UNCOMPRESSEDAUDIOFORMAT f;
    if (FAILED(fmt->GetUncompressedAudioFormat(&f))) return APOERR_INVALID_CONNECTION_FORMAT;
    channels_ = f.dwSamplesPerFrame ? f.dwSamplesPerFrame : 2;
    rate_ = f.fFramesPerSecond > 0 ? f.fFramesPerSecond : 48000.f;
    maxFrames_ = in[0]->u32MaxFrameCount ? in[0]->u32MaxFrameCount : 4096;
    try {
      bufL_.assign(maxFrames_, 0.f);
      bufR_.assign(maxFrames_, 0.f);
      dryL_.assign(maxFrames_, 0.f);
      dryR_.assign(maxFrames_, 0.f);
      chain_.init(rate_);
    } catch (...) {
      return E_OUTOFMEMORY;
    }
    float bypass[P_COUNT];
    memcpy(bypass, chain_.p, sizeof(bypass));
    bypass[P_BYPASS] = 1;  // до подключения приложения — прозрачно
    chain_.setParams(bypass);
    openShared();
    kbLog("LockForProcess: %s, %.0f Гц, %u кан., до %u кадров, цепочка: %s, общая память: %s", endpoint_.c_str(), rate_, channels_, maxFrames_, child_ ? "да" : "нет", sh_ ? "есть" : "НЕТ");
    locked_ = true;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE UnlockForProcess() override {
    if (!locked_) return APOERR_NOT_INITIALIZED;
    if (childCfg_) childCfg_->UnlockForProcess();
    locked_ = false;
    return S_OK;
  }

  // IAudioProcessingObjectRT — вызывается в потоке реального времени: без выделений памяти и блокировок
  void STDMETHODCALLTYPE APOProcess(UINT32 nIn, APO_CONNECTION_PROPERTY **in, UINT32 nOut, APO_CONNECTION_PROPERTY **out) override {
    KbStatusBlock.process++;  // только счётчик для диагностики, без блокировок
    if (nIn < 1 || nOut < 1 || !in[0] || !out[0]) return;
    // сначала эффект производителя (если был), он пишет в выходной буфер; Kilobuzz обрабатывает его результат
    if (childRT_) childRT_->APOProcess(nIn, in, nOut, out);
    APO_CONNECTION_PROPERTY *srcConn = childRT_ ? out[0] : in[0];
    const UINT32 frames = srcConn->u32ValidFrameCount < maxFrames_ ? srcConn->u32ValidFrameCount : maxFrames_;
    const float *src = reinterpret_cast<const float *>(srcConn->pBuffer);
    float *dst = reinterpret_cast<float *>(out[0]->pBuffer);
    const UINT32 ch = channels_;
    const bool silent = srcConn->u32BufferFlags == BUFFER_SILENT;

    for (UINT32 i = 0; i < frames; i++) {
      float l = silent ? 0.f : src[i * ch], r = silent ? 0.f : (ch > 1 ? src[i * ch + 1] : l);
      bufL_[i] = l;
      bufR_[i] = r;
    }
    if (sh_) {
      // копия звука до обработки — для анализа в приложении
      uint64_t w = sh_->ringWrite;
      for (UINT32 i = 0; i < frames; i++) {
        size_t j = (size_t)((w + i) % KB_RING_FRAMES);
        sh_->ring[j * 2] = bufL_[i];
        sh_->ring[j * 2 + 1] = bufR_[i];
      }
      MemoryBarrier();
      sh_->ringWrite = w + frames;
      sh_->heartbeat = sh_->heartbeat + 1;
      // новые параметры от приложения
      uint32_t s = sh_->paramSeq;
      if (s != seq_) {
        seq_ = s;
        chain_.setParams(sh_->params[sh_->paramActive & 1]);
      }
    }
    // Страховка от тишины: если обработка выдала «нечисло» или «взрыв» (сбой в фильтре или параметрах), он бы
    // распространился по всей цепочке и звук пропал бы до перезапуска потока. Сбрасываем состояние обработки
    // (параметры сохраняем) и в этот же момент отдаём оригинал — тишины не бывает.
    memcpy(dryL_.data(), bufL_.data(), sizeof(float) * frames);
    memcpy(dryR_.data(), bufR_.data(), sizeof(float) * frames);
    chain_.process(bufL_.data(), bufR_.data(), (int)frames);
    bool bad = false;
    for (UINT32 i = 0; i < frames && !bad; i++) bad = !std::isfinite(bufL_[i]) || !std::isfinite(bufR_[i]) || fabsf(bufL_[i]) > 64.f || fabsf(bufR_[i]) > 64.f;
    if (bad) {
      InterlockedIncrement(&KbStatusBlock.nanResets);
      float keep[P_COUNT];
      memcpy(keep, chain_.p, sizeof(keep));
      chain_.init(rate_);
      chain_.setParams(keep);
      memcpy(bufL_.data(), dryL_.data(), sizeof(float) * frames);
      memcpy(bufR_.data(), dryR_.data(), sizeof(float) * frames);
    }
    if (sh_) {
      sh_->meterComp = chain_.mComp;
      sh_->meterDeess = chain_.mDeess;
      sh_->meterLimiter = chain_.mLim;
      sh_->meterPeak = chain_.mPeak;
      for (int k = 0; k < 4; k++) sh_->meterBands[k] = chain_.smG[k];
    }
    for (UINT32 i = 0; i < frames; i++) {
      if (ch == 1) {
        dst[i] = (bufL_[i] + bufR_[i]) * 0.5f;
        continue;
      }
      dst[i * ch] = bufL_[i];
      dst[i * ch + 1] = bufR_[i];
      if (dst != src) for (UINT32 c = 2; c < ch; c++) dst[i * ch + c] = silent ? 0.f : src[i * ch + c];
    }
    out[0]->u32ValidFrameCount = frames;
    out[0]->u32BufferFlags = BUFFER_VALID;
  }
  UINT32 STDMETHODCALLTYPE CalcInputFrames(UINT32 n) override { return childRT_ ? childRT_->CalcInputFrames(n) : n; }
  UINT32 STDMETHODCALLTYPE CalcOutputFrames(UINT32 n) override { return childRT_ ? childRT_->CalcOutputFrames(n) : n; }

  // IAudioSystemEffects2
  HRESULT STDMETHODCALLTYPE GetEffectsList(LPGUID *ids, UINT *count, HANDLE ev) override {
    if (!ids || !count) return E_POINTER;
    // список эффектов производителя остаётся видимым в настройках Windows
    IAudioSystemEffects2 *fx = nullptr;
    if (child_ && SUCCEEDED(child_->QueryInterface(__uuidof(IAudioSystemEffects2), (void **)&fx))) {
      HRESULT hr = fx->GetEffectsList(ids, count, ev);
      fx->Release();
      return hr;
    }
    *ids = nullptr;
    *count = 0;
    return S_OK;
  }

 private:
  // Поддерживаем только float32 (так звуковой движок Windows отдаёт звук эффектам по умолчанию)
  HRESULT fwdFormat(bool input, IAudioMediaType *opp, IAudioMediaType *req, IAudioMediaType **sup) {
    if (!child_) return checkFormat(opp, req, sup);
    HRESULT hr = input ? child_->IsInputFormatSupported(opp, req, sup) : child_->IsOutputFormatSupported(opp, req, sup);
    if (FAILED(hr) || !sup || !*sup) return hr;
    IAudioMediaType *mine = nullptr;
    HRESULT h2 = checkFormat(nullptr, *sup, &mine);  // Kilobuzz тоже должен уметь этот формат (float32)
    if (mine) mine->Release();
    if (FAILED(h2)) { (*sup)->Release(); *sup = nullptr; return APOERR_FORMAT_NOT_SUPPORTED; }
    return hr;
  }

  static std::wstring endpointGuid(IMMDeviceCollection *col, UINT idx) {
    std::wstring g;
    if (!col) return g;
    IMMDevice *dev = nullptr;
    if (FAILED(col->Item(idx, &dev)) || !dev) return g;
    LPWSTR id = nullptr;
    if (SUCCEEDED(dev->GetId(&id)) && id) {
      std::wstring s = id;
      size_t dot = s.rfind(L'.');
      g = dot == std::wstring::npos ? s : s.substr(dot + 1);
      CoTaskMemFree(id);
    }
    dev->Release();
    return g;
  }

  static bool wrappedClsid(const std::wstring &guid, CLSID *out) {
    wchar_t buf[64];
    DWORD size = sizeof buf;
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Kilobuzz\\APO\\Wrap", guid.c_str(), RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS) return false;
    return SUCCEEDED(CLSIDFromString(buf, out));
  }

  void releaseChild() {
    if (childCfg_) childCfg_->Release();
    if (childRT_) childRT_->Release();
    if (child_) child_->Release();
    childCfg_ = nullptr;
    childRT_ = nullptr;
    child_ = nullptr;
  }

  HRESULT checkFormat(IAudioMediaType *opp, IAudioMediaType *req, IAudioMediaType **sup) {
    if (!req || !sup) return E_POINTER;
    *sup = nullptr;
    UNCOMPRESSEDAUDIOFORMAT f;
    if (FAILED(req->GetUncompressedAudioFormat(&f))) return APOERR_FORMAT_NOT_SUPPORTED;
    if (f.guidFormatType != kFormatFloat || f.dwBytesPerSampleContainer != 4) { kbLog("Формат не поддерживается: %u бит, %u кан.", (unsigned)f.dwValidBitsPerSample, (unsigned)f.dwSamplesPerFrame); return APOERR_FORMAT_NOT_SUPPORTED; }
    if (opp) {
      UNCOMPRESSEDAUDIOFORMAT o;
      if (SUCCEEDED(opp->GetUncompressedAudioFormat(&o)) && (o.dwSamplesPerFrame != f.dwSamplesPerFrame || o.fFramesPerSecond != f.fFramesPerSecond))
        return APOERR_FORMAT_NOT_SUPPORTED;
    }
    req->AddRef();
    *sup = req;
    return S_OK;
  }

  // Общая память — файл в C:\\ProgramData\\Kilobuzz (надёжнее «глобального» имени: не зависит от прав службы
  // на глобальное пространство имён и сеансов). Запасной путь — именованная память Global\\.
  void openShared() {
    if (sh_) return;
    std::wstring path = dataDir() + L"\\shm.bin";
    file_ = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file_ != INVALID_HANDLE_VALUE) {
      map_ = CreateFileMappingW(file_, nullptr, PAGE_READWRITE, 0, sizeof(KbShared), nullptr);
      if (!map_) { KbStatusBlock.errShmMap = GetLastError(); kbLog("Общая память (файл): ошибка %lu", KbStatusBlock.errShmMap); CloseHandle(file_); file_ = INVALID_HANDLE_VALUE; }
    } else {
      KbStatusBlock.errShmFile = GetLastError();
      kbLog("Общая память: не открыть %s (ошибка %lu)", narrow(path).c_str(), KbStatusBlock.errShmFile);
    }
    if (!map_) {
      SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, FALSE};
      ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:(A;;GA;;;WD)(A;;GA;;;AC)S:(ML;;NW;;;LW)", SDDL_REVISION_1, &sa.lpSecurityDescriptor, nullptr);
      map_ = CreateFileMappingW(INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, sizeof(KbShared), KB_SHARED_NAME);
      if (sa.lpSecurityDescriptor) LocalFree(sa.lpSecurityDescriptor);
      if (!map_) { KbStatusBlock.errShmGlobal = GetLastError(); kbLog("Общая память (Global): ошибка %lu", KbStatusBlock.errShmGlobal); return; }
    }
    sh_ = (KbShared *)MapViewOfFile(map_, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(KbShared));
    if (!sh_) { kbLog("MapViewOfFile: ошибка %lu", GetLastError()); CloseHandle(map_); map_ = nullptr; return; }
    KbStatusBlock.shmOk = file_ != INVALID_HANDLE_VALUE ? 1 : 2;  // 1 — файл, 2 — Global
    if (sh_->magic != KB_MAGIC || sh_->version != KB_VERSION) {
      ZeroMemory((void *)sh_, offsetof(KbShared, ring));
      sh_->version = KB_VERSION;
      MemoryBarrier();
      sh_->magic = KB_MAGIC;
    }
    sh_->sampleRate = (uint32_t)rate_;
    sh_->channels = channels_;
    seq_ = sh_->paramSeq;
    if (seq_) chain_.setParams(sh_->params[sh_->paramActive & 1]);
  }
  void closeShared() {
    if (sh_) UnmapViewOfFile(sh_);
    if (map_) CloseHandle(map_);
    if (file_ != INVALID_HANDLE_VALUE) CloseHandle(file_);
    sh_ = nullptr;
    map_ = nullptr;
    file_ = INVALID_HANDLE_VALUE;
  }

  volatile LONG ref_ = 1;
  IUnknown *outer_ = nullptr;
  bool locked_ = false;
  UINT32 channels_ = 2, maxFrames_ = 0;
  float rate_ = 48000.f;
  std::vector<float> bufL_, bufR_, dryL_, dryR_;
  kb::Chain chain_;
  HANDLE map_ = nullptr, file_ = INVALID_HANDLE_VALUE;
  std::string endpoint_;
  KbShared *sh_ = nullptr;
  uint32_t seq_ = 0;
  IAudioProcessingObject *child_ = nullptr;
  IAudioProcessingObjectRT *childRT_ = nullptr;
  IAudioProcessingObjectConfiguration *childCfg_ = nullptr;
  std::vector<BYTE> initCopy_;
};

class Factory final : public IClassFactory {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IClassFactory)) { *ppv = this; AddRef(); return S_OK; }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown *outer, REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    InterlockedIncrement(&KbStatusBlock.createInstance);
    // при агрегации COM разрешает просить только IUnknown
    if (outer && riid != __uuidof(IUnknown)) { InterlockedIncrement(&KbStatusBlock.refused); return KbStatusBlock.lastCreateHr = CLASS_E_NOAGGREGATION; }
    if (outer) InterlockedIncrement(&KbStatusBlock.aggregated);
    static volatile LONG logged = 0;
    if (InterlockedExchange(&logged, 1) == 0) {
      wchar_t exe[MAX_PATH] = L"";
      GetModuleFileNameW(nullptr, exe, MAX_PATH);
      kbLog("Модуль Kilobuzz загружен в %s", narrow(exe).c_str());
    }
    auto *o = new (std::nothrow) KilobuzzApo(outer);
    if (!o) return KbStatusBlock.lastCreateHr = E_OUTOFMEMORY;
    HRESULT hr = o->inner_.QueryInterface(riid, ppv);
    o->inner_.Release();
    return KbStatusBlock.lastCreateHr = hr;
  }
  HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
    lock ? InterlockedIncrement(&g_locks) : InterlockedDecrement(&g_locks);
    return S_OK;
  }
};

static Factory g_factory;

static HRESULT getClassObject(REFIID riid, void **ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;
  HRESULT hr = g_factory.QueryInterface(riid, ppv);
  if (SUCCEEDED(hr)) return hr;
  // запрос сразу интерфейса модуля, без фабрики
  return g_factory.CreateInstance(nullptr, riid, ppv);
}

// В эту библиотеку Windows направляет только классы, записанные на неё в реестре, поэтому
// отвечаем на любой CLSID (звуковая служба может запрашивать модуль под своим идентификатором).
extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID clsid, REFIID riid, void **ppv) {
  InterlockedIncrement(&KbStatusBlock.classObject);
  HRESULT hr = getClassObject(riid, ppv);
  LONG i = (InterlockedIncrement(&KbStatusBlock.reqIdx) - 1) & 3;
  KbStatusBlock.reqClsid[i] = clsid;
  KbStatusBlock.reqRiid[i] = riid;
  KbStatusBlock.reqHr[i] = hr;
  return hr;
}

extern "C" HRESULT __stdcall DllCanUnloadNow() { return g_objects == 0 && g_locks == 0 ? S_OK : S_FALSE; }

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(h);  // в DllMain ничего больше: блокировка загрузчика
  return TRUE;
}
