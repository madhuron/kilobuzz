import { AudioEngine } from './audio/engine.js';
import { FeatureExtractor, TempoTracker } from './audio/features.js';
import { LiveStructure } from './audio/structure-live.js';
import { analyzeBuffer, sectionAt } from './audio/structure-offline.js';
import { GenreClassifier } from './audio/genre.js';
import { computeTarget } from './audio/adaptive.js';
import { EQ_FREQS, GENRES, GENRE_KEYS, SECTIONS, SECTION_KEYS } from './audio/profiles.js';
import { parseParametricEq, guessModelFromDevice, softenProfile, parseFrCsv, deviceDeviation, deviceLowLimit, profileForGeneric, residualDeviation, profileResponse, GENERIC_DEVICES } from './audio/correction.js';
import { TonalBalance, SmartBalance, DensityMeter } from './audio/balance.js';
import { readTags } from './audio/tags.js';
import { ResonanceSuppressor, RES_SLOTS } from './audio/resonance.js';
import { Spectrum, Timeline, fmtTime } from './ui/visualizer.js';
import { Theme } from './ui/theme.js';
import { PRESETS, PRESET_KEYS, EQ_PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);

// В браузере (dev-режим без Electron) — заглушка моста.
const bridge = window.kilobuzz ?? {
  platform: 'web',
  onNowPlaying() {},
  setNowPlayingEnabled() {},
  lookupGenre: async () => ({ tags: [] }),
  requestMic: async () => true,
  openExternal: (u) => window.open(u),
  captureSupported: async () => false,
  startCapture: async () => false,
  stopCapture: async () => {},
  onCaptureStatus() {},
  getArtwork: async () => null,
  getSystemVolume: async () => null,
  searchHeadphones: async () => [],
  loadHeadphoneEq: async () => '',
};
document.body.classList.add(bridge.platform === 'darwin' ? 'mac' : bridge.platform === 'win32' ? 'win' : 'web');

const store = {
  get(key, def) { try { return JSON.parse(localStorage.getItem(`kilobuzz.${key}`)) ?? def; } catch { return def; } },
  set(key, v) { try { localStorage.setItem(`kilobuzz.${key}`, JSON.stringify(v)); } catch {} },
};

/* ---------------- состояние ---------------- */
// Умолчания — итог настройки по слуху (02.11.2026, слепое сравнение 15 случайных вариантов с оригиналом):
// слушателю нравится, когда обработка ЧИСТИТ звук (шипящие, резонансы, немного низа), и не нравится, когда
// ОКРАШИВАЕТ (реверберация/эхо, компрессия, яркий верх, сильная сатурация).
const DEFAULTS = {
  intensity: 1, bass: 1.5, clarity: -0.4, bright: 0,
  compAmount: 0.85, deessBias: 0.25, widthScale: 1, ceiling: 0, drive: 0, enhBass: 0.5, enhPunch: 0.9, enhAir: 0.35, stemKick: 1.5, stemBass: 2,
  balance: 0.5, corrStrength: 0.45, autoLevel: true,
  smart: 0.45, bassLimit: -9, antiboom: 0.75, unmask: 0.7, recover: 0.5, restore: 0.8, headroom: 3, color: 0.4, spaceDuck: 0.7, surround: 'off', surroundAmount: 0.6, surroundDevice: 'headphones',
  sampleRate: 'auto',
  juice: 0.5, space: 0, reverb: 0.06, reverbSize: 'room', delay: 0, delayFeedback: 0.25, delayNote: 0.5,
  volume: 0.8, loudComp: true,
  manualEq: new Array(10).fill(0),
  profile: { bass: 0, treble: 0, presence: 0 }, // личный профиль (тест по слуху)
  fx: { comp: false, deess: true, width: false, limiter: true, enhance: true, smart: true, res: true, unmask: true, restore: true },
  v: 6,
};
const saved = store.get('settings', {});
// v2: новый мягкий тюнинг — старые значения драйва/ширины сбрасываем к умолчаниям
if ((saved.v ?? 0) < 2) Object.assign(saved, { drive: 0, widthScale: 1, compAmount: 1 });
// v3: автобаланс вместо жанровых кривых — прежние «вкусовые» подкрутки обнуляем
if ((saved.v ?? 0) < 3) Object.assign(saved, { bass: 0, clarity: 0, bright: 0, manualEq: new Array(10).fill(0), v: 3 });
// v4: «Красочность» разделена на бас / ударные / воздух; блока «Вкус» больше нет — его скрытые ручки к умолчанию
if ((saved.v ?? 0) < 4) {
  const e = saved.enhance ?? 1;
  Object.assign(saved, { enhBass: e, enhPunch: e, enhAir: e, bright: 0, balance: DEFAULTS.balance, intensity: DEFAULTS.intensity, v: 4 });
  delete saved.enhance;
}
// v5: потолок −0.3 дБ (было −1): лишний запас заставлял лимитер срезать удары на громко сведённых треках
if ((saved.v ?? 0) < 5) { if (saved.ceiling == null || saved.ceiling === -1) saved.ceiling = -0.3; saved.v = 5; }
// v6: потолок 0 дБ — как у самих треков: громкие мастера уже доходят до 0, и любой потолок ниже заставлял
// лимитеры постоянно прижимать низ (замер: бас −3.5 дБ на метале). Теперь срезается только то, что добавила обработка.
if ((saved.v ?? 0) < 6) { if (saved.ceiling == null || saved.ceiling > -1.05) saved.ceiling = 0; saved.v = 6; }
const settings = { ...structuredClone(DEFAULTS), ...saved, fx: { ...DEFAULTS.fx, ...saved.fx } };
let presetLock = false;
const save = () => {
  store.set('settings', settings);
  if (!presetLock) markPresetCustom();
};

/* ---------------- реестр контролов: пресеты и сбросы обновляют интерфейс ---------------- */
const controls = [];
function refreshControls() {
  for (const c of controls) c();
}

/** Сбросить ключи к умолчанию. 'fxAll' — весь блок «Обработка». */
function resetKeys(keys) {
  const list = keys.flatMap((k) => (k === 'fxAll' ? ['compAmount', 'deessBias', 'enhBass', 'enhPunch', 'enhAir', 'stemKick', 'stemBass', 'color', 'widthScale', 'drive', 'ceiling', 'smart', 'bassLimit', 'antiboom', 'unmask', 'recover', 'restore', 'headroom', 'fx'] : [k]));
  for (const k of list) settings[k] = structuredClone(DEFAULTS[k]);
  save();
  refreshControls();
}

const state = {
  mode: 'player',
  adaptive: true,
  power: true,
  playlist: [],
  index: -1,
  map: null,
  analyzing: 0,
  np: null,
  npAt: 0,
  trackKey: '',
  genreLock: '',
  sectionLock: '',
  section: { label: null, progress: 0, next: null },
  lastFeat: null,
  capture: { supported: false, running: false },
  // коррекция АЧХ: профиль на каждое устройство вывода (по названию)
  corrByDevice: store.get('corrByDevice', {}),
  outLabel: '',
};

const engine = new AudioEngine();
/**
 * Служебный доступ для настройки по слуху (A/B-тест) и замеров звука. Вызывается только изнутри окна:
 * в браузерном dev-режиме или через отладочный канал, когда приложение запущено с --remote-debugging-port.
 */
