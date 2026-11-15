/*
 * solverRunner.js - starts fake_solver.py, streams its output, cancels the whole process tree.
 * Pure Node (no Electron imports) so it can be tested with plain `node`.
 *
 * Things that matter here (each one is a bug in the "obvious" version):
 *  1. Python block-buffers stdout when it is a pipe, so PROGRESS lines would all arrive at
 *     the end. We pass -u and PYTHONUNBUFFERED=1.
 *  2. The solver starts a WORKER subprocess (fake_solver.py --_worker). Killing only the
 *     controller leaves the worker running (it even keeps computing after its stdout breaks).
 *     POSIX: we start the solver in its own process group (detached) and signal the group.
 *     Windows: `taskkill /T /F` kills the tree.
 *  3. Data arrives in arbitrary chunks: a line can be split across chunks and a multi-byte
 *     UTF-8 character can be split too. LineSplitter uses StringDecoder and keeps the partial
 *     line. \r\n (Windows) is handled.
 *  4. No shell: arguments go as an array, so paths with spaces (or quotes, &, ...) are safe.
 *  5. Output is batched (every 50 ms) before it is sent to the renderer, so 4000 lines printed
 *     in a few milliseconds become one or two IPC messages instead of 4000.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class LineSplitter {
  constructor(onLine) {
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.onLine = onLine;
  }
  push(chunk) {
    const text = this.partial + this.decoder.write(chunk);
    const parts = text.split('\n');
    this.partial = parts.pop(); // last element is an incomplete line (or '')
    for (const p of parts) this.onLine(p.endsWith('\r') ? p.slice(0, -1) : p);
  }
  end() {
    const rest = this.partial + this.decoder.end();
    this.partial = '';
    if (rest.length) this.onLine(rest.endsWith('\r') ? rest.slice(0, -1) : rest);
  }
}

const PROGRESS_RE = /^PROGRESS\s+([0-9]+(?:\.[0-9]+)?)\b/;

class SolverRun extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.python      python executable (absolute path or command name)
   * @param {string[]} [o.pythonArgs]
   * @param {string} o.solverPath  path to fake_solver.py
   * @param {string} o.casePath    path to the .ayr file
   * @param {number} [o.steps=200]
   * @param {number|null} [o.failAt]
   * @param {string[]} [o.extraArgs]   (tests only, e.g. --step-time)
   */
  constructor(o) {
    super();
    this.o = o;
    this.state = 'idle';
    this.seq = 0;
    this.pending = [];
    this.lastStderr = [];
    this.progress = 0;
    this.cancelRequested = false;
    this.flushTimer = null;
  }

  start() {
    const o = this.o;
    const args = [...(o.pythonArgs || []), '-u', o.solverPath, '--case', o.casePath, '--steps', String(o.steps ?? 200)];
    if (o.failAt != null) args.push('--fail-at', String(o.failAt));
    if (o.extraArgs) args.push(...o.extraArgs);
    this.argv = [o.python, ...args];
    const isWin = process.platform === 'win32';
    this.child = spawn(o.python, args, {
      cwd: path.dirname(o.casePath),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: !isWin, // POSIX: own process group, pgid = child.pid
      windowsHide: true,
    });
    this.state = 'running';
    this.startedAt = Date.now();

    const out = new LineSplitter(line => this._line('o', line));
    const err = new LineSplitter(line => this._line('e', line));
    this.child.stdout.on('data', c => out.push(c));
    this.child.stderr.on('data', c => err.push(c));
    this.child.on('error', e => { // e.g. python not found
      this.spawnError = e;
      this._line('e', `Could not start "${o.python}": ${e.message}`);
    });
    this.child.on('exit', (code, signal) => { this.exitCode = code; this.exitSignal = signal; });
    // 'close' fires only after the process exited AND every holder of our stdout/stderr pipes
    // closed them. The worker inherits stderr, so 'close' also means the worker is gone
    // (or at least has closed our pipe).
    this.child.on('close', async (code, signal) => {
      // If Cancel is in progress, report the end only once it has finished checking that
      // nothing is left, so "cancelled" in the UI means "all stopped".
      if (this.cancelPromise) await this.cancelPromise;
      out.end(); err.end();
      this._flush();
      clearInterval(this.flushTimer);
      let state;
      if (this.cancelRequested) state = 'cancelled';
      else if (this.spawnError) state = 'failed';
      else state = code === 0 ? 'finished' : 'failed';
      this.state = state;
      this.emit('end', {
        state, code: this.spawnError ? null : code, signal,
        lastErrors: this.lastStderr.slice(-8),
        seconds: (Date.now() - this.startedAt) / 1000,
      });
    });
    this.flushTimer = setInterval(() => this._flush(), 50);
    this.emit('started', { pid: this.child.pid, argv: this.argv });
    return this;
  }

  _line(stream, text) {
    this.pending.push({ n: this.seq++, s: stream, t: text });
    if (stream === 'e') {
      this.lastStderr.push(text);
      if (this.lastStderr.length > 50) this.lastStderr.shift();
    } else {
      const m = PROGRESS_RE.exec(text);
      if (m) this.progress = Math.max(0, Math.min(100, parseFloat(m[1])));
    }
    if (this.pending.length >= 5000) this._flush();
  }

  _flush() {
    if (!this.pending.length) return;
    const lines = this.pending;
    this.pending = [];
    this.emit('lines', { lines, progress: this.progress });
  }

  /** Stop everything the run started. Resolves when nothing from the run is left. */
  cancel() {
    if (this.state !== 'running' || !this.child) return Promise.resolve();
    if (!this.cancelPromise) {
      this.cancelRequested = true;
      this.cancelPromise = this._kill();
    }
    return this.cancelPromise;
  }

  async _kill() {
    const pid = this.child.pid;
    if (process.platform === 'win32') {
      // /T = the whole tree (controller + worker), /F = force.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      signalGroup(pid, 'SIGTERM');
      const gone = await waitFor(() => !groupAlive(pid), 2000);
      if (!gone) signalGroup(pid, 'SIGKILL');
      await waitFor(() => !groupAlive(pid), 3000);
    }
    // The worker only removes its heartbeat file when it exits normally.
    const hb = path.join(path.dirname(path.resolve(this.o.casePath)), '.solver_heartbeat');
    await new Promise(r => setTimeout(r, 100));
    try { fs.unlinkSync(hb); } catch { /* not there: fine */ }
  }
}

function signalGroup(pid, sig) {
  try { process.kill(-pid, sig); } catch { /* ESRCH: already gone */ }
}
/**
 * Is any process of group `pgid` still running? kill(-pgid, 0) alone is not enough: it also
 * succeeds for zombies (exited processes not yet reaped by their parent; the orphaned worker's
 * parent is init). So if the group still exists we ask ps for the members' states and ignore Z.
 * `ps -A -o pid=,pgid=,stat=` works on Linux and macOS.
 */
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  const r = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return true; // cannot tell: assume alive
  return r.stdout.split('\n').some(l => {
    const f = l.trim().split(/\s+/);
    return +f[1] === pgid && f[2] && !f[2].startsWith('Z');
  });
}
function waitFor(pred, ms) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

module.exports = { SolverRun, LineSplitter, PROGRESS_RE, groupAlive };
