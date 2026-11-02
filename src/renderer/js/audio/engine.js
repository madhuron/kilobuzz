import { WORKLET_SOURCE } from './worklets.js';
import { EQ_FREQS } from './profiles.js';

const db2lin = (d) => Math.pow(10, d / 20);

/**
 * Граф:
 *   источник → input ─┬→ [M/S анализаторы]  (анализ до обработки, чтобы EQ не влиял на решения)
 *                     └→ коррекция наушников (AutoEq) → preamp → EQ×10 → de-esser → compressor → width → limiter → volume → выход
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.mode = 'player';
    this.meters = { comp: 0, deess: 0, limiter: 0, peak: 0 };
    this.running = false;
    this._lastSent = new Map();
  }

  /** sampleRate — частота обработки; без неё браузер берёт родную частоту устройства вывода. */
  async init({ sampleRate } = {}) {
    if (this.ctx) return;
    const c = (this.ctx = new AudioContext({ latencyHint: 'playback', ...(sampleRate ? { sampleRate } : {}) }));
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    await c.audioWorklet.addModule(url);

    this.input = c.createGain();

    // Mid/Side анализ: M=(L+R)/2 и S=(L-R)/2 нужны для оценки вокала (обычно по центру).
    const split = c.createChannelSplitter(2);
    const mid = c.createGain(), side = c.createGain();
    const gl = c.createGain(), gr = c.createGain(), sl = c.createGain(), sr = c.createGain();
    gl.gain.value = 0.5; gr.gain.value = 0.5; sl.gain.value = 0.5; sr.gain.value = -0.5;
    this.input.connect(split);
    split.connect(gl, 0); split.connect(gr, 1); split.connect(sl, 0); split.connect(sr, 1);
    gl.connect(mid); gr.connect(mid); sl.connect(side); sr.connect(side);
    mid.channelCount = side.channelCount = 1;
    mid.channelCountMode = side.channelCountMode = 'explicit';
    this.anM = this._analyser(4096);
    this.anS = this._analyser(4096);
    mid.connect(this.anM); side.connect(this.anS);

    // Коррекция АЧХ наушников/колонок: до 16 параметрических фильтров, по умолчанию прозрачна.
    this.corrGain = c.createGain();
    this.corr = Array.from({ length: 16 }, () => {
      const b = c.createBiquadFilter();
      b.type = 'peaking';
      b.gain.value = 0;
      return b;
    });

    // Автогромкость: обработанный звук по громкости совпадает с оригиналом (K-взвешенное сравнение)
    this.autoGain = c.createGain();
    // постоянный запас (дБ): звук тише и с эффектами, и без — место для восстановленных ударов
    this.hr = c.createGain();
    this.anKin = this._kMeter(this.hr);
    this.anPeakIn = this._analyser(8192); this.input.connect(this.anPeakIn); // пики входа — сколько есть запаса до 0 дБ
    this._pkHold = 0;

    this.preamp = c.createGain();
    this.eq = EQ_FREQS.map((f, i) => {
      const b = c.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.1;
      b.gain.value = 0;
      return b;
    });
    const node = (name) => new AudioWorkletNode(c, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    // «Анти-бочка»: узкие динамические вырезы на резонансах (частоты задаёт ResonanceSuppressor)
    this.res = Array.from({ length: 4 }, () => {
      const b = c.createBiquadFilter();
      b.type = 'peaking'; b.frequency.value = 1000; b.Q.value = 4; b.gain.value = 0;
      return b;
    });
    this.stems = node('stems'); // разбор на дорожки: кик / бас / остальное
    this.enhancer = node('enhancer');
    this.smart = node('smart-dynamics');
    this.smart.port.onmessage = (e) => (this.meters.bands = e.data.bands);
    this.deesser = node('deesser');
    this.comp = node('compressor');
    this.width = node('stereo-width');
    this._buildSurround();
    this._buildSpace();
    this.lowLim = node('low-limiter'); // ограничитель низа: пики от кика и баса не приглушают всю музыку
    this.limiter = node('limiter');
    this.volume = c.createGain();
    this.outAnalyser = this._analyser(4096, 0.75);

    this.comp.port.onmessage = (e) => { this.meters.comp = e.data.gr; this.meters.compMix = e.data.mix ?? 0; };
    this.deesser.port.onmessage = (e) => (this.meters.deess = e.data.gr);
    this.limiter.port.onmessage = (e) => {
      this.meters.limiter = e.data.gr;
      this.meters.peak = e.data.peak;
    };

    [this.input, this.hr, this.corrGain, ...this.corr, this.preamp, ...this.eq, ...this.res, this.stems, this.enhancer, this.smart, this.deesser, this.comp, this.width, this.surIn]
      .reduce((a, b) => (a.connect(b), b));
    this.surOut.connect(this.spaceIn);
    // mute — для Windows-модуля: звук обрабатывает сама система, приложение только анализирует
    this.mute = c.createGain();
    [this.spaceOut, this.autoGain, this.lowLim, this.limiter, this.volume, this.outAnalyser, this.mute].reduce((a, b) => (a.connect(b), b));
    this.mute.connect(c.destination);
    this.anKout = this._kMeter(this.spaceOut); // громкость обработанного звука до автогромкости
    this.autoGainDb = 0;
    this._kin = null;
    this._kout = null;

    // Плеер для локальных файлов
    this.audioEl = new Audio();
    this.audioEl.preload = 'auto';
    this.mediaSrc = c.createMediaElementSource(this.audioEl);
    this.mediaSrc.connect(this.input);
    this.running = true;
  }

  /**
   * Виртуальная сцена (режимы «5.1» / «7.1») без HRTF: обобщённая модель уха окрашивает звук
   * и на обычных наушниках звучит «в трубу». Вместо этого:
   *  - кроссфид (наушники): каждое ухо слышит немного противоположного канала с задержкой ~0.25 мс
   *    и без верхов — как от колонок перед вами, звук выходит из головы вперёд;
   *  - ранние отражения: несколько слабых задержанных копий без верхов — глубина и «сцена»;
   *  - диффузное пространство из боковой составляющей (некоррелированная реверберация) — ширина
   *    (5.1) и задний план (7.1), без «гребёнки», которую дают простые задержки;
   *  - для колонок вместо кроссфида — мягкое расширение боковой составляющей.
   * Прибавку баса от кроссфида компенсирует полка на прямом сигнале — бас не разбухает.
   */
  _buildSurround() {
    const c = this.ctx;
    const g = (v = 1) => { const n = c.createGain(); n.gain.value = v; return n; };
    const mono = (v = 1) => { const n = g(v); n.channelCount = 1; n.channelCountMode = 'explicit'; return n; };
    const lp = (hz) => { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = hz; f.Q.value = 0.5; return f; };
    const hp = (hz) => { const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hz; f.Q.value = 0.5; return f; };
    const delay = (ms) => { const d = c.createDelay(0.1); d.delayTime.value = ms / 1000; return d; };
    const chain = (...n) => n.reduce((a, b) => (a.connect(b), b));

    this.surIn = g();
    this.surOut = g();
    // прямой сигнал + полка, компенсирующая бас от кроссфида
    this.surShelf = c.createBiquadFilter();
    this.surShelf.type = 'lowshelf'; this.surShelf.frequency.value = 700; this.surShelf.gain.value = 0;
    chain(this.surIn, this.surShelf, this.surOut);

    const split = c.createChannelSplitter(2);
    this.surIn.connect(split);
    const L = mono(), R = mono();
    split.connect(L, 0); split.connect(R, 1);
    const S = mono(), M = mono();
    const l1 = mono(0.5), r1 = mono(-0.5), l2 = mono(0.5), r2 = mono(0.5);
    split.connect(l1, 0); split.connect(r1, 1); split.connect(l2, 0); split.connect(r2, 1);
    l1.connect(S); r1.connect(S); l2.connect(M); r2.connect(M);

    const merge = c.createChannelMerger(2);
    merge.connect(this.surOut);

    // кроссфид
    this.xfeed = [g(0), g(0)];
    // Кроссфид только боковой составляющей: R = M − S, поэтому в левое ухо идёт −S, в правое +S.
    // Центр (вокал, бас) не меняется вовсе — никакой окраски и разбухания баса,
    // а жёстко разведённые по каналам звуки «сходятся» к сцене перед слушателем.
    const xs = chain(S, delay(0.25), lp(700));
    chain(xs, mono(-1), this.xfeed[0]).connect(merge, 0, 0);
    chain(xs, this.xfeed[1]).connect(merge, 0, 1);

    // ранние отражения (разные задержки для ушей, чтобы не было «зеркала»)
    this.refl = g(0);
    // источники отражений — в основном боковая составляющая (центр почти не повторяется → нет «гребёнки» на вокале)
    const eL = mono(), eR = mono();
    chain(S, mono(1), eL); chain(M, mono(0.3), eL);
    chain(S, mono(-1), eR); chain(M, mono(0.3), eR);
    const tapsL = [[eL, 7.3, 0.2], [eR, 11.1, 0.15], [eL, 16.7, 0.11], [eR, 23.9, 0.08]];
    const tapsR = [[eR, 8.1, 0.2], [eL, 12.4, 0.15], [eR, 17.9, 0.11], [eL, 25.3, 0.08]];
    const reflL = mono(), reflR = mono();
    for (const [src, ms, v] of tapsL) chain(src, delay(ms), mono(v), reflL);
    for (const [src, ms, v] of tapsR) chain(src, delay(ms), mono(v), reflR);
    const reflMerge = c.createChannelMerger(2);
    chain(reflL, lp(5500), hp(150)).connect(reflMerge, 0, 0);
    chain(reflR, lp(5500), hp(150)).connect(reflMerge, 0, 1);
    chain(reflMerge, this.refl, this.surOut);

    // диффузное пространство из боковой составляющей
    const ambIn = mono();
    chain(S, mono(1), ambIn);
    chain(M, mono(0.25), ambIn);
    const ambF = chain(ambIn, hp(200), lp(7000));
    const room = (sec, pre) => {
      const conv = c.createConvolver();
      conv.normalize = true;
      conv.buffer = this._roomIR(sec, pre);
      const out = g(0);
      chain(conv, out, this.surOut);
      this._manage(ambF, conv, out);
      return out;
    };
    this.ambShort = room(0.6, 12);
    this.ambLong = room(1.3, 22);

    // расширение для колонок: +S в левый, −S в правый (в средних частотах)
    this.spread = g(0);
    const spreadSrc = chain(S, hp(250), lp(6000), this.spread);
    spreadSrc.connect(merge, 0, 0);
    chain(spreadSrc, mono(-1)).connect(merge, 0, 1);
  }

  /**
   * Пространство: реверберация (комната / зал / стадион) и стерео-дилей «пинг-понг».
   * В посыл идёт только середина и верх (без баса — иначе гул), уровень по умолчанию очень мал:
   * чуть-чуть объёма, а не «эффект».
   */
  _buildSpace() {
    const c = this.ctx;
    const g = (v = 1) => { const n = c.createGain(); n.gain.value = v; return n; };
    const lp = (hz) => { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = hz; f.Q.value = 0.5; return f; };
    const hp = (hz) => { const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hz; f.Q.value = 0.5; return f; };
    const chain = (...n) => n.reduce((a, b) => (a.connect(b), b));
    this.spaceIn = g();
    this.spaceOut = g();
    this.spaceIn.connect(this.spaceOut);
    // хвосты реверба и дилея собираются в общую шину и проходят через ducking (сухой звук — второй вход)
    this.wetBus = g();
    this.ducker = new AudioWorkletNode(c, 'ducker', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2] });
    this.wetBus.connect(this.ducker, 0, 0); this.spaceIn.connect(this.ducker, 0, 1); this.ducker.connect(this.spaceOut);
    const send = chain(this.spaceIn, hp(250), lp(8000));

    // реверберация: три размера, переключаются громкостью (без пересоздания узлов)
    // makeup — выравнивание уровня: нормализованная свёртка «размазывает» энергию во времени и звучит
    // на 10–18 дБ тише сухого звука; с поправкой «мокрый» сигнал на 100% ≈ −3 дБ от музыки (как в модуле Windows)
    this.rev = {};
    for (const [name, sec, pre, damp, makeup] of [['room', 0.45, 8, 7000, 14.7], ['hall', 1.9, 25, 6000, 8.9], ['stadium', 3.8, 60, 4500, 7.2]]) {
      const conv = c.createConvolver();
      conv.normalize = true;
      conv.buffer = this._roomIR(sec, pre);
      const out = g(0);
      chain(conv, lp(damp), out, g(10 ** (makeup / 20)), this.wetBus);
      this._manage(send, conv, out);
      this.rev[name] = out;
    }

    // дилей «пинг-понг»: левый → правый → обратно в левый, повторы темнеют
    const merge = c.createChannelMerger(2);
    const mono = g(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
    this.dlySend = g(0);
    this.dlyL = c.createDelay(2); this.dlyR = c.createDelay(2);
    this.dlyFb = g(0.3);
    chain(send, mono, this.dlySend, this.dlyL);
    const dampL = lp(5000), dampR = lp(4500);
    chain(this.dlyL, dampL); dampL.connect(merge, 0, 0); dampL.connect(this.dlyR);
    chain(this.dlyR, dampR); dampR.connect(merge, 0, 1); chain(dampR, this.dlyFb, this.dlyL);
    this.dlyOut = g(10 ** (4 / 20));  // выравнивание уровня, как у реверберации
    chain(merge, this.dlyOut, this.wetBus);
  }

  /**
   * Свёртка (реверберация) — самый дорогой узел графа. Неиспользуемые свёртки отключаются
   * от входа, тогда браузер их не считает; включаются обратно, как только громкость > 0.
   */
  _manage(input, conv, out) {
    (this._convs ??= []).push({ input, conv, out, active: false, off: 0 });
  }

  _updateConvs() {
    for (const e of this._convs || []) {
      const want = e.target > 1e-4;
      if (want) {
        clearTimeout(e.off);
        e.off = 0;
        if (!e.active) { e.input.connect(e.conv); e.active = true; }
      } else if (e.active && !e.off) {
        // ждём, пока затухнет хвост, и только потом отключаем
        e.off = setTimeout(() => { try { e.input.disconnect(e.conv); } catch {} e.active = false; e.off = 0; }, 5000);
      }
    }
  }

  _target(out, v) {
    const e = this._convs?.find((x) => x.out === out);
    if (e) e.target = v;
  }

  /** reverb 0..1, size 'room'|'hall'|'stadium', delay 0..1 (уже со шкалой по слуху), delayMs, feedback 0..0.8 */
  setSpace({ reverb = 0, size = 'room', delay = 0, delayMs = 250, feedback = 0.3, duck = 0 }) {
    this._spaceDuck = duck;
    this.ducker.port.postMessage({ depth: duck });
    const now = this.ctx.currentTime, set = (p, v) => p.setTargetAtTime(v, now, 0.2);
    for (const k in this.rev) { set(this.rev[k].gain, k === size ? reverb : 0); this._target(this.rev[k], k === size ? reverb : 0); }
    this._updateConvs();
    set(this.dlySend.gain, delay);
    this.dlyL.delayTime.setTargetAtTime(delayMs / 1000, now, 0.3);
    this.dlyR.delayTime.setTargetAtTime(delayMs / 1000, now, 0.3);
    set(this.dlyFb.gain, Math.min(0.8, feedback));
  }

  /** Стереоимпульс «комнаты» с некоррелированными каналами (без «гребёнки»). */
  _roomIR(sec, predelayMs) {
    const c = this.ctx, n = Math.round(sec * c.sampleRate), pre = Math.round((predelayMs / 1000) * c.sampleRate);
    const b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let seed = 9001 + ch * 7919;
      for (let i = pre; i < n; i++) {
        seed = (seed * 16807) % 2147483647;
        const t = (i - pre) / c.sampleRate;
        d[i] = ((seed / 2147483647) * 2 - 1) * Math.exp((-t * 6.9) / sec);
      }
    }
    return b;
  }

  /** mode: 'off' | '5.1' | '7.1'; amount 0..1; device: 'headphones' | 'speakers'. */
  setSurround({ mode, amount, device }) {
    const now = this.ctx.currentTime, set = (p, v) => p.setTargetAtTime(v, now, 0.15);
    const on = mode !== 'off' && amount > 0, a = on ? amount : 0, hp = device !== 'speakers';
    const cf = hp ? 0.32 * a : 0;
    set(this.xfeed[0].gain, cf);
    set(this.xfeed[1].gain, cf);
    set(this.surShelf.gain, 0);
    set(this.refl.gain, (mode === '7.1' ? 1 : 0.8) * a * (hp ? 1 : 0.6));
    set(this.ambShort.gain, mode === '5.1' ? 0.2 * a : 0);
    set(this.ambLong.gain, mode === '7.1' ? 0.3 * a : 0);
    this._target(this.ambShort, mode === '5.1' ? 0.2 * a : 0);
    this._target(this.ambLong, mode === '7.1' ? 0.3 * a : 0);
    this._updateConvs();
    set(this.spread.gain, hp ? 0 : 0.35 * a);
  }

  /** Измеритель громкости с упрощённым K-взвешиванием (ФВЧ 60 Гц + полка +4 дБ от 1.5 кГц). */
  _kMeter(src) {
    const c = this.ctx;
    // громкость сравниваем только по середине (400 Гц – 4 кГц: вокал и инструменты): она остаётся как в
    // оригинале, а бас, кик и воздух добавляются сверху — подъём низа не делает тише остальную музыку
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400; hp.Q.value = 0.5;
    const sh = c.createBiquadFilter(); sh.type = 'lowpass'; sh.frequency.value = 4000; sh.Q.value = 0.5;
    const an = this._analyser(2048);
    src.connect(hp); hp.connect(sh); sh.connect(an);
    return an;
  }

  _kLevel(an, key) {
    const buf = (this[`_${key}buf`] ??= new Float32Array(an.fftSize));
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const db = 10 * Math.log10(s / buf.length + 1e-12);
    const prev = this[`_${key}`];
    // энергетическое усреднение ~3 с (вызов раз в 100 мс)
    const p = prev == null ? db : 10 * Math.log10(0.967 * 10 ** (prev / 10) + 0.033 * 10 ** (db / 10));
    this[`_${key}`] = p;
    return { now: db, avg: p };
  }

  /**
   * Автогромкость; вызывать раз в 100 мс. Сравнивает громкость до и после обработки (без обратной связи:
   * выход меряется до самой автогромкости), поэтому не раскачивается. Возвращает поправку, дБ.
   */
  /** Запас до 0 дБFS у входного трека (дБ): пик за последние ~3 с. Громкие мастера — около 0. */
  inputHeadroom() {
    const buf = (this._pkBuf ??= new Float32Array(this.anPeakIn.fftSize));
    this.anPeakIn.getFloatTimeDomainData(buf);
    let pk = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > pk) pk = a; }
    this._pkHold = Math.max(pk, this._pkHold * 0.995); // ~3 с при вызове 10 раз в секунду
    return this._pkHold > 1e-4 ? -20 * Math.log10(this._pkHold) : 12;
  }

  updateAutoGain(enabled) {
    const i = this._kLevel(this.anKin, 'kin'), o = this._kLevel(this.anKout, 'kout');
    let target = this.autoGainDb;
    if (!enabled) target = 0;
    // убавлять больше 1.5 дБ нельзя: иначе проваливается тело звука, и обработка звучит тише и тоньше оригинала
    else if (i.now > -55 && o.now > -70) target = Math.max(-1.5, Math.min(6, i.avg - o.avg));
    // Лимитер на громкость не влияет: на громких мастерах он срабатывает от пиков самого оригинала
    // (плеер выдаёт пики выше 0 дБ), и прежнее «убавить, если лимитер жмёт» делало звук тише оригинала.
    // при тишине уровни бывают −∞ и разность даёт «нечисло» — оно ушло бы в модуль и выключило звук
    if (!Number.isFinite(target)) target = Number.isFinite(this.autoGainDb) ? this.autoGainDb : 0;
    if (!Number.isFinite(this.autoGainDb)) this.autoGainDb = 0;
    this.autoGainDb += (target - this.autoGainDb) * 0.15;
    this.autoGain.gain.setTargetAtTime(db2lin(this.autoGainDb), this.ctx.currentTime, 0.3);
    return this.autoGainDb;
  }

  _analyser(size, smoothing = 0) {
    const a = this.ctx.createAnalyser();
    a.fftSize = size;
    a.smoothingTimeConstant = smoothing;
    a.minDecibels = -120;
    a.maxDecibels = 0;
    return a;
  }

  /** Полная остановка — для перезапуска на другой частоте. */
  async close() {
    this.running = false;
    try { this.audioEl?.pause(); this.audioEl?.removeAttribute('src'); } catch {}
    this._stopStream();
    this.stopCapture();
    for (const e of this._convs || []) clearTimeout(e.off);
    this._convs = [];
    this._lastSent.clear();
    this._smartKey = null;
    this._td = null;
    this.capStats = null;
    this.meters = { comp: 0, deess: 0, limiter: 0, peak: 0 };
    try { await this.ctx?.close(); } catch {}
    this.ctx = null;
  }

  /** Родная частота устройства вывода (deviceId из enumerateDevices; '' — по умолчанию). */
  static async deviceRate(deviceId = '') {
    let probe;
    try {
      probe = new AudioContext(deviceId && deviceId !== 'default' ? { sinkId: deviceId } : {});
      return probe.sampleRate;
    } catch {
      return null;
    } finally {
      probe?.close().catch(() => {});
    }
  }

  async resume() {
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'player') {
      this._stopStream();
      this.stopCapture();
      try { this.mediaSrc.connect(this.input); } catch {}
    } else {
      this.audioEl.pause();
      try { this.mediaSrc.disconnect(); } catch {}
    }
  }

  /** Подключает поток системного звука (MessagePort из главного процесса) напрямую в AudioWorklet. */
  startCapture(port) {
    this.stopCapture();
    this.capNode = new AudioWorkletNode(this.ctx, 'pcm-source', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.capNode.port.onmessage = (e) => {
      if (e.data.rateFix) this.onRateFix?.(e.data);
      else Object.assign(this.capStats ??= {}, e.data);
    };
    this.capNode.port.postMessage({ port }, [port]);
    this.capNode.connect(this.input);
  }

  stopCapture() {
    try { this.capNode?.disconnect(); } catch {}
    this.capNode = null;
  }

  /** profile: { preamp, filters: [{ type: 'PK'|'LSC'|'HSC', fc, gain, q }] } или null — выключить. */
  setCorrection(profile) {
    const now = this.ctx.currentTime;
    const types = { PK: 'peaking', LSC: 'lowshelf', HSC: 'highshelf', LS: 'lowshelf', HS: 'highshelf' };
    this.corr.forEach((b, i) => {
      const f = profile?.filters[i];
      b.type = f ? types[f.type] || 'peaking' : 'peaking';
      b.frequency.setValueAtTime(f ? f.fc : 1000, now);
      b.Q.setValueAtTime(f ? f.q : 1, now);
      b.gain.setTargetAtTime(f ? f.gain : 0, now, 0.05);
    });
    this.corrGain.gain.setTargetAtTime(db2lin(profile ? profile.preamp : 0), now, 0.05);
  }

  async startSystem(deviceId) {
    this._stopStream();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    this.streamSrc = this.ctx.createMediaStreamSource(this.stream);
    this.streamSrc.connect(this.input);
  }

  _stopStream() {
    try { this.streamSrc?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = this.streamSrc = null;
  }

  async setOutput(deviceId) {
    if (typeof this.ctx.setSinkId === 'function') await this.ctx.setSinkId(deviceId || '');
  }

  setVolume(v) {
    this.volume.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.03);
  }

  _post(node, key, msg) {
    const s = JSON.stringify(msg);
    if (this._lastSent.get(key) === s) return;
    this._lastSent.set(key, s);
    node.port.postMessage(msg);
  }

  /** target — результат computeTarget(); trackLoud — средняя громкость трека (дБ) для относительного порога. */
  applyTarget(t, trackLoud, bypassAll) {
    const now = this.ctx.currentTime;
    const tc = Math.max(0.02, t.tc);
    this.eq.forEach((b, i) => b.gain.setTargetAtTime(bypassAll ? 0 : t.eq[i], now, tc));
    this.preamp.gain.setTargetAtTime(bypassAll ? 1 : db2lin(t.preamp), now, tc);
    this._headroomDb = t.headroom || 0;
    this.hr.gain.setTargetAtTime(db2lin(-this._headroomDb), now, 0.1);

    const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
    const c = t.comp;
    // Компрессор — мягкая «склейка»: порог выше средней громкости трека, ловит только пики
    // (1–2 дБ), медленная атака сохраняет удары и согласные, параллельный микс не душит динамику.
    // Порог — около средней громкости трека: громкие места реально сжимаются (2–5 дБ),
    // при любом мастеринге (тихом или «пережатом»). Плотность (0..2) задаётся в приложении.
    // пресет + «Сочность» + автоплотность не должны складываться в пережатие («качание»)
    const threshold = (Number.isFinite(trackLoud) ? trackLoud : -14) - 6 + Math.max(-8, c.thr);
    this._post(this.comp, 'comp', {
      bypass: bypassAll || !t.fx.comp,
      threshold: r(threshold),
      // «склейка», а не давление: мягкое соотношение и параллельный подмес не больше половины
      ratio: r(Math.min(2.5, c.ratio), 2),
      attack: r(Math.max(5, c.attack)),
      release: r(Math.max(60, c.release)),
      mix: r(Math.max(0, Math.min(0.5, c.mix)), 2),
      knee: 6,
    });
    const d = Math.max(0, Math.min(1, t.deess));
    this._post(this.deesser, 'deess', {
      bypass: bypassAll || !t.fx.deess,
      threshold: r(-4 - 8 * d),
      maxReduction: r(2 + 4 * d),
    });
    const st = t.stems || {};
    this._post(this.stems, 'stems', { bypass: bypassAll || !t.fx.enhance, kick: r(st.kick || 0, 2), punch: r(st.punch || 0, 2), bass: r(st.bass || 0, 2), sustain: r(st.sustain || 0, 2), harm: r(st.harm || 0, 2), duck: r(st.duck || 0, 2), rest: 0, tame: r(st.tame || 0, 2), recover: r(st.recover || 0, 2), restore: r(st.restore || 0, 2), color: r(st.color || 0, 2) });
    this._post(this.enhancer, 'enh', {
      bypass: bypassAll || !t.fx.enhance,
      bass: r(t.enhance.bass, 2),
      air: r(t.enhance.air, 2),
      warm: r(t.enhance.warm ?? 0, 2),
      punch: r(t.enhance.punch ?? 0, 2),
    });
    this._post(this.smart, 'smart', { bypass: bypassAll || !t.fx.smart, amount: r(t.smart, 2), bassLimit: r(t.bassLimit) });
    this._post(this.width, 'width', { bypass: bypassAll || !t.fx.width, width: r(t.width, 2) });
    this._post(this.lowLim, 'lowlim', { bypass: bypassAll || !t.fx.limiter, ceiling: r(t.ceiling) });
    this._post(this.limiter, 'lim', {
      bypass: bypassAll || !t.fx.limiter,
      ceiling: r(t.ceiling),
      drive: bypassAll || !t.fx.limiter ? 0 : r(t.drive),
    });
  }

  /** slots: [{f, gain, q}] — вырезы подавителя резонансов. */
  setResonance(slots, on) {
    const now = this.ctx.currentTime;
    slots.forEach((s, i) => {
      const b = this.res[i];
      b.frequency.setTargetAtTime(s.f, now, 0.05);
      b.Q.setTargetAtTime(s.q, now, 0.05);
      b.gain.setTargetAtTime(on ? s.gain : 0, now, 0.08);
    });
  }

  setMuted(on) {
    this.mute.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  /**
   * Текущие параметры всех блоков одним вектором для модуля Kilobuzz APO (Windows).
   * Раскладка совпадает с native/win/shared.h (KbParam). Значения AudioParam берутся текущие
   * (уже сглаженные), поэтому модуль звучит так же, как движок приложения.
   */
  snapshot(bypass = false) {
    const P = new Float32Array(142);
    const db = (g) => 20 * Math.log10(Math.max(1e-6, g));
    const J = (k) => { try { return JSON.parse(this._lastSent.get(k) || '{}'); } catch { return {}; } };
    P[0] = 1; P[1] = bypass ? 1 : 0;
    P[2] = db(this.corrGain.gain.value);
    this.corr.forEach((b, i) => {
      const o = 3 + i * 4;
      P[o] = b.type === 'lowshelf' ? 1 : b.type === 'highshelf' ? 2 : 0;
      P[o + 1] = b.frequency.value; P[o + 2] = b.gain.value; P[o + 3] = b.Q.value;
    });
    P[67] = db(this.preamp.gain.value);
    this.eq.forEach((b, i) => (P[68 + i] = b.gain.value));
    this.res.forEach((b, i) => { P[78 + i * 3] = b.frequency.value; P[79 + i * 3] = b.gain.value; P[80 + i * 3] = b.Q.value; });
    const enh = J('enh'); P[90] = enh.bass || 0; P[91] = enh.air || 0; P[92] = enh.warm || 0; P[93] = enh.bypass ? 1 : 0;
    (this._smartKey || '0,0,0,0').split(',').map(Number).forEach((g, k) => (P[94 + k] = g || 0));
    const sm = J('smart'); P[98] = sm.amount ?? 0; P[99] = sm.bassLimit ?? -9; P[100] = sm.bypass ? 1 : 0;
    const de = J('deess'); P[101] = de.threshold ?? -10; P[102] = de.maxReduction ?? 4; P[103] = de.bypass ? 1 : 0;
    const c = J('comp'); P[104] = c.threshold ?? -18; P[105] = c.ratio ?? 1; P[106] = c.attack ?? 15; P[107] = c.release ?? 150; P[108] = c.mix ?? 0; P[109] = c.knee ?? 6; P[110] = c.bypass ? 1 : 0;
    const w = J('width'); P[111] = w.width ?? 1; P[112] = w.bypass ? 1 : 0;
    P[113] = this.xfeed[0].gain.value; P[114] = this.refl.gain.value; P[115] = this.ambShort.gain.value; P[116] = this.ambLong.gain.value; P[117] = this.spread.gain.value;
    P[118] = this.rev.room.gain.value; P[119] = this.rev.hall.gain.value; P[120] = this.rev.stadium.gain.value;
    P[121] = this.dlySend.gain.value; P[122] = this.dlyL.delayTime.value * 1000; P[123] = this.dlyFb.gain.value;
    P[124] = this.autoGainDb || 0;
    const l = J('lim'); P[125] = l.ceiling ?? -1; P[126] = l.drive ?? 0; P[127] = l.bypass ? 1 : 0;
    P[128] = enh.punch || 0;
    const stm = J('stems'), son = !bypass && !stm.bypass;
    [stm.kick, stm.punch, stm.bass, stm.sustain, stm.harm, stm.duck, stm.rest, stm.tame, stm.recover].forEach((v, k) => (P[129 + k] = son ? v || 0 : 0));
    P[138] = this._headroomDb || 0; // запас — и при «Эффекты выкл» (честное сравнение громкости)
    P[139] = son ? stm.restore || 0 : 0;
    P[140] = son ? stm.color || 0 : 0;
    P[141] = this._spaceDuck || 0;
    for (let k = 0; k < P.length; k++) if (!Number.isFinite(P[k])) P[k] = 0; // модуль получает только числа
    return P;
  }

  /** Быстрые поправки полос умной динамики (вызывать ~каждые 60 мс). */
  setSmartGains(gains) {
    const g = gains.map((x) => Math.round(x * 10) / 10);
    const key = g.join(',');
    if (key === this._smartKey) return;
    this._smartKey = key;
    this.smart.port.postMessage({ gains: g });
  }

  /** Суммарная АЧХ (дБ) на заданных частотах — для отрисовки кривых. which: 'eq' | 'corr'. */
  eqResponse(freqs, which = 'eq') {
    const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    const gain = which === 'eq' ? this.preamp : this.corrGain;
    const total = new Float32Array(freqs.length).fill(20 * Math.log10(gain.gain.value || 1e-6));
    for (const b of which === 'eq' ? this.eq : this.corr) {
      b.getFrequencyResponse(freqs, mag, ph);
      for (let i = 0; i < freqs.length; i++) total[i] += 20 * Math.log10(mag[i] || 1e-6);
    }
    return total;
  }

  currentEqGains() {
    return this.eq.map((b) => b.gain.value);
  }
}