window.__kb = {
  engine,
  get state() { return state; },
  settings,
  /** Что сейчас играет и как Kilobuzz это слышит. */
  info() {
    const probs = Object.entries(state.lastProbs || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${GENRES[k]?.name || k} ${Math.round(v * 100)}%`);
    const t = state.target;
    const pick = ['juice', 'bass', 'clarity', 'enhBass', 'enhPunch', 'enhAir', 'compAmount', 'smart', 'antiboom', 'widthScale', 'space', 'reverb', 'delay', 'corrStrength', 'manualEq'];
    return {
      track: state.np ? `${state.np.artist || ''} — ${state.np.title || ''} (${state.np.app || ''})` : state.playlist[state.index]?.name || null,
      mode: state.mode, power: state.power, genre: probs, section: state.section?.label,
      device: currentCorr()?.name || null,
      settings: Object.fromEntries(pick.map((k) => [k, settings[k]])),
      eq: t?.eq?.map((v) => +v.toFixed(1)), enhance: t?.enhance, autoGain: +(engine.autoGainDb || 0).toFixed(1),
      ab: abState && { cur: abState.cur, a: abState.a, b: abState.b },
    };
  },
  /** Поменять настройки прямо сейчас. */
  set(values) { applyValues(values); return this.info().settings; },
  /** Два варианта поверх текущих настроек; в окне появятся кнопки A / B (клавиши 1 / 2). */
  ab(a, b) {
    abState = { base: structuredClone(settings), a, b, cur: 'A' };
    showAbBar();
    abPick('A');
    return 'A/B готов';
  },
  /** Закончить сравнение: оставить победителя ('A' | 'B') или вернуть как было (null). */
  abEnd(keep = null) {
    if (!abState) return 'нет сравнения';
    const { base, a, b } = abState;
    abState = null;
    $('abBar')?.remove();
    applyValues({ ...structuredClone(base), ...(keep === 'A' ? a : keep === 'B' ? b : {}) });
    return keep ? `оставлен ${keep}` : 'возвращено как было';
  },
};

let abState = null;
function applyValues(values) {
  const corrBefore = settings.corrStrength;
  Object.assign(settings, structuredClone(values));
  save();
  refreshControls();
  if (settings.corrStrength !== corrBefore) applyCorrectionForDevice();
}
function abPick(which) {
  if (!abState) return;
  abState.cur = which;
  applyValues({ ...structuredClone(abState.base), ...(which === 'A' ? abState.a : abState.b) });
  $('abBar')?.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === which));
}
function showAbBar() {
  let bar = $('abBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'abBar';
    bar.className = 'ab-bar';
    bar.innerHTML = '<span>Сравнение</span><button type="button" data-v="A">A</button><button type="button" data-v="B">B</button><small>клавиши 1 / 2</small>';
    document.body.appendChild(bar);
    bar.querySelectorAll('button').forEach((x) => (x.onclick = () => abPick(x.dataset.v)));
  }
}
window.addEventListener('keydown', (e) => {
  if (!abState || e.target.closest?.('input, textarea, select')) return;
  if (e.key === '1') abPick('A');
  if (e.key === '2') abPick('B');
});
const live = new LiveStructure();
const genre = new GenreClassifier();
const tempo = new TempoTracker();
const balance = new TonalBalance();
const smartBal = new SmartBalance();
const density = new DensityMeter();
let smartTick = 0;
let feats = null;
let resSup = null;
const spectrum = new Spectrum($('spectrum'), engine);
const timeline = new Timeline($('timeline'));
const theme = new Theme(store);

/* ---------------- утилиты UI ---------------- */
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function hashHue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function setTrackInfo({ title, artist, app }) {
  $('npTitle').textContent = title || 'Без названия';
  $('npArtist').textContent = artist || '';
  $('npApp').textContent = app || '—';
  const h = hashHue(`${artist}${title}`);
  $('art').style.background = `hsl(${h} 45% 42%)`;
  $('artText').textContent = (title || '♪').trim().slice(0, 1).toUpperCase();
}

let coverToken = 0;
function setCover(url) {
  const img = $('artImg');
  if (url) { img.src = url; img.hidden = false; }
  else { img.hidden = true; img.removeAttribute('src'); }
}

/** Обложка: встроенная в файл → из плеера (Spotify/Apple Music) → каталог iTunes. */
async function loadCover(info, embedded) {
  const token = ++coverToken;
  setCover(embedded || null);
  if (embedded || !info.title) return;
  const url = await bridge.getArtwork(info).catch(() => null);
  if (token === coverToken) setCover(url);
}

/** Новый трек: сбрасываем статистику и запрашиваем жанровые теги. */
function onNewTrack(artist, title) {
  live.reset();
  genre.reset();
  tempo.reset();
  balance.reset();
  smartBal.reset();
  density.reset();
  resSup?.reset();
  $('genreTags').innerHTML = '';
  const key = `${artist}|${title}`;
  state.trackKey = key;
  if (!artist) return;
  bridge.lookupGenre(artist, title).then((res) => {
    if (state.trackKey !== key) return;
    genre.setTags(res.tags);
    $('genreTags').innerHTML = (res.tags || []).slice(0, 8).map((t) => `<span>${escapeHtml(t.name)}</span>`).join('');
  });
}

function parseName(file) {
  const base = file.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\d+[\s.-]+/, '');
  const m = base.split(/\s+[-–—]\s+/);
  return m.length >= 2 ? { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { artist: '', title: base.trim() };
}

const sgn = (v, u = ' дБ') => `${v > 0 ? '+' : ''}${v.toFixed(1)}${u}`;
const pct = (v) => `${Math.round(v * 100)}%`;

/* ---------------- построение контролов ---------------- */
function buildStatic() {
  $('genreLock').innerHTML = '<option value="">Авто</option>' + GENRE_KEYS.map((k) => `<option value="${k}">${GENRES[k].name}</option>`).join('');
  $('sectionLock').innerHTML = '<option value="">Секция: авто</option>' + SECTION_KEYS.map((k) => `<option value="${k}">${SECTIONS[k].name}</option>`).join('');
  $('legend').innerHTML = SECTION_KEYS.map((k) => `<span><i style="background:${SECTIONS[k].color}"></i>${SECTIONS[k].name}</span>`).join('');
  $('genreLock').onchange = (e) => (state.genreLock = e.target.value);
  $('sectionLock').onchange = (e) => (state.sectionLock = e.target.value);
}

function buildEq() {
  const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);
  $('eq').innerHTML = EQ_FREQS.map((f, i) => `
    <div class="band">
      <span class="val" id="eqv${i}">0.0</span>
      <div class="track"><div class="fill" id="eqf${i}"></div><input type="range" min="-12" max="12" step="0.5" value="${settings.manualEq[i]}" data-i="${i}" title="Ваша поправка, дБ (двойной клик — сброс)"></div>
      <span class="hz">${fmtHz(f)}</span>
    </div>`).join('');
  $('eq').querySelectorAll('input').forEach((inp) => {
    inp.oninput = () => { settings.manualEq[+inp.dataset.i] = +inp.value; save(); syncEqPreset(); };
    inp.ondblclick = () => { inp.value = 0; inp.oninput(); };
  });
  buildEqPresets();
  controls.push(syncEqPreset);
}

function slider({ label, key, min, max, step, fmt }) {
  const el = document.createElement('div');
  el.className = 'sl';
  el.innerHTML = `<span>${label}</span><b></b><input type="range" class="range" min="${min}" max="${max}" step="${step}">`;
  const inp = el.querySelector('input'), out = el.querySelector('b');
  const paint = () => {
    out.textContent = fmt(+inp.value);
    out.classList.toggle('changed', Math.abs(+inp.value - DEFAULTS[key]) > 1e-6);
    out.title = out.classList.contains('changed') ? 'Сбросить к умолчанию' : '';
    inp.style.setProperty('--v', `${((inp.value - min) / (max - min)) * 100}%`);
  };
  inp.value = settings[key];
  inp.oninput = () => { settings[key] = +inp.value; paint(); save(); };
  const reset = () => { inp.value = DEFAULTS[key]; inp.oninput(); inp.dispatchEvent(new Event('change')); };
  inp.ondblclick = reset;
  out.onclick = () => out.classList.contains('changed') && reset();
  controls.push(() => { inp.value = settings[key]; paint(); });
  paint();
  return el;
}

function buildFx() {
  const fx = [
    { key: 'comp', name: 'Компрессор', meter: true, sl: { label: 'Плотность', key: 'compAmount', min: 0, max: 2, step: 0.05, fmt: pct } },
    { key: 'deess', name: 'Де-эссер', meter: true, sl: { label: 'Сила', key: 'deessBias', min: -0.5, max: 0.5, step: 0.05, fmt: (v) => sgn(v * 100, '%') } },
    { key: 'unmask', name: 'Прозрачность', meter: false, sl: [
      { label: 'Гасить выпирающее (резонансы, «стена»)', key: 'unmask', min: 0, max: 1, step: 0.05, fmt: pct },
      { label: 'Поднимать заглушённое (спрятанные инструменты)', key: 'recover', min: 0, max: 1, step: 0.05, fmt: pct },
    ] },
    { key: 'restore', name: 'Восстановление ударов', meter: false, sl: [
      { label: 'Сила (атаки, придавленные при мастеринге)', key: 'restore', min: 0, max: 1, step: 0.05, fmt: pct },
      { label: 'Запас громкости (прибавьте ручкой на карте)', key: 'headroom', min: 0, max: 6, step: 0.5, fmt: (v) => `${v.toFixed(1)} дБ` },
    ] },
    { key: 'res', name: 'Анти-бочка', meter: false, slots: true, sl: { label: 'Подавление гула и резонансов', key: 'antiboom', min: 0, max: 1, step: 0.05, fmt: pct } },
    { key: 'smart', name: 'Умная динамика', meter: false, bands: true, sl: { label: 'Сила (баланс полос, защита баса)', key: 'smart', min: 0, max: 1, step: 0.05, fmt: pct } },
    { key: 'enhance', name: 'Красочность', meter: false, sl: [
      { label: 'Громкость баса (0 — как в оригинале)', key: 'stemBass', min: -12, max: 6, step: 0.5, fmt: sgn },
      { label: 'Жир баса — протяжность и насыщение', key: 'enhBass', min: 0, max: 2, step: 0.05, fmt: pct },
      { label: 'Громкость кика (0 — как в оригинале)', key: 'stemKick', min: -12, max: 6, step: 0.5, fmt: sgn },
      { label: 'Удар кика — быстрая атака', key: 'enhPunch', min: 0, max: 2, step: 0.05, fmt: pct },
      { label: 'Воздух — прозрачность верха', key: 'enhAir', min: 0, max: 2, step: 0.05, fmt: pct },
      { label: 'Окраска — тёплое насыщение инструментов и вокала', key: 'color', min: 0, max: 1, step: 0.05, fmt: pct },
    ] },
    { key: 'width', name: 'Ширина стерео', meter: false, sl: { label: 'Масштаб', key: 'widthScale', min: 0.5, max: 1.5, step: 0.05, fmt: pct } },
    { key: 'limiter', name: 'Лимитер', meter: true, sl: { label: 'Громкость (драйв)', key: 'drive', min: 0, max: 8, step: 0.5, fmt: sgn } },
  ];
  const list = $('fxList');
  for (const f of fx) {
    const row = document.createElement('div');
    row.className = 'fx-row' + (settings.fx[f.key] ? '' : ' off');
    row.innerHTML = `<div class="fx-h"><label class="toggle"><input type="checkbox" ${settings.fx[f.key] ? 'checked' : ''}><span></span></label><b>${f.name}</b><em id="grt-${f.key}">${f.meter ? '0.0 дБ' : ''}</em></div>${f.meter ? `<div class="gr"><i id="gr-${f.key}"></i></div>` : ''}`;
    const tg = row.querySelector('input');
    tg.onchange = (e) => {
      settings.fx[f.key] = e.target.checked;
      row.classList.toggle('off', !e.target.checked);
      save();
    };
    controls.push(() => { tg.checked = settings.fx[f.key]; row.classList.toggle('off', !tg.checked); });
    if (f.bands) {
      const bands = document.createElement('div');
      bands.className = 'bands';
      bands.innerHTML = ['Бас', 'Низ-сер.', 'Середина', 'Верх'].map((n, i) => `<div><div class="bm"><i id="band${i}"></i></div>${n}</div>`).join('');
      row.appendChild(bands);
    }
    if (f.slots) {
      // четыре постоянные ячейки: каждый вырез живёт в своей, ничего не появляется и не исчезает
      const slots = document.createElement('div');
      slots.className = 'res-slots';
      slots.innerHTML = Array.from({ length: RES_SLOTS }, (_, i) => `<span id="resSlot${i}" class="idle"><b>—</b><i></i></span>`).join('');
      row.appendChild(slots);
    }
    for (const s of [].concat(f.sl)) row.appendChild(slider(s));
    if (f.key === 'limiter') row.appendChild(slider({ label: 'Потолок', key: 'ceiling', min: -3, max: 0, step: 0.1, fmt: (v) => `${v.toFixed(1)} дБ` }));
    list.appendChild(row);
  }


  renderProfileSummary();
  const cs = slider({ label: 'Сила коррекции', key: 'corrStrength', min: 0, max: 1, step: 0.05, fmt: pct });
  cs.querySelector('input').addEventListener('change', () => applyCorrectionForDevice());
  $('corrStrengthBox').appendChild(cs);
  for (const id of ['autoLevel', 'loudComp']) {
    $(id).onchange = (e) => { settings[id] = e.target.checked; save(); };
    controls.push(() => ($(id).checked = settings[id]));
  }

  // Простой режим: четыре понятные ручки + пресеты
  const simple = $('simpleSliders');
  const hint = (el, text) => { const sm = document.createElement('small'); sm.textContent = text; el.appendChild(sm); return el; };
  simple.appendChild(hint(slider({ label: 'Сочность', key: 'juice', min: 0, max: 1, step: 0.05, fmt: pct }), 'плотность, тепло и насыщенность — сколько нужно этому треку'));
  simple.appendChild(hint(slider({ label: 'Бас', key: 'bass', min: -6, max: 6, step: 0.5, fmt: sgn }), 'с учётом возможностей вашего устройства'));
  simple.appendChild(hint(slider({ label: 'Чёткость', key: 'clarity', min: -6, max: 6, step: 0.5, fmt: sgn }), 'голос и детали'));
  simple.appendChild(hint(slider({ label: 'Простор', key: 'space', min: 0, max: 1, step: 0.05, fmt: pct }), 'реверберация и эхо вокруг звука'));
  const chips = $('presetChips');
  const chipIds = ['auto', 'studio', 'stadium', 'bass', 'vocal', 'night', 'cinema'];
  const short = { auto: 'Авто', studio: 'Студия', stadium: 'Стадион', bass: 'Бас', vocal: 'Вокал', night: 'Ночной', cinema: 'Кино' };
  chips.innerHTML = chipIds.map((k) => `<button type="button" data-p="${k}" title="${PRESETS[k].name}">${short[k]}</button>`).join('');
  chips.querySelectorAll('button').forEach((b) => (b.onclick = () => applyPreset(b.dataset.p)));
  controls.push(() => chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', store.get('preset', 'auto') === b.dataset.p)));

  // Пространство (расширенный режим)
  const spaceBox = $('spaceBox');
  spaceBox.appendChild(slider({ label: 'Реверберация', key: 'reverb', min: 0, max: 0.4, step: 0.01, fmt: (v) => pct(v / 0.4) }));
  spaceBox.appendChild(slider({ label: 'Дилей (эхо)', key: 'delay', min: 0, max: 0.3, step: 0.01, fmt: (v) => pct(v / 0.3) }));
  spaceBox.appendChild(slider({ label: 'Повторы дилея', key: 'delayFeedback', min: 0, max: 0.7, step: 0.05, fmt: pct }));
  spaceBox.appendChild(slider({ label: 'Приглушать хвосты под музыкой (ducking)', key: 'spaceDuck', min: 0, max: 1, step: 0.05, fmt: pct }));
  spaceBox.appendChild(slider({ label: 'Длина эха (доля такта)', key: 'delayNote', min: 0.25, max: 1, step: 0.25, fmt: (v) => ({ 0.25: '1/16', 0.5: '1/8', 0.75: '3/16', 1: '1/4' })[v] || v }));
  const revBtns = $('revSizeSeg').querySelectorAll('button');
  revBtns.forEach((b) => (b.onclick = () => { settings.reverbSize = b.dataset.v; save(); refreshControls(); }));
  controls.push(() => revBtns.forEach((b) => b.classList.toggle('on', b.dataset.v === settings.reverbSize)));

  // Объём
  $('surAmountBox').appendChild(slider({ label: 'Сила объёма', key: 'surroundAmount', min: 0, max: 1, step: 0.05, fmt: pct }));
  const seg = (id, key) => {
    const btns = $(id).querySelectorAll('button');
    btns.forEach((b) => (b.onclick = () => { settings[key] = b.dataset.v; save(); refreshControls(); }));
    controls.push(() => btns.forEach((b) => b.classList.toggle('on', b.dataset.v === settings[key])));
  };
  seg('surSeg', 'surround');
  seg('surDevSeg', 'surroundDevice');

  // сбросы по блокам
  document.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = () => {
    resetKeys(b.dataset.reset.split(','));
    if (b.dataset.reset.includes('manualEq')) $('eq').querySelectorAll('input').forEach((i) => (i.value = 0));
    toast('Блок сброшен к настройкам по умолчанию', 1600);
  }));
  controls.push(() => $('eq').querySelectorAll('input').forEach((i) => (i.value = settings.manualEq[+i.dataset.i])));
  refreshControls();
}

/* ---------------- пресеты ---------------- */
let userPresets = store.get('presets', {});

function buildPresets() {
  const sel = $('presetSel');
  const cur = store.get('preset', 'auto');
  sel.innerHTML =
    `<optgroup label="Пресеты">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('')}</optgroup>` +
    (Object.keys(userPresets).length ? `<optgroup label="Мои">${Object.keys(userPresets).map((n) => `<option value="u:${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</optgroup>` : '') +
    '<optgroup label="—"><option value="__custom" disabled>Свои настройки</option><option value="__save">Сохранить текущие…</option>' +
    (Object.keys(userPresets).length ? '<option value="__del">Удалить выбранный мой пресет…</option>' : '') + '</optgroup>';
  sel.value = cur;
  if (sel.value !== cur) sel.value = '__custom';
  sel.dataset.prev = sel.value;
  sel.onchange = () => {
    const v = sel.value;
    if (v === '__save') return savePresetDialog();
    if (v === '__del') {
      const prev = sel.dataset.prev;
      if (prev?.startsWith('u:')) { delete userPresets[prev.slice(2)]; store.set('presets', userPresets); toast('Пресет удалён'); }
      store.set('preset', 'auto');
      applyPreset('auto');
      return buildPresets();
    }
    applyPreset(v);
  };
}

function applyPreset(id) {
  const values = id.startsWith('u:') ? userPresets[id.slice(2)] : PRESETS[id]?.values;
  if (!values) return;
  presetLock = true;
  for (const k of PRESET_KEYS) settings[k] = structuredClone(DEFAULTS[k]);
  Object.assign(settings, structuredClone(values));
  // мои пресеты старых версий: одна «Красочность» на все три ручки
  if (values.enhance != null && values.enhBass == null) Object.assign(settings, { enhBass: values.enhance, enhPunch: values.enhance, enhAir: values.enhance });
  delete settings.enhance;
  settings.fx = { ...DEFAULTS.fx, ...(values.fx || {}) };
  save();
  presetLock = false;
  store.set('preset', id);
  $('presetSel').value = id;
  $('presetSel').dataset.prev = id;
  refreshControls();
}

function markPresetCustom() {
  const sel = $('presetSel');
  if (!sel || sel.value === '__custom') return;
  store.set('preset', '__custom');
  sel.value = '__custom';
  sel.dataset.prev = '__custom';
  document.querySelectorAll('#presetChips button').forEach((b) => b.classList.remove('on'));
}

/** Окно ввода названия; onSave(name) вызывается при «Сохранить», onClose — всегда. */
function askPresetName(onSave, onClose) {
  const dlg = $('presetDlg');
  $('presetName').value = '';
  dlg.showModal();
  dlg.onclose = () => {
    const name = $('presetName').value.trim();
    if (dlg.returnValue === 'ok' && name) onSave(name);
    onClose();
  };
}

function savePresetDialog() {
  askPresetName((name) => {
    userPresets[name] = Object.fromEntries(PRESET_KEYS.map((k) => [k, structuredClone(settings[k])]));
    store.set('presets', userPresets);
    store.set('preset', `u:${name}`);
    toast(`Пресет «${name}» сохранён`);
  }, buildPresets);
}

/* ---------------- личный профиль (тест по слуху, по образцу SoundID) ---------------- */
// Три параметра, сильнее всего влияющих на предпочтение (исследования Harman): бас, верх, присутствие.
// По 3 раунда на каждый, шаг уменьшается вдвое (3 → 1.5 → 0.75 дБ). Громкость середины в A и B
// одинаковая (автогромкость), какая сторона «больше», а какая «меньше» — случайно.
const PROFILE_STEPS = [
  { key: 'bass', name: 'Бас', hint: 'глубина и вес низа, кик и бас' },
  { key: 'treble', name: 'Верх', hint: 'воздух, блеск тарелок и хэтов' },
  { key: 'presence', name: 'Присутствие', hint: 'насколько вокал и гитары «впереди»' },
];
const PROFILE_DELTAS = [3, 1.5, 0.75];
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} дБ`;
const profileText = (p) => PROFILE_STEPS.map((s) => `${s.name.toLowerCase()} ${signed(p?.[s.key] || 0)}`).join(', ');

function renderProfileSummary() {
  let box = $('profileBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'profileBox';
    box.className = 'profile-box';
    $('corrCurrent').after(box);
  }
  const p = settings.profile || {};
  const any = PROFILE_STEPS.some((s) => p[s.key]);
  const chips = PROFILE_STEPS.map((s) => `<span class="pf-chip"><small>${s.name}</small><b>${signed(p[s.key] || 0).replace(' дБ', '')}<i> дБ</i></b></span>`).join('');
  box.innerHTML = `<div class="pf-head"><b>Личный профиль</b>${any ? '' : '<small class="muted">не настроен — 2 минуты сравнений на вашем треке</small>'}</div>
    ${any ? `<div class="pf-chips">${chips}</div>` : ''}
    <div class="pf-actions"><button class="btn sm primary" id="profileTest">${any ? 'Пройти заново' : 'Настроить'}</button>${any ? '<button class="btn sm" id="profileReset">Сбросить</button>' : ''}</div>`;
  $('profileTest').onclick = startProfileTest;
  if ($('profileReset')) $('profileReset').onclick = () => { settings.profile = { bass: 0, treble: 0, presence: 0 }; save(); renderProfileSummary(); toast('Личный профиль сброшен'); };
}

function startProfileTest() {
  const before = structuredClone(settings.profile || {});
  const cur = { bass: 0, treble: 0, presence: 0 };
  let step = 0, round = 0, which = 'A', flip = Math.random() < 0.5;
  const dlg = document.createElement('dialog');
  dlg.className = 'modal profile-test';
  document.body.appendChild(dlg);
  const total = PROFILE_STEPS.length * PROFILE_DELTAS.length;
  const variant = (w) => {
    const s = PROFILE_STEPS[step], d = PROFILE_DELTAS[round] * ((w === 'A') !== flip ? -1 : 1);
    return { ...cur, [s.key]: Math.max(-6, Math.min(6, cur[s.key] + d)) };
  };
  const apply = (w) => { which = w; settings.profile = variant(w); render(); };
  const close = () => { window.removeEventListener('keydown', onKey, true); dlg.close(); dlg.remove(); };
  const finish = () => {
    settings.profile = { ...cur };
    save();
    close();
    renderProfileSummary();
    toast(`Профиль сохранён: ${profileText(cur)}`, 5000);
  };
  const choose = (w) => {
    if (w) cur[PROFILE_STEPS[step].key] = variant(w)[PROFILE_STEPS[step].key];
    if (++round >= PROFILE_DELTAS.length) { round = 0; step++; }
    if (step >= PROFILE_STEPS.length) return finish();
    flip = Math.random() < 0.5;
    apply('A');
  };
  const onKey = (e) => {
    if (e.key === '1') { apply('A'); e.preventDefault(); }
    else if (e.key === '2') { apply('B'); e.preventDefault(); }
  };
  function render() {
    const s = PROFILE_STEPS[step], n = step * PROFILE_DELTAS.length + round + 1;
    dlg.innerHTML = `<header class="panel-h"><h3>Личный профиль</h3><small class="muted">выбор ${n} из ${total}</small></header>
      <div class="pt-bar"><i style="width:${((n - 1) / total) * 100}%"></i></div>
      <p class="pt-what"><b>${s.name}</b> — ${s.hint}</p>
      <p class="muted pt-help">Включите любимый трек. Переключайте A и B (клавиши 1 и 2) на одном и том же месте и выберите, что нравится больше.</p>
      <div class="pt-ab"><button type="button" data-v="A" class="${which === 'A' ? 'on' : ''}">A</button><button type="button" data-v="B" class="${which === 'B' ? 'on' : ''}">B</button></div>
      <div class="row between pt-pick"><button type="button" class="btn" data-c="A">Лучше A</button><button type="button" class="btn" data-c="">Одинаково</button><button type="button" class="btn" data-c="B">Лучше B</button></div>
      <footer class="row between"><button type="button" class="btn sm" data-x="cancel">Отмена</button><small class="muted">шаг ${PROFILE_DELTAS[round]} дБ</small></footer>`;
    dlg.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => apply(b.dataset.v)));
    dlg.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => choose(b.dataset.c)));
    dlg.querySelector('[data-x]').onclick = () => { settings.profile = before; close(); };
  }
  dlg.addEventListener('cancel', () => { settings.profile = before; window.removeEventListener('keydown', onKey, true); dlg.remove(); });
  window.addEventListener('keydown', onKey, true);
  dlg.showModal();
  apply('A');
}

/* ---------------- пресеты эквалайзера ---------------- */
let userEqPresets = store.get('eqPresets', {});
const sameEq = (a, b) => a.every((v, i) => Math.abs(v - (b[i] || 0)) < 1e-6);

/** Какой пресет соответствует текущим ползункам: 'flat', 'u:Имя' или '__custom'. */
function currentEqPreset() {
  for (const [n, eq] of Object.entries(userEqPresets)) if (sameEq(settings.manualEq, eq)) return `u:${n}`;
  for (const [k, p] of Object.entries(EQ_PRESETS)) if (sameEq(settings.manualEq, p.eq)) return k;
  return '__custom';
}

function syncEqPreset() {
  const sel = $('eqPresetSel');
  sel.value = currentEqPreset();
  sel.dataset.prev = sel.value;
}

function buildEqPresets() {
  const sel = $('eqPresetSel');
  const mine = Object.keys(userEqPresets);
  sel.innerHTML =
    `<optgroup label="Пресеты EQ">${Object.entries(EQ_PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('')}</optgroup>` +
    (mine.length ? `<optgroup label="Мои">${mine.map((n) => `<option value="u:${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</optgroup>` : '') +
    '<optgroup label="—"><option value="__custom" disabled>Свои правки</option><option value="__save">Сохранить текущий EQ…</option>' +
    (mine.length ? '<option value="__del">Удалить выбранный мой EQ…</option>' : '') + '</optgroup>';
  syncEqPreset();
  sel.onchange = () => {
    const v = sel.value, prev = sel.dataset.prev;
    if (v === '__save') {
      return askPresetName((name) => {
        userEqPresets[name] = settings.manualEq.slice();
        store.set('eqPresets', userEqPresets);
        toast(`EQ «${name}» сохранён`);
      }, buildEqPresets);
    }
    if (v === '__del') {
      if (prev?.startsWith('u:')) {
        delete userEqPresets[prev.slice(2)];
        store.set('eqPresets', userEqPresets);
        toast(`EQ «${prev.slice(2)}» удалён`);
      } else toast('Сначала выберите свой пресет EQ');
      return buildEqPresets();
    }
    const eq = v.startsWith('u:') ? userEqPresets[v.slice(2)] : EQ_PRESETS[v]?.eq;
    if (!eq) return syncEqPreset();
    settings.manualEq = eq.slice();
    save();
    refreshControls();
  };
}

/* ---------------- аудио: запуск ---------------- */
/* ---------- частота дискретизации ---------- */
// settings.sampleRate: 'auto' — обработка на родной частоте текущего устройства вывода; число — выбранная вручную
async function desiredRate() {
  if (settings.sampleRate && settings.sampleRate !== 'auto') return +settings.sampleRate;
  return (await currentDeviceRate()) || undefined;
}

/** Текущее устройство вывода из системного списка macOS (без открытия звукового потока). */
async function macDevice() {
  if (bridge.platform !== 'darwin' || !bridge.audioDevices) return null;
  const list = await bridge.audioDevices().catch(() => null);
  if (!list) return null;
  const name = (guessModelFromDevice(state.outLabel) || state.outLabel || '').toLowerCase().replace(/^default - /, '');
  const sel = $('outSelect')?.value;
  const byName = name && list.find((x) => name.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(name));
  return (sel && sel !== 'default' && byName) || list.find((x) => x.default) || byName || null;
}

async function currentDeviceRate() {
  const d = await macDevice();
  if (d) return d.rate;
  return AudioEngine.deviceRate($('outSelect')?.value || '');
}

async function setupEngine() {
  feats = new FeatureExtractor(engine);
  resSup = new ResonanceSuppressor(feats.binHz, feats.N);
  engine.setVolume(state.sysVolOk?.() ? 1 : settings.volume);
  engine.audioEl.addEventListener('ended', () => playIndex(state.index + 1));
  engine.audioEl.addEventListener('play', () => { syncPlayIcon(); bridge.setPlaybackActive?.(true); });
  engine.audioEl.addEventListener('pause', () => { syncPlayIcon(); bridge.setPlaybackActive?.(false); });
  engine.audioEl.addEventListener('seeking', () => tempo.reset());
  await refreshDevices();
  if ($('outSelect').value) await engine.setOutput($('outSelect').value).catch(() => {});
  state.surKey = state.spKey = null;
  applyCorrectionForDevice();
  updateRateInfo();
}

async function ensureEngine() {
  if (!engine.ctx) {
    await engine.init({ sampleRate: await desiredRate() });
    await setupEngine();
  }
  await engine.resume();
}

/** Перезапуск движка на другой частоте: трек, позиция и обработка системного звука сохраняются. */
let rebuilding = false;
async function rebuildEngine(rate) {
  if (rebuilding || !engine.ctx) return;
  if (rate && Math.abs(rate - engine.ctx.sampleRate) < 1) return updateRateInfo();
  rebuilding = true;
  try {
    const el = engine.audioEl, src = el?.src, t = el?.currentTime || 0, playing = el && !el.paused;
    const wasCap = state.capture.running;
    if (wasCap) await stopSystem();
    await engine.close();
    await engine.init({ sampleRate: rate });
    await setupEngine();
    engine.setMode(state.mode);
    if (state.mode === 'player' && src) {
      engine.audioEl.src = src;
      engine.audioEl.addEventListener('loadedmetadata', () => { engine.audioEl.currentTime = t; if (playing) engine.audioEl.play().catch(() => {}); }, { once: true });
    }
    if (wasCap) await toggleSystem();
    toast(`Обработка на ${fmtRate(engine.ctx.sampleRate)}`, 1800);
  } finally {
    rebuilding = false;
  }
}

/** Авто-режим: если частота устройства изменилась — перезапускаемся на новой. */
async function followDeviceRate() {
  if (!engine.ctx || (settings.sampleRate && settings.sampleRate !== 'auto')) return updateRateInfo();
  const r = await desiredRate();
  if (r && Math.abs(r - engine.ctx.sampleRate) >= 1) await rebuildEngine(r);
  else updateRateInfo();
}

const fmtRate = (r) => `${(r / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} кГц`;

async function updateRateInfo() {
  const info = $('rateInfo');
  if (!info) return;
  const d = await macDevice();
  const dev = d ? d.rate : state.lastProbeRate ?? (state.lastProbeRate = await AudioEngine.deviceRate($('outSelect')?.value || ''));
  const proc = engine.ctx?.sampleRate;
  info.textContent = `Устройство: ${dev ? fmtRate(dev) : '—'} · обработка: ${proc ? fmtRate(proc) : '—'}${dev && proc && Math.abs(dev - proc) >= 1 ? ' (с пересчётом частоты)' : ''}`;
  // macOS: частоты, которые поддерживает текущее устройство (16 кГц у Bluetooth — режим гарнитуры, его не предлагаем)
  $('deviceRateRow').hidden = !d;
  if (d) {
    const sel = $('deviceRateSel');
    const rates = d.rates.filter((r) => r >= 32000);
    sel.innerHTML = rates.map((r) => `<option value="${r}">${fmtRate(r)}</option>`).join('');
    sel.value = String(d.rate);
    sel.dataset.uid = d.uid;
    sel.disabled = rates.length < 2;
    $('deviceRateName').textContent = d.name;
  }
}

function bindRateSettings() {
  const sel = $('procRateSel');
  sel.value = String(settings.sampleRate || 'auto');
  sel.onchange = async () => {
    settings.sampleRate = sel.value === 'auto' ? 'auto' : +sel.value;
    store.set('settings', settings);
    await rebuildEngine(await desiredRate());
  };
  $('deviceRateSel').onchange = async (e) => {
    const r = await bridge.setDeviceRate?.(e.target.dataset.uid, +e.target.value);
    if (!r?.ok) toast('Устройство не приняло эту частоту');
    await followDeviceRate();
  };
}

/* ---------------- обновления (GitHub Releases) ---------------- */
let updDismissed = '';
function renderUpdate(st) {
  if (!st) return;
  $('appVersion').textContent = st.current || '';
  const pct = st.percent != null ? ` · ${st.percent}%` : '';
  const text = {
    idle: 'Проверяется автоматически при запуске и раз в 6 часов',
    checking: 'Проверяю…',
    none: 'Установлена последняя версия',
    available: `Доступна версия ${st.version} — скачайте установщик`,
    downloading: `Скачиваю версию ${st.version || ''}${pct}`,
    ready: `Версия ${st.version} скачана — установится при перезапуске`,
    error: st.error || 'Не удалось проверить обновления',
  }[st.state] || '';
  $('updStatus').textContent = st.supported === false && st.state === 'idle' ? 'Обновления работают в установленном приложении' : text;
  $('updCheck').textContent = st.state === 'ready' || st.state === 'available' ? 'Установить' : 'Проверить';
  $('updCheck').disabled = st.state === 'checking' || st.state === 'downloading';
  const show = (st.state === 'ready' || st.state === 'available') && updDismissed !== st.version;
  $('updateBar').hidden = !show;
  if (show) {
    $('updText').textContent = st.state === 'ready' ? `Kilobuzz ${st.version} готов к установке` : `Вышел Kilobuzz ${st.version}`;
    $('updInstall').textContent = st.state === 'ready' ? 'Перезапустить' : 'Скачать';
  }
  if (st.manual && st.state === 'none') toast('Установлена последняя версия');
  if (st.manual && st.state === 'error') toast(st.error || 'Не удалось проверить обновления');
}

async function installUpdate() {
  const st = await bridge.updateState?.();
  if (st?.state === 'available' && st.manualUrl) return bridge.openExternal(st.manualUrl);
  if (st?.state !== 'ready') return bridge.checkUpdate();
  if (state.capture?.running) await stopSystem().catch(() => {});
  const ok = await bridge.installUpdate();
  if (!ok) toast('Не получилось заменить приложение — открываю установщик', 5000);
}

function bindUpdates() {
  if (!bridge.updateState) return;
  bridge.onUpdateState(renderUpdate);
  bridge.updateState().then(renderUpdate);
  $('updCheck').onclick = () => ($('updCheck').textContent === 'Установить' ? installUpdate() : bridge.checkUpdate());
  $('updInstall').onclick = installUpdate;
  $('updLater').onclick = async () => {
    updDismissed = (await bridge.updateState())?.version || '';
    $('updateBar').hidden = true;
  };
}

function syncPlayIcon() {
  const playing = state.mode === 'system' ? !!state.np?.playing : engine.audioEl && !engine.audioEl.paused;
  $('playIcon').innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
}

/* ---------------- плеер ---------------- */
function addFiles(files) {
  const audio = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(f.name));
  if (!audio.length) return;
  const start = state.playlist.length;
  for (const f of audio) state.playlist.push({ name: f.name, url: URL.createObjectURL(f), file: f, ...parseName(f.name) });
  renderPlaylist();
  if (state.index < 0 || engine.audioEl?.paused) playIndex(start);
}

function renderPlaylist() {
  $('playlist').innerHTML = state.playlist
    .map((t, i) => `<li class="${i === state.index ? 'on' : ''}" data-i="${i}"><i>${i === state.index ? '▶' : i + 1}</i><span>${escapeHtml(t.artist ? `${t.artist} — ${t.title}` : t.title)}</span></li>`)
    .join('');
  $('playlist').querySelectorAll('li').forEach((li) => (li.onclick = () => playIndex(+li.dataset.i)));
}

async function playIndex(i) {
  if (!state.playlist.length) return;
  i = (i + state.playlist.length) % state.playlist.length;
  await ensureEngine();
  if (state.mode !== 'player') setMode('player');
  const t = state.playlist[i];
  state.index = i;
  state.map = null;
  if (t.file && !t.tagsRead) {
    t.tagsRead = true;
    const tags = await readTags(t.file);
    Object.assign(t, { title: tags.title || t.title, artist: tags.artist || t.artist, album: tags.album, cover: tags.cover });
  }
  renderPlaylist();
  renderSeekSections();
  setTrackInfo({ title: t.title, artist: t.artist, app: 'Файл' });
  loadCover({ artist: t.artist, title: t.title }, t.cover);
  onNewTrack(t.artist, t.title);
  engine.audioEl.src = t.url;
  engine.audioEl.play().catch(() => {});

  // Полный анализ структуры файла в фоне
  const token = (state.analyzing = Math.random());
  $('tlStatus').textContent = 'анализ…';
  try {
    const buf = await engine.ctx.decodeAudioData(await (await fetch(t.url)).arrayBuffer());
    const map = await analyzeBuffer(buf, (p) => {
      if (state.analyzing === token) $('tlStatus').textContent = `анализ ${Math.round(p * 100)}%`;
    });
    if (state.analyzing !== token) return;
    state.map = map;
    $('tlStatus').textContent = map ? `${map.segments.length} секций` : '';
    renderSeekSections();
  } catch (err) {
    console.warn(err);
    if (state.analyzing === token) $('tlStatus').textContent = 'живой анализ';
  }
}

function renderSeekSections() {
  const m = state.map;
  $('seekSections').innerHTML = m
    ? m.segments.map((s) => `<i style="width:${((s.end - s.start) / m.duration) * 100}%;background:${SECTIONS[s.label].color}"></i>`).join('')
    : '';
}

/* ---------------- устройства ---------------- */
const VIRTUAL_RE = /(blackhole|cable|vb-audio|soundflower|loopback|virtual|voicemeeter)/i;

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const label = (d, i) => d.label || `Устройство ${i + 1}`;
    // Вход — только виртуальные кабели: микрофон как «системный звук» не используем никогда.
    const ins = devs.filter((d) => d.kind === 'audioinput' && VIRTUAL_RE.test(d.label));
    let outs = devs.filter((d) => d.kind === 'audiooutput' && !VIRTUAL_RE.test(d.label));
    // На телефоне браузерный движок не перечисляет выходы — одно «текущее» устройство,
    // а модель наушников для коррекции выбирается поиском.
    if (!outs.length) outs = [{ deviceId: '', label: 'Наушники / динамик телефона' }];
    const inSel = $('inSelect'), outSel = $('outSelect');
    const prevIn = inSel.value, prevOut = outSel.value || store.get('out', 'default');
    inSel.innerHTML = ins.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(label(d, i))}</option>`).join('');
    outSel.innerHTML = outs.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(label(d, i))}</option>`).join('');
    if (ins.some((d) => d.deviceId === prevIn)) inSel.value = prevIn;
    outSel.value = outs.some((d) => d.deviceId === prevOut) ? prevOut : outs[0]?.deviceId || '';
    state.outLabel = outSel.selectedOptions[0]?.textContent || '';
    renderSystemSource();
  } catch (e) {
    console.warn(e);
  }
}

