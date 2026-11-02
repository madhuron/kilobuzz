// kilobuzz-apo-setup.exe — установка / удаление модуля обработки Kilobuzz для Windows.
// Запускается с правами администратора (пользователь подтверждает в окне UAC).
//   install    — копирует KilobuzzAPO.dll в Program Files, регистрирует APO и подключает его
//                ко всем активным устройствам вывода (прежние настройки сохраняются для отката)
//   uninstall  — возвращает исходные настройки устройств и удаляет модуль
//   status     — печатает JSON: установлен ли модуль и на каких устройствах
// После установки/удаления перезапускается служба «Windows Audio».
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <shlobj.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>
#include <string>
#include <vector>
#include <tlhelp32.h>
#include <time.h>
#include "apo_api.h"
#include "kbstatus.h"

static const wchar_t *CLSID_STR = L"{6B9E5B7C-3F2A-4C1D-9E8F-1A2B3C4D5E6F}";
static const wchar_t *IID_APO_STR = L"{FD7F2B29-24D0-4B5C-B177-592C39F9CA10}";
// Слоты эффектов устройства. Kilobuzz занимает свободный; если все заняты — встраивается в цепочку
// перед существующим эффектом производителя (тот продолжает работать — его запускает сам Kilobuzz).
static const wchar_t *K_SFX = L"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},5";       // до микширования (модель с режимами)
static const wchar_t *K_MFX = L"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},6";       // после микширования
static const wchar_t *K_EFX = L"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},7";       // на выходе устройства
static const wchar_t *K_GFX = L"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},2";       // после микширования (классическая модель)
static const wchar_t *K_SFX_MODES = L"{d3993a3f-99c2-4402-b5ec-a92a0367664b},5";
static const wchar_t *K_MFX_MODES = L"{d3993a3f-99c2-4402-b5ec-a92a0367664b},6";
static const wchar_t *K_EFX_MODES = L"{d3993a3f-99c2-4402-b5ec-a92a0367664b},7";
// Привязка эффектов к устройству (KSNODETYPE_ANY). Без неё Windows не загружает эффекты в классической
// модели — так бывает у USB-звуковых карт без фирменных эффектов.
static const wchar_t *K_ASSOC = L"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},0";
static const wchar_t *KSNODETYPE_ANY = L"{00000000-0000-0000-0000-000000000000}";
static const wchar_t *FX_KEYS[] = {K_GFX, K_MFX, K_EFX, K_MFX_MODES, K_EFX_MODES, K_ASSOC};
static const wchar_t *SLOTS[] = {K_GFX, K_MFX, K_EFX};
static const wchar_t *AUDIO_KEY = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Audio";
static const wchar_t *MODE_DEFAULT = L"{C18E2F7E-933D-4965-B7D1-1EEF228D2AF3}";
static const wchar_t *DISABLE_SYSFX = L"{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5";
static const wchar_t *RENDER = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render\\";
static const wchar_t *BACKUP = L"SOFTWARE\\Kilobuzz\\APO\\Backup\\";

static std::wstring *g_buf = nullptr;  // diagfull собирает вывод в файл
static void out(const wchar_t *fmt, ...) {
  va_list a;
  va_start(a, fmt);
  if (g_buf) {
    wchar_t tmp[4096];
    vswprintf(tmp, 4096, fmt, a);
    *g_buf += tmp;
  } else {
    vfwprintf(stdout, fmt, a);
    fflush(stdout);
  }
  va_end(a);
}

static bool enablePrivilege(const wchar_t *name) {
  HANDLE tok;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &tok)) return false;
  TOKEN_PRIVILEGES tp = {1, {{{0, 0}, SE_PRIVILEGE_ENABLED}}};
  bool ok = LookupPrivilegeValueW(nullptr, name, &tp.Privileges[0].Luid) && AdjustTokenPrivileges(tok, FALSE, &tp, 0, nullptr, nullptr);
  CloseHandle(tok);
  return ok && GetLastError() == ERROR_SUCCESS;
}

// Ключи устройств принадлежат системе: администратор временно получает право записи
// (так же делает Equalizer APO).
static bool makeWritable(const std::wstring &sub) {
  HKEY k;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, sub.c_str(), 0, KEY_SET_VALUE, &k) == ERROR_SUCCESS) { RegCloseKey(k); return true; }
  enablePrivilege(SE_TAKE_OWNERSHIP_NAME);
  enablePrivilege(SE_RESTORE_NAME);
  enablePrivilege(SE_BACKUP_NAME);
  SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY;
  PSID admins = nullptr;
  if (!AllocateAndInitializeSid(&nt, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &admins)) return false;
  std::wstring obj = L"MACHINE\\" + sub;
  SetNamedSecurityInfoW(&obj[0], SE_REGISTRY_KEY, OWNER_SECURITY_INFORMATION, admins, nullptr, nullptr, nullptr);
  PACL oldDacl = nullptr, newDacl = nullptr;
  PSECURITY_DESCRIPTOR sd = nullptr;
  bool ok = false;
  if (GetNamedSecurityInfoW(obj.c_str(), SE_REGISTRY_KEY, DACL_SECURITY_INFORMATION, nullptr, nullptr, &oldDacl, nullptr, &sd) == ERROR_SUCCESS) {
    EXPLICIT_ACCESSW ea = {};
    ea.grfAccessPermissions = KEY_ALL_ACCESS;
    ea.grfAccessMode = GRANT_ACCESS;
    ea.grfInheritance = CONTAINER_INHERIT_ACE;
    ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType = TRUSTEE_IS_GROUP;
    ea.Trustee.ptstrName = (LPWSTR)admins;
    if (SetEntriesInAclW(1, &ea, oldDacl, &newDacl) == ERROR_SUCCESS)
      ok = SetNamedSecurityInfoW(&obj[0], SE_REGISTRY_KEY, DACL_SECURITY_INFORMATION, nullptr, nullptr, newDacl, nullptr) == ERROR_SUCCESS;
  }
  if (newDacl) LocalFree(newDacl);
  if (sd) LocalFree(sd);
  FreeSid(admins);
  return ok;
}

