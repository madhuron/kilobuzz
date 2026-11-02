// Обработка Kilobuzz на C++ — порт звукового движка приложения (src/renderer/js/audio/*)
// для работы внутри звуковой системы Windows (APO). Параметры вычисляет приложение и передаёт
// вектором (см. shared.h); здесь — только сама обработка, без анализа.
// Файл переносимый: собирается и на macOS для сверки с JS-версией (scripts/apo-parity).
#pragma once
#include <math.h>
#include <cmath>
#include <string.h>
#include <stdint.h>
#include <vector>
#include "shared.h"
#include "stems.h"

namespace kb {

const double PI = 3.14159265358979323846;

inline float db2lin(float d) { return expf(d * 0.11512925464970229f); }
inline float lin2db(float l) { return 8.685889638065035f * logf(l > 1e-9f ? l : 1e-9f); }
inline float pow2db(float p) { return 4.3429448190325175f * logf(p + 1e-12f); }
inline float coefMs(float ms, float rate) { return expf(-1.f / (fmaxf(ms, 0.01f) * 0.001f * rate)); }
inline float onePole(float hz, float sr) { return 1.f - expf(-2.f * 3.14159265f * hz / sr); }
inline float sat(float x) { if (x > 3) return 1; if (x < -3) return -1; float x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); }
const int CR = 8;

// ---------- биквад (RBJ, как BiquadFilterNode в Web Audio) ----------
enum BqType { BQ_PEAK = 0, BQ_LOWSHELF = 1, BQ_HIGHSHELF = 2, BQ_LOWPASS = 3, BQ_HIGHPASS = 4 };
struct Biquad {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  double z1[2] = {0, 0}, z2[2] = {0, 0};
  int type = -1; float f = -1, g = -999, q = -1, sr = 0;
  void set(int t, float freq, float gain, float Q, float rate) {
    if (t == type && freq == f && gain == g && Q == q && rate == sr) return;
    type = t; f = freq; g = gain; q = Q; sr = rate;
    freq = fminf(fmaxf(freq, 10.f), rate * 0.49f);
    double A = pow(10.0, gain / 40.0), w0 = 2 * PI * freq / rate, cw = cos(w0), sw = sin(w0);
    double B0, B1, B2, A0, A1, A2;
    if (t == BQ_PEAK) {
      double al = sw / (2 * fmax(Q, 0.01));
      B0 = 1 + al * A; B1 = -2 * cw; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * cw; A2 = 1 - al / A;
    } else if (t == BQ_LOWSHELF || t == BQ_HIGHSHELF) {
      // Web Audio: наклон S = 1
      double al = sw / 2 * sqrt((A + 1 / A) * (1 / 1.0 - 1) + 2), sA = 2 * sqrt(A) * al, s = t == BQ_LOWSHELF ? 1 : -1;
      B0 = A * ((A + 1) - s * (A - 1) * cw + sA);
      B1 = s * 2 * A * ((A - 1) - s * (A + 1) * cw);
      B2 = A * ((A + 1) - s * (A - 1) * cw - sA);
      A0 = (A + 1) + s * (A - 1) * cw + sA;
      A1 = -s * 2 * ((A - 1) + s * (A + 1) * cw);
      A2 = (A + 1) + s * (A - 1) * cw - sA;
    } else {
      double al = sw / (2 * fmax(Q, 0.01));
      if (t == BQ_LOWPASS) { B0 = (1 - cw) / 2; B1 = 1 - cw; B2 = (1 - cw) / 2; }
      else { B0 = (1 + cw) / 2; B1 = -(1 + cw); B2 = (1 + cw) / 2; }
      A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al;
    }
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  }
  inline float run(int c, float x) {
    double y = b0 * x + z1[c];
    z1[c] = b1 * x - a1 * y + z2[c];
    z2[c] = b2 * x - a2 * y;
    return (float)y;
  }
  bool flat() const { return type == BQ_PEAK || type == BQ_LOWSHELF || type == BQ_HIGHSHELF ? fabsf(g) < 1e-3f : false; }
};

// ---------- линия задержки ----------
struct Delay {
  std::vector<float> b; size_t w = 0;
  void init(size_t n) { b.assign(n + 2, 0.f); w = 0; }
  inline void push(float x) { b[w] = x; if (++w >= b.size()) w = 0; }
  inline float tap(float samples) const {  // дробная задержка, линейная интерполяция
    float d = fminf(fmaxf(samples, 1.f), (float)b.size() - 2);
    float r = (float)w - d; while (r < 0) r += (float)b.size();
    size_t i = (size_t)r; float fr = r - i; size_t j = i + 1 >= b.size() ? 0 : i + 1;
    return b[i] * (1 - fr) + b[j] * fr;
  }
};

