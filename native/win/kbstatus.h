// Состояние модуля в его собственной памяти. Звуковой процесс Windows может не иметь права
// ничего записать (ни файлы, ни журнал событий), поэтому диагностика с правами администратора
// читает эту структуру прямо из памяти audiodg.exe (экспорт KbStatus).
#pragma once
#include <windows.h>

#define KB_STATUS_MAGIC 0x5354424B  // 'KBTS'
#define KB_STATUS_LINES 12

struct KbStatus {
  DWORD magic;
  volatile LONG classObject, createInstance, initialize, lockForProcess, process;
  DWORD errLogFile, errTempFile, errEventLog;  // последние коды ошибок записи журнала (0 — успешно)
  DWORD errShmFile, errShmMap, errShmGlobal;   // общая память: файл, отображение файла, Global-имя
  DWORD shmOk;
  volatile LONG lineIdx;
  // последние запросы DllGetClassObject: какой класс и интерфейс просила Windows и что ответил модуль
  volatile LONG reqIdx;
  GUID reqClsid[4], reqRiid[4];
  HRESULT reqHr[4];
  char lines[KB_STATUS_LINES][240];            // последние сообщения модуля (кольцо)
  volatile LONG aggregated, refused;           // создано внутри объекта звуковой системы / отказов фабрики
  HRESULT lastCreateHr;                        // ответ последнего CreateInstance
  volatile LONG nanResets;                     // сколько раз обработка выдала «нечисло» и была сброшена (звук не пропадал)
};