/* ---------------- системный звук ---------------- */
function setCapStatus(kind, text) {
  $('capDot').className = `dot ${kind}`;
  $('capText').textContent = text;
}

function renderSystemSource() {
  const cap = state.capture;
  const hint = $('sysHint');
  const btn = $('sysStart');
  btn.textContent = cap.running ? 'Остановить' : 'Начать обработку';
  btn.className = cap.running ? 'btn wide' : 'btn primary wide';
  btn.disabled = false;
  $('cableBlock').hidden = cap.supported;
  const win = bridge.platform === 'win32';
  if (win) renderApoBlock();

  if (cap.supported && win) {
    hint.className = 'hint';
    hint.innerHTML = cap.running
      ? 'Звук всех приложений обрабатывается прямо в Windows. Громкость и выбор устройства — как обычно.'
      : 'Нажмите «Начать обработку». Kilobuzz обрабатывает звук только пока открыт; закроете — звук обычный.';
    return;
  }
  if (cap.supported) {
    hint.className = 'hint';
    hint.innerHTML = cap.running
      ? 'Звук всех приложений идёт через Kilobuzz. Оригинал приглушён, пока работает обработка.'
      : 'Kilobuzz перехватит звук всех приложений и пропустит его через обработку. Ничего устанавливать не нужно. При первом запуске macOS спросит разрешение на запись системного звука.';
    return;
  }
  // Windows и старые macOS — только через виртуальный кабель
  const hasCable = $('inSelect').options.length > 0;
  btn.disabled = !hasCable && !cap.running;
  if (!hasCable) {
    hint.className = 'hint warn';
    hint.innerHTML = bridge.platform === 'win32'
      ? 'Виртуальный кабель не найден. Установите бесплатный <b>VB-CABLE</b>, выберите в Windows устройство вывода <b>CABLE Input</b> и перезапустите Kilobuzz.'
      : 'Нужна macOS 14.2+ или виртуальный кабель <b>BlackHole 2ch</b> (выберите его как вывод звука в системе).';
  } else {
    hint.className = 'hint';
    hint.innerHTML = bridge.platform === 'win32'
      ? 'В настройках звука Windows выберите вывод <b>CABLE Input</b>. Справа выберите свои наушники или колонки.'
      : 'Выберите <b>BlackHole</b> как вывод звука в системе, а справа — свои наушники.';
  }
}