static bool setStr(HKEY root, const std::wstring &sub, const wchar_t *name, const std::wstring &val, DWORD type = REG_SZ) {
  HKEY k;
  if (RegCreateKeyExW(root, sub.c_str(), 0, nullptr, 0, KEY_SET_VALUE | KEY_WOW64_64KEY, nullptr, &k, nullptr) != ERROR_SUCCESS) return false;
  std::wstring data = val;
  data.push_back(L'\0');
  if (type == REG_MULTI_SZ) data.push_back(L'\0');
  bool ok = RegSetValueExW(k, name, 0, type, (const BYTE *)data.data(), (DWORD)(data.size() * sizeof(wchar_t))) == ERROR_SUCCESS;
  RegCloseKey(k);
  return ok;
}

static bool setDword(HKEY root, const std::wstring &sub, const wchar_t *name, DWORD v) {
  HKEY k;
  if (RegCreateKeyExW(root, sub.c_str(), 0, nullptr, 0, KEY_SET_VALUE | KEY_WOW64_64KEY, nullptr, &k, nullptr) != ERROR_SUCCESS) return false;
  bool ok = RegSetValueExW(k, name, 0, REG_DWORD, (const BYTE *)&v, sizeof v) == ERROR_SUCCESS;
  RegCloseKey(k);
  return ok;
}

// Прочитать значение как есть (тип + байты); false — значения нет
static bool readRaw(const std::wstring &sub, const wchar_t *name, DWORD &type, std::vector<BYTE> &data) {
  HKEY k;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, sub.c_str(), 0, KEY_QUERY_VALUE | KEY_WOW64_64KEY, &k) != ERROR_SUCCESS) return false;
  DWORD size = 0;
  bool ok = RegQueryValueExW(k, name, nullptr, &type, nullptr, &size) == ERROR_SUCCESS;
  if (ok) {
    data.resize(size);
    ok = RegQueryValueExW(k, name, nullptr, &type, data.data(), &size) == ERROR_SUCCESS;
  }
  RegCloseKey(k);
  return ok;
}

static void writeRaw(const std::wstring &sub, const wchar_t *name, DWORD type, const std::vector<BYTE> &data) {
  HKEY k;
  if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, sub.c_str(), 0, nullptr, 0, KEY_SET_VALUE | KEY_WOW64_64KEY, nullptr, &k, nullptr) != ERROR_SUCCESS) return;
  RegSetValueExW(k, name, 0, type, data.data(), (DWORD)data.size());
  RegCloseKey(k);
}

static void deleteValue(const std::wstring &sub, const wchar_t *name) {
  HKEY k;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, sub.c_str(), 0, KEY_SET_VALUE | KEY_WOW64_64KEY, &k) != ERROR_SUCCESS) return;
  RegDeleteValueW(k, name);
  RegCloseKey(k);
}

struct Endpoint { std::wstring guid, name; };

static std::vector<Endpoint> renderEndpoints() {
  std::vector<Endpoint> list;
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IMMDeviceEnumerator *en = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void **)&en))) return list;
  IMMDeviceCollection *col = nullptr;
  if (SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) {
    UINT n = 0;
    col->GetCount(&n);
    for (UINT i = 0; i < n; i++) {
      IMMDevice *dev = nullptr;
      if (FAILED(col->Item(i, &dev))) continue;
      LPWSTR id = nullptr;
      Endpoint e;
      if (SUCCEEDED(dev->GetId(&id))) {
        std::wstring s = id;  // {0.0.0.00000000}.{guid}
        size_t dot = s.rfind(L'.');
        e.guid = dot == std::wstring::npos ? s : s.substr(dot + 1);
        CoTaskMemFree(id);
      }
      IPropertyStore *ps = nullptr;
      if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &ps))) {
        PROPVARIANT v;
        PropVariantInit(&v);
        if (SUCCEEDED(ps->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) e.name = v.pwszVal;
        PropVariantClear(&v);
        ps->Release();
      }
      if (!e.guid.empty()) list.push_back(e);
      dev->Release();
    }
    col->Release();
  }
  en->Release();
  return list;
}

static void restartAudio() {
  // Перезапуск «Windows Audio», чтобы звуковая система загрузила/выгрузила модуль
  STARTUPINFOW si = {sizeof si};
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi;
  wchar_t cmd[] = L"cmd.exe /c net stop audiosrv /y & net start audiosrv";
  if (CreateProcessW(nullptr, cmd, nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
    WaitForSingleObject(pi.hProcess, 30000);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }
}

static std::wstring installDir() {
  wchar_t pf[MAX_PATH];
  SHGetFolderPathW(nullptr, CSIDL_PROGRAM_FILES, nullptr, 0, pf);
  return std::wstring(pf) + L"\\Kilobuzz\\APO";
}

// Папка для журнала модуля и общей памяти с приложением: доступ всем (модуль работает от имени службы)
static std::wstring dataDir() {
  wchar_t pd[MAX_PATH];
  SHGetFolderPathW(nullptr, CSIDL_COMMON_APPDATA, nullptr, 0, pd);
  return std::wstring(pd) + L"\\Kilobuzz";
}

static void prepareDataDir() {
  std::wstring dir = dataDir();
  SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, FALSE};
  ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LS)(A;OICI;FA;;;WR)(A;OICI;FA;;;AC)S:(ML;OICI;NW;;;LW)", SDDL_REVISION_1, &sa.lpSecurityDescriptor, nullptr);
  if (!CreateDirectoryW(dir.c_str(), &sa) && sa.lpSecurityDescriptor) {
    // папка уже есть — новые права применяются и к файлам внутри
    BOOL present = FALSE, def = FALSE;
    PACL dacl = nullptr;
    if (GetSecurityDescriptorDacl(sa.lpSecurityDescriptor, &present, &dacl, &def) && present)
      SetNamedSecurityInfoW(&dir[0], SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr);
  }
  if (sa.lpSecurityDescriptor) LocalFree(sa.lpSecurityDescriptor);
}

