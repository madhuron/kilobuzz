const { execFile, spawn } = require('child_process');
const EventEmitter = require('events');

// Windows: громкость устройства по умолчанию через Core Audio (IAudioEndpointVolume).
// Один долгоживущий PowerShell: читает команды из stdin («get» или число 0..1), отвечает строкой.
const WIN_SCRIPT = `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext); int j(); int GetMasterVolumeLevelScalar(out float pfLevel); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class KbAudio {
  static IAudioEndpointVolume Vol() {
    var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator; IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null; var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv)); return epv;
  }
  public static float Get() { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Set(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, System.Guid.Empty)); }
}
'@
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($l -eq $null) { break }
  try { if ($l -ne 'get') { [KbAudio]::Set([float]::Parse($l, [Globalization.CultureInfo]::InvariantCulture)) }; [Console]::Out.WriteLine([KbAudio]::Get().ToString([Globalization.CultureInfo]::InvariantCulture)) }
  catch { [Console]::Out.WriteLine('-1') }
  [Console]::Out.Flush()
}`;

const run = (cmd, args) =>
  new Promise((res) => execFile(cmd, args, { timeout: 3000 }, (err, out) => res(err ? null : String(out).trim())));

/** Системная громкость (0..1): чтение с опросом раз в секунду и установка. */
class SystemVolume extends EventEmitter {
  constructor() {
    super();
    this.value = null;
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      const v = await this.get();
      if (v != null && (this.value == null || Math.abs(v - this.value) > 0.004)) {
        this.value = v;
        this.emit('change', v);
      }
      this.timer = setTimeout(tick, 1000);
    };
    tick();
  }

  async get() {
    if (process.platform === 'darwin') {
      const out = await run('osascript', ['-e', 'output volume of (get volume settings)']);
      const n = parseFloat(out);
      return Number.isFinite(n) ? n / 100 : null; // «missing value» — у устройства нет регулятора
    }
    if (process.platform === 'win32') return this._win('get');
    return null;
  }

  async set(v) {
    v = Math.max(0, Math.min(1, Number(v) || 0));
    this.value = v;
    if (process.platform === 'darwin') return run('osascript', ['-e', `set volume output volume ${Math.round(v * 100)}`]);
    if (process.platform === 'win32') return this._win(v.toFixed(3));
  }

  _win(cmd) {
    if (!this.ps) {
      const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
      this.queue = [];
      let buf = '';
      this.ps.stdout.setEncoding('utf8');
      this.ps.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const n = parseFloat(buf.slice(0, i));
          buf = buf.slice(i + 1);
          this.queue.shift()?.(n >= 0 ? n : null);
        }
      });
      this.ps.on('exit', () => (this.ps = null));
    }
    return new Promise((res) => {
      this.queue.push(res);
      this.ps.stdin.write(`${cmd}\n`);
    });
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.ps?.kill();
  }
}

module.exports = { SystemVolume };