// ---------- Freeverb (алгоритмическая реверберация) ----------
struct Freeverb {
  struct Comb { std::vector<float> b; size_t i = 0; float st = 0;
    inline float run(float x, float fb, float d1, float d2) { float o = b[i]; st = o * d2 + st * d1; b[i] = x + st * fb; if (++i >= b.size()) i = 0; return o; } };
  struct AP { std::vector<float> b; size_t i = 0;
    inline float run(float x) { float bo = b[i]; float o = -x + bo; b[i] = x + bo * 0.5f; if (++i >= b.size()) i = 0; return o; } };
  Comb cL[8], cR[8]; AP aL[4], aR[4]; Delay pre;
  float fb = 0.84f, d1 = 0.2f, d2 = 0.8f, preSamples = 0;
  void init(float sr, float room, float damp, float predelayMs) {
    static const int ct[8] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617}, at[4] = {556, 441, 341, 225};
    float k = sr / 44100.f;
    for (int i = 0; i < 8; i++) { cL[i].b.assign((size_t)(ct[i] * k), 0.f); cR[i].b.assign((size_t)((ct[i] + 23) * k), 0.f); }
    for (int i = 0; i < 4; i++) { aL[i].b.assign((size_t)(at[i] * k), 0.f); aR[i].b.assign((size_t)((at[i] + 23) * k), 0.f); }
    fb = room * 0.28f + 0.7f; d1 = damp * 0.4f; d2 = 1 - d1;
    preSamples = predelayMs * 0.001f * sr;
    pre.init((size_t)preSamples + 4);
  }
  inline void run(float in, float &oL, float &oR) {
    pre.push(in);
    float x = pre.tap(fmaxf(preSamples, 1.f)) * 0.015f;
    float l = 0, r = 0;
    for (int i = 0; i < 8; i++) { l += cL[i].run(x, fb, d1, d2); r += cR[i].run(x, fb, d1, d2); }
    for (int i = 0; i < 4; i++) { l = aL[i].run(l); r = aR[i].run(r); }
    oL = l * 3.f; oR = r * 3.f;
  }
};

// ---------- вся цепочка ----------
struct Chain {
  float sr = 48000;
  float p[P_COUNT];
  // фильтры
  Biquad corr[16], eq[10], res[4];
  float corrLin = 1, preLin = 1, hrLin = 1;  // hrLin — постоянный запас (P_HEADROOM), плавно
  // «Красочность»
  float enS[2][8] = {}; float enCur[4] = {0, 0, 0, 0};
  float puLp = 0, puF = 0, puS = 0, puG = 1;  // «Ударные»: детектор атаки (общий для каналов)
  Stems stems;  // разбор на дорожки: кик / бас / остальное
  // умная динамика
  double smQ[2][4] = {}; float smG[4] = {}, smLin[4] = {1, 1, 1, 1}, smHarm = 0, smPk = 0;
  // де-эссер
  float deLp[2] = {}, deZ1 = 0, deZ2 = 0, deS = 0, deF = 0, deG = 0, deHg = 1;
  // компрессор
  float cEnv = 0, cGf = 0, cGs = 0, cLin = 1, cAvg = 0, cElapsed = 0, cHpL = 0, cHpR = 0;
  // ширина
  float wW = 1, wSlp = 0;
  // сцена
  Delay xsD; Biquad xsLp, rfLp[2], rfHp[2], amHp, amLp, spHp, spLp; Delay eLd, eRd;
  Freeverb ambShort, ambLong;
  // пространство
  Biquad spSendHp[2], spSendLp[2], revLp[3][2];
  Freeverb rev[3]; Delay dL, dR; Biquad dLlp, dRlp; float dRout = 0;
  float dkEnv = 0, dkRef = 0, dkG = 1;  // ducking пространства: огибающая сухого звука и её средний уровень
  // автогромкость, лимитер
  float agLin = 1;
  int limN = 240; std::vector<float> limBufL, limBufR, dqV; std::vector<double> dqI; size_t limPos = 0, dqCap = 0; uint64_t dqHead = 0, dqTail = 0, limIdx = 0; float limG = 1;
  float llS[2][2] = {}; std::vector<float> llBuf[4], llV; std::vector<double> llI; size_t llPos = 0; uint64_t llHead = 0, llTail = 0, llIdx = 0; float llG = 1, llMin = 1;  // ограничитель низа
  // индикаторы
  float mComp = 0, mDeess = 0, mLim = 0, mPeak = 0;

