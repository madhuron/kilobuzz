/**
 * Минимальный разбор тегов локальных файлов: название, исполнитель и встроенная обложка.
 * Поддержка: MP3 (ID3v2.3/2.4), FLAC (Vorbis comments + PICTURE), M4A/MP4 (ilst).
 */
export async function readTags(file) {
  const head = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
  try {
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return id3(head);
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) return flac(head);
    if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') return mp4(head);
  } catch (e) {
    console.warn('tags', e);
  }
  return {};
}

const blobUrl = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type: type || 'image/jpeg' }));
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

function decodeText(bytes) {
  const enc = bytes[0], body = bytes.subarray(1);
  const name = enc === 1 || enc === 2 ? 'utf-16' : enc === 3 ? 'utf-8' : 'latin1';
  return new TextDecoder(enc === 2 ? 'utf-16be' : name).decode(body).replace(/\0+$/g, '').split('\0')[0].trim();
}

function id3(b) {
  const ver = b[3], size = syncsafe(b, 6) + 10, out = {};
  let o = 10;
  if (b[5] & 0x40) o += ver === 4 ? syncsafe(b, 10) : u32(b, 10) + 4; // расширенный заголовок
  while (o + 10 < Math.min(size, b.length)) {
    const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    const len = ver === 4 ? syncsafe(b, o + 4) : u32(b, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id) || len <= 0) break;
    const data = b.subarray(o + 10, o + 10 + len);
    if (id === 'TIT2') out.title = decodeText(data);
    else if (id === 'TPE1') out.artist = decodeText(data);
    else if (id === 'TALB') out.album = decodeText(data);
    else if (id === 'APIC' && !out.cover) {
      const enc = data[0];
      let p = 1;
      const mimeEnd = data.indexOf(0, p);
      const type = new TextDecoder('latin1').decode(data.subarray(p, mimeEnd));
      p = mimeEnd + 2; // + тип картинки
      if (enc === 1 || enc === 2) { while (p + 1 < data.length && (data[p] || data[p + 1])) p += 2; p += 2; }
      else { while (p < data.length && data[p]) p++; p++; }
      out.cover = blobUrl(data.subarray(p), type.includes('/') ? type : `image/${type.toLowerCase() || 'jpeg'}`);
    }
    o += 10 + len;
  }
  return out;
}

function flac(b) {
  const out = {};
  let o = 4, last = false;
  while (!last && o + 4 < b.length) {
    last = !!(b[o] & 0x80);
    const type = b[o] & 0x7f, len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    const d = b.subarray(o + 4, o + 4 + len);
    const le = (x) => (d[x] | (d[x + 1] << 8) | (d[x + 2] << 16) | (d[x + 3] << 24)) >>> 0;
    if (type === 4) {
      let p = 4 + le(0);
      const n = le(p); p += 4;
      for (let i = 0; i < n && p < d.length; i++) {
        const l = le(p), s = new TextDecoder().decode(d.subarray(p + 4, p + 4 + l));
        p += 4 + l;
        const [k, v] = [s.slice(0, s.indexOf('=')).toUpperCase(), s.slice(s.indexOf('=') + 1)];
        if (k === 'TITLE') out.title = v;
        if (k === 'ARTIST') out.artist ??= v;
        if (k === 'ALBUM') out.album = v;
      }
    } else if (type === 6 && !out.cover) {
      let p = 4;
      const ml = u32(d, p); const mime = new TextDecoder().decode(d.subarray(p + 4, p + 4 + ml)); p += 4 + ml;
      const dl = u32(d, p); p += 4 + dl + 16;
      const len2 = u32(d, p); p += 4;
      out.cover = blobUrl(d.subarray(p, p + len2), mime);
    }
    o += 4 + len;
  }
  return out;
}

function mp4(b) {
  const out = {};
  const walk = (s, e, path) => {
    let o = s;
    while (o + 8 <= e) {
      const size = u32(b, o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (size < 8 || o + size > e) break;
      const inner = o + 8;
      if (['moov', 'udta', 'ilst'].includes(type)) walk(inner, o + size, type);
      else if (type === 'meta') walk(inner + 4, o + size, type);
      else if (path === 'ilst' && u32(b, inner + 4) === 0x64617461) {
        const dataType = u32(b, inner + 8) & 0xffffff, payload = b.subarray(inner + 16, o + size);
        if (type === 'covr') out.cover ??= blobUrl(payload, dataType === 14 ? 'image/png' : 'image/jpeg');
        else if (type === '©nam') out.title = new TextDecoder().decode(payload);
        else if (type === '©ART') out.artist = new TextDecoder().decode(payload);
        else if (type === '©alb') out.album = new TextDecoder().decode(payload);
      }
      o += size;
    }
  };
  walk(0, b.length, '');
  return out;
}
