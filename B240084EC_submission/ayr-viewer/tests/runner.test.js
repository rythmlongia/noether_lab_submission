// Tests for the solver runner: line splitting, and real runs of solver/fake_solver.py
// (shortened with --step-time). Run with `npm test`. The real-process tests need Python 3.9+
// on PATH (python3, or python / py on Windows) and are skipped otherwise.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { SolverRun, LineSplitter } = require('../src/main/solverRunner.js');
const { writeAyr, tetra } = require('./ayrWriter.js');

test('LineSplitter: lines split across chunks, CRLF, and a UTF-8 character split across chunks', () => {
  const got = [];
  const s = new LineSplitter(l => got.push(l));
  const bytes = Buffer.from('abc\r\nde', 'utf8');
  s.push(bytes);
  const umlaut = Buffer.from('fä\ng', 'utf8'); // 'ä' is 2 bytes: split between them
  s.push(umlaut.subarray(0, 2)); s.push(umlaut.subarray(2));
  s.push(Buffer.from('h\n\nlast'));
  s.end();
  assert.deepEqual(got, ['abc', 'defä', 'gh', '', 'last']);
});

function findPython() {
  const cands = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [c, a] of cands) {
    try {
      const out = execFileSync(c, [...a, '-c', 'import sys;print(sys.version_info>=(3,9));print(sys.executable)'], { encoding: 'utf8' });
      const [ok, exe] = out.trim().split(/\r?\n/);
      if (ok === 'True') return exe;
    } catch { /* next */ }
  }
  return null;
}
const PY = findPython();
const SOLVER = path.join(__dirname, '..', 'solver', 'fake_solver.py');

function makeCase(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr run with spaces '));
  const p = path.join(dir, 'my case & co.ayr');
  fs.writeFileSync(p, writeAyr(tetra({ name })));
  return p;
}

function run(opts) {
  return new Promise(resolve => {
    const r = new SolverRun({ python: PY, solverPath: SOLVER, steps: 200, ...opts });
    const lines = [], progressAt = [];
    const t0 = Date.now();
    r.on('lines', b => { lines.push(...b.lines); progressAt.push([Date.now() - t0, b.progress]); });
    r.on('end', e => resolve({ e, lines, progressAt, r }));
    r.start();
    if (opts.onStart) opts.onStart(r);
  });
}

const skip = !PY && 'python 3.9+ not found';

