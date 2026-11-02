const { execFile, spawn } = require('child_process');
const EventEmitter = require('events');

const SEP = String.fromCharCode(31);

// macOS: AppleScript к Spotify и Apple Music. Скрипт запускается только если приложение уже работает,
// иначе osascript спросит «Где Spotify?» или запустит его.
const MAC_APPS = [
  { proc: 'Spotify', name: 'Spotify', durationDiv: 1000 },
  { proc: 'Music', name: 'Apple Music', durationDiv: 1 },
];

function macScript(app) {
  const S = 'ASCII character 31';
  // У Spotify есть прямая ссылка на обложку; у Apple Music обложку выгружает artwork.js
  const art = app === 'Spotify' ? `(${S}) & (artwork url of t)` : `(${S}) & ""`;
  return `
tell application "${app}"
  if player state is stopped then return ""
  set t to current track
  return (name of t) & (${S}) & (artist of t) & (${S}) & (album of t) & (${S}) & ((duration of t) as text) & (${S}) & ((player position) as text) & (${S}) & ((player state) as text) & ${art}
end tell`;
}

const run = (cmd, args, timeout = 3000) =>
  new Promise((res) => execFile(cmd, args, { timeout }, (err, out) => res(err ? '' : String(out).trim())));

const num = (s) => parseFloat(String(s).replace(',', '.')) || 0;

