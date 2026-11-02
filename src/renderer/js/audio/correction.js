/**
 * Профиль коррекции в формате Equalizer APO / AutoEq (ParametricEQ.txt):
 *   Preamp: -6.2 dB
 *   Filter 1: ON LSC Fc 105 Hz Gain -3.2 dB Q 0.70
 * Такой же формат экспортируют spinorama.org (колонки) и многие другие измерительные базы.
 */
export function parseParametricEq(text) {
  const preamp = parseFloat(text.match(/Preamp:\s*(-?[\d.]+)\s*dB/i)?.[1] ?? '0');
  const filters = [];
  const re = /Filter\s*\d*:\s*ON\s+(PK|PEQ|LSC|HSC|LS|HS|LSQ|HSQ)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+(-?[\d.]+)\s*dB(?:\s+Q\s+([\d.]+))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const t = m[1].toUpperCase();
    filters.push({
      type: t.startsWith('L') ? 'LSC' : t.startsWith('H') ? 'HSC' : 'PK',
      fc: parseFloat(m[2]),
      gain: parseFloat(m[3]),
      q: parseFloat(m[4] ?? '0.71'),
    });
  }
  if (!filters.length) throw new Error('В файле нет параметрических фильтров (ожидается формат Equalizer APO / AutoEq)');
  return { preamp, filters: filters.slice(0, 12) };
}