test('full run: finished, live progress, path with spaces, HTML name kept as text, all lines in order', { skip, timeout: 60000 }, async () => {
  const name = '<img src=x onerror="alert(1)">';
  const casePath = makeCase(name);
  const { e, lines, progressAt } = await run({ casePath, extraArgs: ['--step-time', '0.02'] });
  assert.equal(e.state, 'finished'); assert.equal(e.code, 0);
  // sequence numbers strictly increasing = order of receipt kept
  lines.forEach((l, i) => assert.equal(l.n, i));
  const out = lines.filter(l => l.s === 'o').map(l => l.t);
  assert.ok(out.includes(`Case name : ${name}`), 'case name printed verbatim');
  assert.ok(out.includes('PROGRESS 100.0 finished'));
  // progress was seen at many distinct moments, not only at the end
  const distinct = new Set(progressAt.map(p => p[1]));
  assert.ok(distinct.size > 20, `progress updates seen: ${distinct.size}`);
  // the long DEBUG lines arrive complete (8000 numbers each)
  const dbg = out.filter(t => t.startsWith('DEBUG residual vector'));
  assert.equal(dbg.length, 2);
  for (const d of dbg) { assert.ok(d.endsWith(']')); assert.equal(d.split(',').length, 8000); }
  // the diagnostics bursts arrive complete
  const diagHeaders = out.filter(t => /^Diagnostics written \((\d+) cells\)/.test(t));
  const announced = diagHeaders.reduce((s, t) => s + +/\((\d+)/.exec(t)[1], 0);
  assert.equal(out.filter(t => t.startsWith('  [diag]')).length, announced);
});

test('non-ASCII case name (CJK, umlaut, Ø) arrives intact', { skip, timeout: 30000 }, async () => {
  // On Windows a piped Python writes stdout in the ANSI code page (cp1252); without PYTHONIOENCODING=utf-8 the
  // solver's print() of this name raises UnicodeEncodeError and the run dies with exit 1 (seen on Windows 11,
  // Python 3.13: verification/windows/unicode_case_name.txt). We decode as UTF-8, so it must arrive byte-exact.
  const name = '鋳造ハウジング Gehäuse – Ø40';
  const { e, lines } = await run({ casePath: makeCase(name), steps: 5, extraArgs: ['--step-time', '0.01'] });
  assert.equal(e.state, 'finished'); assert.equal(e.code, 0);
  assert.ok(lines.some(l => l.s === 'o' && l.t === `Case name : ${name}`), 'case name printed verbatim');
});

test('--fail-at 70: failed with exit code 3 and the error lines', { skip, timeout: 60000 }, async () => {
  const { e } = await run({ casePath: makeCase('fail'), failAt: 70, extraArgs: ['--step-time', '0.01'] });
  assert.equal(e.state, 'failed'); assert.equal(e.code, 3);
  assert.ok(e.lastErrors.some(l => l.startsWith('ERROR: linear solver for T diverged')));
  assert.equal(e.lastErrors.at(-1), 'ERROR: aborting run');
});

test('bad case file: failed with exit code 2', { skip, timeout: 20000 }, async () => {
  const p = makeCase('x'); fs.writeFileSync(p, 'not an ayr file');
  const { e } = await run({ casePath: p });
  assert.equal(e.state, 'failed'); assert.equal(e.code, 2);
  assert.match(e.lastErrors.join('\n'), /bad magic/);
});

test('missing python: failed, not crashed', { timeout: 20000 }, async () => {
  const { e } = await run({ casePath: makeCase('x'), python: 'definitely-not-python-xyz' });
  assert.equal(e.state, 'failed');
  assert.match(e.lastErrors.join('\n'), /Could not start/);
});

function solverPids() {
  if (process.platform === 'win32') {
    // wmic is gone on recent Windows 11; ask CIM through PowerShell. Only python processes,
    // so the PowerShell command line (which contains the search text) is not counted.
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*fake_solver.py*' } | ForEach-Object { $_.ProcessId }";
    const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).stdout || '';
    return out.split(/\s+/).filter(s => /^\d+$/.test(s)).map(Number);
  }
  // pid, process group, state. Zombies (state Z) have already exited; they only wait to be reaped
  // by their parent (for the orphaned worker that is init, which some containers never do).
  const out = spawnSync('ps', ['-eo', 'pid,pgid,stat,args'], { encoding: 'utf8' }).stdout;
  return out.split('\n').map(l => l.trim().split(/\s+/))
    .filter(f => f.length > 3 && !f[2].startsWith('Z') && f.slice(3).join(' ').includes('fake_solver.py'))
    .map(f => +f[0]);
}
function groupMembers(pgid) {
  const out = spawnSync('ps', ['-eo', 'pid,pgid,stat'], { encoding: 'utf8' }).stdout;
  return out.split('\n').map(l => l.trim().split(/\s+/)).filter(f => +f[1] === pgid && f[2] && !f[2].startsWith('Z')).map(f => +f[0]);
}

test('cancel: cancelled state and no solver process (controller or worker) left, 3 times', { skip, timeout: 90000 }, async () => {
  for (let k = 0; k < 3; k++) {
    let pid;
    const casePath = makeCase('cancel');
    const done = run({
      casePath,
      onStart: r => {
        pid = r.child.pid;
        setTimeout(async () => {
          assert.equal(solverPids().length >= 2, true, 'controller and worker are running before cancel');
          await r.cancel();
        }, 1500);
      },
    });
    const { e } = await done;
    assert.equal(e.state, 'cancelled');
    assert.deepEqual(solverPids(), [], 'right after cancel');
    if (process.platform !== 'win32') assert.deepEqual(groupMembers(pid), [], 'nothing left in the process group');
    await new Promise(r => setTimeout(r, 1500));
    assert.deepEqual(solverPids(), [], 'again 1.5 s later');
    assert.equal(fs.existsSync(path.join(path.dirname(casePath), '.solver_heartbeat')), false, 'heartbeat cleaned up');
  }
});
