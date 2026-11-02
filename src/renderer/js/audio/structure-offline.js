const dB = (p) => 10 * Math.log10(p + 1e-12);
const FRAME = 0.5; // секунд на кадр карты структуры

function percentileNorm(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const p5 = s[Math.floor(s.length * 0.05)], p95 = s[Math.floor(s.length * 0.95)];
  const span = p95 - p5 || 1;
  return arr.map((v) => Math.max(0, Math.min(1, (v - p5) / span)));
}

function smooth(arr, radius) {
  return arr.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(arr.length - 1, i + radius); j++) { s += arr[j]; n++; }
    return s / n;
  });
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/**
 * Полный анализ структуры файла заранее (режим плеера):
 * признаки по кадрам → кривая новизны (смена характера звука) → границы → метки секций.
 * Зная карту заранее, эквалайзер переключается точно в момент дропа, а не с задержкой.
 */
export async function analyzeBuffer(buf, onProgress) {
  const sr = buf.sampleRate;
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const sub = Math.round(sr * 0.05); // подкадр 50 мс
  const nSub = Math.floor(L.length / sub);
  const a = (hz) => 1 - Math.exp((-2 * Math.PI * hz) / sr);
  const aLow = a(150), aHi = a(4000), aV1 = a(250), aV2 = a(3500);
  let lpLow = 0, lp4k = 0, vm1 = 0, vm2 = 0, vs1 = 0, vs2 = 0;

  const E = new Float32Array(nSub), LOW = new Float32Array(nSub), HIGH = new Float32Array(nSub),
    VC = new Float32Array(nSub), VS = new Float32Array(nSub);

  for (let fi = 0; fi < nSub; fi++) {
    let e = 0, lo = 0, h = 0, vc = 0, vs = 0;
    for (let i = fi * sub, end = i + sub; i < end; i++) {
      const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5;
      e += m * m + s * s;
      lpLow += aLow * (m - lpLow); lo += lpLow * lpLow;
      lp4k += aHi * (m - lp4k); const hp = m - lp4k; h += hp * hp;
      vm1 += aV1 * (m - vm1); vm2 += aV2 * (m - vm1 - vm2); vc += vm2 * vm2;
      vs1 += aV1 * (s - vs1); vs2 += aV2 * (s - vs1 - vs2); vs += vs2 * vs2;
    }
    E[fi] = e / sub; LOW[fi] = lo / sub; HIGH[fi] = h / sub; VC[fi] = vc / sub; VS[fi] = vs / sub;
    if (fi % 400 === 0) {
      onProgress?.(fi / nSub);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Агрегация в кадры по 0.5 с
  const per = Math.round(FRAME / 0.05);
  const n = Math.floor(nSub / per);
  if (n < 8) return null;
  const loud = [], low = [], high = [], vocal = [], kick = [];
  for (let k = 0; k < n; k++) {
    let e = 0, lo = 0, h = 0, vc = 0, vs = 0, kc = 0;
    const vdb = [];
    for (let j = k * per; j < (k + 1) * per; j++) {
      e += E[j]; lo += LOW[j]; h += HIGH[j]; vc += VC[j]; vs += VS[j];
      vdb.push(dB(VC[j]));
      // удар: резкий рост низа или всей энергии (бочка поверх непрерывного баса тоже ловится)
      if (j > 0 && (dB(LOW[j]) - dB(LOW[j - 1]) > 4 || dB(E[j]) - dB(E[j - 1]) > 2.5)) kc++;
    }
    loud.push(dB(e / per));
    low.push(dB(lo / per));
    high.push(dB(h / per));
    let mod = 0;
    for (let j = 1; j < vdb.length; j++) mod += Math.abs(vdb[j] - vdb[j - 1]);
    const center = vc / (vc + vs + 1e-12);
    vocal.push(0.6 * center + 0.4 * Math.min(1, mod / vdb.length / 3) + 0.3 * Math.min(1, Math.max(0, (dB(vc) - dB(e) + 9) / 6)));
    kick.push(kc);
  }

  const N = {
    loud: smooth(percentileNorm(loud), 2),
    low: smooth(percentileNorm(low), 2),
    high: smooth(percentileNorm(high), 2),
    vocal: smooth(percentileNorm(vocal), 4),
    kick: smooth(percentileNorm(kick), 4),
  };
  const keys = Object.keys(N);

  // Новизна: расстояние между средними признаками в окнах 5 с слева и справа.
  const K = 10;
  const nov = new Array(n).fill(0);
  for (let i = K; i < n - K; i++) {
    let d = 0;
    for (const key of keys) {
      const w = key === 'loud' || key === 'low' ? 1.3 : 1;
      const l = mean(N[key].slice(i - K, i)), r = mean(N[key].slice(i, i + K));
      d += w * (l - r) ** 2;
    }
    nov[i] = Math.sqrt(d);
  }
  const nm = mean(nov), ns = Math.sqrt(mean(nov.map((v) => (v - nm) ** 2)));
  const bounds = [0];
  for (let i = K; i < n - K; i++) {
    let isMax = nov[i] > nm + 0.4 * ns;
    for (let j = Math.max(0, i - 8); j <= Math.min(n - 1, i + 8) && isMax; j++) if (nov[j] > nov[i]) isMax = false;
    if (isMax && i - bounds.at(-1) >= 8) {
      // уточняем границу по самому резкому скачку громкости рядом
      let best = i, bd = 0;
      for (let j = Math.max(1, i - 3); j <= Math.min(n - 1, i + 3); j++) {
        const d = Math.abs(N.loud[j] - N.loud[j - 1]) + Math.abs(N.low[j] - N.low[j - 1]);
        if (d > bd) { bd = d; best = j; }
      }
      bounds.push(best);
    }
  }
  bounds.push(n);

  let segs = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const s = bounds[b], e = bounds[b + 1];
    if (e - s < 1) continue;
    const f = {};
    for (const key of keys) f[key] = mean(N[key].slice(s, e));
    const third = Math.max(1, Math.floor((e - s) / 3));
    f.trend = mean(N.loud.slice(e - third, e)) - mean(N.loud.slice(s, s + third)) + 0.7 * (mean(N.high.slice(e - third, e)) - mean(N.high.slice(s, s + third)));
    f.energy = 0.45 * f.loud + 0.35 * f.low + 0.2 * f.kick;
    segs.push({ s, e, f });
  }

  const energies = segs.map((x) => x.f.energy).sort((a, b) => a - b);
  const hiThr = energies[Math.floor(energies.length * 0.65)] ?? 0.6;
  const med = energies[Math.floor(energies.length * 0.5)] ?? 0.5;

  segs.forEach((seg, i) => {
    const f = seg.f;
    if (i === 0 && f.energy < Math.max(med, 0.45)) seg.label = 'intro';
    else if (i === segs.length - 1 && segs.length > 2 && (f.energy < med || f.trend < -0.1)) seg.label = 'outro';
    else if (f.energy >= hiThr && f.energy > 0.45 && f.loud > 0.55) {
      if (f.vocal > 0.55 && f.kick < 0.6) seg.label = 'chorus';
      else if (f.low > 0.55 || f.kick > 0.5) seg.label = f.vocal > 0.7 ? 'chorus' : 'drop';
      else seg.label = f.vocal > 0.45 ? 'chorus' : 'instrumental';
    } else if (f.energy < 0.3 && i > 0) seg.label = 'breakdown';
    else if (f.vocal > 0.45) seg.label = 'verse';
    else seg.label = 'instrumental';
  });

  // Нарастание и точное начало кульминации. Граница по новизне часто ставится в середину подъёма,
  // поэтому: (1) сдвигаем начало дропа/припева вперёд — туда, где энергия перестаёт расти;
  // (2) от этой точки идём назад, пока энергия монотонно росла — это и есть нарастание.
  const energy = smooth(N.loud.map((v, i) => 0.6 * v + 0.4 * N.low[i]), 1);
  const frameLabel = new Array(n);
  segs.forEach((seg) => { for (let j = seg.s; j < seg.e; j++) frameLabel[j] = seg.label; });
  segs.forEach((seg, i) => {
    if (i === 0 || (seg.label !== 'drop' && seg.label !== 'chorus')) return;
    const plateau = [...energy.slice(seg.s, seg.e)].sort((a, b) => a - b)[Math.floor((seg.e - seg.s) * 0.75)];
    let start = seg.s;
    while (start < Math.min(seg.e - 4, seg.s + 20) && energy[start] < plateau - 0.05) start++;
    let j = start - 1;
    while (j - 4 >= 0 && start - j < 32 && energy[j] > energy[j - 4] + 0.015 && frameLabel[j] !== 'intro') j--;
    const run = start - 1 - j;
    const label = run >= 6 && energy[start - 1] - energy[j] > 0.15 ? 'buildup' : segs[i - 1].label;
    for (let k = seg.s; k < start; k++) frameLabel[k] = segs[i - 1].label;
    if (label === 'buildup') for (let k = j + 1; k < start; k++) frameLabel[k] = 'buildup';
  });
  const out = [];
  for (let j = 0; j < n; j++) {
    const last = out.at(-1);
    if (last && last.label === frameLabel[j]) last.e = j + 1;
    else out.push({ s: j, e: j + 1, label: frameLabel[j] });
  }

  const merged = [];
  for (const seg of out) {
    const last = merged.at(-1);
    if (last && last.label === seg.label) last.e = seg.e;
    else merged.push({ ...seg });
  }
  onProgress?.(1);
  return {
    duration: buf.duration,
    frame: FRAME,
    curve: N.loud.map((v, i) => 0.6 * v + 0.4 * N.low[i]),
    segments: merged.map((x) => ({ start: x.s * FRAME, end: Math.min(buf.duration, x.e * FRAME), label: x.label })),
  };
}

export function sectionAt(map, t, lookahead = 0.04) {
  const tt = t + lookahead;
  const i = map.segments.findIndex((s) => tt >= s.start && tt < s.end);
  if (i < 0) return { label: map.segments.at(-1)?.label ?? 'outro', progress: 1, next: null, conf: 1 };
  const s = map.segments[i], nx = map.segments[i + 1];
  return {
    label: s.label,
    progress: Math.max(0, Math.min(1, (t - s.start) / (s.end - s.start))),
    next: nx ? { label: nx.label, in: nx.start - t } : null,
    conf: 1,
  };
}
