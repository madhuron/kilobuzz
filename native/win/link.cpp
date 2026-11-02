// kilobuzz-link.exe — связь приложения Kilobuzz с модулем Kilobuzz APO через общую память.
//   stdin  ← пакеты параметров: 4 байта 'KBP1' + P_COUNT float32 (раскладка — shared.h)
//   stdout → звук ДО обработки для анализа: float32 interleaved stereo
//   stderr → строки JSON со статусом: ready / idle / error
// Когда приложение закрывается (stdin закрыт), модуль переводится в прозрачный режим.
#include <windows.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>
#include <shlobj.h>
#include <string>
#include "shared.h"

static KbShared *g_sh = nullptr;

static void status(const char *json) {
  fprintf(stderr, "%s\n", json);
  fflush(stderr);
}

static void writeParams(const float *p) {
  uint32_t next = (g_sh->paramActive + 1) & 1;
  memcpy(g_sh->params[next], p, sizeof(float) * P_COUNT);
  MemoryBarrier();
  g_sh->paramActive = next;
  g_sh->paramSeq = g_sh->paramSeq + 1;
}

static DWORD WINAPI readParams(LPVOID) {
  float buf[P_COUNT];
  for (;;) {
    char magic[4];
    if (fread(magic, 1, 4, stdin) != 4) break;
    if (memcmp(magic, "KBP1", 4) != 0) continue;
    if (fread(buf, sizeof(float), P_COUNT, stdin) != P_COUNT) break;
    writeParams(buf);
  }
  // приложение закрылось — модуль становится прозрачным
  float p[P_COUNT];
  memcpy(p, g_sh->params[g_sh->paramActive & 1], sizeof(p));
  p[P_BYPASS] = 1;
  p[P_HEADROOM] = 0;  // без приложения — обычная громкость
  writeParams(p);
  ExitProcess(0);
  return 0;
}

int wmain() {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  // общая память: файл в C:\\ProgramData\\Kilobuzz (основной путь) или именованная Global\\ (запасной)
  wchar_t pd[MAX_PATH] = L"C:\\ProgramData";
  SHGetFolderPathW(nullptr, CSIDL_COMMON_APPDATA, nullptr, 0, pd);
  std::wstring path = std::wstring(pd) + L"\\Kilobuzz\\shm.bin";
  HANDLE map = nullptr;
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file != INVALID_HANDLE_VALUE) {
    LARGE_INTEGER size;
    if (GetFileSizeEx(file, &size) && size.QuadPart >= (LONGLONG)sizeof(KbShared)) map = CreateFileMappingW(file, nullptr, PAGE_READWRITE, 0, sizeof(KbShared), nullptr);
  }
  if (!map) map = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, KB_SHARED_NAME);
  if (!map) {
    // модуль не установлен или Windows его ещё не загрузила
    status("{\"event\":\"error\",\"code\":\"not_loaded\",\"message\":\"Модуль Kilobuzz для Windows не активен\"}");
    return 2;
  }
  g_sh = (KbShared *)MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(KbShared));
  if (!g_sh || g_sh->magic != KB_MAGIC) {
    status("{\"event\":\"error\",\"code\":\"not_loaded\",\"message\":\"Модуль Kilobuzz для Windows не активен\"}");
    return 2;
  }
  if (g_sh->version != KB_VERSION) {
    status("{\"event\":\"error\",\"code\":\"bad_version\",\"message\":\"Версия модуля не совпадает с приложением — переустановите модуль\"}");
    return 3;
  }
  char msg[200];
  snprintf(msg, sizeof msg, "{\"event\":\"ready\",\"sampleRate\":%u,\"channels\":%u}", g_sh->sampleRate, g_sh->channels);
  status(msg);
  CreateThread(nullptr, 0, readParams, nullptr, 0, nullptr);

  uint64_t rd = g_sh->ringWrite;
  uint32_t lastBeat = g_sh->heartbeat, idleMs = 0;
  bool idle = false;
  static float out[KB_RING_FRAMES * 2];
  for (;;) {
    Sleep(10);
    uint64_t w = g_sh->ringWrite;
    if (w - rd > KB_RING_FRAMES / 2) rd = w - 4800;  // отстали — догоняем
    size_t n = 0;
    for (; rd < w; rd++, n++) {
      size_t j = (size_t)(rd % KB_RING_FRAMES);
      out[n * 2] = g_sh->ring[j * 2];
      out[n * 2 + 1] = g_sh->ring[j * 2 + 1];
    }
    if (n) {
      if (fwrite(out, sizeof(float) * 2, n, stdout) != n) return 0;
      fflush(stdout);
    }
    // звуковая система Windows останавливает обработку, когда ничего не играет
    uint32_t beat = g_sh->heartbeat;
    if (beat == lastBeat) idleMs += 10; else { idleMs = 0; lastBeat = beat; }
    if (!idle && idleMs > 1500) { idle = true; status("{\"event\":\"idle\"}"); }
    if (idle && idleMs == 0) {
      idle = false;
      snprintf(msg, sizeof msg, "{\"event\":\"ready\",\"sampleRate\":%u,\"channels\":%u}", g_sh->sampleRate, g_sh->channels);
      status(msg);
    }
  }
}
