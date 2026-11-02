const { app, shell } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

/**
 * Обновления через GitHub Releases (репозиторий — поле "repository" в package.json).
 *  Windows: electron-updater — скачивает установщик в фоне, ставит при перезапуске (без прав администратора).
 *  macOS: стандартный механизм (Squirrel) требует платной подписи Apple, поэтому свой: скачиваем
 *         Kilobuzz-<версия>-universal-mac.zip, распаковываем и при перезапуске заменяем Kilobuzz.app на месте.
 *         Если папку приложения нельзя перезаписать — открываем .dmg для ручной установки.
 * Состояния для интерфейса: idle | checking | none | available | downloading | ready | error.
 */
class Updater extends EventEmitter {
  constructor() {
    super();
    this.state = { state: 'idle', current: app.getVersion() };
    this.repo = readRepo();
    this.timer = null;
    this.macApp = null;   // распакованный Kilobuzz.app, готовый к установке
    this.macDmgUrl = '';
    if (process.platform === 'win32' && app.isPackaged) this._initWin();
  }

  get supported() {
    return app.isPackaged && !!this.repo && (process.platform === 'win32' || process.platform === 'darwin');
  }

  /** Проверять при запуске и каждые 6 часов. */
  start() {
    if (!this.supported) return;
    setTimeout(() => this.check(), 15000);
    this.timer = setInterval(() => this.check(), 6 * 3600 * 1000);
  }

  stop() { clearInterval(this.timer); }

  _set(patch) {
    this.state = { ...this.state, ...patch, current: app.getVersion() };
    this.emit('state', this.state);
  }

  async check(manual = false) {
    if (!this.supported) return this._set({ state: 'error', error: app.isPackaged ? 'Не указан репозиторий' : 'Обновления работают только в установленном приложении' });
    if (['checking', 'downloading', 'ready'].includes(this.state.state)) return this.state;
    this._set({ state: 'checking', manual, error: null });
    try {
      if (process.platform === 'win32') await this.win.checkForUpdates();
      else await this._checkMac();
    } catch (e) {
      this._set({ state: 'error', error: friendly(e) });
    }
    return this.state;
  }

  install() {
    if (this.state.state !== 'ready') return false;
    if (process.platform === 'win32') {
      // тихая установка поверх и запуск новой версии
      setImmediate(() => this.win.quitAndInstall(true, true));
      return true;
    }
    return this._installMac();
  }

  /* ---------------- Windows ---------------- */
  _initWin() {
    const { autoUpdater } = require('electron-updater');
    this.win = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('update-available', (i) => this._set({ state: 'downloading', version: i.version, notes: notesText(i.releaseNotes), percent: 0 }));
    autoUpdater.on('update-not-available', () => this._set({ state: 'none' }));
    autoUpdater.on('download-progress', (p) => this._set({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (i) => this._set({ state: 'ready', version: i.version }));
    autoUpdater.on('error', (e) => this._set({ state: 'error', error: friendly(e) }));
  }

  /* ---------------- macOS ---------------- */
  async _checkMac() {
    const rel = await getJson(`https://api.github.com/repos/${this.repo}/releases/latest`);
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!version || compare(version, app.getVersion()) <= 0) return this._set({ state: 'none' });
    const zip = rel.assets.find((a) => /mac\.zip$/i.test(a.name) && /universal/i.test(a.name)) || rel.assets.find((a) => /mac\.zip$/i.test(a.name));
    const dmg = rel.assets.find((a) => /\.dmg$/i.test(a.name));
    this.macDmgUrl = dmg?.browser_download_url || rel.html_url;
    const notes = String(rel.body || '').trim();
    if (!zip) return this._set({ state: 'available', version, notes, manualUrl: this.macDmgUrl });
    this._set({ state: 'downloading', version, notes, percent: 0 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilobuzz-update-'));
    const file = path.join(dir, zip.name);
    await download(zip.browser_download_url, file, zip.size, (percent) => this._set({ percent }));
    await run('/usr/bin/ditto', ['-x', '-k', file, dir]);
    const appPath = path.join(dir, 'Kilobuzz.app');
    if (!fs.existsSync(appPath)) throw new Error('В архиве обновления нет Kilobuzz.app');
    // скачано самим приложением — снимаем карантин, чтобы macOS не спрашивала про «скачано из интернета»
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath]).catch(() => {});
    this.macApp = appPath;
    this._set({ state: 'ready', version });
  }

  _installMac() {
    const target = currentBundle();
    if (!target || !this.macApp || !canReplace(target)) {
      // нет права записи (например, приложение запущено прямо из .dmg) — ручная установка
      shell.openExternal(this.macDmgUrl);
      return false;
    }
    // после выхода: дождаться завершения, заменить .app, открыть новую версию
    const script = `
      while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
      rm -rf "${target}.old"
      mv "${target}" "${target}.old" && /usr/bin/ditto "${this.macApp}" "${target}" && rm -rf "${target}.old" || { rm -rf "${target}"; mv "${target}.old" "${target}"; }
      open "${target}"`;
    spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
    setImmediate(() => app.quit());
    return true;
  }
}

/* ---------------- служебное ---------------- */
function readRepo() {
  try {
    const pkg = require('../../package.json');
    const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const m = r.match(/github(?:\.com[/:]|:)([^/]+\/[^/.]+)/i);
    return m ? m[1] : '';
  } catch { return ''; }
}

/** Путь к запущенному Kilobuzz.app. */
function currentBundle() {
  const m = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//);
  return m ? m[1] : null;
}

function canReplace(bundle) {
  if (bundle.startsWith('/Volumes/')) return false;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

function compare(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Kilobuzz' } });
  if (r.status === 404) throw new Error('Опубликованных версий пока нет');
  if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
  return r.json();
}

async function download(url, file, size, onProgress) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Kilobuzz' } });
  if (!r.ok || !r.body) throw new Error(`Не удалось скачать обновление (${r.status})`);
  const total = +r.headers.get('content-length') || size || 0;
  const out = fs.createWriteStream(file);
  let got = 0, last = -1;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
    const p = total ? Math.floor((got / total) * 100) : 0;
    if (p !== last) { last = p; onProgress(p); }
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
}

function run(cmd, args) {
  return new Promise((res, rej) => execFile(cmd, args, (e) => (e ? rej(e) : res())));
}

function notesText(n) {
  if (Array.isArray(n)) return n.map((x) => x.note).join('\n');
  return String(n || '').replace(/<[^>]+>/g, '').trim();
}

function friendly(e) {
  const m = String(e?.message || e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network|fetch failed/i.test(m)) return 'Нет связи с GitHub';
  if (/404|latest\.yml|Cannot find/i.test(m)) return 'Опубликованных версий пока нет';
  return m.split('\n')[0].slice(0, 200);
}

module.exports = { Updater };
