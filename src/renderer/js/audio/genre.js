import { GENRE_KEYS } from './profiles.js';

// Названия жанров MusicBrainz и каталога Apple (английские и русские: «Hip-Hop/Rap», «Хип-хоп/рэп», «Hard Rock»…).
const TAG_RULES = [
  [/(edm|electro|house|techno|trance|dubstep|drum ?(and|&|n) ?bass|dnb|hardstyle|bass music|future bass|electronic|dance|garage|breakbeat|rave|synthwave|электрон|танц)/i, 'edm'],
  [/(hip.?hop|rap|trap|drill|grime|phonk|рэп|хип.?хоп)/i, 'hiphop'],
  [/(metal|metalcore|deathcore|djent|thrash|метал)/i, 'metal'],
  [/(rock|punk|grunge|shoegaze|alternative|indie|рок|альтернатив|инди)/i, 'rock'],
  [/(pop|поп)/i, 'pop'],
  [/(r&b|rnb|rhythm and blues|soul|funk)/i, 'rnb'],
  [/(jazz|swing|bossa|bebop|blues|джаз)/i, 'jazz'],
  [/(classical|orchestra|baroque|opera|symphon|chamber|soundtrack|score|neoclassical|классик)/i, 'classical'],
  [/(folk|acoustic|singer.?songwriter|country|americana|бард)/i, 'acoustic'],
  [/(lo.?fi|chill|downtempo|trip.?hop|ambient)/i, 'lofi'],
];

/** Прототипы стилей в пространстве аудиопризнаков: [среднее, разброс]. */
const PROTO = {
  edm:       { bpm: [[128, 174], 14], low: [-4, 3], cent: [11.1, 0.8], flat: [0.25, 0.15], dyn: [0.8, 0.6], reg: [0.6, 0.2], vocal: [0.35, 0.25] },
  hiphop:    { bpm: [[90, 145], 14], low: [-3, 3], cent: [10.8, 0.8], flat: [0.2, 0.15], dyn: [1, 0.6], reg: [0.45, 0.2], vocal: [0.65, 0.2] },
  rock:      { bpm: [[125], 25], low: [-8, 3], cent: [11.3, 0.7], flat: [0.35, 0.15], dyn: [1.2, 0.6], reg: [0.35, 0.2], vocal: [0.5, 0.25] },
  metal:     { bpm: [[150], 30], low: [-8, 3], cent: [11.6, 0.7], flat: [0.5, 0.15], dyn: [0.7, 0.5], reg: [0.35, 0.2], vocal: [0.4, 0.25] },
  pop:       { bpm: [[115], 20], low: [-6, 3], cent: [11.2, 0.7], flat: [0.25, 0.15], dyn: [1, 0.6], reg: [0.5, 0.2], vocal: [0.7, 0.2] },
  rnb:       { bpm: [[85], 15], low: [-5, 3], cent: [10.6, 0.7], flat: [0.2, 0.15], dyn: [1.2, 0.7], reg: [0.4, 0.2], vocal: [0.7, 0.2] },
  jazz:      { bpm: [[120], 40], low: [-10, 3], cent: [10.6, 0.8], flat: [0.15, 0.12], dyn: [2, 1], reg: [0.2, 0.15], vocal: [0.4, 0.3] },
  classical: { bpm: [[100], 50], low: [-12, 4], cent: [10.2, 0.9], flat: [0.12, 0.1], dyn: [3, 1.5], reg: [0.1, 0.1], vocal: [0.2, 0.25] },
  acoustic:  { bpm: [[105], 30], low: [-11, 3], cent: [10.7, 0.8], flat: [0.15, 0.1], dyn: [1.8, 0.8], reg: [0.2, 0.15], vocal: [0.65, 0.25] },
  lofi:      { bpm: [[82], 12], low: [-6, 3], cent: [10.1, 0.7], flat: [0.2, 0.15], dyn: [1, 0.6], reg: [0.45, 0.2], vocal: [0.25, 0.25] },
};

const uniform = () => Object.fromEntries(GENRE_KEYS.map((k) => [k, 1 / GENRE_KEYS.length]));

/**
 * Стиль = теги из метаданных (MusicBrainz по исполнителю) + анализ самого звука.
 * Аудио-часть — эвристика по прототипам; при наличии тегов они весят больше.
 */
export class GenreClassifier {
  constructor() { this.reset(); }