/** Из названия устройства вывода пытаемся получить модель наушников для поиска в базе. */
export function guessModelFromDevice(label) {
  if (!label) return null;
  let s = label.replace(/^(Default|По умолчанию|Communications)\s*-\s*/i, '').replace(/\(.*?\)/g, '').trim();
  if (/(speaker|динамик|built-in|встроен|display|monitor|hdmi|displayport|airplay|телевизор|tv\b|realtek|high definition audio)/i.test(s)) return null;
  s = s.replace(/^(наушники|headphones)\s+/i, '').replace(/['’]s\s/i, ' ');
  // «Наушники AirPods Pro (Максим)» → «AirPods Pro»; оставляем первые слова-модели
  return s.length >= 3 ? s : null;
}

/** АЧХ одного биквада (RBJ cookbook) в дБ на частоте f. */
function biquadDb({ type, fc, gain, q }, f, fs = 48000) {
  const A = 10 ** (gain / 40), w0 = (2 * Math.PI * fc) / fs, cw = Math.cos(w0), al = Math.sin(w0) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'PK') {
    [b0, b1, b2, a0, a1, a2] = [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
  } else {
    const sA = 2 * Math.sqrt(A) * al, lo = type === 'LSC';
    const s1 = lo ? 1 : -1;
    b0 = A * ((A + 1) - s1 * (A - 1) * cw + sA);
    b1 = s1 * 2 * A * ((A - 1) - s1 * (A + 1) * cw);
    b2 = A * ((A + 1) - s1 * (A - 1) * cw - sA);
    a0 = (A + 1) + s1 * (A - 1) * cw + sA;
    a1 = -s1 * 2 * ((A - 1) + s1 * (A + 1) * cw);
    a2 = (A + 1) + s1 * (A - 1) * cw - sA;
  }
  const w = (2 * Math.PI * f) / fs, c1 = Math.cos(w), s1_ = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1_ + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1_ + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

const GRID = Array.from({ length: 120 }, (_, i) => 20 * Math.pow(1000, i / 119));
// Фиксированный банк: 15 колоколов через 2/3 октавы — даёт плавную кривую без узких «зубцов»
export const BANK = Array.from({ length: 15 }, (_, i) => 28 * Math.pow(2, i * 0.67));
const BANK_Q = 1.8;

/**
 * Мягкая версия профиля коррекции. Строгое выравнивание по замеру одного экземпляра на стенде
 * часто звучит хуже: посадка, амбушюры и режим ANC у всех разные. Поэтому корректируем
 * итоговую кривую целиком (а не отдельные фильтры — иначе соседние подъём и срез дают провал):
 *  - сглаживаем кривую на 1/2 октавы (узкие резонансы конкретного замера уходят);
 *  - масштабируем силу (по умолчанию 60%);
 *  - подъёмы в 1–6 кГц (зона резкости и самая индивидуальная) ≤ +2 дБ, прочие ≤ +4, срезы ≥ −7;
 *  - под получившуюся кривую подбираем банк из 15 плавных фильтров.
 * Предусиление не нужно: уровень выравнивает автогромкость, пики ловит лимитер.
 */
export function softenProfile(profile, strength = 0.6) {
  const raw = GRID.map((f) => profile.filters.reduce((s, flt) => s + biquadDb(flt, f), 0));
  const target = GRID.map((f, i) => {
    let sum = 0, n = 0;
    GRID.forEach((g, j) => { if (Math.abs(Math.log2(g / f)) <= 0.25) { sum += raw[j]; n++; } });
    const raw0 = sum / n;
    // срезы в зоне гула (150–500 Гц) — в полную силу: убрать «бубнение» наушников не вредит никогда
    let v = raw0 * (raw0 < 0 && f >= 150 && f <= 500 ? Math.max(strength, 1) : strength);
    v = Math.min(v, f >= 1000 && f <= 2500 ? 1 : f > 2500 && f <= 6000 ? 2 : 4);
    // Характер наушников не отнимаем: сочный низ (кик, саб) и воздух — то, за что их любят.
    // Коррекция убирает недостатки (гул, резкость 3–7 кГц), а не делает звук «ровным и плоским».
    // Пики 5–10 кГц — это свист шипящих («с», «ц»), недостаток наушников (у DT 770 — 8–9 кГц): их убираем.
    if (f < 130) v = Math.max(v, -0.5);
    else if (f > 11000) v = Math.max(v, -1.5);
    return Math.max(-7, v);
  });
  const at = (f) => {
    const i = GRID.findIndex((g) => g >= f);
    return i <= 0 ? target[Math.max(0, i)] : target[i - 1] + ((target[i] - target[i - 1]) * Math.log(f / GRID[i - 1])) / Math.log(GRID[i] / GRID[i - 1]);
  };
  const gains = BANK.map((f) => at(Math.min(f, 19000)));
  for (let it = 0; it < 60; it++) {
    BANK.forEach((f, j) => {
      const resp = BANK.reduce((s, fc, k) => s + biquadDb({ type: 'PK', fc, gain: gains[k], q: BANK_Q }, f), 0);
      gains[j] += 0.5 * (at(Math.min(f, 19000)) - resp);
    });
  }
  return { preamp: 0, filters: BANK.map((fc, j) => ({ type: 'PK', fc, gain: Math.max(-9, Math.min(6, gains[j])), q: BANK_Q })) };
}

/** Для проверок: АЧХ профиля в дБ на частотах freqs. */
export function profileResponse(profile, freqs) {
  return freqs.map((f) => profile.filters.reduce((s, flt) => s + biquadDb(flt, f), 0));
}

/* ---------------- АЧХ устройства ---------------- */

/** CSV AutoEq (frequency, raw, …, target) → { f, raw, target } на ~160 логарифмических точках. */
export function parseFrCsv(text) {
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  const iF = head.indexOf('frequency'), iR = head.indexOf('raw'), iT = head.indexOf('target');
  if (iF < 0 || iR < 0) throw new Error('Нет данных АЧХ');
  const rows = lines.slice(1).map((l) => l.split(',').map(Number)).filter((r) => r[iF] >= 20 && r[iF] <= 20000);
  const step = Math.max(1, Math.floor(rows.length / 160));
  const pick = rows.filter((_, i) => i % step === 0);
  return { f: pick.map((r) => r[iF]), raw: pick.map((r) => r[iR]), target: pick.map((r) => (iT >= 0 ? r[iT] : 0)) };
}

// Типовые АЧХ устройств без точного замера: отклонение от нейтрального звука (дБ) по октавам 32 Гц…16 кГц.
export const GENERIC_DEVICES = {
  laptop: { name: 'Встроенные динамики ноутбука', dev: [-30, -24, -14, -5, 0, 0, 2, 1, -2, -8] },
  btspeaker: { name: 'Портативная Bluetooth-колонка', dev: [-18, -8, 0, 2, 1, 0, 0, -1, -3, -8] },
  earbuds: { name: 'Вкладыши (без замера)', dev: [-6, -3, -1, 0, 0, 0, -2, -3, -2, -6] },
  phone: { name: 'Динамик телефона', dev: [-36, -30, -20, -8, -1, 0, 3, 2, -3, -10] },
  flat: { name: 'Студийные мониторы / ровные наушники', dev: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};
const OCT = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Отклонение устройства от целевой кривой по октавам (дБ, нормировано к середине 500–2000 Гц). */
export function deviceDeviation(fr) {
  if (fr.dev) return fr.dev.slice();
  const dev = OCT.map((fc) => {
    let s = 0, n = 0;
    fr.f.forEach((f, i) => { if (Math.abs(Math.log2(f / fc)) <= 0.5) { s += fr.raw[i] - fr.target[i]; n++; } });
    return n ? s / n : 0;
  });
  const mid = (dev[4] + dev[5] + dev[6]) / 3;
  return dev.map((d) => d - mid);
}

/** Частота, ниже которой устройство теряет больше 10 дБ относительно середины (физический предел баса). */
export function deviceLowLimit(fr) {
  const dev = deviceDeviation(fr);
  for (let i = 3; i >= 0; i--) if (dev[i] < -10) return OCT[i + 1] * 0.8;
  return 0;
}

/** Плавная коррекция под типовое устройство: выравниваем, но ниже предела баса ничего не поднимаем. */
export function profileForGeneric(dev, strength = 0.6) {
  const fLow = deviceLowLimit({ dev });
  const filters = OCT.map((fc, i) => {
    let g = -dev[i] * strength;
    if (g > 0 && fc < fLow) g = 0;
    g = Math.max(-7, Math.min(fc >= 1000 && fc <= 6000 ? 2 : 4, g));
    return { type: 'PK', fc, gain: g, q: 1.2 };
  });
  return { preamp: 0, filters };
}

/** Остаточное отклонение по октавам после применённой коррекции (для автобаланса). */
export function residualDeviation(dev, appliedProfile) {
  const resp = appliedProfile ? profileResponse(appliedProfile, OCT) : OCT.map(() => 0);
  const r = dev.map((d, i) => d + resp[i]);
  const mid = (r[4] + r[5] + r[6]) / 3;
  return r.map((x) => x - mid);
}