  void init(float rate) {
    sr = rate;
    memset(p, 0, sizeof(p));
    p[P_SMART_AMOUNT] = 0; p[P_WIDTH] = 1; p[P_LIM_CEIL] = -1; p[P_DLY_MS] = 250; p[P_COMP_RATIO] = 1;
    for (auto &b : corr) b.set(BQ_PEAK, 1000, 0, 1, sr);
    static const float ef[10] = {32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};
    for (int i = 0; i < 10; i++) eq[i].set(i == 0 ? BQ_LOWSHELF : i == 9 ? BQ_HIGHSHELF : BQ_PEAK, ef[i], 0, 1.1f, sr);
    for (auto &b : res) b.set(BQ_PEAK, 1000, 0, 4, sr);
    xsD.init((size_t)(0.001f * sr) + 8); xsLp.set(BQ_LOWPASS, 700, 0, 0.5f, sr);
    for (int c = 0; c < 2; c++) { rfLp[c].set(BQ_LOWPASS, 5500, 0, 0.5f, sr); rfHp[c].set(BQ_HIGHPASS, 150, 0, 0.5f, sr); }
    eLd.init((size_t)(0.03f * sr)); eRd.init((size_t)(0.03f * sr));
    amHp.set(BQ_HIGHPASS, 200, 0, 0.5f, sr); amLp.set(BQ_LOWPASS, 7000, 0, 0.5f, sr);
    spHp.set(BQ_HIGHPASS, 250, 0, 0.5f, sr); spLp.set(BQ_LOWPASS, 6000, 0, 0.5f, sr);
    ambShort.init(sr, 0.6f, 0.5f, 12); ambLong.init(sr, 0.8f, 0.45f, 22);
    for (int c = 0; c < 2; c++) { spSendHp[c].set(BQ_HIGHPASS, 250, 0, 0.5f, sr); spSendLp[c].set(BQ_LOWPASS, 8000, 0, 0.5f, sr); }
    rev[0].init(sr, 0.55f, 0.5f, 8); rev[1].init(sr, 0.84f, 0.4f, 25); rev[2].init(sr, 0.93f, 0.25f, 60);
    static const float damp[3] = {7000, 6000, 4500};
    for (int k = 0; k < 3; k++) for (int c = 0; c < 2; c++) revLp[k][c].set(BQ_LOWPASS, damp[k], 0, 0.5f, sr);
    dL.init((size_t)(2.1f * sr)); dR.init((size_t)(2.1f * sr)); dLlp.set(BQ_LOWPASS, 5000, 0, 0.5f, sr); dRlp.set(BQ_LOWPASS, 4500, 0, 0.5f, sr);
    limN = (int)fmaxf(1, roundf(0.005f * sr));
    limBufL.assign(limN, 0.f); limBufR.assign(limN, 0.f); dqCap = limN + 4; dqV.assign(dqCap, 0.f); dqI.assign(dqCap, 0.0);
    stems.init(sr);
    for (auto &b : llBuf) b.assign(limN, 0.f); llV.assign(dqCap, 0.f); llI.assign(dqCap, 0.0);
  }

  void setParams(const float *src) {
    memcpy(p, src, sizeof(p));
    // «нечисло» в параметрах (сбой расчёта в приложении) иначе превратило бы весь звук в тишину
    for (int i = 0; i < P_COUNT; i++) if (!std::isfinite(p[i])) p[i] = 0;
    corrLin = db2lin(p[P_CORR_GAIN]);
    for (int i = 0; i < 16; i++) {
      const float *c = p + P_CORR + i * 4;
      corr[i].set(c[0] == 1 ? BQ_LOWSHELF : c[0] == 2 ? BQ_HIGHSHELF : BQ_PEAK, c[1] > 0 ? c[1] : 1000, c[2], c[3] > 0 ? c[3] : 1, sr);
    }
    preLin = db2lin(p[P_PREAMP]);
    for (int i = 0; i < 10; i++) eq[i].set(eq[i].type, eq[i].f, p[P_EQ + i], 1.1f, sr);
    for (int i = 0; i < 4; i++) { const float *r = p + P_RES + i * 3; res[i].set(BQ_PEAK, r[0] > 0 ? r[0] : 1000, r[1], r[2] > 0 ? r[2] : 4, sr); }
  }