// Windows: системные медиа-контролы (SMTC) — видят Spotify, Яндекс Музыку, браузеры, VK, Apple Music и т.д.
const WIN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
while ($true) {
  try {
    $s = $mgr.GetCurrentSession()
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $tl = $s.GetTimelineProperties()
      $playing = $s.GetPlaybackInfo().PlaybackStatus -eq 'Playing'
      $pos = $tl.Position.TotalSeconds
      if ($playing) { $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds }
      $o = @{ app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; duration = $tl.EndTime.TotalSeconds; position = $pos; playing = $playing }
      [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
    } else { [Console]::Out.WriteLine('{}') }
  } catch { [Console]::Out.WriteLine('{}') }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}`;

// Apple Music для Windows пишет в поле исполнителя «Исполнитель — Альбом», а альбом оставляет пустым.
function splitArtistAlbum(o) {
  if (o.album || !o.artist) return o;
  const i = o.artist.lastIndexOf(' — ');
  return i > 0 ? { ...o, artist: o.artist.slice(0, i).trim(), album: o.artist.slice(i + 3).trim() } : o;
}

function prettyWinApp(id = '') {
  const map = [[/spotify/i, 'Spotify'], [/yandex/i, 'Яндекс Музыка'], [/chrome/i, 'Chrome'], [/msedge/i, 'Edge'], [/firefox/i, 'Firefox'], [/applemusic|apple/i, 'Apple Music'], [/vk/i, 'VK'], [/zune|music/i, 'Media Player']];
  for (const [re, name] of map) if (re.test(id)) return name;
  return id.split('!')[0].split('.').pop() || 'Плеер';
}

// Команды управления плеером. macOS — AppleScript (одинаковые команды у Spotify и Music),
// Windows — системные медиаконтролы через одноразовый PowerShell.
const MAC_CMD = {
  playpause: 'playpause',
  next: 'next track',
  prev: 'previous track',
};

function winCommand(cmd, value) {
  const call = {
    playpause: 'TryTogglePlayPauseAsync()',
    next: 'TrySkipNextAsync()',
    prev: 'TrySkipPreviousAsync()',
    seek: `TryChangePlaybackPositionAsync(${Math.round((value || 0) * 1e7)})`,
  }[cmd];
  if (!call) return Promise.resolve(false);
  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
if ($s) {
  if ('${cmd}' -eq 'seek' -and -not $s.GetPlaybackInfo().Controls.IsPlaybackPositionEnabled) {
    # Apple Music для Windows не принимает перемотку через системные контролы —
    # двигаем ползунок времени в её окне (UI Automation; значение — секунды)
    if ($s.SourceAppUserModelId -match 'AppleMusic') {
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $p = Get-Process AppleMusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
      if ($p) {
        # перемотка выводит окно Apple Music вперёд — запоминаем, что было активно, и сразу возвращаем
        Add-Type @'
using System; using System.Runtime.InteropServices;
public static class KbWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  public static void Restore(IntPtr prev) {
    uint ft = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
    AttachThreadInput(me, ft, true); SetForegroundWindow(prev); BringWindowToTop(prev); AttachThreadInput(me, ft, false);
  }
}
'@
        $prev = [KbWin]::GetForegroundWindow()
        $wasMin = [KbWin]::IsIconic($p.MainWindowHandle)
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
        $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'LCDScrubber')
        $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
        if ($e) {
          $rv = $e.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
          $v = [Math]::Max(0, [Math]::Min($rv.Current.Maximum - 0.1, ${Math.max(0, Number(value) || 0)}))
          # Apple Music применяет позицию, когда приходит следующее значение, — даём второе, почти такое же
          $rv.SetValue($v); Start-Sleep -Milliseconds 30; $rv.SetValue($v + 0.01)
        }
        for ($i = 0; $i -lt 30; $i++) {
          if ($prev -ne [IntPtr]::Zero -and [KbWin]::GetForegroundWindow() -ne $prev) { [KbWin]::Restore($prev) }
          Start-Sleep -Milliseconds 20
        }
        if ($wasMin) { [KbWin]::ShowWindow($p.MainWindowHandle, 7) | Out-Null }  # снова свернуть, не активируя
      }
    }
  } else { Await ($s.${call}) ([bool]) | Out-Null }
}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], 10000).then(() => true);
}

class NowPlayingWatcher extends EventEmitter {
  /** cmd: 'playpause' | 'next' | 'prev' | 'seek' (value — секунды). */
  async command(cmd, value) {
    if (process.platform === 'win32') return winCommand(cmd, value);
    if (process.platform !== 'darwin') return false;
    const app = this.last?.app === 'Spotify' ? 'Spotify' : this.last?.app === 'Apple Music' ? 'Music' : null;
    if (!app) return false;
    const line = cmd === 'seek' ? `set player position to ${Math.max(0, Number(value) || 0)}` : MAC_CMD[cmd];
    if (!line) return false;
    await run('osascript', ['-e', `tell application "${app}" to ${line}`]);
    clearTimeout(this.timer);
    this._pollMac(); // сразу обновляем состояние
    return true;
  }

  start() {
    if (this.active) return;
    this.active = true;
    if (process.platform === 'darwin') this._pollMac();
    else if (process.platform === 'win32') this._spawnWin();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.proc?.kill();
    this.proc = null;
  }

  async _pollMac() {
    if (!this.active) return;
    const results = [];
    for (const a of MAC_APPS) {
      if (!(await run('pgrep', ['-x', a.proc]))) continue;
      const out = await run('osascript', ['-e', macScript(a.proc)]);
      if (!out) continue;
      const [title, artist, album, dur, pos, state, artworkUrl] = out.split(SEP);
      results.push({ app: a.name, title, artist, album, artworkUrl, duration: num(dur) / a.durationDiv, position: num(pos), playing: /playing/i.test(state) });
    }
    const best = results.find((r) => r.playing) || results[0] || null;
    this.last = best;
    this.emit('update', best);
    this.timer = setTimeout(() => this._pollMac(), 1200);
  }

  _spawnWin() {
    const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
    const proc = (this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true }));
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try {
          const o = JSON.parse(line);
          this.last = o.title ? splitArtistAlbum({ ...o, app: prettyWinApp(o.app) }) : null;
          this.emit('update', this.last);
        } catch {}
      }
    });
    proc.on('exit', () => {
      if (this.active && this.proc === proc) this.timer = setTimeout(() => this._spawnWin(), 3000);
    });
  }
}

module.exports = { NowPlayingWatcher };
