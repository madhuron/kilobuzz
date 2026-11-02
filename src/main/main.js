const { app, BrowserWindow, ipcMain, session, shell, systemPreferences, nativeImage, powerSaveBlocker, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { NowPlayingWatcher } = require('./nowplaying');
const { GenreLookup } = require('./genre-lookup');
const { SystemCapture } = require('./capture');
const { AutoEqDb } = require('./autoeq');
const { Artwork } = require('./artwork');
const { SystemVolume } = require('./volume');
const { apoStatus, apoRun, apoDiag, apoDiagFull } = require('./apo-win');
const { binPath } = require('./capture');
const { Updater } = require('./updater');
const { execFile } = require('child_process');

app.setName('Kilobuzz');
// Звук не должен «засыпать», когда окно свёрнуто или в фокусе другое приложение:
// без этих флагов Chromium понижает приоритет и замедляет таймеры скрытого окна.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let win = null;
const watcher = new NowPlayingWatcher();
const capture = new SystemCapture();
const lookup = new GenreLookup(path.join(app.getPath('userData'), 'genre-cache.json'));
const autoeq = new AutoEqDb(path.join(app.getPath('userData'), 'autoeq-index.md'));
const artwork = new Artwork();
const sysVolume = new SystemVolume();
const updater = new Updater();
const ICON = path.join(__dirname, '../../build/icon.png');

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    title: 'Kilobuzz',
    icon: ICON,
    width: 1400,
    height: 880,
    minWidth: 1120,
    minHeight: 740,
    backgroundColor: '#0e0e10',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    titleBarOverlay: isMac ? undefined : { color: '#0e0e10', symbolColor: '#a1a1aa', height: 52 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => {
    capture.stop();
    win = null;
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(ICON));

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

  ipcMain.handle('media:request', async () => {
    if (process.platform !== 'darwin') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
  ipcMain.handle('genre:lookup', (_e, { artist, title }) => lookup.lookup(artist, title));
  ipcMain.handle('volume:set', (_e, v) => sysVolume.set(v));
  ipcMain.handle('volume:get', () => sysVolume.get());
  ipcMain.handle('player:command', async (_e, { cmd, value }) => {
    // перемотка Apple Music двигает ползунок в её окне и выводит его вперёд — на это время Kilobuzz
    // держится поверх всех окон, поэтому ничего не мелькает и окно не «сворачивается»
    const pin = cmd === 'seek' && process.platform === 'win32' && win && !win.isDestroyed() && !win.isMinimized();
    if (pin) win.setAlwaysOnTop(true, 'screen-saver');
    try { return await watcher.command(cmd, value); }
    finally { if (pin && !win.isDestroyed()) { win.setAlwaysOnTop(false); win.focus(); } }
  });
  ipcMain.handle('artwork:get', (_e, info) => artwork.get(info || {}));
  ipcMain.handle('autoeq:search', (_e, q) => autoeq.search(q));
  ipcMain.handle('autoeq:load', (_e, p) => autoeq.load(p));
  ipcMain.handle('autoeq:fr', (_e, p) => autoeq.loadFr(p));
  ipcMain.handle('capture:supported', () => SystemCapture.supported());
  // Пока идёт обработка системного звука — запрещаем macOS усыплять приложение (App Nap)
  let napBlock = null;
  const keepAwake = (on) => {
    if (on && napBlock === null) napBlock = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && napBlock !== null) { powerSaveBlocker.stop(napBlock); napBlock = null; }
  };
  ipcMain.handle('capture:start', (e) => {
    capture.start(e.sender);
    keepAwake(true);
    return true;
  });
  ipcMain.handle('capture:stop', () => { capture.stop(); keepAwake(false); });
  ipcMain.on('playback:active', (_e, on) => keepAwake(!!on || capture.proc != null));
  ipcMain.on('capture:params', (_e, buf) => capture.sendParams(buf));
  ipcMain.handle('update:state', () => ({ ...updater.state, supported: updater.supported }));
  ipcMain.handle('update:check', () => updater.check(true));
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('apo:status', () => apoStatus());
  // Устройства вывода и их частоты (macOS: через нативный модуль; Windows меняет частоту в своих настройках)
  const helper = (args) => new Promise((resolve) => {
    const exe = process.platform === 'darwin' ? binPath('kilobuzz-capture') : null;
    if (!exe) return resolve(null);
    execFile(exe, args, { timeout: 5000 }, (err, out) => { try { resolve(JSON.parse(String(out))); } catch { resolve(null); } });
  });
  ipcMain.handle('audio:devices', () => helper(['devices']));
  ipcMain.handle('audio:setRate', (_e, { uid, rate }) => helper(['setrate', String(uid), String(rate)]));
  ipcMain.handle('apo:install', () => apoRun('install'));
  ipcMain.handle('apo:uninstall', () => apoRun('uninstall'));
  ipcMain.handle('apo:diag', () => apoDiag());
  ipcMain.handle('apo:diagFull', () => apoDiagFull());
  // буфер обмена и файл с диагностикой — через систему (окну приложения доступ к буферу не выдаётся)
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('diag:save', (_e, text) => {
    const file = path.join(app.getPath('desktop'), 'kilobuzz-diagnostics.txt');
    fs.writeFileSync(file, String(text), 'utf8');
    shell.showItemInFolder(file);
    return file;
  });
  ipcMain.handle('apo:compat', () => apoRun('compat'));
  ipcMain.on('nowplaying:enable', (_e, on) => (on ? watcher.start() : watcher.stop()));
  ipcMain.on('open-external', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });

  capture.on('status', (s) => win?.webContents.send('capture:status', s));
  watcher.on('update', (info) => win?.webContents.send('nowplaying', info));
  sysVolume.on('change', (v) => win?.webContents.send('volume', v));
  updater.on('state', (st) => win?.webContents.send('update:state', { ...st, supported: updater.supported }));
  updater.start();
  sysVolume.start();
  createWindow();
});

app.on('before-quit', () => {
  updater.stop();
  capture.stop();
  sysVolume.stop();
});
app.on('window-all-closed', () => {
  watcher.stop();
  capture.stop();
  app.quit();
});
