// Find a usable Python 3.9+ interpreter. Each candidate is asked for its own
// sys.executable, which is then stored, so later runs do not go through the `py`
// launcher or the Windows Store "python" alias (which opens the Store instead of running).
'use strict';
const { execFile } = require('child_process');

const PROBE = 'import sys; print("OK" if sys.version_info >= (3, 9) else "OLD", sys.version.split()[0], sys.executable)';

function probe(command, args = []) {
  return new Promise(resolve => {
    execFile(command, [...args, '-c', PROBE], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /^(OK|OLD) (\S+) (.+)$/m.exec(String(stdout).trim());
      if (!m) return resolve(null);
      resolve({ ok: m[1] === 'OK', version: m[2], executable: m[3].trim() });
    });
  });
}

async function detectPython() {
  const cands = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  const tried = [];
  for (const [cmd, args] of cands) {
    const r = await probe(cmd, args);
    tried.push(`${[cmd, ...args].join(' ')}: ${r ? `Python ${r.version}${r.ok ? '' : ' (too old)'}` : 'not found'}`);
    if (r && r.ok) return { executable: r.executable, version: r.version, tried };
  }
  return { executable: null, tried };
}

module.exports = { detectPython, probe };