async function toggleSystem() {
  await ensureEngine();
  if (state.capture.running) return stopSystem();
  const cap = state.capture;
  try {
    await engine.setOutput($('outSelect').value).catch(() => {});
    if (cap.supported) {
      setCapStatus('wait', 'Запуск…');
      cap.want = true;
      // Windows: звук обрабатывает модуль в системе, приложение только анализирует (свой выход заглушён)
      if (bridge.platform === 'win32') engine.setMuted(true);
      await bridge.startCapture();
    } else {
      await bridge.requestMic();
      await engine.startSystem($('inSelect').value);
      cap.running = true;
      state.applyCableVolume?.();
      setCapStatus('ok', `Захват: ${$('inSelect').selectedOptions[0]?.textContent}`);
    }
    renderSystemSource();
    if (!state.np) setTrackInfo({ title: 'Системный звук', artist: 'Все приложения', app: 'Захват' });
  } catch (e) {
    setCapStatus('err', 'Ошибка');
    toast(`Не удалось начать: ${e.message}`);
  }
}

async function stopSystem() {
  state.capture.want = false;
  state.capture.waitSince = null;
  if (bridge.platform === 'win32' && state.capture.supported && engine.running) {
    bridge.sendApoParams?.(engine.snapshot(true).buffer); // модуль → прозрачный режим
    engine.setMuted(false);
  }
  state.capture.running = false;
  state.applyCableVolume?.();
  await bridge.stopCapture();
  engine.stopCapture();
  engine._stopStream?.();
  setCapStatus('', 'Остановлено');
  renderSystemSource();
}

