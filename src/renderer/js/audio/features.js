import { BAND_EDGES } from './balance.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const dB = (p) => 10 * Math.log10(p + 1e-12);

const BANDS = [
  ['sub', 20, 60], ['bass', 60, 250], ['lowmid', 250, 500], ['mid', 500, 2000],
  ['presence', 2000, 4000], ['brill', 4000, 8000], ['air', 8000, 16000],
];

/** Извлекает признаки звука ~50 раз/с из M/S-анализаторов движка. */
export class FeatureExtractor {
  constructor(engine) {
    const an = engine.anM;
    this.e = engine;
    this.N = an.frequencyBinCount;
    this.binHz = engine.ctx.sampleRate / an.fftSize;
    this.dbM = new Float32Array(this.N);
    this.dbS = new Float32Array(this.N);
    this.prev = new Float32Array(this.N).fill(-100);
    this.tM = new Float32Array(an.fftSize);
    this.tS = new Float32Array(an.fftSize);
    this.vHist = [];
    this.k0 = this.bin(20);
    this.k1 = this.bin(20000);
    // номер октавной полосы EQ для каждого бина (для автобаланса)
    this.binBand = new Int8Array(this.N).fill(-1);
    for (let k = 0; k < this.N; k++) {
      const f = k * this.binHz;
      this.binBand[k] = BAND_EDGES.findIndex(([a, b]) => f >= a && f < b);
    }
  }

  bin(hz) {
    return Math.min(this.N - 1, Math.max(1, Math.round(hz / this.binHz)));
  }

  frame(t) {
    const { anM, anS } = this.e;
    anM.getFloatTimeDomainData(this.tM);
    anS.getFloatTimeDomainData(this.tS);
    let ms = 0;
    for (let i = 0; i < this.tM.length; i++) ms += this.tM[i] * this.tM[i] + this.tS[i] * this.tS[i];
    const loud = dB(ms / this.tM.length);
    if (loud < -65) return { t, silent: true, loud };

    anM.getFloatFrequencyData(this.dbM);
    anS.getFloatFrequencyData(this.dbS);

    const band = { sub: 0, bass: 0, lowmid: 0, mid: 0, presence: 0, brill: 0, air: 0 };
    const oct = new Float64Array(10);
    const spec = (this.spec ??= new Float32Array(this.N));
    let total = 0, magSum = 0, cent = 0, vM = 0, vS = 0, logSum = 0, ari = 0, cnt = 0, flux = 0, bassFlux = 0, sideP = 0;
    for (let k = this.k0; k <= this.k1; k++) {
      const f = k * this.binHz;
      const dm = Math.max(-100, this.dbM[k]), ds = Math.max(-100, this.dbS[k]);
      const pm = Math.exp(dm * 0.23025850929940458), ps = Math.exp(ds * 0.23025850929940458), p = pm + ps;
      spec[k] = 10 * Math.log10(p + 1e-20);
      const bb = this.binBand[k];
      if (bb >= 0) oct[bb] += p;
      if (f > 16000) continue;
      total += p;
      sideP += ps;
      const mag = Math.sqrt(p);
      magSum += mag;
      cent += f * mag;
      for (const [name, a, b] of BANDS) if (f >= a && f < b) { band[name] += p; break; }
      if (f >= 250 && f < 3500) { vM += pm; vS += ps; }
      if (f >= 200 && f < 6000) { logSum += Math.log(p + 1e-20); ari += p; cnt++; }
      const d = dm - this.prev[k];
      if (d > 0) {
        flux += d;
        if (f < 150) bassFlux += d;
      }
      this.prev[k] = dm;
    }
    const nb = this.k1 - this.k0 + 1;
    const flat = cnt ? Math.exp(logSum / cnt) / (ari / cnt + 1e-20) : 0;
    const centroid = cent / (magSum + 1e-12);

    // Оценка вокала: центр стереобазы + доля вокальной полосы + слоговая модуляция + тональность.
    const vdb = dB(vM);
    this.vHist.push(vdb);
    if (this.vHist.length > 75) this.vHist.shift();
    let mod = 0;
    for (let i = 1; i < this.vHist.length; i++) mod += Math.abs(this.vHist[i] - this.vHist[i - 1]);
    mod /= Math.max(1, this.vHist.length - 1);
    const center = vM / (vM + vS + 1e-12);
    const vRel = vdb - dB(total);
    const vocalRaw =
      0.35 * clamp01((center - 0.6) / 0.35) +
      0.25 * clamp01((vRel + 9) / 6) +
      0.2 * clamp01((mod - 0.6) / 1.6) +
      0.2 * clamp01((1 - flat - 0.55) / 0.4);

    const bands = {};
    for (const k in band) bands[k] = dB(band[k]);
    return {
      t, silent: false, loud,
      bands, oct, spec,
      total: dB(total),
      lowRatio: dB(band.sub + band.bass) - dB(total),
      highDb: dB(band.brill + band.air),
      centroid, flat,
      flux: flux / nb,
      bassFlux,
      vocal: clamp01(vocalRaw),
      width: sideP / (total + 1e-12),
    };
  }
}

/** Оценка темпа автокорреляцией огибающей атак (спектрального потока). */
export class TempoTracker {
  constructor() { this.reset(); }
  reset() {
    this.env = [];
    this.times = [];
    this.bpm = 0;
    this.regularity = 0;
    this.lastEst = 0;
  }
  push(flux, t) {
    this.env.push(flux);
    this.times.push(t);
    if (this.env.length > 400) { this.env.shift(); this.times.shift(); }
    if (t - this.lastEst > 1 && this.env.length > 200) {
      this.lastEst = t;
      this._estimate();
    }
  }
  _estimate() {
    const n = this.env.length;
    const hop = (this.times[n - 1] - this.times[0]) / (n - 1);
    // Аудиочасы могли стоять (пауза устройства) — тогда шаг кадра бессмысленен, а диапазон лагов огромен.
    if (!(hop > 0.008 && hop < 0.1)) return;
    const mean = this.env.reduce((a, b) => a + b, 0) / n;
    const x = this.env.map((v) => v - mean);
    const ac = (lag) => {
      let s = 0;
      for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
      return s / (n - lag);
    };
    const r0 = ac(0) || 1e-9;
    const minLag = Math.floor(60 / (185 * hop)), maxLag = Math.ceil(60 / (68 * hop));
    let best = -Infinity, bestLag = 0;
    const vals = [];
    for (let l = minLag; l <= 2 * maxLag + 2 && l < n - 10; l++) vals[l] = ac(l);
    // Счёт кандидата: автокорреляция + её «гармоника» на двойном лаге, с мягким априори вокруг 120 BPM —
    // так меньше путаницы между темпом, половинным и полуторным.
    const score = (l) => {
      const bpm = 60 / (l * hop);
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      return (vals[l] + 0.5 * (vals[2 * l] ?? 0)) * prior;
    };
    for (let l = minLag + 1; l <= maxLag; l++) {
      if (vals[l] >= vals[l - 1] && vals[l] >= vals[l + 1]) {
        const sc = score(l);
        if (sc > best) { best = sc; bestLag = l; }
      }
    }
    if (!bestLag) return;
    const a = vals[bestLag - 1], b = vals[bestLag], c = vals[bestLag + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    const bpm = 60 / ((bestLag + Math.max(-0.5, Math.min(0.5, shift))) * hop);
    this.bpm = this.bpm ? this.bpm * 0.7 + bpm * 0.3 : bpm;
    if (Math.abs(bpm - this.bpm) > 15) this.bpm = bpm;
    this.regularity = clamp01(vals[bestLag] / r0);
  }
}