  // ---- блоки (порт worklets.js) ----
  void enhancer(float *L, float *R, int n) {
    const bool off = p[P_ENH_BYPASS] != 0;
    float tb = off ? 0 : p[P_ENH_BASS], ta = off ? 0 : p[P_ENH_AIR], tw = off ? 0 : p[P_ENH_WARM], tp = off ? 0 : p[P_ENH_PUNCH];
    if (tb == 0 && ta == 0 && tw == 0 && tp == 0 && enCur[0] < 1e-3f && enCur[1] < 1e-3f && enCur[2] < 1e-3f && enCur[3] < 1e-3f) return;
    const float aLo = onePole(110, sr), aHb = onePole(160, sr), aHi = onePole(3500, sr), aHx = onePole(6000, sr), aDc = onePole(12, sr), b0 = sat(0.25f);
    const float pLp = onePole(2500, sr), fA = 1 - coefMs(1, sr), sA = 1 - coefMs(30, sr), rel = 1 - coefMs(120, sr), gA = 1 - coefMs(3, sr);
    float db = (tb - enCur[0]) / n, da = (ta - enCur[1]) / n, dw = (tw - enCur[2]) / n, dp = (tp - enCur[3]) / n;
    float kb = enCur[0], ka = enCur[1], kw = enCur[2], kp = enCur[3];
    for (int i = 0; i < n; i++) {
      kb += db; ka += da; kw += dw; kp += dp;
      // «Ударные»: огибающие мощности (быстрая против медленной, общий спад) → усиление только на атаке
      puLp += pLp * ((L[i] + R[i]) * 0.5f - puLp);
      float a = puLp * puLp;
      puF += (a > puF ? fA : rel) * (a - puF);
      puS += (a > puS ? sA : rel) * (a - puS);
      float tr = fminf(1, fmaxf(0, (puF / (puS + 1e-9f) - 1.5f) / 3));
      puG += gA * (1 + kp * 0.6f * tr - puG);
      for (int c = 0; c < 2; c++) {
        float *x = c ? R : L, *s = enS[c];
        float v = x[i];
        s[0] += aLo * (v - s[0]); s[1] += aLo * (s[0] - s[1]);
        float h = sat(s[1] * 4) * 0.25f - s[1]; s[2] += aHb * (h - s[2]); float bassH = h - s[2];
        s[3] += aHi * (v - s[3]); float hi = v - s[3];
        float e = sat(hi * 3) * 0.33f - hi; s[4] += aHx * (e - s[4]); float airH = e - s[4];
        float t = (sat(v * 1.1f + 0.25f) - b0) / 1.1f - v; s[6] += aDc * (t - s[6]); float warmH = t - s[6];
        x[i] = v * puG + kb * bassH * 1.2f + ka * airH * 0.7f + kw * warmH * 0.9f;
      }
    }
    enCur[0] = tb; enCur[1] = ta; enCur[2] = tw; enCur[3] = tp;
  }