static int install() {
  prepareDataDir();
  // 1. копия модуля туда, откуда его может читать служба звука
  wchar_t self[MAX_PATH];
  GetModuleFileNameW(nullptr, self, MAX_PATH);
  std::wstring dir = std::wstring(self).substr(0, std::wstring(self).rfind(L'\\'));
  std::wstring dst = installDir();
  SHCreateDirectoryExW(nullptr, dst.c_str(), nullptr);
  std::wstring dll = dst + L"\\KilobuzzAPO.dll";
  bool pending = false;
  if (!CopyFileW((dir + L"\\KilobuzzAPO.dll").c_str(), dll.c_str(), FALSE)) {
    // файл занят старой версией в звуковой системе: занятый файл можно переименовать — отодвигаем его,
    // кладём новую версию на его место, старую удалим при перезагрузке; служба перезапустится с новой
    std::wstring old = dst + L"\\KilobuzzAPO.old." + std::to_wstring(GetTickCount64()) + L".dll";
    bool moved = MoveFileExW(dll.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING) != 0;
    if (moved) MoveFileExW(old.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
    if (!moved || !CopyFileW((dir + L"\\KilobuzzAPO.dll").c_str(), dll.c_str(), FALSE)) {
      // запасной путь — замена при перезагрузке
      std::wstring tmp = dst + L"\\KilobuzzAPO.new.dll";
      if (!CopyFileW((dir + L"\\KilobuzzAPO.dll").c_str(), tmp.c_str(), FALSE)) { out(L"{\"ok\":false,\"error\":\"copy\"}\n"); return 1; }
      MoveFileExW(tmp.c_str(), dll.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_DELAY_UNTIL_REBOOT);
      pending = true;
    }
  }
  if (!pending) DeleteFileW((dst + L"\\KilobuzzAPO.new.dll").c_str());  // устаревшая отложенная замена больше не нужна
  // 2. регистрация COM-объекта и APO
  std::wstring clsidKey = std::wstring(L"SOFTWARE\\Classes\\CLSID\\") + CLSID_STR;
  setStr(HKEY_LOCAL_MACHINE, clsidKey, nullptr, L"Kilobuzz APO");
  setStr(HKEY_LOCAL_MACHINE, clsidKey + L"\\InprocServer32", nullptr, dll);
  setStr(HKEY_LOCAL_MACHINE, clsidKey + L"\\InprocServer32", L"ThreadingModel", L"Both");
  std::wstring apoKey = std::wstring(L"SOFTWARE\\Classes\\AudioEngine\\AudioProcessingObjects\\") + CLSID_STR;
  setStr(HKEY_LOCAL_MACHINE, apoKey, L"FriendlyName", L"Kilobuzz");
  setStr(HKEY_LOCAL_MACHINE, apoKey, L"Copyright", L"Kilobuzz");
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"MajorVersion", 1);
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"MinorVersion", 0);
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"Flags", 0xE);
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"MinInputConnections", 1);
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"MaxInputConnections", 1);
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"MinOutputConnections", 1);
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"MaxOutputConnections", 1);
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"MaxInstances", 0xFFFFFFFF);
  setDword(HKEY_LOCAL_MACHINE, apoKey, L"NumAPOInterfaces", 1);
  setStr(HKEY_LOCAL_MACHINE, apoKey, L"APOInterface0", IID_APO_STR);

  // 3. подключение ко всем активным устройствам вывода, с резервной копией прежних значений
  auto eps = renderEndpoints();
  int done = 0;
  out(L"{\"ok\":true,\"devices\":[");
  for (size_t i = 0; i < eps.size(); i++) {
    const auto &e = eps[i];
    std::wstring base = RENDER + e.guid, fx = base + L"\\FxProperties", props = base + L"\\Properties", bk = BACKUP + e.guid;
    if (!makeWritable(fx) && !makeWritable(base)) continue;
    makeWritable(props);
    for (const wchar_t *name : FX_KEYS) {
      DWORD type;
      std::vector<BYTE> data;
      std::wstring tag = std::wstring(L"had:") + name;
      // резервную копию делаем один раз — повторная установка не затирает настоящие исходные значения
      DWORD t2; std::vector<BYTE> d2;
      if (!readRaw(bk, tag.c_str(), t2, d2)) {
        bool had = readRaw(fx, name, type, data);
        setDword(HKEY_LOCAL_MACHINE, bk, tag.c_str(), had ? 1 : 0);
        if (had) writeRaw(bk, name, type, data);
      }
    }
    // выбор слота
    auto cur = [&](const wchar_t *name) -> std::wstring {
      DWORD t; std::vector<BYTE> d;
      if (!readRaw(fx, name, t, d) || d.size() < 2 || (t != REG_SZ && t != REG_MULTI_SZ)) return L"";
      return std::wstring((const wchar_t *)d.data());  // для списка — первый элемент
    };
    auto ours = [&](const std::wstring &v) { return _wcsicmp(v.c_str(), CLSID_STR) == 0; };
    // новая схема (с режимами обработки): у устройства есть списки режимов или эффекты SFX/MFX/EFX.
    // В ней Windows не читает классический слот GFX — модуль туда ставить нельзя.
    bool modeModel = !cur(K_SFX).empty() || !cur(K_MFX).empty() || !cur(K_EFX).empty() ||
                     !cur(K_SFX_MODES).empty() || !cur(K_MFX_MODES).empty() || !cur(K_EFX_MODES).empty();
    const wchar_t *slot;
    std::wstring wrap;
    if (modeModel) {
      if (cur(K_MFX).empty() || ours(cur(K_MFX))) slot = K_MFX;
      else if (cur(K_EFX).empty() || ours(cur(K_EFX))) slot = K_EFX;
      else { slot = K_MFX; wrap = cur(K_MFX); }
    } else {
      slot = K_GFX;
      if (!cur(K_GFX).empty() && !ours(cur(K_GFX))) wrap = cur(K_GFX);
    }
    // повторная установка: эффект производителя уже записан в цепочку ранее
    std::wstring wrapKey = L"SOFTWARE\\Kilobuzz\\APO\\Wrap";
    if (wrap.empty()) {
      DWORD t; std::vector<BYTE> d;
      if (readRaw(wrapKey, e.guid.c_str(), t, d) && d.size() > 2 && ours(cur(slot))) wrap = (const wchar_t *)d.data();
    }
    // прежняя установка в другой слот — возвращаем там исходное значение
    for (const wchar_t *o : SLOTS) {
      if (o == slot || !ours(cur(o))) continue;
      DWORD t, t2; std::vector<BYTE> had, d;
      std::wstring tag = std::wstring(L"had:") + o;
      if (readRaw(bk, tag.c_str(), t2, had) && had.size() >= 4 && *(DWORD *)had.data() == 1 && readRaw(bk, o, t, d) && !ours((const wchar_t *)d.data())) writeRaw(fx, o, t, d);
      else deleteValue(fx, o);
    }
    DWORD type = REG_SZ;
    std::vector<BYTE> prev;
    readRaw(fx, slot, type, prev);
    setStr(HKEY_LOCAL_MACHINE, fx, slot, CLSID_STR, type == REG_MULTI_SZ ? REG_MULTI_SZ : REG_SZ);
    if (cur(K_ASSOC).empty()) setStr(HKEY_LOCAL_MACHINE, fx, K_ASSOC, KSNODETYPE_ANY);
    if (slot == K_MFX && cur(K_MFX_MODES).empty()) setStr(HKEY_LOCAL_MACHINE, fx, K_MFX_MODES, MODE_DEFAULT, REG_MULTI_SZ);
    if (slot == K_EFX && cur(K_EFX_MODES).empty()) setStr(HKEY_LOCAL_MACHINE, fx, K_EFX_MODES, MODE_DEFAULT, REG_MULTI_SZ);
    if (!wrap.empty()) setStr(HKEY_LOCAL_MACHINE, wrapKey, e.guid.c_str(), wrap);
    else deleteValue(wrapKey, e.guid.c_str());
    // «Дополнительные звуковые эффекты» должны быть включены
    setDword(HKEY_LOCAL_MACHINE, props, DISABLE_SYSFX, 0);
    out(L"%s{\"guid\":\"%ls\",\"name\":\"%ls\",\"chained\":%ls}", done ? L"," : L"", e.guid.c_str(), e.name.c_str(), wrap.empty() ? L"false" : L"true");
    done++;
  }
  out(L"]}\n");
  setStr(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Kilobuzz\\APO", L"Installed", L"1");
  restartAudio();
  return done ? 0 : 1;
}