/* ---------- Windows: модуль Kilobuzz (APO) вместо виртуального кабеля ---------- */
const KB_CLSID = '{6B9E5B7C-3F2A-4C1D-9E8F-1A2B3C4D5E6F}';
// Диагностика больше не всплывает сама — только по кнопке «Диагностика» в блоке модуля.
function scheduleApoDiag() {}
async function showApoDiag() {
  renderApoDiag(await bridge.apoDiag?.().catch(() => null));
}

/** Понятный вывод по журналу модуля и записям устройств — вместо бесконечного ожидания. */
function renderApoDiag(d) {
  let box = $('apoDiag');
  if (!box) { box = document.createElement('div'); box.id = 'apoDiag'; $('sysHint').after(box); }
  if (!d) { box.innerHTML = '<p class="hint err">Не удалось получить диагностику модуля.</p>'; return; }
  const ours = (v) => String(v || '').toUpperCase().includes(KB_CLSID);
  const devs = (d.devices || []).filter((x) => ours(x.gfx) || ours(x.mfx) || ours(x.efx));
  const log = String(d.log || '');
  const lines = log.trim().split(/\r?\n/).filter(Boolean);
  let title, text, action = '';
  if (!d.dll || !devs.length) {
    title = 'Модуль не подключён к устройствам вывода';
    text = 'Нажмите «Переустановить модуль» и подтвердите в окне Windows.';
    action = '<button class="btn sm primary" id="dgReinstall">Переустановить модуль</button>';
  } else if (devs.some((x) => x.modes && ours(x.gfx))) {
    title = 'Модуль подключён к устройству не тем способом';
    text = 'Ваше устройство использует новую схему звуковых эффектов Windows, а модуль записан в старый слот, который Windows для него не читает. Нажмите «Переустановить модуль».';
    action = '<button class="btn sm primary" id="dgReinstall">Переустановить модуль</button>';
  } else if (devs.some((x) => !x.assoc)) {
    title = 'Модуль установлен не полностью';
    text = 'У устройства нет записи, без которой Windows не загружает эффекты (бывает у USB-звуковых карт). Новая версия установщика её добавляет — нажмите «Переустановить модуль».';
    action = '<button class="btn sm primary" id="dgReinstall">Переустановить модуль</button>';
  } else if (devs.some((x) => x.sysfxDisabled)) {
    title = 'В Windows выключены «Улучшения звука» для устройства';
    text = `Параметры → Система → Звук → ${escapeHtml(devs.find((x) => x.sysfxDisabled).name)} → «Улучшения звука»: включить. После этого включите музыку.`;
  } else if (!/загружен в .*audiodg/i.test(log)) {
    title = 'Windows не загружает модуль Kilobuzz';
    text = d.compat
      ? 'Режим совместимости включён, но от звуковой службы Windows нет ответа. Нажмите «Подробная проверка» и подтвердите в окне Windows — она покажет, загружен ли модуль, — и пришлите результат.'
      : 'На части компьютеров Windows загружает сторонние звуковые модули только в «режиме совместимости» (так же работает Equalizer APO). Он отключает защиту аудиотракта для защищённого контента (DRM): на некоторых сервисах может пропасть звук в защищённом видео. Отключается удалением модуля.';
    if (!d.compat) action = '<button class="btn sm primary" id="dgCompat">Включить режим совместимости</button>';
  } else if (!/LockForProcess/.test(log)) {
    title = 'Модуль загружен, но звук через устройство не идёт';
    text = `Включите музыку на устройстве: ${escapeHtml(devs.map((x) => x.name).join(', '))}.`;
  } else {
    title = 'Модуль работает, но связь с приложением не установилась';
    text = escapeHtml(lines.slice(-2).join(' · '));
  }
  box.innerHTML = `<div class="diag"><b>${title}</b><p>${text}</p><div class="row wrap">${action}<button class="btn sm" id="dgCopy">Скопировать диагностику</button><button class="btn sm" id="dgFull">Подробная проверка</button></div><textarea class="diag-text" readonly id="dgText"></textarea></div>`;
  let report = JSON.stringify(d, null, 1);
  $('dgText').value = report;
  // буфер обмена и файл — через систему (окну приложения браузерный буфер недоступен)
  const share = async () => {
    await bridge.copyText(report).catch(() => {});
    const file = await bridge.saveDiagnostics(report).catch(() => null);
    toast(file ? 'Скопировано и сохранено на рабочий стол: kilobuzz-diagnostics.txt' : 'Скопировано в буфер обмена', 6000);
  };
  $('dgCopy').onclick = share;
  $('dgFull').onclick = async () => {
    toast('Подтвердите в окне Windows — проверка займёт несколько секунд', 5000);
    $('dgFull').disabled = true;
    const full = await bridge.apoDiagFull?.().catch(() => null);
    $('dgFull').disabled = false;
    if (!full) return toast('Подробная проверка отменена или не удалась');
    try { report = JSON.stringify(JSON.parse(full), null, 1); } catch { report = full; }
    $('dgText').value = report;
    await share();
  };
  if ($('dgCompat')) $('dgCompat').onclick = async () => {
    toast('Подтвердите в окне Windows', 4000);
    const r = await bridge.apoCompat();
    toast(r.ok ? 'Режим совместимости включён — включите музыку' : 'Отменено');
    state.capture.waitSince = Date.now();
    box.innerHTML = '';
    if (state.capture.want) bridge.startCapture();
  };
  if ($('dgReinstall')) $('dgReinstall').onclick = async () => {
    toast('Подтвердите в окне Windows', 4000);
    const r = await bridge.apoInstall();
    state.capture.apo = r.status;
    toast(r.ok ? 'Модуль переустановлен — включите музыку' : 'Отменено');
    state.capture.waitSince = Date.now();
    box.innerHTML = '';
    if (state.capture.want) bridge.startCapture();
  };
}

