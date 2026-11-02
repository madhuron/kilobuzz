const { app, MessageChannelMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

/** Путь к нативной программе (в собранном приложении — Resources/bin). */
function binPath(name) {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', name)
    : path.join(__dirname, '../../native/bin', process.platform === 'win32' ? 'win' : '', name);
  return fs.existsSync(p) ? p : null;
}
// macOS: захват через Core Audio tap; Windows: связь с модулем Kilobuzz APO
const helperPath = () => binPath(process.platform === 'win32' ? 'kilobuzz-link.exe' : 'kilobuzz-capture');

function macVersion() {
  const [maj, min] = (process.getSystemVersion?.() || '0.0').split('.').map(Number);
  return { maj, min };
}

/**
 * Захват системного звука на macOS без виртуального кабеля.
 * PCM из helper'а отдаётся в renderer через MessagePort прямо в AudioWorklet, минуя UI-поток.
 */
class SystemCapture extends EventEmitter {
  static supported() {
    if (process.platform === 'win32') return !!helperPath();
    if (process.platform !== 'darwin' || !helperPath()) return false;
    const { maj, min } = macVersion();
    return maj > 14 || (maj === 14 && min >= 2);
  }

  start(webContents) {
    this.stop();
    const bin = helperPath();
    if (!bin) throw new Error('Модуль захвата не найден');
    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    webContents.postMessage('capture:port', null, [port2]);

    const win = process.platform === 'win32';
    const proc = (this.proc = spawn(bin, win ? [] : [String(process.pid)], { stdio: [win ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true }));
    proc.stdin?.on('error', () => {});
    let rest = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const usable = buf.length - (buf.length % 8); // целые стерео-кадры float32
      rest = buf.subarray(usable);
      if (!usable) return;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable);
      this.port?.postMessage({ pcm: ab });
    });
    let line = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      line += d;
      let i;
      while ((i = line.indexOf('\n')) >= 0) {
        const s = line.slice(0, i);
        line = line.slice(i + 1);
        try {
          const ev = JSON.parse(s);
          if (ev.event === 'ready') this.port?.postMessage({ sampleRate: ev.sampleRate });
          this.emit('status', ev);
        } catch {}
      }
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = null;
        this.emit('status', { event: code === 2 ? 'error' : 'stopped', code: code === 2 ? 'not_loaded' : code });
      }
    });
  }

  /** Windows: передать модулю APO вектор параметров обработки (Float32Array из AudioEngine.snapshot). */
  sendParams(buf) {
    if (!this.proc?.stdin?.writable) return;
    const head = Buffer.from('KBP1', 'ascii');
    this.proc.stdin.write(Buffer.concat([head, Buffer.from(buf)]));
  }

  stop() {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      if (process.platform === 'win32' && p.stdin?.writable) {
        // закрытый stdin — сигнал связующей программе перевести модуль в прозрачный режим и выйти
        p.stdin.end();
        setTimeout(() => p.kill(), 1500);
      } else p.kill('SIGTERM');
    }
    this.port?.close();
    this.port = null;
  }
}

module.exports = { SystemCapture, binPath };