static int uninstall() {
  HKEY k;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Kilobuzz\\APO\\Backup", 0, KEY_READ | KEY_WOW64_64KEY, &k) == ERROR_SUCCESS) {
    wchar_t name[256];
    for (DWORD i = 0;; i++) {
      DWORD len = 256;
      if (RegEnumKeyExW(k, i, name, &len, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
      std::wstring guid = name, fx = RENDER + guid + L"\\FxProperties", bk = BACKUP + guid;
      makeWritable(fx);
      for (const wchar_t *v : FX_KEYS) {
        DWORD type, t2;
        std::vector<BYTE> had, data;
        std::wstring tag = std::wstring(L"had:") + v;
        if (readRaw(bk, tag.c_str(), t2, had) && had.size() >= 4 && *(DWORD *)had.data() == 1 && readRaw(bk, v, type, data)) writeRaw(fx, v, type, data);
        else deleteValue(fx, v);
      }
    }
    RegCloseKey(k);
  }
  RegDeleteTreeW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Kilobuzz\\APO");
  RegDeleteTreeW(HKEY_LOCAL_MACHINE, (std::wstring(L"SOFTWARE\\Classes\\AudioEngine\\AudioProcessingObjects\\") + CLSID_STR).c_str());
  RegDeleteTreeW(HKEY_LOCAL_MACHINE, (std::wstring(L"SOFTWARE\\Classes\\CLSID\\") + CLSID_STR).c_str());
  restartAudio();
  std::wstring dll = installDir() + L"\\KilobuzzAPO.dll";
  if (!DeleteFileW(dll.c_str())) MoveFileExW(dll.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
  out(L"{\"ok\":true}\n");
  return 0;
}

// Режим совместимости: на части систем звуковая служба загружает сторонние модули только
// с отключённой защитой аудиотракта (так же делает Equalizer APO). Включается только по кнопке пользователя.
static int compat(bool on) {
  if (on) {
    DWORD t; std::vector<BYTE> d;
    if (!readRaw(L"SOFTWARE\\Kilobuzz\\APO", L"had:compat", t, d)) {
      bool had = readRaw(AUDIO_KEY, L"DisableProtectedAudioDG", t, d);
      setDword(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Kilobuzz\\APO", L"had:compat", had ? 1 : 0);
      if (had) writeRaw(L"SOFTWARE\\Kilobuzz\\APO", L"compat:old", t, d);
    }
    makeWritable(AUDIO_KEY);
    setDword(HKEY_LOCAL_MACHINE, AUDIO_KEY, L"DisableProtectedAudioDG", 1);
  } else {
    DWORD t; std::vector<BYTE> had, old;
    if (readRaw(L"SOFTWARE\\Kilobuzz\\APO", L"had:compat", t, had)) {
      if (had.size() >= 4 && *(DWORD *)had.data() == 1 && readRaw(L"SOFTWARE\\Kilobuzz\\APO", L"compat:old", t, old)) writeRaw(AUDIO_KEY, L"DisableProtectedAudioDG", t, old);
      else deleteValue(AUDIO_KEY, L"DisableProtectedAudioDG");
    }
  }
  restartAudio();
  out(L"{\"ok\":true}\n");
  return 0;
}

static std::wstring jsonEsc(const std::wstring &s) {
  std::wstring r;
  for (wchar_t c : s) {
    if (c == L'"' || c == L'\\') { r += L'\\'; r += c; }
    else if (c == L'\n') r += L"\\n";
    else if (c >= 32) r += c;
  }
  return r;
}

static std::wstring tail(const std::wstring &path, long max) {
  std::wstring log;
  // FILE_FLAG_BACKUP_SEMANTICS: администратор читает и папку службы, куда обычный доступ закрыт
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (h == INVALID_HANDLE_VALUE) return log;
  LARGE_INTEGER sz = {};
  GetFileSizeEx(h, &sz);
  long size = (long)sz.QuadPart, from = size > max ? size - max : 0;
  SetFilePointer(h, from, nullptr, FILE_BEGIN);
  std::string b(size - from, '\0');
  DWORD rd = 0;
  ReadFile(h, &b[0], (DWORD)b.size(), &rd, nullptr);
  CloseHandle(h);
  b.resize(rd);
  int wl = MultiByteToWideChar(CP_UTF8, 0, b.data(), (int)b.size(), nullptr, 0);
  log.resize(wl);
  MultiByteToWideChar(CP_UTF8, 0, b.data(), (int)b.size(), &log[0], wl);
  return log;
}

// журнал модуля: основной в ProgramData и запасной во временной папке звуковой службы
static std::wstring readLog() {
  wchar_t win[MAX_PATH];
  GetWindowsDirectoryW(win, MAX_PATH);
  std::wstring a = tail(dataDir() + L"\\apo.log", 4000);
  std::wstring b = tail(std::wstring(win) + L"\\ServiceProfiles\\LocalService\\AppData\\Local\\Temp\\kilobuzz-apo.log", 4000);
  if (!b.empty()) a += L"--- журнал звуковой службы ---\n" + b;
  // последние сообщения модуля из журнала событий Windows
  std::vector<std::wstring> ev;
  if (HANDLE h = OpenEventLogW(nullptr, L"Application")) {
    std::vector<BYTE> buf(64 * 1024);
    DWORD rd = 0, need = 0;
    while (ev.size() < 30 && ReadEventLogW(h, EVENTLOG_SEQUENTIAL_READ | EVENTLOG_BACKWARDS_READ, 0, buf.data(), (DWORD)buf.size(), &rd, &need)) {
      for (BYTE *p = buf.data(); p < buf.data() + rd && ev.size() < 30;) {
        auto *r = (EVENTLOGRECORD *)p;
        const wchar_t *src = (const wchar_t *)(p + sizeof(EVENTLOGRECORD));
        if (_wcsicmp(src, L"Kilobuzz") == 0 && r->NumStrings > 0) {
          time_t tt = r->TimeGenerated;
          struct tm lt;
          localtime_s(&lt, &tt);
          wchar_t ts[32];
          swprintf(ts, 32, L"%02d.%02d %02d:%02d:%02d ", lt.tm_mday, lt.tm_mon + 1, lt.tm_hour, lt.tm_min, lt.tm_sec);
          ev.push_back(std::wstring(ts) + (const wchar_t *)(p + r->StringOffset));
        }
        p += r->Length;
      }
    }
    CloseEventLog(h);
  }
  if (!ev.empty()) {
    a += L"--- журнал событий Windows ---\n";
    for (auto it = ev.rbegin(); it != ev.rend(); ++it) a += *it + L"\n";
  }
  return a;
}

// Диагностика (без прав администратора): что записано у устройств, загружала ли Windows модуль (журнал)
static int diag() {
  DWORD type; std::vector<BYTE> v;
  out(L"{\"installed\":%ls", readRaw(L"SOFTWARE\\Kilobuzz\\APO", L"Installed", type, v) ? L"true" : L"false");
  out(L",\"compat\":%ls", readRaw(AUDIO_KEY, L"DisableProtectedAudioDG", type, v) && v.size() >= 4 && *(DWORD *)v.data() == 1 ? L"true" : L"false");
  out(L",\"dll\":%ls", GetFileAttributesW((installDir() + L"\\KilobuzzAPO.dll").c_str()) != INVALID_FILE_ATTRIBUTES ? L"true" : L"false");
  out(L",\"devices\":[");
  int n = 0;
  for (const auto &e : renderEndpoints()) {
    std::wstring fx = RENDER + e.guid + L"\\FxProperties";
    out(L"%s{\"name\":\"%ls\"", n++ ? L"," : L"", jsonEsc(e.name).c_str());
    const wchar_t *names[] = {L"assoc", L"gfx", L"mfx", L"efx"};
    const wchar_t *keys[] = {K_ASSOC, K_GFX, K_MFX, K_EFX};
    for (int i = 0; i < 4; i++) {
      std::wstring val;
      if (readRaw(fx, keys[i], type, v) && v.size() >= 2 && (type == REG_SZ || type == REG_MULTI_SZ)) val = (const wchar_t *)v.data();
      out(L",\"%ls\":\"%ls\"", names[i], jsonEsc(val).c_str());
    }
    bool modes = false;
    for (const wchar_t *k : {K_SFX, K_SFX_MODES, K_MFX_MODES, K_EFX_MODES})
      if (readRaw(fx, k, type, v) && v.size() > 2) modes = true;
    out(L",\"modes\":%ls", modes ? L"true" : L"false");
    std::wstring props = RENDER + e.guid + L"\\Properties";
    out(L",\"sysfxDisabled\":%ls}", readRaw(props, DISABLE_SYSFX, type, v) && v.size() >= 4 && *(DWORD *)v.data() == 1 ? L"true" : L"false");
  }
  // хвост журнала модуля
  std::wstring log = readLog();
  out(L"],\"log\":\"%ls\"}\n", jsonEsc(log).c_str());
  return 0;
}

// ---------- подробная диагностика (с правами администратора) ----------
static std::wstring hr(HRESULT h) { wchar_t b[16]; swprintf(b, 16, L"0x%08lx", (unsigned long)h); return b; }

static std::wstring regStr(HKEY root, const std::wstring &sub, const wchar_t *name) {
  HKEY k;
  if (RegOpenKeyExW(root, sub.c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &k) != ERROR_SUCCESS) return L"<нет ключа>";
  wchar_t buf[1024]; DWORD sz = sizeof buf, type = 0;
  LONG r = RegQueryValueExW(k, name, nullptr, &type, (BYTE *)buf, &sz);
  RegCloseKey(k);
  if (r != ERROR_SUCCESS) return L"<нет значения>";
  buf[sz / 2 < 1023 ? sz / 2 : 1023] = 0;
  return buf;
}

// все значения ключа: строки как есть, остальное — тип и размер
static void dumpKey(const std::wstring &sub) {
  HKEY k;
  out(L"{");
  LONG r = RegOpenKeyExW(HKEY_LOCAL_MACHINE, sub.c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &k);
  if (r != ERROR_SUCCESS) { out(L"\"error\":\"%ls\"}", r == ERROR_FILE_NOT_FOUND ? L"нет ключа" : L"нет доступа"); return; }
  for (DWORD i = 0, n = 0; i < 400; i++) {
    wchar_t name[256]; DWORD nl = 256, type = 0, sz = 0;
    if (RegEnumValueW(k, i, name, &nl, nullptr, &type, nullptr, &sz) != ERROR_SUCCESS) break;
    std::vector<BYTE> d(sz + 4, 0); nl = 256;
    RegEnumValueW(k, i, name, &nl, nullptr, &type, d.data(), &sz);
    std::wstring val;
    if (type == REG_SZ || type == REG_EXPAND_SZ) val = (const wchar_t *)d.data();
    else if (type == REG_MULTI_SZ) { for (const wchar_t *p = (const wchar_t *)d.data(); *p; p += wcslen(p) + 1) { if (!val.empty()) val += L" | "; val += p; } }
    else if (type == REG_DWORD && sz >= 4) { wchar_t b[24]; swprintf(b, 24, L"dword %lu", *(DWORD *)d.data()); val = b; }
    else { wchar_t b[48]; swprintf(b, 48, L"тип %lu, %lu байт", type, sz); val = b; }
    out(L"%ls\"%ls\":\"%ls\"", n++ ? L"," : L"", jsonEsc(name).c_str(), jsonEsc(val).c_str());
  }
  RegCloseKey(k);
  out(L"}");
}

// загружает модуль в этот процесс так же, как это делает звуковая система
static void selfTest() {
  std::wstring dll = installDir() + L"\\KilobuzzAPO.dll";
  HMODULE m = LoadLibraryW(dll.c_str());
  if (!m) { out(L",\"selftest\":\"LoadLibrary: ошибка %lu\"", GetLastError()); return; }
  typedef HRESULT(__stdcall * GetCO)(REFCLSID, REFIID, void **);
  GetCO get = (GetCO)GetProcAddress(m, "DllGetClassObject");
  if (!get) { out(L",\"selftest\":\"нет DllGetClassObject\""); return; }
  CLSID clsid; CLSIDFromString(CLSID_STR, &clsid);
  IClassFactory *cf = nullptr;
  HRESULT h = get(clsid, __uuidof(IClassFactory), (void **)&cf);
  if (FAILED(h)) { out(L",\"selftest\":\"DllGetClassObject %ls\"", hr(h).c_str()); return; }
  IAudioProcessingObject *apo = nullptr;
  h = cf->CreateInstance(nullptr, __uuidof(IAudioProcessingObject), (void **)&apo);
  cf->Release();
  if (FAILED(h)) { out(L",\"selftest\":\"CreateInstance %ls\"", hr(h).c_str()); return; }
  APO_REG_PROPERTIES *rp = nullptr;
  h = apo->GetRegistrationProperties(&rp);
  out(L",\"selftest\":\"ok, GetRegistrationProperties %ls\"", hr(h).c_str());
  if (rp) CoTaskMemFree(rp);
  apo->Release();
  // через COM-регистрацию — так модуль ищет звуковая система
  h = CoCreateInstance(clsid, nullptr, CLSCTX_INPROC_SERVER, __uuidof(IAudioProcessingObject), (void **)&apo);
  out(L",\"cocreate\":\"%ls\"", hr(h).c_str());
  if (SUCCEEDED(h)) apo->Release();
  // звуковая система создаёт модуль внутри своего объекта (агрегация) — проверяем и этот путь
  struct Outer final : IUnknown {
    IUnknown *inner = nullptr;
    LONG ref = 1;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override {
      if (riid == __uuidof(IUnknown)) { *ppv = this; AddRef(); return S_OK; }
      return inner ? inner->QueryInterface(riid, ppv) : E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref; }
    ULONG STDMETHODCALLTYPE Release() override { return --ref; }
  } outer;
  h = CoCreateInstance(clsid, &outer, CLSCTX_INPROC_SERVER, __uuidof(IUnknown), (void **)&outer.inner);
  if (SUCCEEDED(h)) {
    h = outer.QueryInterface(__uuidof(IAudioProcessingObject), (void **)&apo);
    if (SUCCEEDED(h)) {
      rp = nullptr;
      h = apo->GetRegistrationProperties(&rp);
      if (rp) CoTaskMemFree(rp);
      apo->Release();
    }
    outer.inner->Release();
  }
  out(L",\"aggregated\":\"%ls\"", hr(h).c_str());
}

// состояние модуля прямо из памяти звукового процесса (там у модуля может не быть права что-либо записать)
static void readStatus(DWORD pid, BYTE *remoteBase) {
  HMODULE m = LoadLibraryW((installDir() + L"\\KilobuzzAPO.dll").c_str());
  BYTE *local = m ? (BYTE *)GetProcAddress(m, "KbStatusBlock") : nullptr;
  if (!local) { out(L",\"status\":\"в этой версии модуля нет блока состояния\""); return; }
  HANDLE p = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, FALSE, pid);
  if (!p) { out(L",\"status\":\"OpenProcess: ошибка %lu\"", GetLastError()); return; }
  KbStatus st = {};
  SIZE_T rd = 0;
  BOOL ok = ReadProcessMemory(p, remoteBase + (local - (BYTE *)m), &st, sizeof st, &rd);
  DWORD err = GetLastError();
  CloseHandle(p);
  if (!ok || st.magic != KB_STATUS_MAGIC) { out(L",\"status\":\"не прочитано (%lu)\"", ok ? 0 : err); return; }
  out(L",\"status\":{\"classObject\":%ld,\"createInstance\":%ld,\"initialize\":%ld,\"lockForProcess\":%ld,\"process\":%ld",
      st.classObject, st.createInstance, st.initialize, st.lockForProcess, st.process);
  out(L",\"aggregated\":%ld,\"refused\":%ld,\"lastCreateHr\":\"%ls\",\"nanResets\":%ld", st.aggregated, st.refused, hr(st.lastCreateHr).c_str(), st.nanResets);
  out(L",\"errLogFile\":%lu,\"errTempFile\":%lu,\"errEventLog\":%lu,\"errShmFile\":%lu,\"errShmMap\":%lu,\"errShmGlobal\":%lu,\"shm\":%lu",
      st.errLogFile, st.errTempFile, st.errEventLog, st.errShmFile, st.errShmMap, st.errShmGlobal, st.shmOk);
  out(L",\"requests\":[");
  for (LONG i = 0, c = st.reqIdx < 4 ? st.reqIdx : 4; i < c; i++) {
    wchar_t a[64], b[64];
    StringFromGUID2(st.reqClsid[i], a, 64);
    StringFromGUID2(st.reqRiid[i], b, 64);
    out(L"%ls{\"clsid\":\"%ls\",\"riid\":\"%ls\",\"hr\":\"%ls\"}", i ? L"," : L"", a, b, hr(st.reqHr[i]).c_str());
  }
  out(L"],\"lines\":[");
  LONG n = st.lineIdx, from = n > KB_STATUS_LINES ? n - KB_STATUS_LINES : 0;
  for (LONG i = from; i < n; i++) {
    char *l = st.lines[i % KB_STATUS_LINES];
    l[sizeof st.lines[0] - 1] = 0;
    wchar_t w[256];
    MultiByteToWideChar(CP_UTF8, 0, l, -1, w, 256);
    out(L"%ls\"%ls\"", i > from ? L"," : L"", jsonEsc(w).c_str());
  }
  out(L"]}");
}

// какие сторонние модули загружены в процесс звуковой системы (audiodg.exe)
static void audiodgModules() {
  wchar_t win[MAX_PATH]; GetWindowsDirectoryW(win, MAX_PATH);
  out(L",\"audiodg\":[");
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W pe = {sizeof pe};
  int np = 0;
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
    if (_wcsicmp(pe.szExeFile, L"audiodg.exe") != 0) continue;
    out(L"%ls{\"pid\":%lu", np++ ? L"," : L"", pe.th32ProcessID);
    HANDLE ms = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pe.th32ProcessID);
    if (ms == INVALID_HANDLE_VALUE) { out(L",\"error\":\"модули недоступны (%lu) — процесс защищён\"}", GetLastError()); continue; }
    MODULEENTRY32W me = {sizeof me};
    bool kb = false;
    BYTE *kbBase = nullptr;
    std::wstring other;
    for (BOOL mo = Module32FirstW(ms, &me); mo; mo = Module32NextW(ms, &me)) {
      if (_wcsicmp(me.szModule, L"KilobuzzAPO.dll") == 0) { kb = true; kbBase = me.modBaseAddr; }
      else if (_wcsnicmp(me.szExePath, win, wcslen(win)) != 0) { if (!other.empty()) other += L", "; other += me.szExePath; }
    }
    CloseHandle(ms);
    out(L",\"kilobuzz\":%ls,\"thirdParty\":\"%ls\"", kb ? L"true" : L"false", jsonEsc(other).c_str());
    if (kbBase) readStatus(pe.th32ProcessID, kbBase);
    out(L"}");
  }
  if (snap != INVALID_HANDLE_VALUE) CloseHandle(snap);
  out(L"]");
}

