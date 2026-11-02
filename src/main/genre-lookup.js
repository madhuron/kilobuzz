const fs = require('fs');

const UA = 'kilobuzz/0.1 ( https://github.com/kilobuzz )';

/**
 * Жанр трека из двух источников (без ключей API), с кэшем на диске:
 *  1) каталог Apple (iTunes Search) — жанр, который Apple Music указывает у самого трека («Metal», «Hip-Hop/Rap»…);
 *     главный источник, весит больше всего;
 *  2) MusicBrainz — теги исполнителя (несколько стилей: метал + рок + альтернатива…); лимит 1 запрос/с — очередь.
 */
class GenreLookup {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.queue = Promise.resolve();
    try { this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { this.cache = {}; }
    if (this.cache.v !== 2) this.cache = { v: 2 }; // старый кэш искал «Исполнитель — Альбом» и почти всегда пуст
  }

  async lookup(artist, title) {
    const name = mainArtist(artist);
    if (!name) return { tags: [] };
    const [apple, mb] = await Promise.all([this._apple(name, title).catch(() => null), this._mb(name).catch(() => null)]);
    const tags = [];
    if (apple) tags.push({ name: apple, count: 100, source: 'apple' });
    for (const t of mb?.tags || []) tags.push(t);
    return { artist: mb?.artist || name, genre: apple, tags };
  }

  _save() {
    fs.promises.writeFile(this.cacheFile, JSON.stringify(this.cache)).catch(() => {});
  }

  async _apple(artist, title) {
    const key = `apple:${artist}|${title}`.toLowerCase();
    if (this.cache[key]) return this.cache[key];
    const want = artist.toLowerCase().split(/\s+/)[0];
    // сначала общий каталог, затем российский (там есть русскоязычные исполнители)
    for (const country of ['us', 'ru']) {
      const term = encodeURIComponent(`${artist} ${title || ''}`.trim());
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=8&country=${country}`);
      if (!res.ok) continue;
      const data = await res.json();
      const hit = (data.results || []).find((r) => String(r.artistName || '').toLowerCase().includes(want));
      if (hit?.primaryGenreName) {
        this.cache[key] = hit.primaryGenreName;
        this._save();
        return hit.primaryGenreName;
      }
    }
    return null;
  }

  _mb(artist) {
    const key = `mb:${artist}`.toLowerCase();
    if (this.cache[key]) return Promise.resolve(this.cache[key]);
    const job = this.queue.then(() => this._fetchMb(artist, key));
    this.queue = job.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
    return job;
  }

  async _fetchMb(artist, key) {
    const q = encodeURIComponent(`artist:"${artist.replace(/"/g, '')}"`);
    const res = await fetch(`https://musicbrainz.org/ws/2/artist/?query=${q}&fmt=json&limit=5`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
    const data = await res.json();
    // только точное совпадение имени — иначе «RAM & PLC» находил транс-исполнителя «RAM»
    const exact = (data.artists || []).filter((x) => String(x.name).toLowerCase() === artist.toLowerCase());
    const a = exact.find((x) => (x.tags || []).length) || exact[0];
    const tags = (a?.tags || []).map((t) => ({ name: t.name, count: t.count || 1 })).sort((x, y) => y.count - x.count).slice(0, 12);
    const result = { artist: a?.name || artist, tags };
    if (tags.length) { this.cache[key] = result; this._save(); } // пустое не кэшируем — попробуем позже
    return result;
  }
}

/** «Исполнитель — Альбом» (Apple Music), «A feat. B», «A, B», «A & B» → основной исполнитель. */
function mainArtist(s) {
  let a = String(s || '');
  const dash = a.lastIndexOf(' — ');
  if (dash > 0) a = a.slice(0, dash);
  return a.split(/,| feat\.? | ft\.? | x /i)[0].trim();
}

module.exports = { GenreLookup };
