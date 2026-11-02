const ACCENTS = ['#4f8cff', '#7c5cff', '#16b8a6', '#34c759', '#f5a524', '#f2555a', '#ececf1'];

const DEFAULT = { theme: 'system', accent: ACCENTS[0], radius: 8, density: 'normal', sectionColor: false, glow: false };

/**
 * Оформление на дизайн-токенах: тема, акцент, скругления, плотность.
 * Все значения ложатся в CSS-переменные на :root, поэтому тему легко расширять.
 */
export class Theme {
  constructor(store) {
    this.store = store;
    this.v = { ...DEFAULT, ...store.get('theme', {}) };
    this.section = null;
    this._cache = null;
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => (this._cache = null));
    this.apply();
  }

  apply() {
    const r = document.documentElement, v = this.v;
    r.dataset.theme = v.theme;
    r.dataset.density = v.density;
    r.style.setProperty('--radius', `${v.radius}px`);
    const accent = v.sectionColor && this.section ? this.section : v.accent;
    r.style.setProperty('--accent', accent);
    r.style.setProperty('--accent-fg', luminance(accent) > 0.6 ? '#111114' : '#ffffff');
    document.body.classList.toggle('glow', v.glow);
    this._cache = null;
  }

  set(patch) {
    Object.assign(this.v, patch);
    this.store.set('theme', this.v);
    this.apply();
    this.syncDialog();
  }

  setSectionColor(color) {
    this.section = color;
    if (this.v.sectionColor) this.apply();
  }

  /** Цвета для canvas, читаются из CSS-токенов (кэшируются до смены темы). */
  colors() {
    if (this._cache) return this._cache;
    const cs = getComputedStyle(document.documentElement);
    const get = (n) => cs.getPropertyValue(n).trim();
    return (this._cache = { accent: get('--accent'), text: get('--text'), muted: get('--muted'), grid: get('--grid') });
  }

  open() {
    this.syncDialog();
    document.getElementById('settings').showModal();
  }

  bindDialog() {
    const seg = (id, key, cast = (x) => x) =>
      document.getElementById(id).querySelectorAll('button').forEach((b) => (b.onclick = () => this.set({ [key]: cast(b.dataset.v) })));
    seg('themeSeg', 'theme');
    seg('radiusSeg', 'radius', Number);
    seg('densitySeg', 'density');
    const sw = document.getElementById('swatches');
    sw.innerHTML = ACCENTS.map((c) => `<button type="button" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('') + '<input type="color" id="accentCustom" title="Свой цвет">';
    sw.querySelectorAll('button').forEach((b) => (b.onclick = () => this.set({ accent: b.dataset.c })));
    document.getElementById('accentCustom').oninput = (e) => this.set({ accent: e.target.value });
    document.getElementById('setSectionColor').onchange = (e) => this.set({ sectionColor: e.target.checked });
    document.getElementById('setGlow').onchange = (e) => this.set({ glow: e.target.checked });
    document.getElementById('themeReset').onclick = () => this.set({ ...DEFAULT });
  }

  syncDialog() {
    const v = this.v;
    const mark = (id, val) => document.getElementById(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(b.dataset.v) === String(val)));
    mark('themeSeg', v.theme);
    mark('radiusSeg', v.radius);
    mark('densitySeg', v.density);
    document.querySelectorAll('#swatches button').forEach((b) => b.classList.toggle('on', b.dataset.c === v.accent));
    document.getElementById('accentCustom').value = v.accent;
    document.getElementById('setSectionColor').checked = v.sectionColor;
    document.getElementById('setGlow').checked = v.glow;
  }
}

function luminance(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (Number.isNaN(n)) return 0;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
