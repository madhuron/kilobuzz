// Код AudioWorklet-процессоров. Хранится строкой и грузится через Blob URL,
// чтобы одинаково работать из file:// (Electron) и с http (dev-режим).
//
// Производительность: тяжёлые операции (log/pow) считаются не на каждый сэмпл,
// а раз в CR сэмплов (control rate) с линейной интерполяцией усиления между точками.
export const WORKLET_SOURCE = String.raw`
const CR = 8;
const db2lin = (d) => Math.exp(d * 0.11512925464970229);
const lin2db = (l) => 8.685889638065035 * Math.log(l > 1e-9 ? l : 1e-9);
const pow2db = (p) => 4.3429448190325175 * Math.log(p + 1e-12);
const coef = (ms, rate) => Math.exp(-1 / (Math.max(ms, 0.01) * 0.001 * (rate || sampleRate)));
// быстрая мягкая сатурация (аппроксимация tanh)
const sat = (x) => { if (x > 3) return 1; if (x < -3) return -1; const x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); };

class Meter {
  constructor(port, hz) { this.port = port; this.every = Math.max(1, Math.round(sampleRate / hz / 128)); this.n = 0; }
  tick(data) { if (++this.n >= this.every) { this.n = 0; this.port.postMessage(data); } }
}

function io(inputs, outputs) {
  const inp = inputs[0], out = outputs[0];
  const oL = out[0], oR = out[1] || out[0];
  if (!inp || inp.length === 0) { oL.fill(0); oR.fill(0); return null; }
  return { L: inp[0], R: inp[1] || inp[0], oL, oR };
}

// Источник из захвата системного звука: PCM приходит по MessagePort из главного процесса.
// Скорость потока измеряется по аудиочасам (заявленной частоте не доверяем), а уровень буфера
// держится около цели плавной подстройкой коэффициента ресемплинга — без скачков и пауз.
const STD_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
class PcmSourceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 1 << 18;
    this.buf = new Float32Array(this.cap * 2);
    this.w = 0; this.r = 0; this.frac = 0;
    this.srcRate = sampleRate;
    this.adj = 1;
    // целевой запас буфера подстраивается: растёт после пропуска, медленно уменьшается, когда всё ровно
    this.target = 0.12;
    this.stableSec = 0;
    this.last = [0, 0];
    this.priming = true;
    this.underruns = 0;
    this.est = { t0: -1, frames: 0, last: 0 };
    this.fade = 0;
    this.stats = new Meter(this.port, 4);
    this.port.onmessage = (e) => {
      const p = e.data && e.data.port;
      if (p) p.onmessage = (m) => this.onData(m.data);
    };
  }
  onData(d) {
    if (d.sampleRate) { this.srcRate = d.sampleRate; return; }
    if (!d.pcm) return;
    const f = new Float32Array(d.pcm), frames = f.length >> 1, mask = this.cap - 1;
    for (let i = 0; i < frames; i++) {
      const j = (this.w + i) & mask;
      this.buf[2 * j] = f[2 * i]; this.buf[2 * j + 1] = f[2 * i + 1];
    }
    this.w += frames;
    this.measure(frames);
  }
  measure(frames) {
    const e = this.est;
    if (e.t0 < 0) { e.t0 = currentTime; e.frames = 0; return; }
    e.frames += frames;
    const dt = currentTime - e.t0;
    if (dt < 3 || currentTime - e.last < 1) return;
    e.last = currentTime;
    const rate = e.frames / dt;
    if (Math.abs(rate - this.srcRate) / this.srcRate > 0.015) {
      let best = rate, bd = Infinity;
      for (const r of STD_RATES) { const d = Math.abs(r - rate) / r; if (d < bd) { bd = d; best = r; } }
      this.srcRate = bd < 0.03 ? best : rate;
      this.port.postMessage({ rateFix: this.srcRate, measured: Math.round(rate) });
    }
  }
  process(inputs, outputs) {
    const oL = outputs[0][0], oR = outputs[0][1] || oL, mask = this.cap - 1;
    const level = (this.w - this.r) / this.srcRate;
    if (this.priming) {
      if (level < this.target) { oL.fill(0); oR.fill(0); return true; }
      this.priming = false;
      this.fade = 0;
    }
    if (level > Math.max(0.6, this.target * 3)) { this.r = this.w - Math.round(this.target * this.srcRate); this.frac = 0; }
    this.stableSec += oL.length / sampleRate;
    if (this.stableSec > 30 && this.target > 0.1) { this.target = Math.max(0.1, this.target * 0.9); this.stableSec = 0; }
    // мягкая подстройка: ±0.3% скорости (неслышно), чтобы уровень буфера стремился к цели
    const want = 1 + Math.max(-0.003, Math.min(0.003, (level - this.target) / this.target * 0.002));
    this.adj += (want - this.adj) * 0.02;
    const ratio = (this.srcRate / sampleRate) * this.adj;
    for (let i = 0; i < oL.length; i++) {
      if (this.w - this.r < 2) {
        // данных не хватило: плавно затухаем (без щелчка) и увеличиваем запас буфера
        this.underruns++;
        this.priming = true;
        this.target = Math.min(0.35, this.target * 1.5 + 0.02);
        this.stableSec = 0;
        let k = 1;
        for (; i < oL.length; i++) { k *= 0.97; oL[i] = this.last[0] * k; oR[i] = this.last[1] * k; }
        break;
      }
      const a = this.r & mask, b = (this.r + 1) & mask, t = this.frac;
      if (this.fade < 1) this.fade = Math.min(1, this.fade + 1 / 256);
      oL[i] = (this.buf[2 * a] * (1 - t) + this.buf[2 * b] * t) * this.fade;
      oR[i] = (this.buf[2 * a + 1] * (1 - t) + this.buf[2 * b + 1] * t) * this.fade;
      this.last[0] = oL[i]; this.last[1] = oR[i];
      this.frac += ratio;
      const step = this.frac | 0;
      this.r += step; this.frac -= step;
    }
    this.stats.tick({ buffered: (this.w - this.r) / this.srcRate, rate: this.srcRate, underruns: this.underruns, target: this.target });
    return true;
  }
}

// Компрессор: feed-forward, связанная стерео-детекция (RMS ~10 мс), мягкое колено.
// Параллельная схема: сжатый сигнал с автокомпенсацией уровня смешивается с исходным —
// громкие места «собираются», тихие детали подтягиваются, а удары не сплющиваются.
// Отпускание зависит от программы: короткие пики отпускаются быстро, длительное сжатие — плавно
// (без «качания» громкости).
class CompressorProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.p = { threshold: -18, ratio: 2.5, knee: 6, attack: 15, release: 150, mix: 0.6, bypass: false, ...(opts && opts.processorOptions) };
    this.env = 0; this.gf = 0; this.gs = 0; this.lin = 1; this.avgGr = 0; this.elapsed = 0; this.hpL = 0; this.hpR = 0;
    this.aSc = 1 - Math.exp(-2 * Math.PI * 150 / sampleRate);
    this.meter = new Meter(this.port, 30);
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.update(); };
    this.update();
  }
  update() {
    const cr = sampleRate / CR;
    this.aA = coef(this.p.attack, cr);
    this.aRf = coef(this.p.release, cr);          // быстрое отпускание
    this.aRs = coef(this.p.release * 5, cr);      // медленное (длительное сжатие)
    this.aD = coef(10);
    this.cr = cr;
  }
  process(inputs, outputs) {
    const b = io(inputs, outputs); if (!b) return true;
    const { L, R, oL, oR } = b, p = this.p;
    if (p.bypass || p.mix <= 0) {
      oL.set(L); oR.set(R); this.gf = this.gs = 0; this.lin = 1;
      this.meter.tick({ gr: 0, makeup: 0 }); return true;
    }
    const T = p.threshold, K = Math.max(p.knee, 0.01), slope = 1 / Math.max(p.ratio, 1) - 1, mix = p.mix, aD = this.aD;
    let env = this.env, gf = this.gf, gs = this.gs, lin = this.lin, avg = this.avgGr, maxGr = 0;
    for (let i0 = 0; i0 < L.length; i0 += CR) {
      // детектор без низа (ФВЧ 150 Гц): бас и кик не «качают» весь микс и не съедают свою атаку
      for (let i = i0; i < i0 + CR; i++) {
        this.hpL += this.aSc * (L[i] - this.hpL); this.hpR += this.aSc * (R[i] - this.hpR);
        const l = L[i] - this.hpL, r = R[i] - this.hpR, s = l * l > r * r ? l * l : r * r;
        env = aD * env + (1 - aD) * s;
      }
      const over = pow2db(env) - T;
      let y;
      if (2 * over < -K) y = 0;
      else if (2 * over > K) y = slope * over;
      else { const q = over + K / 2; y = slope * q * q / (2 * K); }
      // двухступенчатое отпускание: итоговое сжатие — наибольшее из быстрого и медленного
      gf = y < gf ? this.aA * gf + (1 - this.aA) * y : this.aRf * gf + (1 - this.aRf) * y;
      gs = y < gs ? this.aA * gs + (1 - this.aA) * y * 0.6 : this.aRs * gs + (1 - this.aRs) * y;
      const g = Math.min(gf, gs);
      // автокомпенсация почти постоянна на весь трек (~15 с): иначе она «отменяет» сжатие в каждой
      // части и тихие места не подтягиваются. В начале — быстрее, чтобы не было провала уровня.
      this.elapsed += CR / sampleRate;
      const aAvg = Math.exp(-1 / (Math.min(15, 1 + this.elapsed) * this.cr));
      avg = aAvg * avg + (1 - aAvg) * g;
      const mk = -avg * 0.85;
      const next = mix * db2lin(g + mk) + (1 - mix), step = (next - lin) / CR;
      for (let i = i0; i < i0 + CR; i++) { lin += step; oL[i] = L[i] * lin; oR[i] = R[i] * lin; }
      if (-g > maxGr) maxGr = -g;
    }
    if (gf > -1e-4) gf = 0;
    if (gs > -1e-4) gs = 0;
    Object.assign(this, { env, gf, gs, lin, avgGr: avg });
    this.meter.tick({ gr: maxGr, makeup: -avg * 0.85, mix });
    return true;
  }
}

// Де-эссер: детектор сибилянтов (~6.5 кГц) относительно всего сигнала,
// ослабляется только верхняя полоса после комплементарного разделения.
class DeesserProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { freq: 6500, split: 5000, threshold: -10, maxReduction: 4, bypass: false };
    this.lpL = 0; this.lpR = 0; this.z1 = 0; this.z2 = 0; this.sEnv = 0; this.fEnv = 0; this.g = 0; this.hg = 1;
    this.meter = new Meter(this.port, 30);
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.update(); };
    this.update();
  }
  update() {
    const fs = sampleRate, cr = fs / CR;
    this.aSplit = 1 - Math.exp(-2 * Math.PI * this.p.split / fs);
    const w0 = 2 * Math.PI * Math.min(this.p.freq, fs * 0.45) / fs, al = Math.sin(w0) / (2 * 1.2), a0 = 1 + al;
    this.b0 = al / a0; this.b2 = -al / a0; this.a1 = -2 * Math.cos(w0) / a0; this.a2 = (1 - al) / a0;
    this.aEnv = coef(4); this.aAtt = coef(2, cr); this.aRel = coef(80, cr);
  }
  process(inputs, outputs) {
    const b = io(inputs, outputs); if (!b) return true;
    const { L, R, oL, oR } = b, p = this.p;
    if (p.bypass) { oL.set(L); oR.set(R); this.g = 0; this.hg = 1; this.meter.tick({ gr: 0 }); return true; }
    const aS = this.aSplit, aE = this.aEnv;
    let { lpL, lpR, z1, z2, sEnv, fEnv, g, hg } = this, maxGr = 0;
    for (let i0 = 0; i0 < L.length; i0 += CR) {
      for (let i = i0; i < i0 + CR; i++) {
        const m = (L[i] + R[i]) * 0.5;
        const y = this.b0 * m + z1;
        z1 = -this.a1 * y + z2;
        z2 = this.b2 * m - this.a2 * y;
        sEnv = aE * sEnv + (1 - aE) * y * y;
        fEnv = aE * fEnv + (1 - aE) * m * m;
      }
      let target = 0;
      if (fEnv > 1e-7) {
        const over = pow2db(sEnv) - pow2db(fEnv) - p.threshold;
        if (over > 0) target = -Math.min(p.maxReduction, over * 1.5);
      }
      g = target < g ? this.aAtt * g + (1 - this.aAtt) * target : this.aRel * g + (1 - this.aRel) * target;
      if (g > -1e-4) g = 0;
      const next = db2lin(g), step = (next - hg) / CR;
      for (let i = i0; i < i0 + CR; i++) {
        hg += step;
        lpL += aS * (L[i] - lpL); lpR += aS * (R[i] - lpR);
        oL[i] = lpL + (L[i] - lpL) * hg;
        oR[i] = lpR + (R[i] - lpR) * hg;
      }
      if (-g > maxGr) maxGr = -g;
    }
    Object.assign(this, { lpL, lpR, z1, z2, sEnv, fEnv, g, hg });
    this.meter.tick({ gr: maxGr });
    return true;
  }
}

// «Красочность»: психоакустическое улучшение вместо грубого подъёма EQ.
//  bass — гармоники низа (бас слышен даже на маленьких динамиках, без гула и перегруза),
//  air  — лёгкие гармоники верха (прозрачность и детальность без резкости),
//  punch — «ударные»: подчёркивает атаку (быстрая огибающая против медленной), хвост не трогает —
//          удары щёлкают чётче, а общий уровень почти не растёт.
class EnhancerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { bass: 0.3, air: 0.3, warm: 0, punch: 0, bypass: false };
    this.cur = { bass: 0, air: 0, warm: 0, punch: 0 };
    this.aDc = 1 - Math.exp(-2 * Math.PI * 12 / sampleRate);
    const a = (hz) => 1 - Math.exp(-2 * Math.PI * hz / sampleRate);
    const t = (ms) => 1 - Math.exp(-1 / (ms * 0.001 * sampleRate));
    this.aLo = a(110); this.aHb = a(160); this.aHi = a(3500); this.aHx = a(6000);
    // огибающие мощности с общим спадом: на ровном звуке они совпадают (усиления нет), на ударе быстрая уходит вперёд
    this.pk = { lp: a(2500), fA: t(1), sA: t(30), rel: t(120), g: t(3) };
    this.ps = { lp: 0, f: 0, s: 0, g: 1 };
    this.pg = new Float32Array(128);
    this.s = [new Float64Array(8), new Float64Array(8)];
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    const b = io(inputs, outputs); if (!b) return true;
    const { L, R, oL, oR } = b, p = this.p;
    const tb = p.bypass ? 0 : p.bass, ta = p.bypass ? 0 : p.air, tw = p.bypass ? 0 : p.warm, tp = p.bypass ? 0 : p.punch || 0;
    if (tb === 0 && ta === 0 && tw === 0 && tp === 0 && this.cur.bass < 1e-3 && this.cur.air < 1e-3 && this.cur.warm < 1e-3 && this.cur.punch < 1e-3) { oL.set(L); oR.set(R); return true; }
    const n = L.length;
    // усиление атаки — общее для обоих каналов (стереокартина не плывёт)
    if (this.pg.length < n) this.pg = new Float32Array(n);
    const pg = this.pg, pk = this.pk, ps = this.ps, dp = (tp - this.cur.punch) / n;
    let kp = this.cur.punch;
    for (let i = 0; i < n; i++) {
      kp += dp;
      ps.lp += pk.lp * ((L[i] + R[i]) * 0.5 - ps.lp);
      const v = ps.lp * ps.lp;
      ps.f += (v > ps.f ? pk.fA : pk.rel) * (v - ps.f);
      ps.s += (v > ps.s ? pk.sA : pk.rel) * (v - ps.s);
      const tr = Math.min(1, Math.max(0, (ps.f / (ps.s + 1e-9) - 1.5) / 3));
      ps.g += pk.g * (1 + kp * 0.6 * tr - ps.g);
      pg[i] = ps.g;
    }
    const db = (tb - this.cur.bass) / n, da = (ta - this.cur.air) / n, dw = (tw - this.cur.warm) / n;
    const aDc = this.aDc, b0 = sat(0.25);
    const { aLo, aHb, aHi, aHx } = this;
    for (let c = 0; c < 2; c++) {
      const x = c ? R : L, o = c ? oR : oL, s = this.s[c];
      let kb = this.cur.bass, ka = this.cur.air, kw = this.cur.warm;
      for (let i = 0; i < n; i++) {
        const v = x[i];
        kb += db; ka += da; kw += dw;
        // низ: 2 полюса ФНЧ 110 Гц → сатурация → оставляем только гармоники (>160 Гц)
        s[0] += aLo * (v - s[0]); s[1] += aLo * (s[0] - s[1]);
        const h = sat(s[1] * 4) * 0.25 - s[1]; // только нелинейный остаток = гармоники
        s[2] += aHb * (h - s[2]);
        const bassH = h - s[2];
        // верх: ФВЧ 3.5 кГц → сатурация → гармоники выше 6 кГц
        s[3] += aHi * (v - s[3]);
        const hi = v - s[3];
        const e = sat(hi * 3) * 0.33 - hi;
        s[4] += aHx * (e - s[4]);
        const airH = e - s[4];
        // «тепло»: асимметричная мягкая сатурация (чётные гармоники, как лента/лампа) — только
        // нелинейный остаток, со снятием постоянной составляющей. На тихом звуке почти не слышна,
        // на громком добавляет плотности и «жира».
        const t = (sat(v * 1.1 + 0.25) - b0) / 1.1 - v;
        s[6] += aDc * (t - s[6]);
        const warmH = t - s[6];
        o[i] = v * pg[i] + kb * bassH * 1.2 + ka * airH * 0.7 + kw * warmH * 0.9;
      }
    }
    this.cur.bass = tb; this.cur.air = ta; this.cur.warm = tw; this.cur.punch = tp;
    return true;
  }
}

// мягкое ограничение с «коленом»: до 70% порога звук не трогается, выше — плавно подходит к порогу
const softClip = (x, t) => { const a = Math.abs(x), k = 0.7 * t; if (a <= k) return x; const y = k + (t - k) * Math.tanh((a - k) / (t - k)); return x < 0 ? -y : y; };

// Разбор на дорожки на лету: кик / бас / остальное — порт native/win/stems.h (держать одинаковыми).
// Спектр (окно 2048, шаг 512, √Ханн); в низу (до ~260 Гц) «удар» — превышение уровня частоты над её
// медианой за 12 шагов, «протяжное» — остальное. Маски в сумме дают 1: без обработки — ровно оригинал
// с задержкой 2048 отсчётов. Кик и бас обрабатываются по отдельности во времени.
class StemsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const N = 2048, HOP = 512, HIST = 12, KMAX = 24;
    Object.assign(this, { N, HOP, HIST, KMAX });
    this.p = { kick: 0, punch: 0, bass: 0, sustain: 0, harm: 0, duck: 0, rest: 0, tame: 0, recover: 0 };
    this.prm = new Float64Array(7); this.cur = new Float64Array(7);
    this.cs = new Float64Array(N / 2); this.sn = new Float64Array(N / 2); this.rev = new Int32Array(N);
    for (let i = 0; i < N / 2; i++) { this.cs[i] = Math.cos(2 * Math.PI * i / N); this.sn[i] = -Math.sin(2 * Math.PI * i / N); }
    let bits = 0; while ((1 << bits) < N) bits++;
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
    this.win = new Float64Array(N); for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.kRe = new Float64Array(N); this.kIm = new Float64Array(N); this.bRe = new Float64Array(N); this.bIm = new Float64Array(N);
    this.inL = new Float32Array(N); this.inR = new Float32Array(N);
    this.acc = Array.from({ length: 6 }, () => new Float32Array(2 * N));
    this.out = Array.from({ length: 6 }, () => new Float32Array(HOP));
    this.hist = Array.from({ length: HIST }, () => new Float32Array(KMAX + 1));
    this.tmp = new Float32Array(HIST);
    this.wLow = new Float32Array(KMAX + 1);
    const bin = sampleRate / N; this.kTop = 0;
    for (let k = 0; k <= KMAX; k++) {
      const f = k * bin, w = f <= 130 ? 1 : f >= 260 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (f - 130) / 130);
      this.wLow[k] = w; if (w > 0) this.kTop = k;
    }
    this.histPos = 0; this.rover = N - HOP;
    // снятие маскировки (порт unmask() из native/win/stems.h)
    const NB = N / 2 + 1; this.NB = NB;
    this.pw = new Float64Array(NB); this.avgP = new Float64Array(NB); this.gsm = new Float64Array(NB);
    this.pre = new Float64Array(NB + 1); this.preA = new Float64Array(NB + 1);
    this.kLo = Math.ceil(150 / bin); this.kHi = Math.min(NB - 2, Math.floor(16000 / bin));
    this.avgA = 1 - Math.exp(-HOP / (sampleRate * 1.0));
    this.umTame = 0; this.umRec = 0;
    this.rF = 0; this.rS = 0; this.rG = 1; this.restore = 0; // восстановление ударов на «остальном»
    this.cLp = [0, 0]; this.cLp2 = [0, 0]; this.cDc = [0, 0]; this.rPk = 0; this.color = 0; // окраска «остального»
    this.kF = 0; this.kS = 0; this.kG = 1; this.kAmp = 0; this.bAmp = 0; this.bRef = 0; this.bPk = 0; this.kPk = 0; this.kOn = 0; this.bG = 1; this.dG = 1;
    this.satB = [0, 0]; this.satK = [0, 0];

    const tc = (ms) => 1 - Math.exp(-1 / (ms * 0.001 * sampleRate));
    // огибающие не быстрее одной волны баса: иначе усиление дёргается внутри волны — это искажения
    this.c = { kfA: tc(1), ksA: tc(30), kRel: tc(120), gA: tc(3), ampA: tc(12), ampR: tc(120), envA: tc(10), envR: tc(60), refR: tc(1500), smooth: tc(20), bDown: tc(15), duckIn: tc(10), duckOut: tc(80), onRel: tc(60), satA: 1 - Math.exp(-2 * Math.PI * 800 / sampleRate), colA: 1 - Math.exp(-2 * Math.PI * 5000 / sampleRate), dcA: 1 - Math.exp(-2 * Math.PI * 30 / sampleRate) };
    this.port.onmessage = (e) => {
      Object.assign(this.p, e.data);
      const p = this.p, on = !p.bypass;
      this.prm.set([on ? p.kick : 0, on ? p.punch : 0, on ? p.bass : 0, on ? p.sustain : 0, on ? p.harm : 0, on ? p.duck : 0, on ? p.rest : 0]);
      this.umTame = on ? p.tame || 0 : 0; this.umRec = on ? p.recover || 0 : 0; this.restore = on ? p.restore || 0 : 0; this.color = on ? p.color || 0 : 0;
    };
  }
  fft(re, im, inverse) {
    const n = this.N, rev = this.rev, cs = this.cs, sn = this.sn;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const step = n / len, half = len / 2;
      for (let i = 0; i < n; i += len)
        for (let j = 0; j < half; j++) {
          const wr = cs[j * step], wi = inverse ? -sn[j * step] : sn[j * step];
          const a = i + j, b = a + half;
          const vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        }
    }
  }
  // снятие маскировки на дорожке «остальное» — см. unmask() в native/win/stems.h
  unmask() {
    const { NB, pw, avgP, gsm, pre, preA, kLo, kHi, re, im, N } = this;
    const dB = (p) => 4.3429448190325175 * Math.log(p + 1e-20);
    pre[0] = 0; preA[0] = 0;
    for (let k = 0; k < NB; k++) { pre[k + 1] = pre[k] + pw[k]; preA[k + 1] = preA[k] + avgP[k]; }
    const rng = (a, b) => [Math.max(0, a), Math.min(NB - 1, b)];
    let pmax = 1e-20; for (let k = kLo; k <= kHi; k++) if (pw[k] > pmax) pmax = pw[k];
    const floorDb = dB(pmax) - 60;
    for (let k = kLo; k <= kHi; k++) {
      const w = k * 0.12 > 2 ? Math.trunc(k * 0.12) : 2, W = k * 0.45 > 6 ? Math.trunc(k * 0.45) : 6;
      const [a1, b1] = rng(k - w, k + w), [a2, b2] = rng(k - W, k + W), c1 = b1 - a1 + 1, c2 = b2 - a2 + 1;
      const env = (pre[b1 + 1] - pre[a1]) / c1, wide = (pre[b2 + 1] - pre[a2]) / c2;
      const envL = (preA[b1 + 1] - preA[a1]) / c1, wideL = (preA[b2 + 1] - preA[a2]) / c2;
      const ev = dB(env), dev = (ev - dB(wide)) - (dB(envL) - dB(wideL));
      let tgt = 0;
      if (dev > 0.5) tgt = -Math.min(4, (dev - 0.5) * 0.8) * this.umTame;
      else if (dev < -0.5 && ev > floorDb) tgt = Math.min(4, (-dev - 0.5) * 0.8) * this.umRec;
      let sa = 0, na = 0;
      for (let j = k - w - 1; j <= k + w + 1; j++) if (j >= 0 && j < NB && (j < k - 1 || j > k + 1)) { sa += avgP[j]; na++; }
      const ex = dB(avgP[k]) - dB(sa / (na || 1));
      if (ex > 8) tgt -= Math.min(4, (ex - 8) * 0.5) * this.umTame;
      gsm[k] += (tgt < gsm[k] ? 0.6 : 0.2) * (tgt - gsm[k]);
    }
    for (let k = kLo; k <= kHi; k++) {
      const g = (gsm[k - 1] + gsm[k] + gsm[k + 1]) / 3;
      if (g > -0.01 && g < 0.01) continue;
      const lin = db2lin(g), m = N - k;
      re[k] *= lin; im[k] *= lin; re[m] *= lin; im[m] *= lin;
    }
  }
  frame() {
    const { N, HOP, HIST, re, im, kRe, kIm, bRe, bIm, win } = this;
    for (let i = 0; i < N; i++) { re[i] = this.inL[i] * win[i]; im[i] = this.inR[i] * win[i]; }
    this.fft(re, im, false);
    const um = this.umTame > 0 || this.umRec > 0;
    if (um) for (let k = 0; k < this.NB; k++) {
      const m = (N - k) & (N - 1);
      const lr = 0.5 * (re[k] + re[m]), li = 0.5 * (im[k] - im[m]), rr = 0.5 * (im[k] + im[m]), ri = -0.5 * (re[k] - re[m]);
      this.pw[k] = lr * lr + li * li + rr * rr + ri * ri;
      this.avgP[k] += this.avgA * (this.pw[k] - this.avgP[k]);
    }
    const h = this.hist[this.histPos];
    for (let k = 0; k <= this.kTop; k++) {
      const m = (N - k) & (N - 1);
      const lr = 0.5 * (re[k] + re[m]), li = 0.5 * (im[k] - im[m]), rr = 0.5 * (im[k] + im[m]), ri = -0.5 * (re[k] - re[m]);
      h[k] = Math.sqrt(lr * lr + li * li) + Math.sqrt(rr * rr + ri * ri);
    }
    kRe.fill(0); kIm.fill(0); bRe.fill(0); bIm.fill(0);
    const tmp = this.tmp;
    for (let k = 0; k <= this.kTop; k++) {
      for (let t = 0; t < HIST; t++) tmp[t] = this.hist[t][k];
      tmp.sort();
      const sus = HIST & 1 ? tmp[HIST >> 1] : 0.5 * (tmp[HIST / 2 - 1] + tmp[HIST / 2]), mag = h[k];
      const pk = mag > 1e-12 ? Math.max(0, mag * mag - sus * sus) / (mag * mag) : 0;
      const wk = this.wLow[k] * pk, wb = this.wLow[k] * (1 - pk), m = (N - k) & (N - 1);
      kRe[k] = re[k] * wk; kIm[k] = im[k] * wk; bRe[k] = re[k] * wb; bIm[k] = im[k] * wb;
      if (m !== k) { kRe[m] = re[m] * wk; kIm[m] = im[m] * wk; bRe[m] = re[m] * wb; bIm[m] = im[m] * wb; }
    }
    this.histPos = (this.histPos + 1) % HIST;
    for (let k = 0; k < N; k++) { re[k] -= kRe[k] + bRe[k]; im[k] -= kIm[k] + bIm[k]; }
    if (um) this.unmask(); else this.gsm.fill(0);
    const norm = 1 / (N * 2);
    this.fft(kRe, kIm, true); this.fft(bRe, bIm, true); this.fft(re, im, true);
    const acc = this.acc;
    for (let i = 0; i < N; i++) {
      const w = win[i] * norm;
      acc[0][i] += kRe[i] * w; acc[1][i] += kIm[i] * w; acc[2][i] += bRe[i] * w; acc[3][i] += bIm[i] * w; acc[4][i] += re[i] * w; acc[5][i] += im[i] * w;
    }
    for (let s = 0; s < 6; s++) {
      this.out[s].set(acc[s].subarray(0, HOP));
      acc[s].copyWithin(0, HOP); acc[s].fill(0, 2 * N - HOP);
    }
    this.inL.copyWithin(0, HOP); this.inR.copyWithin(0, HOP);
  }
  process(inputs, outputs) {
    const b = io(inputs, outputs); if (!b) return true;
    const { L, R, oL, oR } = b, c = this.c, prm = this.prm, cur = this.cur, N = this.N, HOP = this.HOP, out = this.out;
    for (let i = 0; i < L.length; i++) {
      this.inL[this.rover] = L[i]; this.inR[this.rover] = R[i];
      const o = this.rover - (N - HOP);
      // кик и бас — в моно: стерео в самом низу не слышно, а низ от него размывается
      const kl = 0.5 * (out[0][o] + out[1][o]), kr = kl, bl = 0.5 * (out[2][o] + out[3][o]), br = bl, rl = out[4][o], rr = out[5][o];
      if (++this.rover >= N) { this.rover = N - HOP; this.frame(); }
      for (let j = 0; j < 7; j++) cur[j] += (prm[j] - cur[j]) * c.smooth;
      const kp = 0.25 * (kl + kr) * (kl + kr);
      this.kF += (kp > this.kF ? c.kfA : c.kRel) * (kp - this.kF);
      this.kS += (kp > this.kS ? c.ksA : c.kRel) * (kp - this.kS);
      const tr = Math.min(1, Math.max(0, (this.kF / (this.kS + 1e-12) - 1.5) / 3));
      this.kG += c.gA * (1 + cur[1] * 0.8 * tr - this.kG);
      const kickG = this.kG * db2lin(cur[0]);
      const ka = 0.5 * (Math.abs(kl) + Math.abs(kr)), ba = 0.5 * (Math.abs(bl) + Math.abs(br));
      this.kAmp += (ka > this.kAmp ? c.ampA : c.ampR) * (ka - this.kAmp);
      this.bAmp += (ba > this.bAmp ? c.ampA : c.ampR) * (ba - this.bAmp);
      const share = this.kAmp / (this.kAmp + this.bAmp + 1e-9);
      // уступает только в момент удара (~60 мс), а не всё время
      this.kOn += (tr > this.kOn ? 1 : c.onRel) * (tr - this.kOn);
      const dt = db2lin(-cur[5] * this.kOn * Math.min(1, share * 2));
      this.dG += (dt < this.dG ? c.duckIn : c.duckOut) * (dt - this.dG);
      this.bRef += (this.bAmp > this.bRef ? c.envA : c.refR) * (this.bAmp - this.bRef);
      let up = 1;
      if (cur[3] > 0 && this.bRef > 1e-4 && this.bAmp > this.bRef * 0.05) up = Math.min(db2lin(6 * cur[3]), Math.pow(this.bRef / this.bAmp, 0.8 * cur[3]));
      this.bG += (up < this.bG ? c.bDown : c.envR) * (up - this.bG);
      const bassG = this.bG * this.dG * db2lin(cur[2]), restG = db2lin(cur[6]);
      // сатурация по дорожкам: бас — мягкое насыщение (толще, пики сглажены), кик — подрезка вершины удара
      // порог — от собственного уровня дорожки: насыщается ровно прибавка; гармоники — только до ~800 Гц
      // пики дорожек до обработки — порог насыщения: выше исходного пика прибавка не выходит
      const bp = Math.max(Math.abs(bl), Math.abs(br)), kpk = Math.max(Math.abs(kl), Math.abs(kr));
      this.bPk = bp > this.bPk ? bp : this.bPk + (bp - this.bPk) * c.refR;
      this.kPk = kpk > this.kPk ? kpk : this.kPk + (kpk - this.kPk) * c.refR;
      // восстановление ударов на «остальном» (атаки малого, хэтов, гитар) — в запас, освобождённый P_HEADROOM
      const rp = 0.25 * (rl + rr) * (rl + rr);
      this.rF += (rp > this.rF ? c.kfA : c.kRel) * (rp - this.rF);
      this.rS += (rp > this.rS ? c.ksA : c.kRel) * (rp - this.rS);
      const rtr = Math.min(1, Math.max(0, (this.rF / (this.rS + 1e-12) - 3) / 6)); // только резкие атаки
      this.rG += c.gA * (1 + this.restore * rtr - this.rG);
      const restG2 = restG * this.rG;
      const hS = cur[4], hK = cur[1] * 0.6, tB = Math.max(1e-4, this.bPk), tK = Math.max(1e-4, this.kPk);
      // окраска «остального»: тёплое насыщение ниже ~4 кГц, порог от недавнего пика дорожки
      const col = this.color, rpk = Math.max(Math.abs(rl), Math.abs(rr)) * restG2;
      this.rPk = rpk > this.rPk ? rpk : this.rPk + (rpk - this.rPk) * c.refR;
      // параллельное насыщение: копия разогрета ~+12 дБ, смягчена сверху, без постоянной составляющей, подмешана
      const ref = Math.max(1e-4, 0.25 * this.rPk), bias = 0.3, sb = sat(bias);
      for (let ch = 0; ch < 2; ch++) {
        const x = (ch ? br : bl) * bassG, k = (ch ? kr : kl) * kickG;
        let r = (ch ? rr : rl) * restG2;
        this.satB[ch] += c.satA * (hS * (softClip(x, tB) - x) - this.satB[ch]);
        this.satK[ch] += c.satA * (hK * (softClip(k, tK) - k) - this.satK[ch]);
        if (col > 0) {
          const s = (sat(r / ref + bias) - sb) * ref * 0.9;
          this.cLp[ch] += c.colA * (s - this.cLp[ch]); this.cLp2[ch] += c.colA * (this.cLp[ch] - this.cLp2[ch]);
          this.cDc[ch] += c.dcA * (this.cLp2[ch] - this.cDc[ch]);
          r += col * 0.8 * (this.cLp2[ch] - this.cDc[ch]);
        }
        const y = k + this.satK[ch] + x + this.satB[ch] + r;
        if (ch) oR[i] = y;
        else oL[i] = y;
      }
    }
    return true;
  }
}

// Ducking пространства (порт из space() в native/win/dsp.h): вход 0 — реверб и дилей, вход 1 — сухой звук.
// Пока звучит музыка (удары, вокал), хвосты тише; в паузах проявляются — объём без каши.
class DuckerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { depth: 0 }; this.env = 0; this.ref = 0; this.g = 1;
    const t = (ms) => 1 - Math.exp(-1 / (ms * 0.001 * sampleRate));
    this.aA = t(10); this.aR = t(250); this.aAvg = t(2000);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    const wet = inputs[0], dry = inputs[1], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    if (!wet || !wet.length) { oL.fill(0); oR.fill(0); return true; }
    const wL = wet[0], wR = wet[1] || wet[0], dL = dry && dry[0], dR = dry && (dry[1] || dry[0]);
    for (let i = 0; i < wL.length; i++) {
      // огибающая мощности сухого звука против её среднего за 2 с: приглушаются только моменты громче
      // обычного (удар, вступление вокала), а ровно звучащая музыка хвосты не глушит
      const m = dL ? 0.5 * (dL[i] + dR[i]) : 0, d = m * m;
      this.env += (d > this.env ? this.aA : this.aR) * (d - this.env);
      this.ref += this.aAvg * (this.env - this.ref);
      const over = Math.min(1, Math.max(0, Math.sqrt(this.env / (this.ref + 1e-12)) - 1.1));
      this.g += 0.002 * (db2lin(-12 * this.p.depth * over) - this.g);
      oL[i] = wL[i] * this.g; oR[i] = wR[i] * this.g;
    }
    return true;
  }
}

// Ширина стерео (mid/side), бас ниже ~150 Гц не расширяется, чтобы не «размывать» низ.
class WidthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { width: 1, bypass: false }; this.w = 1; this.sLp = 0;
    this.aLp = 1 - Math.exp(-2 * Math.PI * 150 / sampleRate);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    const b = io(inputs, outputs); if (!b) return true;
    const { L, R, oL, oR } = b;
    const target = this.p.bypass ? 1 : this.p.width;
    let w = this.w, sLp = this.sLp;
    for (let i = 0; i < L.length; i++) {
      w += (target - w) * 0.0004;
      const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5;
      sLp += this.aLp * (s - sLp);
      const so = sLp * (w < 1 ? w : 1) + (s - sLp) * w;
      oL[i] = m + so; oR[i] = m - so;
    }
    this.w = w; this.sLp = sLp;
    return true;
  }
}

// Ограничитель низа (порт lowLimiter из native/win/dsp.h): если пик создают кик и бас, приглушается
// только низ (ниже ~400 Гц), вокал и инструменты не трогаются — нет «качания» всей музыки на ударах.
class LowLimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { ceiling: -1, bypass: false };
    this.N = Math.max(1, Math.round(0.005 * sampleRate));
    this.buf = [0, 1, 2, 3].map(() => new Float32Array(this.N)); this.pos = 0;
    this.cap = this.N + 4; this.dqV = new Float32Array(this.cap); this.dqI = new Float64Array(this.cap);
    this.head = 0; this.tail = 0; this.idx = 0; this.g = 1;
    this.s = [[0, 0], [0, 0]];
    this.a = 1 - Math.exp(-2 * Math.PI * 400 / sampleRate);
    this.aAtt = 1 - Math.exp(-4 / this.N); this.aRel = coef(15); // быстро отпускает: срезается вершина удара, а не бас после него
    this.gMin = db2lin(-6);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    const b = io(inputs, outputs); if (!b) return true;
    const { L, R, oL, oR } = b, p = this.p;
    if (p.bypass) { oL.set(L); oR.set(R); return true; }
    const ceil = db2lin(p.ceiling), N = this.N, cap = this.cap, dqV = this.dqV, dqI = this.dqI, a = this.a, buf = this.buf, st = this.s;
    let g = this.g, pos = this.pos, head = this.head, tail = this.tail, idx = this.idx;
    const lo = [0, 0], hi = [0, 0];
    for (let i = 0; i < L.length; i++, idx++) {
      let t = 1;
      for (let c = 0; c < 2; c++) {
        const x = c ? R[i] : L[i], s = st[c];
        s[0] += a * (x - s[0]); s[1] += a * (s[0] - s[1]);
        lo[c] = s[1]; hi[c] = x - s[1];
        if (Math.abs(x) > ceil && lo[c] * x > 0) t = Math.min(t, Math.max(this.gMin, (Math.sign(x) * ceil - hi[c]) / lo[c]));
      }
      while (tail > head && dqV[(tail - 1) % cap] >= t) tail--;
      dqV[tail % cap] = t; dqI[tail % cap] = idx; tail++;
      while (dqI[head % cap] <= idx - (N + 1)) head++;
      const m = dqV[head % cap];
      g += m < g ? (m - g) * this.aAtt : (m - g) * (1 - this.aRel);
      oL[i] = buf[0][pos] + buf[2][pos] * g; oR[i] = buf[1][pos] + buf[3][pos] * g;
      buf[0][pos] = hi[0]; buf[1][pos] = hi[1]; buf[2][pos] = lo[0]; buf[3][pos] = lo[1];
      pos = pos + 1 === N ? 0 : pos + 1;
    }
    Object.assign(this, { g, pos, head, tail, idx });
    return true;
  }
}

// Лимитер с look-ahead 5 мс: скользящий минимум требуемого усиления (монотонная очередь),
// плавная атака за время look-ahead и финальный клип как страховка.
class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { ceiling: -1, release: 120, drive: 0, bypass: false };
    this.N = Math.max(1, Math.round(0.005 * sampleRate));
    this.bufL = new Float32Array(this.N); this.bufR = new Float32Array(this.N); this.pos = 0;
    this.cap = this.N + 4; this.dqV = new Float32Array(this.cap); this.dqI = new Float64Array(this.cap);
    this.head = 0; this.tail = 0; this.idx = 0; this.g = 1;
    this.aAtt = 1 - Math.exp(-4 / this.N);
    this.meter = new Meter(this.port, 30);
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.update(); };
    this.update();
  }
  update() { this.aRel = coef(this.p.release); }
  process(inputs, outputs) {
    const b = io(inputs, outputs); if (!b) return true;
    const { L, R, oL, oR } = b, p = this.p;
    const drive = db2lin(p.drive), ceil = db2lin(p.ceiling);
    if (p.bypass) {
      let pk = 0;
      for (let i = 0; i < L.length; i++) { oL[i] = L[i]; oR[i] = R[i]; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); }
      this.meter.tick({ gr: 0, peak: pk }); return true;
    }
    const N = this.N, cap = this.cap, dqV = this.dqV, dqI = this.dqI;
    let g = this.g, pos = this.pos, head = this.head, tail = this.tail, idx = this.idx, minG = 1, pk = 0;
    for (let i = 0; i < L.length; i++, idx++) {
      const l = L[i] * drive, r = R[i] * drive;
      const a = Math.max(Math.abs(l), Math.abs(r));
      const t = a > ceil ? ceil / a : 1;
      while (tail > head && dqV[(tail - 1) % cap] >= t) tail--;
      dqV[tail % cap] = t; dqI[tail % cap] = idx; tail++;
      while (dqI[head % cap] <= idx - (N + 1)) head++;
      const m = dqV[head % cap];
      g += m < g ? (m - g) * this.aAtt : (m - g) * (1 - this.aRel);
      const dl = this.bufL[pos], dr = this.bufR[pos];
      this.bufL[pos] = l; this.bufR[pos] = r; pos = pos + 1 === N ? 0 : pos + 1;
      let ol = dl * g, or = dr * g;
      if (ol > ceil) ol = ceil; else if (ol < -ceil) ol = -ceil;
      if (or > ceil) or = ceil; else if (or < -ceil) or = -ceil;
      oL[i] = ol; oR[i] = or;
      if (g < minG) minG = g;
      const ao = Math.max(Math.abs(ol), Math.abs(or)); if (ao > pk) pk = ao;
    }
    Object.assign(this, { g, pos, head, tail, idx });
    this.meter.tick({ gr: -lin2db(minG), peak: pk });
    return true;
  }
}

// «Умная динамика»: применяет поправки 4 полос (бас / низ-середина / середина / верх), которые
// вычисляет анализатор (SmartBalance в balance.js): полоса, вышедшая за норму стиля, мягко поджимается.
// Здесь же защита баса — пики низа выше порога гасятся (динамик не «упирается»), а убранное
// возвращается гармониками: бас ощущается так же плотно, но без перегруза.
// Полосы делятся комплементарно (сумма полос = исходник), так что при нулевых поправках звук не меняется.
class SmartDynamicsProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.p = { gains: [0, 0, 0, 0], amount: 0.6, bassLimit: -9, bypass: false, ...(opts && opts.processorOptions) };
    const a = (hz) => 1 - Math.exp(-2 * Math.PI * hz / sampleRate);
    this.a1 = a(120); this.a2 = a(500); this.a3 = a(4000); this.aH = a(150);
    this.q0 = new Float64Array(4); this.q1 = new Float64Array(4);
    this.g = new Float64Array(4);
    this.lin = new Float64Array(4).fill(1);
    this.bands = new Float64Array(4);
    this.harm = 0; this.pk = 0;
    this.aAtt = coef(20, sampleRate / CR);
    this.aRel = coef(300, sampleRate / CR);
    this.aPk = coef(80, sampleRate / CR);
    this.meter = new Meter(this.port, 15);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    const b = io(inputs, outputs); if (!b) return true;
    const { L, R, oL, oR } = b, p = this.p;
    if (p.bypass || p.amount <= 0) {
      oL.set(L); oR.set(R);
      this.g.fill(0); this.lin.fill(1); this.harm = 0;
      if (this.meter.n + 1 >= this.meter.every) this.meter.tick({ bands: [0, 0, 0, 0] }); else this.meter.n++;
      return true;
    }
    const { a1, a2, a3, aH, g, lin } = this;
    for (let i0 = 0; i0 < L.length; i0 += CR) {
      // пик баса (для защиты динамика): по фильтру первой полосы, без изменения состояния звука
      let lowPk = 0;
      for (let i = i0; i < i0 + CR; i++) { const v = Math.abs(this.q0[0] + a1 * (L[i] - this.q0[0])); if (v > lowPk) lowPk = v; }
      this.pk = lowPk > this.pk ? lowPk : this.aPk * this.pk + (1 - this.aPk) * lowPk;
      for (let k = 0; k < 4; k++) {
        let target = p.gains[k] || 0;
        if (k === 0) {
          const over = lin2db(this.pk) - p.bassLimit;
          if (over > 0) target = Math.min(target, -Math.min(8, over * 0.8) * p.amount);
        }
        g[k] = target < g[k] ? this.aAtt * g[k] + (1 - this.aAtt) * target : this.aRel * g[k] + (1 - this.aRel) * target;
        if (g[k] > -1e-3 && g[k] < 1e-3) g[k] = 0;
        this.bands[k] = g[k];
      }
      // сколько баса убрали — столько возвращаем гармониками
      const harmTarget = g[0] < 0 ? Math.min(1, -g[0] / 6) * 1.2 : 0;
      const n0 = db2lin(g[0]), n1 = db2lin(g[1]), n2 = db2lin(g[2]), n3 = db2lin(g[3]);
      const l0 = lin[0], l1 = lin[1], l2 = lin[2], l3 = lin[3], hm0 = this.harm;
      const d0 = (n0 - l0) / CR, d1 = (n1 - l1) / CR, d2 = (n2 - l2) / CR, d3 = (n3 - l3) / CR, dh = (harmTarget - hm0) / CR;
      for (let c = 0; c < 2; c++) {
        const x = c ? R : L, o = c ? oR : oL, q = c ? this.q1 : this.q0;
        for (let n = 1, i = i0; i < i0 + CR; i++, n++) {
          const v = x[i];
          q[0] += a1 * (v - q[0]); const b1 = q[0], r1 = v - b1;
          q[1] += a2 * (r1 - q[1]); const b2 = q[1], r2 = r1 - b2;
          q[2] += a3 * (r2 - q[2]); const b3 = q[2], b4 = r2 - b3;
          const h = sat(b1 * 4) * 0.25 - b1;
          q[3] += aH * (h - q[3]);
          o[i] = b1 * (l0 + d0 * n) + b2 * (l1 + d1 * n) + b3 * (l2 + d2 * n) + b4 * (l3 + d3 * n) + (h - q[3]) * (hm0 + dh * n);
        }
      }
      lin[0] = n0; lin[1] = n1; lin[2] = n2; lin[3] = n3;
      this.harm = harmTarget;
    }
    if (this.meter.n + 1 >= this.meter.every) this.meter.tick({ bands: Array.from(this.bands) }); else this.meter.n++;
    return true;
  }
}

registerProcessor('smart-dynamics', SmartDynamicsProcessor);
registerProcessor('pcm-source', PcmSourceProcessor);
registerProcessor('compressor', CompressorProcessor);
registerProcessor('deesser', DeesserProcessor);
registerProcessor('stems', StemsProcessor);
registerProcessor('ducker', DuckerProcessor);
registerProcessor('enhancer', EnhancerProcessor);
registerProcessor('stereo-width', WidthProcessor);
registerProcessor('low-limiter', LowLimiterProcessor);
registerProcessor('limiter', LimiterProcessor);
`;
