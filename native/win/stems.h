// Разбор музыки на дорожки на лету (без нейросетей) и обработка кика и баса по отдельности.
//
// Звук раскладывается в спектр (окно 2048, шаг 512, √Ханн). В низу (до ~260 Гц) каждая частота
// делится на две части по поведению во времени:
//   «удар» (кик)      — то, что выше своего недавнего уровня (медиана за ~130 мс): атака и тело кика;
//   «протяжное» (бас) — устойчивая часть: басовые ноты, 808, саб.
// Всё остальное (середина и верх целиком) — третья дорожка, она проходит без изменений.
// Маски в сумме дают 1, поэтому без обработки дорожки складываются ровно в оригинал
// (с задержкой N = 2048 отсчётов, ~43 мс при 48 кГц).
//
// Обработка (во времени, на собранных дорожках):
//   кик  — громкость и «удар» (подчёркивание атаки только на кике, бас не «пердит»);
//   бас  — громкость, «протяжность» (поднимает затухающий хвост ноты к её пику),
//          сатурация (мягкое насыщение только басовой дорожки — гармоники без хрипа и без лишних пиков),
//          и уступка кику: на мгновение удара бас чуть убирается, кик «садится» в микс.
// Порт: src/renderer/js/audio/worklets.js → StemsProcessor (держать одинаковыми).
#pragma once
#include <math.h>
#include <string.h>
#include <vector>

