// Extra Task 2 checks in the REAL Electron app on Windows (same set-up as app_check.mjs):
//   1. after a FAILED run (--fail-at): no solver process and no heartbeat file (.solver_heartbeat / .tmp) left
//   2. responsiveness during the solver's 3000-4000-line diagnostics burst (at 25 % of the run):
//      frame times while orbiting, log scrolling, and how fast Cancel reacts
//   3. closing the app window during a run: no solver process left afterwards
//
// Start the app first:  npx electron . --inspect=9229 --remote-debugging-port=9223
// Then:                 node tools/electron_check/solver_checks.mjs <folder with results.ayr>
// The app is closed by step 3.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.argv[2];
if (!dataDir) { console.error('usage: solver_checks.mjs <data dir>'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect(listUrl, pick) {
  const t = pick(await (await fetch(listUrl)).json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  await send('Runtime.enable');
  return { ws, evaluate };
}
const page = await connect('http://127.0.0.1:9223/json', l => l.find(t => t.type === 'page' && t.url.startsWith('app://')));
const main = await connect('http://127.0.0.1:9229/json', l => l[0]);
const solverProcesses = () => +execFileSync('powershell', ['-NoProfile', '-Command',
  "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*fake_solver.py*' }).Count"],
  { encoding: 'utf8', windowsHide: true }).trim();
const heartbeatFiles = () => fs.readdirSync(dataDir).filter(f => f.startsWith('.solver_heartbeat'));
const state = () => page.evaluate(`document.getElementById('run-state').textContent`);
async function waitEnd(maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { const s = await state(); if (/^(finished|failed|cancelled)/.test(s)) return s; await sleep(100); }
  return 'TIMEOUT';
}
const log = (...a) => console.log(...a);

await main.evaluate(`(() => { const { dialog, BrowserWindow } = require('electron');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(path.join(dataDir, 'results.ayr'))}] });
  const w = BrowserWindow.getAllWindows()[0]; w.show(); w.setAlwaysOnTop(true); w.focus(); })()`);
await page.evaluate(`(async () => { document.getElementById('btn-open').click(); await new Promise(r => setTimeout(r, 2500)); })()`);
log(`# Extra solver checks, ${new Date().toISOString()}, Electron ${await main.evaluate('process.versions.electron')}`);
log(`# log limit notice shown before any run: ${JSON.stringify(await page.evaluate(`document.getElementById('log-notice').textContent`))}`);

// 1. failed run
for (const failAt of [5, 30]) {
  await page.evaluate(`(() => { document.getElementById('fail-at').value = '${failAt}'; document.getElementById('btn-run').click(); })()`);
  const s = await waitEnd(60000);
  await sleep(300);
  log(`\n## --fail-at ${failAt}: ${s} | solver processes right after: ${solverProcesses()} | heartbeat files left: ${JSON.stringify(heartbeatFiles())}`);
  await sleep(3000);
  log(`   3 s later: solver processes ${solverProcesses()}`);
}
await page.evaluate(`document.getElementById('fail-at').value = ''`);

// 2. responsiveness during the burst. Step 50 of 200 (25 %) prints 3000-4000 diagnostic lines; at 0.4 s/step
//    that is ~20 s after start. Record every requestAnimationFrame interval from 15 s to 26 s while the camera
//    orbits and the log is scrolled up and down, then press Cancel and time how long "cancelled" takes.
await page.evaluate(`document.getElementById('btn-run').click()`);
await sleep(15000);
const resp = await page.evaluate(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lg = document.getElementById('log'); const iv = []; let last = performance.now(); let on = true;
  const tick = now => { iv.push(now - last); last = now; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  document.getElementById('bench-orbit').click();          // camera orbits for 5 s (as if dragging)
  const rowsBefore = document.querySelectorAll('.log-row').length;
  let scrolls = 0; const t0 = performance.now();
  while (performance.now() - t0 < 11000) {                 // scroll the log up/down every 200 ms
    lg.scrollTop = (scrolls++ % 2) ? lg.scrollHeight : lg.scrollHeight / 3; await sleep(200);
    if (performance.now() - t0 > 5500 && !document.getElementById('bench-out').textContent.startsWith('running')
        && !window.__orbit2) { window.__orbit2 = 1; document.getElementById('bench-orbit').click(); }
  }
  on = false;
  const diag = [...document.querySelectorAll('.log-row')].length;
  const s = iv.slice(1).sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { frames: s.length, median: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1], over50ms: s.filter(x => x > 50).length,
           scrolls, rowsInDom: diag, progress: document.getElementById('progress-text').textContent };
})()`);
const diagLines = await page.evaluate(`window.__diagSeen = 0; 0`);
const tCancel = Date.now();
await page.evaluate(`document.getElementById('btn-cancel').click()`);
const sc = await waitEnd(20000);
log(`\n## during the diagnostics burst (15-26 s into a run, orbiting + scrolling the log every 200 ms):`);
log(`   ${resp.frames} frames; frame interval median ${resp.median.toFixed(1)} ms, p95 ${resp.p95.toFixed(1)}, p99 ${resp.p99.toFixed(1)}, max ${resp.max.toFixed(1)} ms; intervals > 50 ms: ${resp.over50ms}`);
log(`   log scrolled ${resp.scrolls} times; rows in DOM ${resp.rowsInDom}; progress at the end ${resp.progress}`);
log(`   Cancel clicked -> "${sc}" after ${Date.now() - tCancel} ms; solver processes ${solverProcesses()}; heartbeat files ${JSON.stringify(heartbeatFiles())}`);
void diagLines;

// 3. close the window during a run
await page.evaluate(`document.getElementById('btn-run').click()`);
await sleep(4000);
const before = solverProcesses();
await main.evaluate(`(() => { const { BrowserWindow } = require('electron'); BrowserWindow.getAllWindows().forEach(w => w.setAlwaysOnTop(false)); BrowserWindow.getAllWindows()[0].close(); })()`).catch(() => {});
page.ws.close(); main.ws.close();
let after = -1;
for (let i = 0; i < 20; i++) { await sleep(500); after = solverProcesses(); if (after === 0) break; }
await sleep(3000);
log(`\n## window closed during a run: solver processes before ${before}, after close ${after}, 3 s later ${solverProcesses()}; heartbeat files ${JSON.stringify(heartbeatFiles())}`);
const electronLeft = execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe'], { encoding: 'utf8' }).includes('electron.exe');
log(`   electron.exe still running: ${electronLeft}`);
