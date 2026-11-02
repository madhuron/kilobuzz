import { EQ_FREQS } from './profiles.js';

/**
 * Автобаланс тембра: сравнивает долгосрочный спектр трека (энергия по октавам вокруг полос EQ)
 * с эталонным балансом хорошо сведённой музыки и мягко подтягивает трек к нему.
 * Так тёмный трек становится чуть светлее, гулкий — чище, резкий — мягче, даже если сведение неудачное.
 *
 * Эталоны — энергия на октаву относительно полосы 1 кГц (дБ). Это усреднённые оценки баланса
 * коммерческих миксов разных стилей; коррекция ограничена по силе, поэтому неточность эталона
 * не превращается в окраску.
 */
const TARGETS = {
  edm:       [2, 6, 5, 3, 1, 0, -2, -4, -6, -11],
  hiphop:    [3, 7, 5, 3, 1, 0, -2, -4, -6.5, -12],
  pop:       [0, 4, 4, 3, 1.5, 0, -1.5, -3.5, -5.5, -11],
  rnb:       [1, 5, 4.5, 3, 1.5, 0, -2, -4, -6, -12],
  rock:      [-2, 2, 3, 3, 2, 0, -1, -3, -5, -11],
  metal:     [-2, 2, 3, 2.5, 1.5, 0, -0.5, -2.5, -4.5, -10],
  jazz:      [-4, 0, 2, 3, 2, 0, -2, -4, -7, -13],
  classical: [-5, -1, 1.5, 3, 2.5, 0, -2, -4.5, -7.5, -14],
  acoustic:  [-4, 0, 2, 3, 2, 0, -1.5, -3.5, -6.5, -12],
  lofi:      [0, 4, 4, 3, 2, 0, -2.5, -5, -8, -14],
};
// Пределы коррекции по полосам: подъёмы скромнее срезов; в зоне «гула» (250–500) почти не поднимаем.
const MAX_UP = [1.5, 3, 2.5, 1, 1, 1.5, 1.5, 1.5, 2.5, 3];
// Срезаем только недостатки: гул (250–500) и резкость (2–4 кГц). Сочный бас (32–125) и воздух (8–16 кГц)
// автобаланс не трогает: «лишний» бас в электронике — это не ошибка сведения, а то, ради чего её слушают.
// Иначе звук подтягивается к «среднему» эталону и становится плоским.
const MAX_DOWN = [0, 0, -0.5, -2.5, -3, -1.5, -2.5, -2, -0.5, 0];

export const BAND_EDGES = EQ_FREQS.map((f, i) => [i === 0 ? 20 : f / Math.SQRT2, i === EQ_FREQS.length - 1 ? 20000 : f * Math.SQRT2]);

const dB = (p) => 10 * Math.log10(p + 1e-20);
const ref = (arr) => (arr[4] + arr[5] + arr[6]) / 3;

export class TonalBalance {
  constructor() { this.reset(); }

  reset() {
    this.p = null;
    this.sec = 0;
  }

  /** oct — энергия по 10 октавам (линейная), кадр 20 мс. */
  push(oct) {
    this.sec += 0.02;
    // Быстро в начале трека, потом медленно (~20 с): баланс трека в целом, а не текущей секции.
    const tau = Math.min(20, 1.5 + this.sec);
    const a = 1 - Math.exp(-0.02 / tau);
    if (!this.p) this.p = Float64Array.from(oct);
    else for (let i = 0; i < 10; i++) this.p[i] += (oct[i] - this.p[i]) * a;
  }

  get confidence() {
    return Math.min(1, this.sec / 10);
  }

  /** Возвращает поправку EQ (дБ по полосам) и человеко-понятное описание. */
  /** devRes — остаточное отклонение устройства по октавам: учитываем, что слышит человек = трек × устройство. */
  correction(probs, strength = 0.5, devRes = null, fLow = 0) {
    const eq = new Array(10).fill(0);
    if (!this.p || this.sec < 1.5) return { eq, summary: 'Анализ баланса…', rel: null };
    const rel = Array.from(this.p, dB);
    const r0 = ref(rel);
    for (let i = 0; i < 10; i++) rel[i] -= r0 - (devRes?.[i] || 0);

    const tgt = new Array(10).fill(0);
    let sum = 0;
    for (const k in probs) sum += probs[k];
    for (const k in probs) TARGETS[k]?.forEach((v, i) => (tgt[i] += (v * probs[k]) / (sum || 1)));
    const t0 = ref(tgt);

    const diff = tgt.map((v, i) => v - t0 - rel[i]);
    const sm = diff.map((d, i) => 0.25 * (diff[i - 1] ?? d) + 0.5 * d + 0.25 * (diff[i + 1] ?? d));
    const k = strength * this.confidence;
    for (let i = 0; i < 10; i++) {
      let up = MAX_UP[i];
      if (i === 0 && rel[0] < -25) up = 0; // в записи нет суббаса — поднимать нечего, будет только гул
      if (EQ_FREQS[i] < fLow * 0.9) up = 0; // устройство физически не играет эти частоты
      eq[i] = Math.max(MAX_DOWN[i], Math.min(up, sm[i] * k));
    }
    return { eq, summary: describe(eq), rel };
  }
}