  void smart(float *L, float *R, int n) {
    if (p[P_SMART_BYPASS] || p[P_SMART_AMOUNT] <= 0) { for (int k = 0; k < 4; k++) { smG[k] = 0; smLin[k] = 1; } smHarm = 0; return; }
    const float a1 = onePole(120, sr), a2 = onePole(500, sr), a3 = onePole(4000, sr), aH = onePole(150, sr);
    const float crr = sr / CR, aAtt = coefMs(20, crr), aRel = coefMs(300, crr), aPk = coefMs(80, crr);
    for (int i0 = 0; i0 < n; i0 += CR) {
      const int len = n - i0 < CR ? n - i0 : CR;
      float lowPk = 0;
      for (int i = i0; i < i0 + len; i++) { float v = fabsf((float)(smQ[0][0] + a1 * (L[i] - smQ[0][0]))); if (v > lowPk) lowPk = v; }
      smPk = lowPk > smPk ? lowPk : aPk * smPk + (1 - aPk) * lowPk;
      for (int k = 0; k < 4; k++) {
        float target = p[P_SMART_GAINS + k];
        if (k == 0) { float over = lin2db(smPk) - p[P_SMART_BASSLIMIT]; if (over > 0) target = fminf(target, -fminf(8, over * 0.8f) * p[P_SMART_AMOUNT]); }
        smG[k] = target < smG[k] ? aAtt * smG[k] + (1 - aAtt) * target : aRel * smG[k] + (1 - aRel) * target;
        if (fabsf(smG[k]) < 1e-3f) smG[k] = 0;
      }
      float harmT = smG[0] < 0 ? fminf(1, -smG[0] / 6) * 1.2f : 0;
      float nl[4], d[4]; for (int k = 0; k < 4; k++) { nl[k] = db2lin(smG[k]); d[k] = (nl[k] - smLin[k]) / len; }
      float dh = (harmT - smHarm) / len;
      for (int c = 0; c < 2; c++) {
        float *x = c ? R : L; double *q = smQ[c];
        for (int m = 1, i = i0; i < i0 + len; i++, m++) {
          double v = x[i];
          q[0] += a1 * (v - q[0]); double b1 = q[0], r1 = v - b1;
          q[1] += a2 * (r1 - q[1]); double b2 = q[1], r2 = r1 - b2;
          q[2] += a3 * (r2 - q[2]); double b3 = q[2], b4 = r2 - b3;
          double h = sat((float)b1 * 4) * 0.25 - b1; q[3] += aH * (h - q[3]);
          x[i] = (float)(b1 * (smLin[0] + d[0] * m) + b2 * (smLin[1] + d[1] * m) + b3 * (smLin[2] + d[2] * m) + b4 * (smLin[3] + d[3] * m) + (h - q[3]) * (smHarm + dh * m));
        }
      }
      for (int k = 0; k < 4; k++) smLin[k] = nl[k];
      smHarm = harmT;
    }
  }

  void deesser(float *L, float *R, int n) {
    if (p[P_DEESS_BYPASS]) { deG = 0; deHg = 1; mDeess = 0; return; }
    const float aS = onePole(5000, sr), crr = sr / CR, aE = coefMs(4, sr), aAtt = coefMs(2, crr), aRel = coefMs(80, crr);
    double w0 = 2 * PI * fmin(6500, sr * 0.45) / sr, al = sin(w0) / 2.4, a0 = 1 + al;
    const float b0 = al / a0, b2 = -al / a0, a1 = -2 * cos(w0) / a0, a2 = (1 - al) / a0;
    float maxGr = 0;
    for (int i0 = 0; i0 < n; i0 += CR) {
      const int len = n - i0 < CR ? n - i0 : CR;
      for (int i = i0; i < i0 + len; i++) {
        float m = (L[i] + R[i]) * 0.5f, y = b0 * m + deZ1;
        deZ1 = -a1 * y + deZ2; deZ2 = b2 * m - a2 * y;
        deS = aE * deS + (1 - aE) * y * y; deF = aE * deF + (1 - aE) * m * m;
      }
      float target = 0;
      if (deF > 1e-7f) { float over = pow2db(deS) - pow2db(deF) - p[P_DEESS_THR]; if (over > 0) target = -fminf(p[P_DEESS_MAXRED], over * 1.5f); }
      deG = target < deG ? aAtt * deG + (1 - aAtt) * target : aRel * deG + (1 - aRel) * target;
      if (deG > -1e-4f) deG = 0;
      float nx = db2lin(deG), st = (nx - deHg) / len;
      for (int i = i0; i < i0 + len; i++) {
        deHg += st;
        deLp[0] += aS * (L[i] - deLp[0]); deLp[1] += aS * (R[i] - deLp[1]);
        L[i] = deLp[0] + (L[i] - deLp[0]) * deHg; R[i] = deLp[1] + (R[i] - deLp[1]) * deHg;
      }
      if (-deG > maxGr) maxGr = -deG;
    }
    mDeess = maxGr;
  }

