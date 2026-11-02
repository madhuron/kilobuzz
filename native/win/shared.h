// Общая память между Kilobuzz APO (внутри audiodg.exe) и приложением (через kilobuzz-link.exe).
//  - приложение → APO: вектор параметров обработки (двойной буфер, без блокировок);
//  - APO → приложение: копия звука ДО обработки (для анализа) и индикаторы.
// Раскладка вектора параметров должна совпадать с AudioEngine.snapshot() в src/renderer/js/audio/engine.js.
#pragma once
#include <stdint.h>

#define KB_SHARED_NAME L"Global\\KilobuzzApoShared"
#define KB_MAGIC 0x4B425A31u  // 'KBZ1'
#define KB_VERSION 6u
#define KB_RING_FRAMES 65536u  // ~1.4 с стерео при 48 кГц

enum KbParam {
  P_VERSION = 0,
  P_BYPASS = 1,
  P_CORR_GAIN = 2,
  P_CORR = 3,          // 16 × (type, f, gain, q); type: 0 колокол, 1 низкая полка, 2 высокая полка
  P_PREAMP = 67,
  P_EQ = 68,           // 10 полос: 32 (полка), 64…8000 (колокола), 16000 (полка); Q 1.1
  P_RES = 78,          // 4 × (f, gain, q) — вырезы анти-бочки
  P_ENH_BASS = 90, P_ENH_AIR = 91, P_ENH_WARM = 92, P_ENH_BYPASS = 93,
  P_SMART_GAINS = 94,  // 4 полосы, дБ
  P_SMART_AMOUNT = 98, P_SMART_BASSLIMIT = 99, P_SMART_BYPASS = 100,
  P_DEESS_THR = 101, P_DEESS_MAXRED = 102, P_DEESS_BYPASS = 103,
  P_COMP_THR = 104, P_COMP_RATIO = 105, P_COMP_ATTACK = 106, P_COMP_RELEASE = 107, P_COMP_MIX = 108, P_COMP_KNEE = 109, P_COMP_BYPASS = 110,
  P_WIDTH = 111, P_WIDTH_BYPASS = 112,
  P_XFEED = 113, P_REFL = 114, P_AMB_SHORT = 115, P_AMB_LONG = 116, P_SPREAD = 117,
  P_REV_ROOM = 118, P_REV_HALL = 119, P_REV_STADIUM = 120, P_DLY_SEND = 121, P_DLY_MS = 122, P_DLY_FB = 123,
  P_AUTOGAIN = 124,
  P_LIM_CEIL = 125, P_LIM_DRIVE = 126, P_LIM_BYPASS = 127,
  P_ENH_PUNCH = 128,   // «Ударные» (подчёркивание атаки), 0…1
  P_STEMS = 129,       // 7 параметров дорожек (stems.h): кик дБ, удар, бас дБ, протяжность, гармоники, уступка дБ, остальное дБ
  P_UNMASK = 136,      // снятие маскировки: [0] гасить выпирающее 0…1, [1] поднимать заглушённое 0…1 (идут сразу за P_STEMS)
  P_HEADROOM = 138,    // постоянный запас, дБ (≥ 0): звук тише на столько и с эффектами, и без — место для ударов
  P_RESTORE = 139,     // восстановление ударов на дорожке «остальное», 0…1
  P_COLOR = 140,       // окраска: тёплое насыщение дорожки «остальное» ниже ~4 кГц, 0…1
  P_SPACE_DUCK = 141,  // реверб и дилей приглушаются, пока звучит музыка (ducking), 0…1
  P_COUNT = 142
};

struct KbShared {
  uint32_t magic;
  uint32_t version;
  volatile uint32_t heartbeat;   // растёт при каждом блоке обработки — приложение видит, что APO жив
  volatile uint32_t sampleRate;
  volatile uint32_t channels;
  // параметры (пишет приложение)
  volatile uint32_t paramSeq;    // увеличивается после записи нового набора
  volatile uint32_t paramActive; // индекс актуального буфера (0/1)
  float params[2][P_COUNT];
  // индикаторы (пишет APO)
  volatile float meterComp, meterDeess, meterLimiter, meterPeak;
  volatile float meterBands[4];
  // кольцо звука до обработки, interleaved stereo float32 (пишет APO)
  volatile uint64_t ringWrite;   // счётчик записанных кадров
  float ring[KB_RING_FRAMES * 2];
};