namespace kb {

struct StemFFT {
  int n = 0;
  std::vector<double> cs, sn;
  std::vector<int> rev;
  void init(int N) {
    n = N; cs.resize(N / 2); sn.resize(N / 2); rev.resize(N);
    for (int i = 0; i < N / 2; i++) { cs[i] = cos(2 * 3.14159265358979323846 * i / N); sn[i] = -sin(2 * 3.14159265358979323846 * i / N); }
    int bits = 0; while ((1 << bits) < N) bits++;
    for (int i = 0; i < N; i++) { int r = 0; for (int b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
  }
  // inverse: сопряжённые повороты; нормировка — снаружи
  void run(double *re, double *im, bool inverse) const {
    for (int i = 0; i < n; i++) { int j = rev[i]; if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (int len = 2; len <= n; len <<= 1) {
      int step = n / len, half = len / 2;
      for (int i = 0; i < n; i += len)
        for (int j = 0; j < half; j++) {
          double wr = cs[j * step], wi = inverse ? -sn[j * step] : sn[j * step];
          int a = i + j, b = a + half;
          double vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        }
    }
  }
};

struct Stems {
  static const int N = 2048, HOP = 512, HIST = 12, KMAX = 24;
  float sr = 48000;
  StemFFT fft;
  std::vector<double> win, re, im, sKre, sKim, sBre, sBim;
  std::vector<float> inL, inR;                 // входное окно (линейный FIFO)
  std::vector<float> acc[6];                   // накопители OLA: кик L/R, бас L/R, остальное L/R
  std::vector<float> out[6];                   // готовые отсчёты текущего шага
  float hist[HIST][KMAX + 1] = {};             // история уровней низких частот (для медианы)
  float wLow[KMAX + 1] = {};                   // доля «низа» на каждой частоте (кроссовер 130–260 Гц)
  int histPos = 0, rover = 0, kTop = 0;
  // обработка во времени
  float kF = 0, kS = 0, kG = 1, kAmp = 0, bAmp = 0, bRef = 0, bPk = 0, kPk = 0, kOn = 0, bG = 1, dG = 1;
  float satB[2] = {}, satK[2] = {};            // сглаженный (до ~800 Гц) вклад насыщения
  float rF = 0, rS = 0, rG = 1;                // восстановление ударов на «остальном» (малый, хэты, атаки)
  float cLp[2] = {}, cLp2[2] = {}, cDc[2] = {}, rPk = 0;  // окраска «остального»: фильтры насыщенной копии и пик дорожки
  float cur[7] = {};                           // сглаженные параметры
  // снятие маскировки (по образцу soothe/Gullfoss): усиление каждой частоты «остального», дБ
  static const int NB = N / 2 + 1;
  std::vector<float> pw, avgP, gsm; std::vector<double> pre, preA;
  int kLo = 0, kHi = 0; float umTame = 0, umRec = 0, avgA = 0;

  void init(float rate) {
    sr = rate;
    fft.init(N);
    win.resize(N); for (int i = 0; i < N; i++) win[i] = sqrt(0.5 - 0.5 * cos(2 * 3.14159265358979323846 * i / N));
    re.assign(N, 0); im.assign(N, 0); sKre.assign(N, 0); sKim.assign(N, 0); sBre.assign(N, 0); sBim.assign(N, 0);
    inL.assign(N, 0.f); inR.assign(N, 0.f);
    for (int s = 0; s < 6; s++) { acc[s].assign(2 * N, 0.f); out[s].assign(HOP, 0.f); }
    memset(hist, 0, sizeof(hist)); histPos = 0; rover = N - HOP;
    const float bin = sr / N;
    kTop = 0;
    for (int k = 0; k <= KMAX; k++) {
      float f = k * bin, w = f <= 130 ? 1.f : f >= 260 ? 0.f : 0.5f + 0.5f * cosf(3.14159265f * (f - 130) / 130);
      wLow[k] = w; if (w > 0) kTop = k;
    }
    pw.assign(NB, 0.f); avgP.assign(NB, 0.f); gsm.assign(NB, 0.f); pre.assign(NB + 1, 0.0); preA.assign(NB + 1, 0.0);
    kLo = (int)ceilf(150 / bin); kHi = (int)fminf(NB - 2, 16000 / bin);
    avgA = 1.f - expf(-(float)HOP / (sr * 1.0f));  // устойчивый спектр: ~1 с
    kF = kS = kAmp = bAmp = bRef = bPk = kPk = kOn = 0; rF = rS = 0; rG = 1; cLp[0] = cLp[1] = cLp2[0] = cLp2[1] = cDc[0] = cDc[1] = rPk = 0; kG = bG = dG = 1; satB[0] = satB[1] = satK[0] = satK[1] = 0;
    memset(cur, 0, sizeof(cur));
  }

  static float median(float *v, int n) {
    for (int i = 1; i < n; i++) { float x = v[i]; int j = i - 1; while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; } v[j + 1] = x; }
    return n & 1 ? v[n / 2] : 0.5f * (v[n / 2 - 1] + v[n / 2]);
  }

  // спектральный разбор одного шага
  void frame() {
    for (int i = 0; i < N; i++) { re[i] = inL[i] * win[i]; im[i] = inR[i] * win[i]; }
    fft.run(re.data(), im.data(), false);
    const bool um = umTame > 0 || umRec > 0;
    if (um) for (int k = 0; k < NB; k++) {
      int m = (N - k) & (N - 1);
      double lr = 0.5 * (re[k] + re[m]), li = 0.5 * (im[k] - im[m]), rr = 0.5 * (im[k] + im[m]), ri = -0.5 * (re[k] - re[m]);
      pw[k] = (float)(lr * lr + li * li + rr * rr + ri * ri);
      avgP[k] += avgA * (pw[k] - avgP[k]);
    }
    // распаковка двух вещественных спектров: L_k = (Z_k + Z*_{N-k})/2, R_k = (Z_k − Z*_{N-k})/(2i)
    float *h = hist[histPos];
    for (int k = 0; k <= kTop; k++) {
      int m = (N - k) & (N - 1);
      double lr = 0.5 * (re[k] + re[m]), li = 0.5 * (im[k] - im[m]);
      double rr = 0.5 * (im[k] + im[m]), ri = -0.5 * (re[k] - re[m]);
      h[k] = (float)(sqrt(lr * lr + li * li) + sqrt(rr * rr + ri * ri));
    }
    // по каждой низкой частоте: устойчивая часть = медиана за HIST шагов, удар = превышение над ней
    for (int k = 0; k < N; k++) { sKre[k] = sKim[k] = sBre[k] = sBim[k] = 0; }
    float tmp[HIST];
    for (int k = 0; k <= kTop; k++) {
      for (int t = 0; t < HIST; t++) tmp[t] = hist[t][k];
      float sus = median(tmp, HIST), mag = h[k];
      float pk = mag > 1e-12f ? fmaxf(0.f, mag * mag - sus * sus) / (mag * mag) : 0.f;  // доля мощности «удара»
      float wk = wLow[k] * pk, wb = wLow[k] * (1 - pk);
      // одна и та же маска для L и R → упакованный спектр Z масштабируется целиком (k и N−k)
      int m = (N - k) & (N - 1);
      sKre[k] = re[k] * wk; sKim[k] = im[k] * wk; sBre[k] = re[k] * wb; sBim[k] = im[k] * wb;
      if (m != k) { sKre[m] = re[m] * wk; sKim[m] = im[m] * wk; sBre[m] = re[m] * wb; sBim[m] = im[m] * wb; }
    }
    histPos = (histPos + 1) % HIST;
    // остальное = весь спектр минус кик и бас
    for (int k = 0; k < N; k++) { re[k] -= sKre[k] + sBre[k]; im[k] -= sKim[k] + sBim[k]; }
    if (um) unmask(); else std::fill(gsm.begin(), gsm.end(), 0.f);
    const float norm = 1.f / (N * 2.f);  // 1/N — обратное БПФ, 1/2 — перекрытие 75% с √Ханн²
    fft.run(sKre.data(), sKim.data(), true);
    fft.run(sBre.data(), sBim.data(), true);
    fft.run(re.data(), im.data(), true);
    for (int i = 0; i < N; i++) {
      float w = (float)win[i] * norm;
      acc[0][i] += (float)sKre[i] * w; acc[1][i] += (float)sKim[i] * w;
      acc[2][i] += (float)sBre[i] * w; acc[3][i] += (float)sBim[i] * w;
      acc[4][i] += (float)re[i] * w;   acc[5][i] += (float)im[i] * w;
    }
    for (int s = 0; s < 6; s++) {
      memcpy(out[s].data(), acc[s].data(), sizeof(float) * HOP);
      memmove(acc[s].data(), acc[s].data() + HOP, sizeof(float) * (2 * N - HOP));
      memset(acc[s].data() + 2 * N - HOP, 0, sizeof(float) * HOP);
    }
    memmove(inL.data(), inL.data() + HOP, sizeof(float) * (N - HOP));
    memmove(inR.data(), inR.data() + HOP, sizeof(float) * (N - HOP));
  }

  /**
   * Снятие маскировки на дорожке «остальное» (середина и верх: голос, гитары, клавиши, тарелки).
   *  — область спектра (треть октавы), которая выпирает над своим окружением (октава), приглушается до −3 дБ (Tame);
   *  — область, утонувшая под соседями, поднимается до +3 дБ (Recover) — там прячутся инструменты;
   *  — узкие пики, которые держатся дольше секунды на одной частоте (резонанс, звон), гасятся до −4 дБ.
   *    Меняющиеся ноты не трогаем: их гармоники всегда выше соседей, иначе звук станет тусклым.
   * Усиления сглажены во времени (быстро вниз, медленнее вверх) и по частоте — без «бульканья».
   */
  void unmask() {
    pre[0] = preA[0] = 0;
    for (int k = 0; k < NB; k++) { pre[k + 1] = pre[k] + pw[k]; preA[k + 1] = preA[k] + avgP[k]; }
    auto sum = [&](int a, int b, int &cnt) { a = a < 0 ? 0 : a; b = b > NB - 1 ? NB - 1 : b; cnt = b - a + 1; return cnt > 0 ? pre[b + 1] - pre[a] : 0.0; };
    auto sumA = [&](int a, int b) { a = a < 0 ? 0 : a; b = b > NB - 1 ? NB - 1 : b; return b >= a ? preA[b + 1] - preA[a] : 0.0; };
    float pmax = 1e-20f; for (int k = kLo; k <= kHi; k++) pmax = fmaxf(pmax, pw[k]);
    const float floorDb = dB(pmax) - 60;
    for (int k = kLo; k <= kHi; k++) {
      int w = k * 0.12f > 2 ? (int)(k * 0.12f) : 2, W = k * 0.45f > 6 ? (int)(k * 0.45f) : 6, c1, c2;
      double env = sum(k - w, k + w, c1) / c1, wide = sum(k - W, k + W, c2) / c2;
      double envL = sumA(k - w, k + w) / c1, wideL = sumA(k - W, k + W) / c2;
      float ev = dB((float)env);
      // насколько область сейчас выше/ниже своего обычного уровня в этом треке — с поправкой на соседей
      float dev = (ev - dB((float)wide)) - (dB((float)envL) - dB((float)wideL));
      float tgt = 0;
      if (dev > 0.5f) tgt = -fminf(4.f, (dev - 0.5f) * 0.8f) * umTame;
      else if (dev < -0.5f && ev > floorDb) tgt = fminf(4.f, (-dev - 0.5f) * 0.8f) * umRec;
      // устойчивый узкий пик: средний спектр за ~1 с против соседей (без самого пика ±1)
      double sa = 0; int na = 0;
      for (int j = k - w - 1; j <= k + w + 1; j++) if (j >= 0 && j < NB && (j < k - 1 || j > k + 1)) { sa += avgP[j]; na++; }
      float ex = dB(avgP[k]) - dB((float)(sa / (na ? na : 1)));
      if (ex > 8) tgt -= fminf(4.f, (ex - 8) * 0.5f) * umTame;
      gsm[k] += (tgt < gsm[k] ? 0.6f : 0.2f) * (tgt - gsm[k]);
    }
    for (int k = kLo; k <= kHi; k++) {
      float g = (gsm[k - 1] + gsm[k] + gsm[k + 1]) * (1.f / 3);
      if (g > -0.01f && g < 0.01f) continue;
      double lin = db2(g); int m = N - k;
      re[k] *= lin; im[k] *= lin; re[m] *= lin; im[m] *= lin;
    }
  }
  static inline float dB(float p) { return 4.3429448190325175f * logf(p + 1e-20f); }

  static inline float sat(float x) { if (x > 3) return 1; if (x < -3) return -1; float x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); }
  static inline float tc(float ms, float sr) { return 1.f - expf(-1.f / (ms * 0.001f * sr)); }

  /**
   * prm: [0] кик, дБ  [1] удар кика 0…1  [2] бас, дБ  [3] протяжность 0…1  [4] гармоники баса 0…1
   *      [5] уступка баса кику, дБ  [6] остальное, дБ  [7] [8] снятие маскировки  [9] запас (не здесь)  [10] восстановление ударов 0…1  [11] окраска 0…1
   */
  void process(float *L, float *R, int n, const float *prm) {
    const float kfA = tc(1, sr), ksA = tc(30, sr), kRel = tc(120, sr), gA = tc(3, sr);
    // огибающие не быстрее одной волны баса (40 Гц ≈ 25 мс): иначе усиление дёргается внутри волны — это искажения
    const float ampA = tc(12, sr), ampR = tc(120, sr), envA = tc(10, sr), envR = tc(60, sr), refR = tc(1500, sr), smooth = tc(20, sr);
    const float bDown = tc(15, sr), duckIn = tc(10, sr), duckOut = tc(80, sr), onRel = tc(60, sr), satA = 1 - expf(-2 * 3.14159265f * 800 / sr), colA = 1 - expf(-2 * 3.14159265f * 5000 / sr), dcA = 1 - expf(-2 * 3.14159265f * 30 / sr);

    for (int i = 0; i < n; i++) {
      inL[rover] = L[i]; inR[rover] = R[i];
      int o = rover - (N - HOP);
      // кик и бас — в моно: стерео в самом низу не слышно, а низ от него размывается и раздувается
      float kl = 0.5f * (out[0][o] + out[1][o]), kr = kl, bl = 0.5f * (out[2][o] + out[3][o]), br = bl, rl = out[4][o], rr = out[5][o];
      if (++rover >= N) { rover = N - HOP; frame(); }
      for (int j = 0; j < 7; j++) cur[j] += (prm[j] - cur[j]) * smooth;
      umTame = prm[7]; umRec = prm[8];
      // кик: огибающие мощности (быстрая против медленной) → усиление только на атаке
      float kp = 0.25f * (kl + kr) * (kl + kr);
      kF += (kp > kF ? kfA : kRel) * (kp - kF);
      kS += (kp > kS ? ksA : kRel) * (kp - kS);
      float tr = fminf(1.f, fmaxf(0.f, (kF / (kS + 1e-12f) - 1.5f) / 3.f));
      kG += gA * (1 + cur[1] * 0.8f * tr - kG);
      float kickG = kG * db2(cur[0]);
      // уступка: доля кика в низу прямо сейчас
      float ka = 0.5f * (fabsf(kl) + fabsf(kr)), ba = 0.5f * (fabsf(bl) + fabsf(br));
      kAmp += (ka > kAmp ? ampA : ampR) * (ka - kAmp);
      bAmp += (ba > bAmp ? ampA : ampR) * (ba - bAmp);
      float share = kAmp / (kAmp + bAmp + 1e-9f);
      // уступает только в момент удара (~60 мс), а не всё время: в метале кик стучит почти без перерыва
      kOn += (tr > kOn ? 1.f : onRel) * (tr - kOn);
      float dt = db2(-cur[5] * kOn * fminf(1.f, share * 2));
      dG += (dt < dG ? duckIn : duckOut) * (dt - dG);
      // бас: протяжность — затухающий хвост ноты подтягивается к её недавнему пику (до +6 дБ)
      bRef += (bAmp > bRef ? envA : refR) * (bAmp - bRef);
      float env = bAmp;
      float up = 1.f;
      // хвост тише пика больше чем на 26 дБ — это уже пауза между нотами, её не поднимаем
      if (cur[3] > 0 && bRef > 1e-4f && env > bRef * 0.05f) up = fminf(db2(6 * cur[3]), powf(bRef / env, 0.8f * cur[3]));
      bG += (up < bG ? bDown : envR) * (up - bG);  // вниз быстрее (новая нота — без «бума»), вверх плавно
      float bassG = bG * dG * db2(cur[2]);
      // Сатурация по дорожкам (не на весь микс — иначе интермодуляция, «клиппинг»):
      //   бас проходит через мягкое насыщение — гармоники делают его толще и слышнее, а пики сглаживаются,
      //   поэтому подъём баса не упирается в потолок громкого мастера;
      //   вершина удара кика мягко подрезается — атака остаётся громкой и чёткой, без перегрузки.
      //   Порог — от собственного уровня дорожки (недавний пик), поэтому насыщается ровно добавленная
      //   прибавка: бас громче и толще при прежнем пике. Гармоники насыщения — только до ~800 Гц (без жужжания).
      // пики дорожек до обработки — порог насыщения: выше исходного пика прибавка не выходит
      float bp = fmaxf(fabsf(bl), fabsf(br)), kpk = fmaxf(fabsf(kl), fabsf(kr));
      bPk = bp > bPk ? bp : bPk + (bp - bPk) * refR;
      kPk = kpk > kPk ? kpk : kPk + (kpk - kPk) * refR;
      // Восстановление ударов на «остальном»: атака малого, хэтов, гитар, придавленная лимитером при мастеринге,
      // поднимается обратно (до +6 дБ на самой атаке) — в запас, освобождённый P_HEADROOM.
      float rp = 0.25f * (rl + rr) * (rl + rr);
      rF += (rp > rF ? kfA : kRel) * (rp - rF);
      rS += (rp > rS ? ksA : kRel) * (rp - rS);
      float rtr = fminf(1.f, fmaxf(0.f, (rF / (rS + 1e-12f) - 3.f) / 6.f));  // только резкие атаки (мощность ×3 над фоном)
      rG += gA * (1 + prm[10] * rtr - rG);
      const float hS = cur[4], hK = cur[1] * 0.6f, restG = db2(cur[6]) * rG;
      const float tB = fmaxf(1e-4f, bPk), tK = fmaxf(1e-4f, kPk);
      // Окраска «остального» (голос, гитары, клавиши): тёплое ленточное насыщение (чётные гармоники) только ниже
      // ~4 кГц — без баса (иначе интермодуляция) и без тарелок (иначе песок). Порог — от недавнего пика дорожки.
      const float col = prm[11];
      float rpk = fmaxf(fabsf(rl), fabsf(rr)) * restG;
      rPk = rpk > rPk ? rpk : rPk + (rpk - rPk) * refR;
      // Параллельное насыщение (как «сочный» шин на сведении): копия сильно разогревается (~+12 дБ в насыщение,
      // асимметрично — тёплые чётные гармоники), смягчается сверху (без песка), без постоянной составляющей,
      // и подмешивается к оригиналу. Ручка — сколько копии подмешать; громкость середины выравнивает приложение.
      const float ref = fmaxf(1e-4f, 0.25f * rPk), bias = 0.3f, sb = sat(bias);
      for (int c = 0; c < 2; c++) {
        float x = (c ? br : bl) * bassG, k = (c ? kr : kl) * kickG, r = (c ? rr : rl) * restG;
        satB[c] += satA * (hS * (softClip(x, tB) - x) - satB[c]);
        satK[c] += satA * (hK * (softClip(k, tK) - k) - satK[c]);
        if (col > 0) {
          float s = (sat(r / ref + bias) - sb) * ref * 0.9f;
          cLp[c] += colA * (s - cLp[c]); cLp2[c] += colA * (cLp[c] - cLp2[c]);
          cDc[c] += dcA * (cLp2[c] - cDc[c]);
          r += col * 0.8f * (cLp2[c] - cDc[c]);
        }
        (c ? R : L)[i] = k + satK[c] + x + satB[c] + r;
      }
    }
  }
  static inline float db2(float d) { return expf(d * 0.11512925464970229f); }
  // мягкое ограничение с «коленом»: до 70% порога звук не трогается, выше — плавно подходит к порогу
  static inline float softClip(float x, float t) {
    float a = fabsf(x), k = 0.7f * t;
    if (a <= k) return x;
    float y = k + (t - k) * tanhf((a - k) / (t - k));
    return x < 0 ? -y : y;
  }
};

}  // namespace kb