/**
 * Установка / обновление / удаление модуля с полосой загрузки: пока идёт работа, вместо кнопок
 * видно, что происходит. Сначала Windows спрашивает разрешение (окно UAC), потом модуль ставится.
 */
let apoBusy = false;
async function apoAction(kind) {
  if (apoBusy) return;
  apoBusy = true;
  const box = $('apoBlock');
  const label = { install: 'Установка модуля', update: 'Обновление модуля', remove: 'Удаление модуля' }[kind];
  box.innerHTML = `<div class="apo-progress"><div class="row between"><b>${label}…</b><span id="apoPct">0%</span></div>
    <div class="bar"><i id="apoBar"></i></div><small class="muted" id="apoStep">Подтвердите в окне Windows</small></div>`;
  let pct = 0;
  const paint = () => { $('apoBar').style.width = `${pct}%`; $('apoPct').textContent = `${Math.round(pct)}%`; };
  // настоящего прогресса Windows не сообщает — полоса плавно идёт к 90% и заканчивается, когда всё готово
  const timer = setInterval(() => {
    pct += (90 - pct) * 0.04;
    if (pct > 25) $('apoStep').textContent = kind === 'remove' ? 'Возвращаем настройки звука Windows' : 'Подключаем модуль к устройствам вывода';
    paint();
  }, 150);
  if (kind === 'remove' && state.capture.running) await stopSystem();
  const r = kind === 'remove' ? await bridge.apoUninstall() : await bridge.apoInstall();
  clearInterval(timer);
  pct = 100;
  paint();
  $('apoStep').textContent = r.ok ? 'Готово' : 'Отменено';
  await new Promise((res) => setTimeout(res, 600));
  apoBusy = false;
  state.capture.apo = r.status;
  state.capture.supported = !!r.status?.installed;
  if (r.ok) toast({ install: 'Модуль установлен — включите музыку', update: 'Модуль обновлён — включите музыку', remove: 'Модуль удалён' }[kind]);
  else toast(r.cancelled ? 'Отменено' : 'Модуль не изменён — попробуйте ещё раз');
  state.capture.waitSince = Date.now();
  renderSystemSource();
  if (r.ok && kind !== 'remove' && state.capture.want) bridge.startCapture();
}

function renderApoBlock() {
  let box = $('apoBlock');
  if (!box) {
    box = document.createElement('div');
    box.id = 'apoBlock';
    $('cableBlock').before(box);
  }
  if (apoBusy) return;
  const apo = state.capture.apo;
  if (!apo?.available) { box.innerHTML = ''; return; }
  if (apo.installed) {
    const chained = (apo.devices || []).some((d) => d.chained);
    box.innerHTML = `${apo.outdated ? '<p class="hint">Вышла новая версия модуля — обновите его, чтобы изменения заработали.</p><button class="btn sm primary" id="apoUpdate">Обновить модуль</button> ' : ''}<p class="hint">Модуль Kilobuzz подключён к звуку Windows.${chained ? ' Эффекты вашей звуковой карты работают как прежде — Kilobuzz добавлен после них.' : ''}</p>
      <div class="row wrap"><button class="btn sm" id="apoRemove">Удалить модуль</button><button class="btn sm" id="apoDiagBtn">Диагностика</button></div>`;
    if ($('apoUpdate')) $('apoUpdate').onclick = () => apoAction('update');
    $('apoRemove').onclick = (e) => { e.preventDefault(); apoAction('remove'); };
    $('apoDiagBtn').onclick = showApoDiag;
  } else {
    box.innerHTML = `<button class="btn primary wide" id="apoInstall">Установить модуль Kilobuzz</button>
      <p class="hint">Один раз: Windows попросит разрешение администратора. Без виртуальных кабелей: обрабатывается звук всех
      приложений, громкость и устройства работают как обычно. Эффекты звуковой карты (Realtek, Dolby и др.) не отключаются —
      Kilobuzz добавляется после них и работает, только пока приложение открыто.</p>
      <p class="hint muted">Или через виртуальный кабель:</p>`;
    $('apoInstall').onclick = () => apoAction('install');
  }
  $('sysStart').hidden = !apo.installed && $('inSelect').options.length === 0;
}

// параметры обработки → модуль Windows (20 раз в секунду)
setInterval(() => {
  const cap = state.capture;
  if (bridge.platform === 'win32' && cap.supported && cap.running && engine.running) bridge.sendApoParams?.(engine.snapshot(!state.power).buffer);
}, 50);

// MessagePort с PCM приходит из preload через window.postMessage
window.addEventListener('message', (e) => {
  if (e.data === 'kilobuzz:capture-port' && e.ports[0]) engine.startCapture(e.ports[0]);
});

function capLabel(rate) {
  const st = engine.capStats;
  const buf = st?.buffered != null ? ` · буфер ${Math.round(st.buffered * 1000)} мс` : '';
  return `Захват идёт · ${Math.round(rate / 100) / 10} кГц${buf}`;
}

engine.onRateFix = ({ rateFix, measured }) => {
  state.capture.rate = rateFix;
  console.info(`kilobuzz: частота захвата уточнена ${measured} → ${rateFix}`);
};

setInterval(() => {
  if (state.capture.running && state.capture.supported && state.capture.rate) setCapStatus('ok', capLabel(engine.capStats?.rate || state.capture.rate));
}, 1000);

bridge.onCaptureStatus((s) => {
  const cap = state.capture;
  if (s.event === 'ready') {
    cap.running = true;
    cap.waitSince = null;
    const dg = $('apoDiag');
    if (dg) dg.innerHTML = '';
    cap.rate = s.sampleRate;
    if (engine.ctx && Math.abs(s.sampleRate - engine.ctx.sampleRate) >= 1 && (!settings.sampleRate || settings.sampleRate === 'auto')) setTimeout(followDeviceRate, 300);
    if (s.excluded === 0) console.warn('kilobuzz: собственные аудиопроцессы не найдены для исключения');
    setCapStatus('ok', capLabel(s.sampleRate));
  } else if (s.event === 'idle') {
    setCapStatus('wait', 'Ожидание звука… включите музыку');
    cap.waitSince ??= Date.now();
    scheduleApoDiag();
    return;
  } else if (s.event === 'error' && s.code === 'not_loaded') {
    // Windows загружает модуль, когда через устройство идёт звук — пробуем снова; если долго нет — диагностика
    cap.running = false;
    setCapStatus('wait', 'Жду модуль Kilobuzz в звуке Windows…');
    cap.waitSince ??= Date.now();
    scheduleApoDiag();
    if (cap.want) setTimeout(() => cap.want && !cap.running && bridge.startCapture(), 3000);
    return;
  } else if (s.event === 'error' && bridge.platform === 'win32') {
    // Windows: без красных ошибок — спокойный статус; модуль подхватится сам или после «Обновить модуль»
    cap.running = false;
    setCapStatus('wait', s.code === 'bad_version' ? 'Обновите модуль, чтобы обработка заработала' : 'Жду модуль Kilobuzz в звуке Windows…');
    renderSystemSource();
    if (s.code !== 'bad_version' && cap.want) setTimeout(() => cap.want && !cap.running && bridge.startCapture(), 3000);
    return;
  } else if (s.event === 'error') {
    cap.running = false;
    setCapStatus('err', s.message || 'Ошибка захвата');
    renderSystemSource();
    $('sysHint').className = 'hint err';
    $('sysHint').textContent = 'Проверьте: Системные настройки → Конфиденциальность и безопасность → Запись экрана и системного звука → Kilobuzz.';
    return;
  } else if (s.event === 'stopped') {
    cap.running = false;
    engine.stopCapture();
    if (bridge.platform === 'win32') engine.setMuted(false);
    setCapStatus('', 'Остановлено');
  } else return;
  renderSystemSource();
});