  reset() {
    this.meta = null;
    this.tags = [];
    this.fromCatalog = false;
    this._snapped = false;
    this.acc = null;
    this.audioSec = 0;
    this.loudWin = [];
    this.lastLoudT = 0;
    this.probs = uniform();
    this.audioProbs = uniform();
  }

  setTags(tags) {
    this.tags = tags || [];
    this.fromCatalog = this.tags.some((t) => t.source === 'apple'); // жанр трека из каталога Apple — почти наверняка верный
    const sc = {};
    for (const { name, count } of this.tags) {
      for (const [re, g] of TAG_RULES) if (re.test(name)) sc[g] = (sc[g] || 0) + Math.max(1, count || 1);
    }
    const sum = Object.values(sc).reduce((a, b) => a + b, 0);
    this.meta = sum ? Object.fromEntries(GENRE_KEYS.map((k) => [k, (sc[k] || 0) / sum])) : null;
  }

  pushAudio(f, tempo) {
    if (f.silent) return;
    const v = {
      low: f.lowRatio,
      cent: Math.log2(Math.max(50, f.centroid)),
      flat: f.flat,
      vocal: f.vocal,
    };
    const a = 1 - Math.exp(-0.02 / 12);
    if (!this.acc) this.acc = { ...v };
    else for (const k in v) this.acc[k] += (v[k] - this.acc[k]) * a;
    this.audioSec += 0.02;
    if (f.t - this.lastLoudT > 1) {
      this.lastLoudT = f.t;
      this.loudWin.push(f.loud);
      if (this.loudWin.length > 30) this.loudWin.shift();
    }
    this.tempo = tempo;
  }

  _audioScores() {
    if (!this.acc || this.audioSec < 4) return null;
    // Микродинамика: средний перепад громкости секунда к секунде (насколько «сжат» мастер),
    // а не разброс между секциями — иначе брейкдауны в EDM выглядят как «живая» музыка.
    let dyn = 0;
    for (let i = 1; i < this.loudWin.length; i++) dyn += Math.abs(this.loudWin[i] - this.loudWin[i - 1]);
    dyn /= Math.max(1, this.loudWin.length - 1);
    const feat = { ...this.acc, dyn, bpm: this.tempo?.bpm || 0, reg: this.tempo?.regularity || 0 };
    const out = {};
    let sum = 0;
    for (const g of GENRE_KEYS) {
      const P = PROTO[g];
      let z2 = 0;
      for (const key of ['low', 'cent', 'flat', 'dyn', 'reg', 'vocal']) z2 += ((feat[key] - P[key][0]) / P[key][1]) ** 2;
      if (feat.bpm) {
        let best = Infinity;
        for (const mu of P.bpm[0]) for (const [mul, pen] of [[1, 0], [2, 0.5], [0.5, 0.5]]) best = Math.min(best, ((feat.bpm * mul - mu) / P.bpm[1]) ** 2 + pen);
        z2 += best;
      }
      out[g] = Math.exp(-0.5 * z2 / 3);
      sum += out[g];
    }
    for (const g of GENRE_KEYS) out[g] /= sum || 1;
    return out;
  }

  update() {
    const audio = this._audioScores();
    if (audio) this.audioProbs = audio;
    // звук только уточняет: при жанре из каталога — 10%, при одних тегах исполнителя — 30%
    const wAudio = audio ? Math.min(1, this.audioSec / 25) * (this.meta ? (this.fromCatalog ? 0.1 : 0.3) : 1) : 0;
    const wMeta = this.meta ? 1 - wAudio : 0;
    const target = {};
    let sum = 0;
    for (const g of GENRE_KEYS) {
      target[g] = (this.meta?.[g] || 0) * wMeta + (audio?.[g] || 0) * wAudio + (wMeta + wAudio === 0 ? 1 : 0.01);
      sum += target[g];
    }
    // данные трека применяются сразу, без долгого «разгона» от равных долей
    const rate = this.meta && !this._snapped ? 1 : 0.08;
    for (const g of GENRE_KEYS) this.probs[g] += (target[g] / sum - this.probs[g]) * rate;
    if (this.meta) this._snapped = true;
    return this.probs;
  }

  top(n = 3) {
    return Object.entries(this.probs).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  get edmness() {
    return Math.min(1, this.probs.edm + 0.6 * this.probs.hiphop + 0.3 * this.probs.pop);
  }
}
