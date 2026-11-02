const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_CACHE = 50;

const mime = (buf) =>
  buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : buf[0] === 0x47 && buf[1] === 0x49 ? 'image/gif' : 'image/jpeg';
const toDataUrl = (buf) => `data:${mime(buf)};base64,${buf.toString('base64')}`;

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return toDataUrl(Buffer.from(await res.arrayBuffer()));
}

/** Обложка из Apple Music: AppleScript выгружает raw data первой обложки во временный файл. */
function appleMusicArtwork() {
  const file = path.join(os.tmpdir(), `kilobuzz-art-${process.pid}`);
  const script = `
tell application "Music"
  if (count of artworks of current track) is 0 then return ""
  set d to raw data of artwork 1 of current track
end tell
set f to open for access (POSIX file "${file}") with write permission
set eof f to 0
write d to f
close access f
return "ok"`;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 4000 }, (err, out) => {
      if (err || !String(out).includes('ok')) return resolve(null);
      try {
        const buf = fs.readFileSync(file);
        resolve(buf.length > 100 ? toDataUrl(buf) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Поиск обложки в каталоге iTunes (без ключа) — запасной вариант для любого источника. */
async function itunesArtwork(artist, title) {
  const clean = (s) => String(s || '').replace(/\(feat\.?[^)]*\)|\[[^\]]*\]|feat\..*$/gi, '').trim();
  const term = encodeURIComponent(`${clean(artist)} ${clean(title)}`.trim());
  if (!term) return null;
  const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`);
  if (!res.ok) return null;
  const data = await res.json();
  const url = data.results?.[0]?.artworkUrl100;
  return url ? fetchImage(url.replace(/\d+x\d+bb/, '600x600bb')) : null;
}

class Artwork {
  constructor() {
    this.cache = new Map();
  }

  async get({ app, artist, title, artworkUrl }) {
    const key = `${artist}|${title}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let url = null;
    try {
      if (artworkUrl && /^https:\/\//.test(artworkUrl)) url = await fetchImage(artworkUrl);
      else if (app === 'Apple Music' && process.platform === 'darwin') url = await appleMusicArtwork();
    } catch {}
    if (!url) url = await itunesArtwork(artist, title).catch(() => null);
    this.cache.set(key, url);
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
    return url;
  }
}

module.exports = { Artwork };
