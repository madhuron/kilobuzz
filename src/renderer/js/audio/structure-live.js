const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const hi = (x, a, b) => clamp01((x - a) / (b - a));
const lo = (x, a, b) => 1 - hi(x, a, b);
const band = (x, a, b, c, d) => hi(x, a, b) * lo(x, c, d);

function rank(arr, key, v) {
  if (!arr.length) return 0.5;
  let below = 0;
  for (const e of arr) if (e[key] < v) below++;
  return below / arr.length;
}

function slope(arr, key) {
  const n = arr.length;
  if (n < 5) return 0;
  const t0 = arr[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const e of arr) {
    const x = e.t - t0, y = e[key];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  return den ? (n * sxy - sx * sy) / den : 0;
}

/**
 * Определение секции трека в реальном времени (для системного звука, где файла целиком нет).
 * Нечёткие правила по относительной громкости/басу (перцентиль внутри трека), плотности бочки,
 * тренду («райзеры») и оценке вокала + гистерезис, чтобы не дёргаться.
 */
export class LiveStructure {
  constructor() {
    this.edmness = 0.5;
    this.reset();
  }

  reset() {
    this.t0 = null;
    this.s = null;
    this.fast = null;
    this.long = [];
    this.recent = [];
    this.kicks = [];
    this.bfMean = 0;
    this.prevBf = 0;
    this.lastDecim = -1;
    this.label = 'intro';
    this.since = 0;
    this.cand = null;
    this.candSince = 0;
    this.peaked = false;
    this.history = [{ t: 0, label: 'intro' }];
    this.scores = {};
    this.metrics = {};
    this.trackTime = 0;
    this.longLoud = NaN;
    this.loudHigh = NaN;
  }

  push(f, trackTime, duration) {
    if (this.t0 === null) this.t0 = f.t;
    const t = Number.isFinite(trackTime) ? trackTime : f.t - this.t0;
    this.trackTime = t;
    if (f.silent) return;

    const ema = (prev, v, tau) => (prev === null ? v : prev + (v - prev) * (1 - Math.exp(-0.02 / tau)));
    const s = this.s ?? { loud: f.loud, bass: f.bands.bass, high: f.highDb, vocal: f.vocal };
    s.loud = ema(s.loud, f.loud, 1.5);
    s.bass = ema(s.bass, Math.max(f.bands.sub, f.bands.bass), 1.5);
    s.high = ema(s.high, f.highDb, 1.5);
    s.vocal = ema(s.vocal, f.vocal, 2.5);
    this.s = s;
    const fast = this.fast ?? { loud: f.loud, bass: f.bands.bass };
    fast.loud = ema(fast.loud, f.loud, 0.25);
    fast.bass = ema(fast.bass, Math.max(f.bands.sub, f.bands.bass), 0.25);
    this.fast = fast;

    // Удары бочки: пики потока в басу выше адаптивного порога.
    this.bfMean = ema(this.bfMean, f.bassFlux, 2);
    if (f.bassFlux > this.bfMean * 1.8 + 2 && f.bassFlux > this.prevBf && f.t - (this.kicks.at(-1) ?? 0) > 0.22) this.kicks.push(f.t);
    this.prevBf = f.bassFlux;
    while (this.kicks.length && f.t - this.kicks[0] > 4) this.kicks.shift();
    const kickRate = this.kicks.length / 4;

    // История 5 Гц: длинная (перцентили внутри трека) и короткая (тренды, скачки).
    if (f.t - this.lastDecim >= 0.2) {
      this.lastDecim = f.t;
      const e = { t: f.t, loud: s.loud, bass: s.bass, high: s.high, fl: fast.loud, fb: fast.bass };
      this.long.push(e);
      this.recent.push(e);
      if (this.long.length > 900) this.long.shift();
      while (this.recent.length && f.t - this.recent[0].t > 8) this.recent.shift();
      const sorted = this.long.map((x) => x.loud).sort((a, b) => a - b);
      this.longLoud = sorted[Math.floor(sorted.length * 0.5)];
      this.loudHigh = sorted[Math.floor(sorted.length * 0.85)]; // уровень громких частей трека — ориентир для компрессора
    } else return;

    const histSec = this.long.length / 5;
    const wHist = clamp01(histSec / 25);
    const relLoud = wHist * rank(this.long, 'loud', s.loud) + (1 - wHist) * hi(s.loud, -30, -10);
    const relBass = wHist * rank(this.long, 'bass', s.bass) + (1 - wHist) * hi(s.bass, -35, -14);
    const loudSlope = slope(this.recent, 'loud');
    // Райзер — устойчивый рост на обеих половинах окна 8 с; одиночная ступенька (смена секции) не считается.
    const half = this.recent.findIndex((e) => f.t - e.t <= 4);
    const a = this.recent.slice(0, Math.max(0, half)), b = this.recent.slice(Math.max(0, half));
    const rise = (arr) => Math.max(slope(arr, 'high') / 0.8, slope(arr, 'loud') / 0.7);
    const riser = a.length >= 5 ? clamp01(Math.min(rise(a), rise(b))) : 0;
    const ago = this.recent.find((e) => f.t - e.t <= 1.6) ?? this.recent[0];
    const jump = ago ? Math.min(fast.loud - ago.fl, fast.bass - ago.fb) : 0;
    const vocal = s.vocal;
    const remaining = duration > 0 ? duration - t : Infinity;
    if (relLoud > 0.75) this.peaked = true;

    const edm = this.edmness;
    const prev = this.label;
    const sc = {
      drop:
        hi(relLoud, 0.55, 0.85) * hi(relBass, 0.5, 0.85) * hi(kickRate, 0.8, 1.8) * (0.55 + 0.45 * edm) * (1 - 0.45 * vocal) +
        ((prev === 'buildup' || prev === 'breakdown') && jump > 4 ? 0.6 : 0),
      chorus: hi(relLoud, 0.5, 0.8) * hi(vocal, 0.35, 0.6),
      verse: band(relLoud, 0.15, 0.35, 0.7, 0.85) * hi(vocal, 0.3, 0.55),
      buildup: hi(riser, 0.15, 0.6) * lo(relLoud, 0.8, 0.97) * (0.5 + 0.5 * edm),
      breakdown: lo(relLoud, 0.25, 0.5) * lo(relBass, 0.3, 0.55) * hi(t, 15, 30),
      instrumental: lo(vocal, 0.25, 0.45) * band(relLoud, 0.2, 0.4, 0.85, 1.01) * 0.8,
      intro: lo(t, 10, 25) * lo(relLoud, 0.55, 0.8) * (this.peaked ? 0 : 1),
      outro: lo(remaining, 8, 20) * (loudSlope <= 0.05 ? 1 : 0.4),
    };
    this.scores = sc;
    this.metrics = { relLoud, relBass, kickRate, vocal, riser, jump };

    let best = prev, bestV = -1;
    for (const k in sc) {
      const v = sc[k] + (k === prev ? 0.12 : 0);
      if (v > bestV) { bestV = v; best = k; }
    }
    if (best === prev) { this.cand = null; return; }
    if (this.cand !== best) { this.cand = best; this.candSince = f.t; }
    const hold = best === 'drop' ? 0.3 : 1.6;
    const dwell = best === 'drop' ? 0.5 : prev === 'drop' ? 4 : 2.5;
    if (f.t - this.candSince >= hold && t - this.since >= dwell) {
      this.label = best;
      this.since = t;
      this.cand = null;
      this.history.push({ t, label: best });
      if (this.history.length > 200) this.history.shift();
    }
  }

  current() {
    const sum = Object.values(this.scores).reduce((a, b) => a + b, 0) || 1;
    return {
      label: this.label,
      conf: (this.scores[this.label] ?? 0) / sum,
      progress: this.label === 'buildup' ? clamp01((this.trackTime - this.since) / 8) : 0,
      next: null,
    };
  }
}