  void compressor(float *L, float *R, int n) {
    float mix = p[P_COMP_MIX];
    if (p[P_COMP_BYPASS] || mix <= 0) { cGf = cGs = 0; cLin = 1; mComp = 0; return; }
    const float crr = sr / CR, aA = coefMs(p[P_COMP_ATTACK], crr), aRf = coefMs(p[P_COMP_RELEASE], crr), aRs = coefMs(p[P_COMP_RELEASE] * 5, crr), aD = coefMs(10, sr), aSc = onePole(150, sr);
    const float T = p[P_COMP_THR], K = fmaxf(p[P_COMP_KNEE], 0.01f), slope = 1 / fmaxf(p[P_COMP_RATIO], 1) - 1;
    float maxGr = 0;
    for (int i0 = 0; i0 < n; i0 += CR) {
      const int len = n - i0 < CR ? n - i0 : CR;
      // детектор без низа (ФВЧ 150 Гц): бас и кик не «качают» весь микс и не съедают свою атаку
      for (int i = i0; i < i0 + len; i++) {
        cHpL += aSc * (L[i] - cHpL); cHpR += aSc * (R[i] - cHpR);
        float l = L[i] - cHpL, r = R[i] - cHpR, s = fmaxf(l * l, r * r);
        cEnv = aD * cEnv + (1 - aD) * s;
      }
      float over = pow2db(cEnv) - T, y;
      if (2 * over < -K) y = 0; else if (2 * over > K) y = slope * over; else { float q = over + K / 2; y = slope * q * q / (2 * K); }
      cGf = y < cGf ? aA * cGf + (1 - aA) * y : aRf * cGf + (1 - aRf) * y;
      cGs = y < cGs ? aA * cGs + (1 - aA) * y * 0.6f : aRs * cGs + (1 - aRs) * y;
      float g = fminf(cGf, cGs);
      cElapsed += (float)len / sr;
      float aAvg = expf(-1.f / (fminf(15.f, 1 + cElapsed) * crr));
      cAvg = aAvg * cAvg + (1 - aAvg) * g;
      float nx = mix * db2lin(g - cAvg * 0.85f) + (1 - mix), st = (nx - cLin) / len;
      for (int i = i0; i < i0 + len; i++) { cLin += st; L[i] *= cLin; R[i] *= cLin; }
      if (-g > maxGr) maxGr = -g;
    }
    if (cGf > -1e-4f) cGf = 0;
    if (cGs > -1e-4f) cGs = 0;
    mComp = maxGr * mix;
  }

  void width(float *L, float *R, int n) {
    float target = p[P_WIDTH_BYPASS] ? 1 : p[P_WIDTH];
    const float aLp = onePole(150, sr);
    for (int i = 0; i < n; i++) {
      wW += (target - wW) * 0.0004f;
      float m = (L[i] + R[i]) * 0.5f, s = (L[i] - R[i]) * 0.5f;
      wSlp += aLp * (s - wSlp);
      float so = wSlp * (wW < 1 ? wW : 1) + (s - wSlp) * wW;
      L[i] = m + so; R[i] = m - so;
    }
  }

  // сцена: кроссфид и отражения из боковой составляющей + «комната» + расширение для колонок
  void stage(float *L, float *R, int n) {
    float xf = p[P_XFEED], rf = p[P_REFL], as = p[P_AMB_SHORT], al = p[P_AMB_LONG], spr = p[P_SPREAD];
    if (xf < 1e-4f && rf < 1e-4f && as < 1e-4f && al < 1e-4f && spr < 1e-4f) return;
    const float ms = sr * 0.001f;
    static const float tL[4][3] = {{0, 7.3f, 0.2f}, {1, 11.1f, 0.15f}, {0, 16.7f, 0.11f}, {1, 23.9f, 0.08f}};
    static const float tR[4][3] = {{1, 8.1f, 0.2f}, {0, 12.4f, 0.15f}, {1, 17.9f, 0.11f}, {0, 25.3f, 0.08f}};
    for (int i = 0; i < n; i++) {
      float l = L[i], r = R[i], M = (l + r) * 0.5f, S = (l - r) * 0.5f;
      xsD.push(S);
      float xs = xsLp.run(0, xsD.tap(0.25f * ms));
      float eL = S + 0.3f * M, eR = -S + 0.3f * M;
      eLd.push(eL); eRd.push(eR);
      float rl = 0, rr = 0;
      for (int k = 0; k < 4; k++) { rl += (tL[k][0] ? eRd : eLd).tap(tL[k][1] * ms) * tL[k][2]; rr += (tR[k][0] ? eRd : eLd).tap(tR[k][1] * ms) * tR[k][2]; }
      rl = rfHp[0].run(0, rfLp[0].run(0, rl)); rr = rfHp[1].run(0, rfLp[1].run(0, rr));
      float amb = amLp.run(0, amHp.run(0, S + 0.25f * M)), aL1 = 0, aR1 = 0, aL2 = 0, aR2 = 0;
      if (as > 1e-4f) ambShort.run(amb, aL1, aR1);
      if (al > 1e-4f) ambLong.run(amb, aL2, aR2);
      float sp = spLp.run(0, spHp.run(0, S)) * spr;
      L[i] = l - xs * xf + rl * rf + aL1 * as + aL2 * al + sp;
      R[i] = r + xs * xf + rr * rf + aR1 * as + aR2 * al - sp;
    }
  }