static int diagFull(const std::wstring &file) {
  std::wstring buf;
  g_buf = &buf;
  prepareDataDir();
  // проверка, что в папку журнала можно писать
  std::wstring logPath = dataDir() + L"\\apo.log";
  FILE *lf = _wfopen(logPath.c_str(), L"ab");
  out(L"{\"logWritable\":%ls", lf ? L"true" : L"false");
  if (lf) { fputs("--- диагностика: проверка записи журнала ---\r\n", lf); fclose(lf); }
  typedef LONG(WINAPI * RtlGetVersionFn)(OSVERSIONINFOW *);
  OSVERSIONINFOW ov = {sizeof ov};
  if (auto f = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion")) f(&ov);
  out(L",\"windows\":\"%lu.%lu.%lu\"", ov.dwMajorVersion, ov.dwMinorVersion, ov.dwBuildNumber);
  DWORD type; std::vector<BYTE> v;
  out(L",\"installed\":%ls", readRaw(L"SOFTWARE\\Kilobuzz\\APO", L"Installed", type, v) ? L"true" : L"false");
  out(L",\"compat\":%ls", readRaw(AUDIO_KEY, L"DisableProtectedAudioDG", type, v) && v.size() >= 4 && *(DWORD *)v.data() == 1 ? L"true" : L"false");
  std::wstring dll = installDir() + L"\\KilobuzzAPO.dll";
  WIN32_FILE_ATTRIBUTE_DATA fa;
  out(L",\"dll\":\"%ls\",\"dllSize\":%lu", jsonEsc(dll).c_str(), GetFileAttributesExW(dll.c_str(), GetFileExInfoStandard, &fa) ? fa.nFileSizeLow : 0);
  std::wstring cls = std::wstring(L"SOFTWARE\\Classes\\CLSID\\") + CLSID_STR + L"\\InprocServer32";
  out(L",\"inproc\":\"%ls\",\"threading\":\"%ls\"", jsonEsc(regStr(HKEY_LOCAL_MACHINE, cls, nullptr)).c_str(), jsonEsc(regStr(HKEY_LOCAL_MACHINE, cls, L"ThreadingModel")).c_str());
  out(L",\"apoReg\":");
  dumpKey(std::wstring(L"SOFTWARE\\Classes\\AudioEngine\\AudioProcessingObjects\\") + CLSID_STR);
  out(L",\"wrap\":");
  dumpKey(L"SOFTWARE\\Kilobuzz\\APO\\Wrap");
  enablePrivilege(SE_DEBUG_NAME);  // чтобы увидеть модули процесса звуковой системы
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  selfTest();
  audiodgModules();
  out(L",\"devices\":[");
  int n = 0;
  for (const auto &e : renderEndpoints()) {
    out(L"%ls{\"name\":\"%ls\",\"guid\":\"%ls\",\"fx\":", n++ ? L"," : L"", jsonEsc(e.name).c_str(), e.guid.c_str());
    dumpKey(RENDER + e.guid + L"\\FxProperties");
    std::wstring props = RENDER + e.guid + L"\\Properties";
    out(L",\"sysfxDisabled\":%ls,\"driver\":\"%ls\"}", readRaw(props, DISABLE_SYSFX, type, v) && v.size() >= 4 && *(DWORD *)v.data() == 1 ? L"true" : L"false",
        jsonEsc(regStr(HKEY_LOCAL_MACHINE, props, L"{a8b865dd-2e3d-4094-ad97-e593a70c75d6},5")).c_str());
  }
  out(L"]");
  std::wstring log = readLog();
  out(L",\"log\":\"%ls\"}\n", jsonEsc(log).c_str());
  g_buf = nullptr;
  // файл в UTF-8
  int len = WideCharToMultiByte(CP_UTF8, 0, buf.c_str(), (int)buf.size(), nullptr, 0, nullptr, nullptr);
  std::string u(len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, buf.c_str(), (int)buf.size(), &u[0], len, nullptr, nullptr);
  FILE *o = _wfopen(file.c_str(), L"wb");
  if (!o) return 1;
  fwrite(u.data(), 1, u.size(), o);
  fclose(o);
  return 0;
}

static int status() {
  DWORD type;
  std::vector<BYTE> data;
  bool installed = readRaw(L"SOFTWARE\\Kilobuzz\\APO", L"Installed", type, data);
  out(L"{\"installed\":%ls,\"devices\":[", installed ? L"true" : L"false");
  auto eps = renderEndpoints();
  int n = 0;
  for (const auto &e : eps) {
    std::vector<BYTE> v;
    bool active = false;
    for (const wchar_t *k : {K_GFX, K_MFX, K_EFX})
      if (readRaw(RENDER + e.guid + L"\\FxProperties", k, type, v) && v.size() > 2 && _wcsnicmp((const wchar_t *)v.data(), CLSID_STR, wcslen(CLSID_STR)) == 0) active = true;
    out(L"%s{\"guid\":\"%ls\",\"name\":\"%ls\",\"active\":%ls}", n++ ? L"," : L"", e.guid.c_str(), e.name.c_str(), active ? L"true" : L"false");
  }
  out(L"]}\n");
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  _setmode(_fileno(stdout), _O_U8TEXT);  // названия устройств бывают на кириллице
  std::wstring cmd = argc > 1 ? argv[1] : L"status";
  if (cmd == L"install") return install();
  if (cmd == L"uninstall") { compat(false); return uninstall(); }
  if (cmd == L"compat") return compat(true);
  if (cmd == L"diag") return diag();
  if (cmd == L"diagfull") return diagFull(argc > 2 ? argv[2] : dataDir() + L"\\diag-full.json");
  return status();
}
