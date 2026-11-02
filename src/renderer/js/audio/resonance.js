/**
 * «Анти-бочка»: подавитель резонансов.
 * Ищет в спектре узкие пики, которые долго держатся на одной частоте (гул записи, «бубнящая» нота,
 * коробочность середины), и ставит на них узкие вырезы — только там и только пока пик есть.
 * Обычный эквалайзер так не умеет: широкий срез убирает гул вместе с телом звука.
 */
const BANDS = [
  // от, до (Гц), порог выступа (дБ), макс. вырез (дБ), добротность
  // ниже 150 Гц не трогаем: там основной тон кика и басовые ноты — это музыка, а не гул
  { lo: 150, hi: 500, thr: 5, max: 5, q: 5 },
  { lo: 500, hi: 5000, thr: 7, max: 3.5, q: 4 },
];
export const RES_SLOTS = 4;

export class ResonanceSuppressor {
  constructor(binHz, nBins) {
    this.binHz = binHz;
    this.n = nBins;
    this.k0 = Math.floor(70 / binHz);
    this.k1 = Math.min(nBins - 2, Math.ceil(5600 / binHz));
    this.avg = null;
    this.slots = Array.from({ length: RES_SLOTS }, () => ({ f: 1000, gain: 0, q: 4 }));
    // окна сглаживания (в бинах) для «широкого» спектра: ±1/3 октавы вокруг каждого бина
    this.win = new Int32Array(this.k1 + 1);
    for (let k = this.k0; k <= this.k1; k++) this.win[k] = Math.max(2, Math.round((k * (2 ** (1 / 3) - 1))));
  }

  reset() {
    this.avg = null;
    this.slots.forEach((s) => (s.gain = 0));
  }

  /** dbFrame — спектр кадра в дБ (Float32Array по бинам). Кадр ~20 мс. */
  push(dbFrame) {
    const a = 1 - Math.exp(-0.02 / 3); // устойчивость ~3 с: меняющиеся ноты не считаются резонансом
    if (!this.avg) {
      this.avg = new Float32Array(this.n);
      for (let k = this.k0; k <= this.k1; k++) this.avg[k] = dbFrame[k];
      return;
    }
    for (let k = this.k0; k <= this.k1; k++) this.avg[k] += (dbFrame[k] - this.avg[k]) * a;
  }

  /** Пересчёт вырезов (раз в ~100 мс). Возвращает [{f, gain, q}] для движка. */
  update(amount) {
    if (!this.avg || amount <= 0) {
      this.slots.forEach((s) => (s.gain *= 0.8));
      return this.slots;
    }
    const avg = this.avg, cands = [];
    // префиксные суммы для быстрого сглаживания
    const pre = new Float64Array(this.k1 + 2);
    for (let k = this.k0; k <= this.k1; k++) pre[k + 1] = pre[k] + avg[k];
    // уровень окружения: среднее по ±1/3 октавы БЕЗ самого пика (±2 бина), иначе пик занижает свой выступ
    const smooth = (k) => {
      const w = this.win[k], a = Math.max(this.k0, k - w - 2), b = Math.min(this.k1, k + w + 2);
      const ia = Math.max(a, k - 2), ib = Math.min(b, k + 2);
      return (pre[b + 1] - pre[a] - (pre[ib + 1] - pre[ia])) / (b - a + 1 - (ib - ia + 1));
    };
    for (const B of BANDS) {
      const ka = Math.max(this.k0 + 1, Math.floor(B.lo / this.binHz)), kb = Math.min(this.k1 - 1, Math.ceil(B.hi / this.binHz));
      for (let k = ka; k <= kb; k++) {
        if (avg[k] < avg[k - 1] || avg[k] < avg[k + 1]) continue;
        const prom = avg[k] - smooth(k);
        if (prom > B.thr) {
          // уточнение частоты пика параболой
          const y0 = avg[k - 1], y1 = avg[k], y2 = avg[k + 1];
          const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
          cands.push({ f: (k + Math.max(-0.5, Math.min(0.5, d))) * this.binHz, gain: -Math.min(B.max, (prom - B.thr) * 0.9) * amount, q: B.q, w: (prom - B.thr) * (B.lo < 500 ? 1.3 : 1) });
        }
      }
    }
    // Гармонический ряд (пики на кратных частотах) — это нота инструмента, а не резонанс:
    // в середине такие пики не трогаем вовсе, в басу — только вполсилы.
    for (const c of cands) {
      c.harm = cands.some((o) => {
        if (o === c) return false;
        const r = o.f > c.f ? o.f / c.f : c.f / o.f, n = Math.round(r);
        return n >= 2 && n <= 8 && Math.abs(r - n) < 0.03 * n;
      });
    }
    for (let i = cands.length - 1; i >= 0; i--) {
      const c = cands[i];
      if (!c.harm) continue;
      if (c.f >= 500) cands.splice(i, 1);
      else { c.gain *= 0.5; c.w *= 0.5; }
    }
    cands.sort((x, y) => y.w - x.w);
    const chosen = [];
    for (const c of cands) {
      if (chosen.every((o) => Math.abs(Math.log2(o.f / c.f)) > 1 / 3)) chosen.push(c);
      if (chosen.length === RES_SLOTS) break;
    }
    // сопоставление с текущими слотами: плавно ведём существующие вырезы, освобождённые гасим
    const used = new Set();
    for (const c of chosen) {
      let best = -1, bd = 1 / 6;
      this.slots.forEach((s, i) => {
        const d = Math.abs(Math.log2(s.f / c.f));
        if (!used.has(i) && s.gain < -0.1 && d < bd) { bd = d; best = i; }
      });
      if (best < 0) best = this.slots.findIndex((s, i) => !used.has(i) && s.gain > -0.1);
      if (best < 0) continue;
      used.add(best);
      const s = this.slots[best];
      if (s.gain > -0.1) s.f = c.f; else s.f += (c.f - s.f) * 0.3;
      s.q = c.q;
      s.gain += (c.gain - s.gain) * (c.gain < s.gain ? 0.5 : 0.15);
    }
    this.slots.forEach((s, i) => { if (!used.has(i)) s.gain *= 0.85; });
    return this.slots;
  }

  /** Для интерфейса: каждый вырез всегда на своём месте (слоты не пересортировываются), чтобы цифры не прыгали. */
  display() {
    return this.slots.map((s) => ({ f: s.f, gain: s.gain, active: s.gain < -0.3 }));
  }

  summary() {
    const act = this.slots.filter((s) => s.gain < -0.5).sort((a, b) => a.f - b.f);
    if (!act.length) return 'резонансов нет';
    return act.map((s) => `${s.f >= 1000 ? (s.f / 1000).toFixed(1) + ' кГц' : Math.round(s.f) + ' Гц'} ${s.gain.toFixed(1)}`).join(' · ');
  }
}