  void space(float *L, float *R, int n) {
    float g[3] = {p[P_REV_ROOM], p[P_REV_HALL], p[P_REV_STADIUM]}, ds = p[P_DLY_SEND], fb = fminf(0.8f, p[P_DLY_FB]);
    if (g[0] < 1e-4f && g[1] < 1e-4f && g[2] < 1e-4f && ds < 1e-4f) return;
    float dSamp = fmaxf(1.f, p[P_DLY_MS] * 0.001f * sr);
    const float dkAtt = 1 - coefMs(5, sr), dkRel = 1 - coefMs(250, sr), dkAvg = 1 - coefMs(2000, sr);
    for (int i = 0; i < n; i++) {
      float sl = spSendLp[0].run(0, spSendHp[0].run(0, L[i])), sr2 = spSendLp[1].run(0, spSendHp[1].run(0, R[i]));
      float mono = (sl + sr2) * 0.5f, oL = 0, oR = 0;
      // ducking: пока звучит музыка (удары, вокал), хвосты тише; в паузах проявляются — объём без каши
      float dry = 0.5f * fabsf(L[i] + R[i]);
      dkEnv += (dry > dkEnv ? dkAtt : dkRel) * (dry - dkEnv);
      dkRef += dkAvg * (dkEnv - dkRef);
      float over = fminf(1.f, fmaxf(0.f, (dkEnv / (dkRef + 1e-6f) - 0.6f) / 1.2f));
      dkG += 0.002f * (db2lin(-12.f * p[P_SPACE_DUCK] * over) - dkG);
      for (int k = 0; k < 3; k++) if (g[k] > 1e-4f) { float a, b; rev[k].run(mono, a, b); oL += revLp[k][0].run(0, a) * g[k]; oR += revLp[k][1].run(0, b) * g[k]; }
      // пинг-понг: левый → правый → обратно в левый
      float inL = mono * ds + dRout * fb;
      dL.push(inL);
      float outL = dLlp.run(0, dL.tap(dSamp));
      dR.push(outL);
      dRout = dRlp.run(0, dR.tap(dSamp));
      L[i] += (oL + outL) * dkG; R[i] += (oR + dRout) * dkG;
    }
  }

  // Ограничитель низа: если пик создают кик и бас, приглушается только низ (ниже ~400 Гц: кик звучит до 100–200 Гц, иначе его атака уходит в «верх»), а вокал,
  // инструменты и верх не трогаются. Общий лимитер после него почти не работает — нет «качания»
  // всей музыки на каждом ударе. Полосы делятся комплементарно (низ + остальное = исходник).
  void lowLimiter(float *L, float *R, int n) {
    if (p[P_LIM_BYPASS]) return;
    const float ceil = db2lin(p[P_LIM_CEIL]), gMin = db2lin(-6), a = onePole(400, sr), aAtt = 1 - expf(-4.f / limN), aRel = coefMs(15, sr);  // быстро отпускает: срезается вершина удара, а не бас после него
    for (int i = 0; i < n; i++, llIdx++) {
      float x[2] = {L[i], R[i]}, lo[2], hi[2], t = 1;
      for (int c = 0; c < 2; c++) {
        llS[c][0] += a * (x[c] - llS[c][0]); llS[c][1] += a * (llS[c][0] - llS[c][1]);
        lo[c] = llS[c][1]; hi[c] = x[c] - lo[c];
        float s = x[c];
        // сколько нужно убрать низа, чтобы сумма не вышла за потолок (только если низ толкает в ту же сторону)
        if (fabsf(s) > ceil && lo[c] * s > 0) t = fminf(t, fmaxf(gMin, (copysignf(ceil, s) - hi[c]) / lo[c]));
      }
      while (llTail > llHead && llV[(llTail - 1) % dqCap] >= t) llTail--;
      llV[llTail % dqCap] = t; llI[llTail % dqCap] = (double)llIdx; llTail++;
      while (llI[llHead % dqCap] <= (double)llIdx - (limN + 1)) llHead++;
      float m = llV[llHead % dqCap];
      llG += m < llG ? (m - llG) * aAtt : (m - llG) * (1 - aRel);
      float dh0 = llBuf[0][llPos], dh1 = llBuf[1][llPos], dl0 = llBuf[2][llPos], dl1 = llBuf[3][llPos];
      llBuf[0][llPos] = hi[0]; llBuf[1][llPos] = hi[1]; llBuf[2][llPos] = lo[0]; llBuf[3][llPos] = lo[1];
      llPos = llPos + 1 == (size_t)limN ? 0 : llPos + 1;
      L[i] = dh0 + dl0 * llG; R[i] = dh1 + dl1 * llG;
      if (llG < llMin) llMin = llG;
    }
  }

