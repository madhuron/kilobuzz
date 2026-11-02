import { SECTIONS } from '../audio/profiles.js';

const F_MIN = 20, F_MAX = 20000;
const xOf = (f, w) => (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * w;

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { w, h, dpr, ctx: canvas.getContext('2d') };
}

function hexA(hex, a) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) hex = '#888888';
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class Spectrum {
  constructor(canvas, engine) {
    this.c = canvas;
    this.e = engine;
    this.smooth = null;
    this.respFreqs = new Float32Array(160).map((_, i) => F_MIN * Math.pow(F_MAX / F_MIN, i / 159));
  }

  /** theme: { accent, text, muted, grid } — цвета берутся из CSS-токенов. */
  draw(theme) {
    const { w, h, dpr, ctx } = fit(this.c);
    ctx.clearRect(0, 0, w, h);
    const color = theme.accent;

    // сетка частот
    ctx.font = `${10 * dpr}px ui-monospace, SF Mono, Menlo, monospace`;
    ctx.fillStyle = theme.muted;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = dpr;
    for (const [f, l] of [[50, '50'], [100, '100'], [250, '250'], [500, '500'], [1000, '1k'], [2500, '2.5k'], [5000, '5k'], [10000, '10k']]) {
      const x = xOf(f, w);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 14 * dpr); ctx.stroke();
      ctx.fillText(l, x + 3 * dpr, h - 3 * dpr);
    }
    if (!this.e.running) return;

    // спектр после обработки
    const an = this.e.outAnalyser;
    const n = an.frequencyBinCount;
    this.data ??= new Float32Array(n);
    an.getFloatFrequencyData(this.data);
    const binHz = this.e.ctx.sampleRate / an.fftSize;
    const cols = Math.round(w / (3 * dpr));
    this.smooth ??= new Float32Array(cols).fill(0);
    if (this.smooth.length !== cols) this.smooth = new Float32Array(cols);
    const top = 14 * dpr, bottom = h - 16 * dpr, H = bottom - top;
    for (let i = 0; i < cols; i++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, i / cols), f1 = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / cols);
      let k0 = Math.floor(f0 / binHz), k1 = Math.max(k0 + 1, Math.ceil(f1 / binHz));
      let m = -140;
      for (let k = k0; k < k1 && k < n; k++) m = Math.max(m, this.data[k]);
      // наклон +3 дБ/окт, чтобы спектр выглядел «ровно», как в профессиональных анализаторах
      const tilt = 3 * Math.log2(Math.max(f0, 20) / 1000);
      const v = Math.max(0, Math.min(1, (m + tilt + 95) / 85));
      this.smooth[i] = v > this.smooth[i] ? v : this.smooth[i] * 0.9 + v * 0.1;
    }
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, hexA(color, 0.35));
    grad.addColorStop(1, hexA(color, 0.02));
    ctx.beginPath();
    ctx.moveTo(0, bottom);
    for (let i = 0; i < cols; i++) {
      const x = (i / (cols - 1)) * w, y = bottom - this.smooth[i] * H;
      if (i === 0) ctx.lineTo(x, y);
      else {
        const px = ((i - 1) / (cols - 1)) * w, py = bottom - this.smooth[i - 1] * H;
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
      }
    }
    ctx.lineTo(w, bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = hexA(color, 0.85);
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();

    // кривые: адаптивный EQ и коррекция наушников (±15 дБ)
    const mid = top + H * 0.42, scale = (H * 0.38) / 15;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    const curve = (resp, dash, width, stroke) => {
      ctx.setLineDash(dash.map((d) => d * dpr));
      ctx.beginPath();
      this.respFreqs.forEach((f, i) => {
        const x = xOf(f, w), y = mid - Math.max(-15, Math.min(15, resp[i])) * scale;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width * dpr;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (this.e.corrActive) curve(this.e.eqResponse(this.respFreqs, 'corr'), [5, 4], 1.4, theme.muted);
    curve(this.e.eqResponse(this.respFreqs, 'eq'), [], 2, theme.text);
  }
}

/** Таймлайн структуры: заранее посчитанная карта (плеер) или живая история (системный звук). */
export class Timeline {
  constructor(canvas) { this.c = canvas; }

  draw({ map, position, duration, live, liveTime, theme }) {
    const { w, h, dpr, ctx } = fit(this.c);
    ctx.clearRect(0, 0, w, h);
    const r = 3 * dpr, gap = 2 * dpr;
    const block = (x0, x1, label, alpha) => {
      const c = SECTIONS[label]?.color || '#888';
      ctx.fillStyle = hexA(c, alpha);
      ctx.beginPath();
      ctx.roundRect(x0 + gap / 2, 0, Math.max(1, x1 - x0 - gap), h - 16 * dpr, r);
      ctx.fill();
    };
    ctx.font = `600 ${10 * dpr}px -apple-system, Segoe UI, sans-serif`;
    const text = theme?.text || '#fff';

    if (map) duration = map.duration;
    if (map && duration > 0) {
      for (const s of map.segments) {
        const x0 = (s.start / duration) * w, x1 = (s.end / duration) * w;
        const active = position >= s.start && position < s.end;
        block(x0, x1, s.label, active ? 0.75 : 0.28);
        if (x1 - x0 > 70 * dpr) {
          ctx.fillStyle = text;
          ctx.globalAlpha = active ? 1 : 0.6;
          ctx.fillText(SECTIONS[s.label].name, x0 + 8 * dpr, 16 * dpr);
          ctx.globalAlpha = 1;
        }
      }
      // кривая энергии
      const hh = h - 16 * dpr;
      ctx.beginPath();
      map.curve.forEach((v, i) => {
        const x = ((i * map.frame) / duration) * w, y = hh - 4 * dpr - v * (hh - 22 * dpr);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = hexA(text, 0.5);
      ctx.lineWidth = 1.2 * dpr;
      ctx.stroke();
      const px = (position / duration) * w;
      ctx.fillStyle = text;
      ctx.fillRect(px - dpr, 0, 2 * dpr, h - 16 * dpr);
      this._axis(ctx, w, h, dpr, 0, duration, theme);
      return;
    }

    if (live?.length) {
      const span = 90, t1 = Math.max(liveTime, span), t0 = t1 - span;
      live.forEach((e, i) => {
        const end = i + 1 < live.length ? live[i + 1].t : liveTime;
        if (end < t0) return;
        const x0 = ((Math.max(e.t, t0) - t0) / span) * w, x1 = ((end - t0) / span) * w;
        block(x0, x1, e.label, i === live.length - 1 ? 0.75 : 0.3);
        if (x1 - x0 > 70 * dpr) {
          ctx.fillStyle = text;
          ctx.fillText(SECTIONS[e.label].name, x0 + 8 * dpr, 16 * dpr);
        }
      });
        this._axis(ctx, w, h, dpr, t0, t1, theme);
    } else {
      ctx.fillStyle = hexA(text, 0.05);
      ctx.beginPath(); ctx.roundRect(0, 0, w, h - 16 * dpr, r); ctx.fill();
    }
  }

  _axis(ctx, w, h, dpr, t0, t1, theme) {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
    ctx.font = `${10 * dpr}px ui-monospace, SF Mono, Menlo, monospace`;
    ctx.fillStyle = theme?.muted || '#888';
    const step = t1 - t0 > 240 ? 60 : 30;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = ((t - t0) / (t1 - t0)) * w;
      ctx.fillText(fmtTime(t), Math.min(w - 26 * dpr, x + 2 * dpr), h - 2 * dpr);
    }
  }
}

export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
