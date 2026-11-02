// Генерирует синтетический EDM-трек с известной структурой для проверки детектора секций:
// вступление → куплет → нарастание → дроп → брейкдаун → нарастание → дроп → концовка.
// node scripts/make-test-track.js out.wav
const fs = require('fs');

const sr = 44100, bpm = 128, beat = 60 / bpm;
const plan = [
  ['intro', 16], ['verse', 22], ['buildup', 8], ['drop', 22], ['breakdown', 15], ['buildup', 8], ['drop', 22], ['outro', 12],
];
const total = plan.reduce((a, [, d]) => a + d, 0);
const n = Math.floor(total * sr);
const L = new Float32Array(n), R = new Float32Array(n);
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

let t0 = 0;
for (const [sec, dur] of plan) {
  const s0 = Math.floor(t0 * sr), s1 = Math.floor((t0 + dur) * sr);
  for (let i = s0; i < s1; i++) {
    const t = i / sr, lt = t - t0, p = lt / dur;
    const bt = t % beat, bar = Math.floor(t / beat);
    let m = 0, side = 0;
    // пэд (широкий, в стороны)
    const padAmp = { intro: 0.12, verse: 0.06, breakdown: 0.16, outro: 0.1 * (1 - p), buildup: 0.05, drop: 0.05 }[sec];
    side += padAmp * (Math.sin(2 * Math.PI * 220 * t + Math.sin(t * 0.5)) + Math.sin(2 * Math.PI * 277 * t)) * 0.5;
    // бочка
    const kickOn = sec === 'drop' || sec === 'verse' || (sec === 'buildup' && p > 0.5) || (sec === 'outro' && p < 0.5);
    if (kickOn) m += (sec === 'drop' ? 0.75 : 0.45) * Math.exp(-bt * 18) * Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-bt * 30)) * bt);
    // бас
    if (sec === 'drop') m += 0.32 * Math.sin(2 * Math.PI * 55 * t) * (bt > 0.08 ? 1 : bt / 0.08);
    // «вокал»: тон с формантами и слоговой модуляцией, по центру
    if (sec === 'verse') {
      const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * t);
      const f0 = 196 * (1 + 0.03 * Math.sin(2 * Math.PI * 5.5 * t)) * (bar % 4 < 2 ? 1 : 1.12);
      let v = 0;
      for (let h = 1; h <= 14; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h * (h >= 3 && h <= 6 ? 2 : 1);
      m += 0.09 * syl * v;
    }
    // хэт + райзер
    if (sec === 'drop' || sec === 'verse') m += 0.05 * rnd() * Math.exp(-((t + beat / 2) % beat) * 60);
    if (sec === 'buildup') { const roll = Math.exp(-((t % (beat / (1 + Math.floor(p * 4) * 1))) * 40)); m += rnd() * (0.08 + 0.35 * p * p) * (0.5 + 0.5 * roll); side += 0.15 * rnd() * p; }
    // лид в дропе
    if (sec === 'drop') side += 0.12 * Math.sign(Math.sin(2 * Math.PI * 440 * t)) * (bar % 2 ? 1 : 0.6);
    L[i] = Math.tanh((m + side) * 1.1) * 0.8;
    R[i] = Math.tanh((m - side) * 1.1) * 0.8;
  }
  t0 += dur;
}

const buf = Buffer.alloc(44 + n * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24);
buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
for (let i = 0; i < n; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
}
fs.writeFileSync(process.argv[2] || 'test-track.wav', buf);
let acc = 0;
console.log(plan.map(([s, d]) => `${(acc += d) - d}s ${s}`).join('\n'));