  void limiter(float *L, float *R, int n) {
    float ceil = db2lin(p[P_LIM_CEIL]), peak = 0;
    if (p[P_LIM_BYPASS]) { for (int i = 0; i < n; i++) peak = fmaxf(peak, fmaxf(fabsf(L[i]), fabsf(R[i]))); mPeak = peak; mLim = 0; return; }
    float drive = db2lin(p[P_LIM_DRIVE]), aAtt = 1 - expf(-4.f / limN), aRel = coefMs(120, sr), minG = 1;
    for (int i = 0; i < n; i++, limIdx++) {
      float l = L[i] * drive, r = R[i] * drive, a = fmaxf(fabsf(l), fabsf(r)), t = a > ceil ? ceil / a : 1;
      while (dqTail > dqHead && dqV[(dqTail - 1) % dqCap] >= t) dqTail--;
      dqV[dqTail % dqCap] = t; dqI[dqTail % dqCap] = (double)limIdx; dqTail++;
      while (dqI[dqHead % dqCap] <= (double)limIdx - (limN + 1)) dqHead++;
      float m = dqV[dqHead % dqCap];
      limG += m < limG ? (m - limG) * aAtt : (m - limG) * (1 - aRel);
      float dl = limBufL[limPos], dr = limBufR[limPos];
      limBufL[limPos] = l; limBufR[limPos] = r; limPos = limPos + 1 == (size_t)limN ? 0 : limPos + 1;
      float ol = fminf(ceil, fmaxf(-ceil, dl * limG)), orr = fminf(ceil, fmaxf(-ceil, dr * limG));
      L[i] = ol; R[i] = orr;
      if (limG < minG) minG = limG;
      peak = fmaxf(peak, fmaxf(fabsf(ol), fabsf(orr)));
    }
    mLim = -lin2db(minG); mPeak = peak;
  }

  /** Обработка стерео-блока на месте. */
  void process(float *L, float *R, int n) {
    // Запас действует и при «Эффекты выкл»: громкость оригинала и обработки одинаковая, сравнение честное
    const float hrT = db2lin(-p[P_HEADROOM]);
    if (p[P_BYPASS]) {
      for (int i = 0; i < n; i++) { hrLin += (hrT - hrLin) * 0.0005f; L[i] *= hrLin; R[i] *= hrLin; }
      return;
    }
    for (int i = 0; i < n; i++) {
      hrLin += (hrT - hrLin) * 0.0005f;
      float l = L[i] * hrLin * corrLin, r = R[i] * hrLin * corrLin;
      for (auto &b : corr) if (!b.flat()) { l = b.run(0, l); r = b.run(1, r); }
      l *= preLin; r *= preLin;
      for (auto &b : eq) if (!b.flat()) { l = b.run(0, l); r = b.run(1, r); }
      for (auto &b : res) if (!b.flat()) { l = b.run(0, l); r = b.run(1, r); }
      L[i] = l; R[i] = r;
    }
    stems.process(L, R, n, p + P_STEMS);  // всегда: постоянная задержка, без параметров — ровно оригинал
    enhancer(L, R, n);
    smart(L, R, n);
    deesser(L, R, n);
    compressor(L, R, n);
    width(L, R, n);
    stage(L, R, n);
    space(L, R, n);
    float tg = db2lin(p[P_AUTOGAIN]);
    for (int i = 0; i < n; i++) { agLin += (tg - agLin) * 0.0005f; L[i] *= agLin; R[i] *= agLin; }
    lowLimiter(L, R, n);
    limiter(L, R, n);
  }
};

}  // namespace kb
