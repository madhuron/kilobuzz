const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { binPath } = require('./capture');

/**
 * Модуль Kilobuzz для Windows (APO): установка и удаление с согласия пользователя (окно UAC),
 * статус — без прав администратора.
 */
const setup = () => binPath('kilobuzz-apo-setup.exe');

function status() {
  return new Promise((resolve) => {
    const exe = setup();
    if (process.platform !== 'win32' || !exe) return resolve({ available: false });
    execFile(exe, ['status'], { windowsHide: true, timeout: 10000 }, (err, out) => {
      let st;
      try { st = { available: true, ...JSON.parse(String(out).trim()) }; } catch { st = { available: true, installed: false }; }
      if (st.installed) st.outdated = outdated();
      resolve(st);
    });
  });
}

/** Модуль в Program Files отличается от того, что поставляется с этой версией приложения. */
function outdated() {
  try {
    const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
    const installed = path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'Kilobuzz', 'APO', 'KilobuzzAPO.dll');
    return hash(binPath('KilobuzzAPO.dll')) !== hash(installed);
  } catch { return false; }
}

/** Диагностика: что записано у устройств, журнал модуля (без прав администратора). */
function diag() {
  return new Promise((resolve) => {
    const exe = setup();
    if (process.platform !== 'win32' || !exe) return resolve(null);
    execFile(exe, ['diag'], { windowsHide: true, timeout: 10000, maxBuffer: 1 << 20 }, (err, out) => {
      try { resolve(JSON.parse(String(out).trim())); } catch { resolve(null); }
    });
  });
}

/** Подробная диагностика с правами администратора (UAC): результат пишется в ProgramData\\Kilobuzz\\diag-full.json. */
function diagFull() {
  return new Promise((resolve) => {
    const exe = setup();
    if (!exe) return resolve(null);
    const out = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Kilobuzz', 'diag-full.json');
    try { fs.unlinkSync(out); } catch {}
    const ps = `$p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList 'diagfull','"${out}"' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 60000 }, () => {
      try { resolve(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '')); } catch { resolve(null); }
    });
  });
}

/** action: 'install' | 'uninstall' | 'compat'. Windows покажет запрос UAC — это и есть согласие пользователя. */
function run(action) {
  return new Promise((resolve) => {
    const exe = setup();
    if (!exe) return resolve({ ok: false, error: 'Модуль не найден в установке приложения' });
    const ps = `$p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '${action}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 300000 }, async (err) => {
      const st = await status();
      // отмена в окне UAC — ошибка запуска; проверяем фактическое состояние
      // «установлен/обновлён» — только если модуль на месте И совпадает с версией приложения (окно UAC могли отменить)
      const ok = action === 'uninstall' ? !st.installed : action === 'install' ? !!st.installed && !st.outdated : !err;
      resolve({ ok, cancelled: !ok && !!err, status: st });
    });
  });
}

module.exports = { apoStatus: status, apoRun: run, apoDiag: diag, apoDiagFull: diagFull };