function setMode(mode) {
  if (state.mode === 'system' && mode !== 'system' && state.capture.running) stopSystem();
  state.mode = mode;
  document.body.classList.toggle('system', mode === 'system');
  setTimeout(syncPlayIcon);
  $('modeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('playerSource').hidden = mode !== 'player';
  $('systemSource').hidden = mode !== 'system';
  bridge.setNowPlayingEnabled(mode === 'system');
  if (engine.ctx) engine.setMode(mode);
  state.map = null;
  renderSeekSections();
  live.reset();
  genre.reset();
  tempo.reset();
  if (mode === 'system') {
    state.np = null;
    state.trackKey = '';
    setTrackInfo({ title: 'Системный звук', artist: '', app: '—' });
    setCover(null);
    renderSystemSource();
  } else if (state.index >= 0) {
    const t = state.playlist[state.index];
    setTrackInfo({ title: t.title, artist: t.artist, app: 'Файл' });
    loadCover({ artist: t.artist, title: t.title }, t.cover);
    onNewTrack(t.artist, t.title);
  }
}

bridge.onNowPlaying((np) => {
  if (state.mode !== 'system') return;
  state.np = np;
  state.npAt = performance.now();
  syncPlayIcon();
  if (!np) return;
  setTrackInfo(np);
  if (`${np.artist}|${np.title}` !== state.trackKey) {
    onNewTrack(np.artist, np.title);
    loadCover(np);
  }
});

function npPosition() {
  const np = state.np;
  if (!np) return NaN;
  return np.position + (np.playing ? (performance.now() - state.npAt) / 1000 : 0);
}

/* ---------------- коррекция наушников (AutoEq) ---------------- */
function currentCorr() {
  return state.corrByDevice[state.outLabel] || null;
}

function appliedProfile(c) {
  if (!c) return null;
  if (c.generic) return profileForGeneric(GENERIC_DEVICES[c.generic].dev, settings.corrStrength);
  return c.profile ? softenProfile(c.profile, settings.corrStrength) : null;
}

/**
 * Устройство: выравнивание его АЧХ + передача её в автобаланс. Даже когда выравнивание выключено,
 * АЧХ устройства учитывается: человек слышит «трек × устройство», и баланс считается по их сумме.
 */
function applyCorrectionForDevice() {
  const c = currentCorr();
  const on = !!c && c.enabled !== false && state.power;
  const prof = on ? appliedProfile(c) : null;
  if (engine.running) {
    engine.setCorrection(prof);
    engine.corrActive = !!prof;
  }
  const fr = c?.generic ? { dev: GENERIC_DEVICES[c.generic].dev } : c?.fr;
  state.devInfo = fr && state.power
    ? { dev: deviceDeviation(fr), res: residualDeviation(deviceDeviation(fr), prof), fLow: deviceLowLimit(fr) }
    : null;
  $('corrToggle').checked = !!c && c.enabled !== false;
  $('corrToggle').disabled = !c;
  $('devType').value = c?.generic || '';
  const fLow = state.devInfo?.fLow;
  $('corrCurrent').innerHTML = c
    ? `<b>${escapeHtml(c.name)}</b>${escapeHtml(c.source || '')}${fr ? ' · АЧХ учитывается' : ''}${fLow ? ` · бас ниже ${Math.round(fLow)} Гц передаётся гармониками` : ''}`
    : `Выберите модель или тип устройства — Kilobuzz подстроит звук под его АЧХ`;
  drawFr(fr, prof);
  suggestCorrection();
  if (c && !c.generic && !c.fr && c.path && !c.frTried) {
    c.frTried = true;
    bridge.loadHeadphoneFr?.(c.path).then((t) => { c.fr = parseFrCsv(t); store.set('corrByDevice', state.corrByDevice); applyCorrectionForDevice(); }).catch(() => {});
  }
}

const FR_OCT = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
function drawFr(fr, prof) {
  $('frWrap').hidden = !fr;
  if (!fr) return;
  const cv = $('frChart'), dpr = window.devicePixelRatio || 1;
  const w = (cv.width = cv.clientWidth * dpr), h = (cv.height = cv.clientHeight * dpr);
  const ctx = cv.getContext('2d'), col = theme.colors();
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, w, h);
  const x = (f) => (Math.log10(f / 20) / 3) * w, y = (d) => h / 2 - (Math.max(-15, Math.min(15, d)) / 15) * (h / 2 - 6 * dpr);
  ctx.strokeStyle = col.grid; ctx.lineWidth = dpr;
  for (const f of [100, 1000, 10000]) { ctx.beginPath(); ctx.moveTo(x(f), 0); ctx.lineTo(x(f), h); ctx.stroke(); }
  ctx.fillStyle = col.muted; ctx.font = `${9 * dpr}px ui-monospace, Menlo, monospace`;
  [['100', 100], ['1k', 1000], ['10k', 10000]].forEach(([t, f]) => ctx.fillText(t, x(f) + 3 * dpr, h - 4 * dpr));
  ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.strokeStyle = col.muted;
  ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(w, y(0)); ctx.stroke(); ctx.setLineDash([]);
  // кривая устройства (отклонение от нейтральной), нормированная к середине
  let fs, dev;
  if (fr.dev) { fs = FR_OCT; dev = fr.dev; }
  else {
    fs = fr.f; const raw = fr.f.map((f, i) => fr.raw[i] - fr.target[i]);
    const mid = raw.filter((_, i) => fr.f[i] >= 500 && fr.f[i] <= 2000);
    const m = mid.reduce((a, b) => a + b, 0) / (mid.length || 1);
    dev = raw.map((d) => d - m);
  }
  const fix = prof ? profileResponse(prof, fs) : fs.map(() => 0);
  const line = (vals, color, width) => {
    ctx.beginPath(); vals.forEach((d, i) => (i ? ctx.lineTo(x(fs[i]), y(d)) : ctx.moveTo(x(fs[i]), y(d))));
    ctx.strokeStyle = color; ctx.lineWidth = width * dpr; ctx.stroke();
  };
  line(dev, css.getPropertyValue('--warn').trim() || '#f5a524', 1.5);
  line(dev.map((d, i) => d + fix[i]), col.accent, 2);
}

let suggestToken = 0;
async function suggestCorrection() {
  const box = $('corrSuggest');
  box.hidden = true;
  if (currentCorr()) return;
  const model = guessModelFromDevice(state.outLabel);
  if (!model) return;
  const token = ++suggestToken;
  try {
    const hits = await bridge.searchHeadphones(model);
    if (token !== suggestToken || !hits.length) return;
    const h = hits[0];
    box.innerHTML = `<span>Найден профиль: <b>${escapeHtml(h.name)}</b></span><button class="btn sm primary">Применить</button>`;
    box.querySelector('button').onclick = () => chooseHeadphone(h);
    box.hidden = false;
  } catch {}
}

async function chooseHeadphone(h) {
  try {
    const [text, csv] = await Promise.all([bridge.loadHeadphoneEq(h.path), bridge.loadHeadphoneFr?.(h.path).catch(() => null)]);
    const profile = parseParametricEq(text);
    setCorrection({ name: h.name, source: h.source, path: h.path, profile, fr: csv ? parseFrCsv(csv) : null });
    toast(`Коррекция применена: ${h.name}`);
  } catch (e) {
    toast(`Не удалось загрузить профиль: ${e.message}`);
  }
}

function setCorrection(c) {
  if (c) state.corrByDevice[state.outLabel] = { ...c, enabled: true };
  else delete state.corrByDevice[state.outLabel];
  store.set('corrByDevice', state.corrByDevice);
  $('corrResults').hidden = true;
  $('corrSearch').value = '';
  applyCorrectionForDevice();
}

let searchTimer;
function bindCorrection() {
  $('corrSearch').oninput = () => {
    clearTimeout(searchTimer);
    const q = $('corrSearch').value.trim();
    const ul = $('corrResults');
    if (q.length < 2) { ul.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      let hits = [];
      try { hits = await bridge.searchHeadphones(q); } catch (e) { toast(`База недоступна: ${e.message}`); }
      ul.innerHTML = hits.length
        ? hits.map((h, i) => `<li data-i="${i}"><span>${escapeHtml(h.name)}</span><small>${escapeHtml(h.source)}</small></li>`).join('')
        : '<li class="empty">Ничего не найдено</li>';
      ul.querySelectorAll('li[data-i]').forEach((li) => (li.onclick = () => chooseHeadphone(hits[+li.dataset.i])));
      ul.hidden = false;
    }, 250);
  };
  $('devType').innerHTML = '<option value="">— модель из базы или тип —</option>' +
    Object.entries(GENERIC_DEVICES).map(([k, d]) => `<option value="${k}">${d.name}</option>`).join('');
  $('devType').onchange = (e) => {
    const k = e.target.value;
    if (k) setCorrection({ name: GENERIC_DEVICES[k].name, source: 'типовая АЧХ', generic: k });
  };
  $('corrToggle').onchange = (e) => {
    const c = currentCorr();
    if (!c) return;
    c.enabled = e.target.checked;
    store.set('corrByDevice', state.corrByDevice);
    applyCorrectionForDevice();
  };
  $('corrImport').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const profile = parseParametricEq(await f.text());
      setCorrection({ name: f.name.replace(/\.txt$/i, '').replace(/ ParametricEQ$/i, ''), source: 'файл', profile });
    } catch (err) {
      toast(err.message);
    }
  };
}

/* ---------------- циклы анализа и управления ---------------- */
setInterval(() => {
  if (!engine.running || !feats || engine.ctx.state !== 'running') return;
  if (state.mode === 'player' && engine.audioEl.paused) return;
  const f = feats.frame(engine.ctx.currentTime);
  state.lastFeat = f;
  if (!f.silent) {
    tempo.push(f.flux, f.t);
    balance.push(f.oct);
    smartBal.push(f.oct);
    density.push(f.loud);
    resSup.push(f.spec);
    if (++smartTick % 3 === 0 && state.lastProbs) {
      const on = state.power && settings.fx.smart && state.adaptive;
      engine.setSmartGains(on ? smartBal.gains(state.lastProbs, state.lastBalEq, settings.smart, state.devInfo?.res) : [0, 0, 0, 0]);
    }
  }
  const tt = state.mode === 'player' ? engine.audioEl.currentTime : npPosition();
  const dur = state.mode === 'player' ? state.map?.duration || engine.audioEl.duration : state.np?.duration;
  live.edmness = genre.edmness;
  live.push(f, tt, dur);
  genre.pushAudio(f, tempo);
}, 20);

