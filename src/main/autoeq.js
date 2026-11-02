const fs = require('fs');

const BASE = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results';
const WEEK = 7 * 24 * 3600 * 1000;
// Предпочтение источникам измерений: стенды oratory1990 и crinacle — самые надёжные.
const SOURCE_RANK = ['oratory1990', 'crinacle', 'Rtings', 'Innerfidelity', 'Headphone.com Legacy', 'Super Review'];

/**
 * База АЧХ наушников проекта AutoEq (MIT, ~5000 моделей): поиск по названию и загрузка
 * параметрического профиля коррекции к нейтральной целевой кривой (Harman).
 */
class AutoEqDb {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.entries = null;
  }

  async _index() {
    if (this.entries) return this.entries;
    let text = null;
    try {
      const st = fs.statSync(this.cacheFile);
      if (Date.now() - st.mtimeMs < WEEK) text = fs.readFileSync(this.cacheFile, 'utf8');
    } catch {}
    if (!text) {
      const res = await fetch(`${BASE}/INDEX.md`);
      if (!res.ok) throw new Error(`AutoEq ${res.status}`);
      text = await res.text();
      fs.promises.writeFile(this.cacheFile, text).catch(() => {});
    }
    const re = /^- \[(.+?)\]\(\.\/(.+?)\) by (.+?)(?: on (.+))?$/;
    this.entries = text.split('\n').map((l) => l.match(re)).filter(Boolean).map((m) => ({
      name: m[1], path: m[2], source: m[3], rig: m[4] || '',
      type: /in-ear/i.test(m[2]) ? 'in-ear' : /earbud/i.test(m[2]) ? 'earbud' : 'over-ear',
    }));
    return this.entries;
  }

  async search(query, limit = 30) {
    const entries = await this._index();
    const tokens = String(query).toLowerCase().replace(/[()]/g, ' ').split(/[\s_]+/).filter((t) => t.length > 1);
    if (!tokens.length) return [];
    const norm = (s) => s.toLowerCase().replace(/[-\s]/g, '');
    const hits = entries.filter((e) => tokens.every((t) => e.name.toLowerCase().includes(t) || norm(e.name).includes(norm(t))));
    const rank = (e) => {
      const r = SOURCE_RANK.indexOf(e.source);
      return (r < 0 ? 10 : r) + e.name.length / 100;
    };
    return hits.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
  }

  async load(entryPath) {
    if (!/^[^.][^]*$/.test(entryPath) || entryPath.includes('..')) throw new Error('bad path');
    const name = decodeURIComponent(entryPath.split('/').pop());
    const url = `${BASE}/${entryPath}/${encodeURIComponent(`${name} ParametricEQ.txt`)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`AutoEq ${res.status}`);
    return res.text();
  }
}

AutoEqDb.prototype.loadFr = async function (entryPath) {
  if (String(entryPath).includes('..')) throw new Error('bad path');
  const name = decodeURIComponent(entryPath.split('/').pop());
  const res = await fetch(`${BASE}/${entryPath}/${encodeURIComponent(`${name}.csv`)}`);
  if (!res.ok) throw new Error(`AutoEq ${res.status}`);
  return res.text();
};

module.exports = { AutoEqDb };