function describe(eq) {
  const parts = [];
  const avg = (a, b) => eq.slice(a, b + 1).reduce((x, y) => x + y, 0) / (b - a + 1);
  const low = avg(0, 1), mud = avg(2, 4), pres = avg(6, 7), air = avg(8, 9);
  const say = (v, plus, minus) => {
    if (v > 0.7) parts.push(`${plus} +${v.toFixed(1)}`);
    else if (v < -0.7) parts.push(`${minus} ${v.toFixed(1)}`);
  };
  say(low, 'бас', 'бас');
  say(mud, 'тело', 'гул');
  say(pres, 'чёткость', 'резкость');
  say(air, 'воздух', 'шипение');
  return parts.length ? parts.join(' · ') + ' дБ' : 'Баланс трека в норме';
}

// Группы октав для 4 полос умной динамики: бас (32–64 + пол-125), низ-середина (пол-125–500),
// середина (1–2 кГц + пол-4к) — опорная, верх (пол-4к–16 кГц)
const GROUPS = [
  [[0, 1], [1, 1], [2, 0.5]],
  [[2, 0.5], [3, 1], [4, 1]],
  [[5, 1], [6, 1], [7, 0.5]],
  [[7, 0.5], [8, 1], [9, 1]],
];
const groupDb = (lin) => GROUPS.map((g) => 10 * Math.log10(g.reduce((s, [i, w]) => s + w * lin[i], 0) + 1e-20));
const TOL = [7, 3, 0, 2.5];   // насколько полосе можно отклоняться от нормы стиля без вмешательства (жирный бас — норма)
const MAX_CUT = [-2, -5, 0, -3];
const MAX_LIFT = [0, 0, 0, 2];

/**
 * Быстрый баланс полос для «умной динамики»: уровень каждой полосы относительно середины
 * сравнивается с нормой стиля (те же эталоны, что у автобаланса). Нормальный мощный дроп
 * не трогается; поджимается только то, что выходит за норму (гудящая нота, резкий верх).
 * Учитывает поправку автобаланса, чтобы не резать одно и то же дважды.
 */
export class SmartBalance {
  constructor() { this.p = null; }
  reset() { this.p = null; }

  push(oct) {
    const a = 1 - Math.exp(-0.02 / 0.25); // ~250 мс
    if (!this.p) this.p = Float64Array.from(oct);
    else for (let i = 0; i < 10; i++) this.p[i] += (oct[i] - this.p[i]) * a;
  }

  gains(probs, staticEq, amount, devRes = null) {
    const out = [0, 0, 0, 0];
    if (!this.p || amount <= 0) return out;
    const lvl = groupDb(this.p);
    if (devRes) GROUPS.forEach((g, k) => (lvl[k] += g.reduce((s, [i, w]) => s + w * devRes[i], 0) / g.reduce((s, [, w]) => s + w, 0)));
    const tgtLin = new Array(10).fill(0);
    let sum = 0;
    for (const k in probs) sum += probs[k];
    for (const k in probs) TARGETS[k]?.forEach((v, i) => (tgtLin[i] += (10 ** (v / 10) * probs[k]) / (sum || 1)));
    const tgt = groupDb(tgtLin);
    // Если середины почти нет (вступление из одного пэда, бас-соло), сравнивать не с чем — не вмешиваемся.
    const total = 10 * Math.log10(lvl.reduce((x, d) => x + 10 ** (d / 10), 0));
    const conf = Math.max(0, Math.min(1, (lvl[2] - total + 22) / 10));
    if (conf <= 0) return out;
    amount *= conf;
    const eqG = GROUPS.map((g) => g.reduce((s, [i, w]) => s + w * (staticEq?.[i] || 0), 0) / g.reduce((s, [, w]) => s + w, 0));
    for (const k of [0, 1, 3]) {
      const excess = (lvl[k] + eqG[k]) - (lvl[2] + eqG[2]) - (tgt[k] - tgt[2]);
      if (excess > TOL[k]) out[k] = Math.max(MAX_CUT[k], -(excess - TOL[k]) * 1.1 * amount);
      else if (excess < -TOL[k] - 2 && MAX_LIFT[k] > 0) out[k] = Math.min(MAX_LIFT[k], (-excess - TOL[k] - 2) * 0.4) * amount;
    }
    return out;
  }
}

/**
 * Автоплотность: по разбросу кратковременной громкости (~15 с) понимает, насколько трек
 * динамичный/«тонкий» (need → 1) или уже плотный, как современный мастер (need → 0).
 * Обработка добавляет сжатие и тепло ровно настолько, насколько их не хватает этому треку.
 */
export class DensityMeter {
  constructor() { this.reset(); }
  reset() { this.h = []; this.n = 0; }
  push(loud) {
    if (++this.n % 10) return; // 5 раз в секунду
    this.h.push(loud);
    if (this.h.length > 75) this.h.shift();
  }
  get lra() {
    if (this.h.length < 15) return null;
    const s = [...this.h].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.2)];
  }
  get need() {
    const r = this.lra;
    return r == null ? 0.5 : Math.max(0, Math.min(1, (r - 4) / 7));
  }
}