let shownLabel, resShownAt = 0;
setInterval(() => {
  if (!engine.running) return;
  const probs = state.genreLock ? { [state.genreLock]: 1 } : genre.update();

  let sec;
  if (state.sectionLock) sec = { label: state.sectionLock, progress: 0.6, next: null };
  else if (state.mode === 'player' && state.map) sec = sectionAt(state.map, engine.audioEl.currentTime);
  else sec = live.current();
  state.section = sec;

  const bal = balance.correction(probs, settings.balance, state.devInfo?.res, state.devInfo?.fLow || 0);
  state.lastProbs = probs;
  if (resSup) {
    const on = state.power && settings.fx.res && state.adaptive;
    engine.setResonance(resSup.update(on ? settings.antiboom : 0), on);
    // цифры обновляем 2 раза в секунду, а не 10, — их можно спокойно прочитать
    const now = performance.now();
    if (now - resShownAt > 500) {
      resShownAt = now;
      resSup.display().forEach((s, i) => {
        const el = $(`resSlot${i}`);
        if (!el) return;
        const act = on && s.active;
        el.className = act ? '' : 'idle';
        el.firstChild.textContent = act ? (s.f >= 1000 ? `${(s.f / 1000).toFixed(1)}к` : `${Math.round(s.f)}`) : '—';
        el.lastChild.textContent = act ? s.gain.toFixed(1) : '';
      });
    }
  }
  state.lastBalEq = state.adaptive ? bal.eq : null;
  const t = computeTarget({ probs, section: sec.label, progress: sec.progress, settings, adaptive: state.adaptive, balanceEq: bal.eq, need: density.need, device: state.devInfo, headroom: engine.inputHeadroom() });
  const ca = settings.compAmount;
  t.comp.mix = Math.min(1, t.comp.mix * Math.min(1, ca) + (ca > 1 ? (ca - 1) * 0.35 : 0));
  t.comp.thr -= (ca - 1) * 5;
  t.comp.ratio *= ca > 1 ? 1 + (ca - 1) * 0.6 : 1;
  engine.applyTarget(t, Number.isFinite(live.loudHigh) ? live.loudHigh : live.longLoud, !state.power);
  const sur = { mode: state.power ? settings.surround : 'off', amount: settings.surroundAmount, device: settings.surroundDevice };
  const surKey = JSON.stringify(sur);
  if (surKey !== state.surKey) { state.surKey = surKey; engine.setSurround(sur); }
  // Пространство: «Простор» (макро) масштабирует реверберацию и дилей; дилей привязан к темпу трека
  const sp = settings.space / 0.3;
  const beat = tempo.bpm && tempo.regularity > 0.12 ? 60000 / tempo.bpm : 480;
  const space = state.power
    ? { reverb: Math.min(0.45, settings.reverb * sp), size: settings.reverbSize, delay: Math.min(0.35, settings.delay * sp), delayMs: Math.min(1500, beat * settings.delayNote), feedback: settings.delayFeedback, duck: settings.spaceDuck ?? 0.7 }
    : { reverb: 0, delay: 0 };
  const spKey = JSON.stringify(space, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
  if (spKey !== state.spKey) { state.spKey = spKey; engine.setSpace(space); }
  state.target = t;
  const ag = engine.updateAutoGain(state.power && settings.autoLevel);
  $('autoGainVal').textContent = state.power && settings.autoLevel ? sgn(ag, '') : '—';
  $('balanceSummary').textContent = state.adaptive && settings.balance > 0 ? bal.summary : 'выключен';

  renderStatus(sec, probs);
  if (sec.label !== shownLabel) {
    shownLabel = sec.label;
    showSection(sec.label);
  }
}, 100);

function showSection(label) {
  const s = SECTIONS[label];
  $('sectionName').textContent = s ? s.name : '—';
  $('sectionSub').textContent = s ? s.desc : 'Включите трек — анализ начнётся автоматически';
  $('secDot').style.background = s ? s.color : '';
  theme.setSectionColor(s?.color || null);
}

function renderStatus(sec, probs) {
  const m = live.metrics;
  $('statBpm').textContent = tempo.bpm && tempo.regularity > 0.12 ? Math.round(tempo.bpm) : '—';
  $('statVocal').textContent = m.vocal != null ? pct(m.vocal) : '—';
  $('statEnergy').textContent = m.relLoud != null ? pct(m.relLoud) : '—';
  $('statNext').textContent = sec.next && sec.next.in < 60 ? `${SECTIONS[sec.next.label].name} ${Math.ceil(sec.next.in)}с` : '—';

  const top = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('genreBars').innerHTML = top
    .map(([k, v], i) => `<div class="bar-row ${i === 0 ? 'top' : ''}"><span>${GENRES[k].name}</span><div class="track"><i style="width:${Math.round(v * 100)}%"></i></div><b>${Math.round(v * 100)}%</b></div>`)
    .join('');

  const gains = state.power ? state.target.eq : new Array(10).fill(0);
  gains.forEach((g, i) => {
    $(`eqv${i}`).textContent = sgn(g, '');
    const fill = $(`eqf${i}`), hgt = (Math.min(10, Math.abs(g)) / 10) * 50;
    fill.style.height = `${hgt}%`;
    fill.style.top = g >= 0 ? `${50 - hgt}%` : '50%';
  });
}

/* ---------------- отрисовка ---------------- */
let glow = 0, lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  // визуализации достаточно ~30 к/с — экономим процессор для звука
  if (now - lastFrame < 31) return;
  lastFrame = now;
  const colors = theme.colors();
  spectrum.draw(colors);

  const playerMode = state.mode === 'player';
  const el = engine.audioEl;
  const pos = playerMode ? el?.currentTime || 0 : npPosition();
  // duration у потоков бывает Infinity — берём длительность из карты структуры, если она есть
  let dur = playerMode ? state.map?.duration || el?.duration : state.np?.duration;
  if (!Number.isFinite(dur) || dur < 0) dur = 0;
  timeline.draw({ map: playerMode ? state.map : null, position: pos, duration: dur, live: live.history, liveTime: live.trackTime, theme: colors });

  $('timeCur').textContent = fmtTime(pos);
  $('timeDur').textContent = fmtTime(dur);
  $('seekFill').style.width = dur ? `${(Math.min(pos, dur) / dur) * 100}%` : '0';
  if (!seeking && dur) $('seekInput').value = Math.round((pos / dur) * 1000);

  const mt = engine.meters;
  const bands = state.power && settings.fx.smart ? mt.bands || [0, 0, 0, 0] : [0, 0, 0, 0];
  bands.forEach((g, i) => {
    const el = $(`band${i}`), w = Math.min(50, (Math.abs(g) / 6) * 50);
    el.className = g > 0 ? 'up' : '';
    el.style.width = `${w}%`;
    el.style.left = g > 0 ? '50%' : `${50 - w}%`;
  });
  for (const k of ['comp', 'deess', 'limiter']) {
    let v = state.power && settings.fx[k] ? mt[k] || 0 : 0;
    if (k === 'comp') v *= mt.compMix ?? 1; // слышимое сжатие с учётом параллельного микса
    $(`gr-${k}`).style.width = `${Math.min(100, (v / 12) * 100)}%`;
    $(`grt-${k}`).textContent = `−${v.toFixed(1)} дБ`;
  }
  if (engine.running) {
    engine._td ??= new Float32Array(engine.outAnalyser.fftSize);
    engine.outAnalyser.getFloatTimeDomainData(engine._td);
    let s = 0;
    for (const v of engine._td) s += v * v;
    const rms = 10 * Math.log10(s / engine._td.length + 1e-12);
    const pk = 20 * Math.log10(mt.peak + 1e-9);
    $('omLevel').style.width = `${Math.max(0, Math.min(100, ((rms + 40) / 40) * 100))}%`;
    $('omPeak').style.width = `${Math.max(0, Math.min(100, ((pk + 40) / 40) * 100))}%`;
    $('omLevelTxt').textContent = rms > -80 ? rms.toFixed(1) : '—';
    $('omPeakTxt').textContent = pk > -80 ? pk.toFixed(1) : '—';
    const f = state.lastFeat;
    glow = Math.max(f && !f.silent ? Math.min(1, f.bassFlux / 120) : 0, glow * 0.9);
    document.documentElement.style.setProperty('--glow', glow.toFixed(3));
  }
}

/* ---------------- события ---------------- */
let seeking = false;
function bind() {
  $('modeSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('adaptiveToggle').onchange = (e) => (state.adaptive = e.target.checked);
  $('fxMaster').onchange = (e) => {
    state.power = e.target.checked;
    document.body.classList.toggle('bypass', !state.power);
    $('fxMasterLbl').textContent = state.power ? 'Эффекты' : 'Оригинал';
    applyCorrectionForDevice();
  };

  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  const dz = $('dropZone');
  window.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dz.classList.remove('over'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (state.mode !== 'player') setMode('player');
    addFiles(e.dataTransfer.files);
  });

  // В режиме системного звука кнопки управляют внешним плеером (Apple Music, Spotify, Windows SMTC).
  const ext = (cmd, value) => {
    if (!state.np) return toast('Плеер не найден: включите музыку в Apple Music или Spotify');
    bridge.playerCommand?.(cmd, value);
    if (cmd === 'playpause') { state.np.playing = !state.np.playing; state.npAt = performance.now(); syncPlayIcon(); }
  };
  $('playBtn').onclick = async () => {
    if (state.mode === 'system') return ext('playpause');
    await ensureEngine();
    if (state.index < 0) return $('fileInput').click();
    engine.audioEl.paused ? engine.audioEl.play() : engine.audioEl.pause();
  };
  $('prevBtn').onclick = () => {
    if (state.mode === 'system') return ext('prev');
    engine.audioEl?.currentTime > 3 ? (engine.audioEl.currentTime = 0) : playIndex(state.index - 1);
  };
  $('nextBtn').onclick = () => (state.mode === 'system' ? ext('next') : playIndex(state.index + 1));
  const seek = $('seekInput');
  seek.oninput = () => (seeking = true);
  seek.onchange = () => {
    seeking = false;
    if (state.mode === 'system') {
      const d = state.np?.duration;
      if (d > 0) {
        const pos = (seek.value / 1000) * d;
        ext('seek', pos);
        state.np.position = pos;
        state.npAt = performance.now();
      }
      return;
    }
    const d = state.map?.duration || engine.audioEl?.duration;
    if (Number.isFinite(d)) engine.audioEl.currentTime = (seek.value / 1000) * d;
  };
  // Громкость = системная громкость (в обе стороны). Если у устройства нет регулятора — своя.
  const vol = $('volInput');
  const paintVol = () => vol.style.setProperty('--v', `${vol.value}%`);
  let volDrag = false, volTimer = 0, sysVolOk = !!bridge.setSystemVolume;
  // Windows + виртуальный кабель: системная громкость меняет громкость кабеля, которую VB-CABLE
  // фактически игнорирует. Поэтому Kilobuzz сам применяет её к своему выходу — клавиши громкости работают.
  const cableMode = () => bridge.platform === 'win32' && state.capture.running && !state.capture.supported;
  const showVol = (v) => {
    if (!volDrag) { vol.value = Math.round(v * 100); paintVol(); }
    settings.volume = v;
    if (engine.ctx && sysVolOk) engine.setVolume(cableMode() ? v : 1);
  };
  state.applyCableVolume = () => engine.ctx && sysVolOk && engine.setVolume(cableMode() ? settings.volume : 1);
  showVol(settings.volume);
  bridge.getSystemVolume?.().then((v) => (v == null ? (sysVolOk = false) : showVol(v)));
  bridge.onSystemVolume?.((v) => showVol(v));
  if (sysVolOk) engine.ctx && engine.setVolume(1);
  vol.onpointerdown = () => (volDrag = true);
  vol.onpointerup = () => setTimeout(() => (volDrag = false), 300);
  vol.oninput = () => {
    settings.volume = vol.value / 100;
    paintVol();
    if (sysVolOk) {
      const now = performance.now();
      if (now - volTimer > 50) { volTimer = now; bridge.setSystemVolume(settings.volume); }
      clearTimeout(vol._t);
      vol._t = setTimeout(() => bridge.setSystemVolume(settings.volume), 80);
    } else if (engine.ctx) engine.setVolume(settings.volume);
    save();
  };
  state.sysVolOk = () => sysVolOk;

  $('sysStart').onclick = toggleSystem;
  $('outSelect').onchange = async () => {
    store.set('out', $('outSelect').value);
    state.outLabel = $('outSelect').selectedOptions[0]?.textContent || '';
    applyCorrectionForDevice();
    if (engine.ctx) await engine.setOutput($('outSelect').value).catch((e) => toast(e.message));
    state.lastProbeRate = null;
    followDeviceRate();
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    await refreshDevices();
    applyCorrectionForDevice();
    state.lastProbeRate = null;
    setTimeout(followDeviceRate, 500); // подключили/сменили устройство — подстраиваем частоту
  });

  $('settingsBtn').onclick = () => { theme.open(); updateRateInfo(); };

  // Простой / расширенный режим (новым пользователям — простой)
  const uiBtns = $('uiModeSeg').querySelectorAll('button');
  const setUi = (m) => {
    store.set('uiMode', m);
    document.body.classList.toggle('simple', m === 'simple');
    uiBtns.forEach((b) => b.classList.toggle('on', b.dataset.v === m));
    requestAnimationFrame(() => applyCorrectionForDevice());
  };
  uiBtns.forEach((b) => (b.onclick = () => setUi(b.dataset.v)));
  setUi(store.get('uiMode', 'simple'));

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); }
    if (e.code === 'KeyB') $('fxMaster').click();
  });
}

async function init() {
  buildStatic();
  buildEq();
  buildFx();
  bind();
  bindCorrection();
  buildPresets();
  theme.bindDialog();
  bindRateSettings();
  bindUpdates();
  // macOS: частоту устройства могут поменять снаружи («Настройка Audio-MIDI») — проверяем раз в 5 с (без открытия звука)
  if (bridge.platform === 'darwin') setInterval(() => engine.ctx && !rebuilding && followDeviceRate(), 5000);
  showSection(null);
  state.capture.supported = await bridge.captureSupported().catch(() => false);
  if (bridge.platform === 'win32') {
    state.capture.apo = await bridge.apoStatus?.().catch(() => null);
    state.capture.supported = !!state.capture.apo?.installed && state.capture.supported;
  }
  setCapStatus('', 'Остановлено');
  await refreshDevices();
  applyCorrectionForDevice();
  requestAnimationFrame(frame);
}
init();

// хук для автотестов в dev-режиме
window.__kilobuzz = { state, engine, live, genre, tempo, loadUrl: (url, name) => { state.playlist.push({ name, url, ...parseName(name) }); renderPlaylist(); return playIndex(state.playlist.length - 1); } };
