// End-to-end check of the REAL Electron app on Windows, driven over the Chrome DevTools Protocol.
//
// Start the app first:   npx electron . --inspect=9229 --remote-debugging-port=9223
// Then:                  node tools/electron_check/app_check.mjs <folder with results.ayr> <output dir for screenshots>
//
// The only thing replaced is the native file dialog (dialog.showOpenDialog, in the main process via the
// Node inspector), which a script cannot click. Everything after it is the app's own code: fs.readFile in
// main, IPC, the Web Worker parser, WebGL, the solver runner, taskkill. Process counts come from
// Get-CimInstance Win32_Process (the same list Task Manager -> Details shows).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [dataDir, shotDir] = process.argv.slice(2);
if (!dataDir || !shotDir) { console.error('usage: app_check.mjs <data dir> <screenshot dir>'); process.exit(2); }
fs.mkdirSync(shotDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- minimal CDP connections: renderer page (port 9223) and main process (Node inspector, port 9229)
async function connect(listUrl, pick) {
  const t = pick(await (await fetch(listUrl)).json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  await send('Runtime.enable');
  return { ws, send, evaluate, events };
}
const page = await connect('http://127.0.0.1:9223/json', l => l.find(t => t.type === 'page' && t.url.startsWith('app://')));
const main = await connect('http://127.0.0.1:9229/json', l => l[0]);

await main.evaluate(`(() => { const { dialog } = require('electron'); globalThis.__next = null;
  dialog.showOpenDialog = async () => globalThis.__next ? { canceled: false, filePaths: [globalThis.__next] } : { canceled: true, filePaths: [] }; })()`);
const UI = `const $ = id => document.getElementById(id); const sleep = ms => new Promise(r => setTimeout(r, ms));`;

async function open(file) {
  await main.evaluate(`globalThis.__next = ${JSON.stringify(file)}`);
  return page.evaluate(`(async () => { ${UI} $('btn-open').click(); await sleep(400);
    for (let i = 0; i < 100 && !$('loading').hidden; i++) await sleep(50);
    return { error: $('error').hidden ? null : $('error').textContent, name: $('case-name').textContent, details: $('file-details').innerText,
             runDisabled: $('btn-run').disabled, imgs: document.querySelectorAll('img').length }; })()`);
}
async function shot(name) {
  await sleep(300);
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotDir, name), Buffer.from(r.result.data, 'base64'));
}
function solverProcesses() {
  const ps = "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*fake_solver.py*' }).Count";
  return +execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
}
async function runSolver({ failAt = '', cancelAfterMs = null } = {}) {
  await page.evaluate(`(() => { ${UI} $('fail-at').value = ${JSON.stringify(String(failAt))}; $('btn-run').click(); })()`);
  let before = null;
  if (cancelAfterMs !== null) {
    await sleep(cancelAfterMs);
    before = solverProcesses();
    await page.evaluate(`document.getElementById('btn-cancel').click()`);
  }
  const t0 = Date.now(); const progressSeen = new Set();
  while (Date.now() - t0 < 150000) {
    const s = await page.evaluate(`[document.getElementById('run-state').textContent, document.getElementById('progress').value]`);
    progressSeen.add(s[1]);
    if (/^(finished|failed|cancelled)/.test(s[0])) break;
    await sleep(250);
  }
  const res = await page.evaluate(`(() => { ${UI} return { state: $('run-state').textContent, result: $('run-result').innerText, progress: $('progress-text').textContent,
    rows: document.querySelectorAll('.log-row').length, imgs: document.querySelectorAll('img').length, alerts: window.__alerts }; })()`);
  await page.evaluate(`document.getElementById('fail-at').value = ''`);
  return { ...res, before, distinctProgressValues: progressSeen.size };
}

const log = (...a) => console.log(...a);
log(`# Windows Electron app check, ${new Date().toISOString()}`);
log(`# ${os.version()} | Node ${process.version} | Electron ${await main.evaluate('process.versions.electron')}`);
await page.evaluate(`window.__alerts = 0; window.alert = () => { window.__alerts++; }`);

// ---- 1. both provided files
for (const f of ['results_small.ayr', 'results.ayr']) {
  const r = await open(path.join(dataDir, f));
  log(`\n## open ${f}: ${r.error ? 'ERROR ' + r.error : 'ok, case ' + r.name}`);
  log(r.details.replace(/\n(?=[A-Z])/g, '\n  ').replace(/^/, '  '));
  await shot(`${f.replace('.ayr', '')}_solid.png`);
}
// results.ayr is open now: Q2 and Q3 live in the UI
const q2 = await page.evaluate(`(async () => { ${UI} document.querySelector('[data-mode=slider]').click(); $('t-slider').value = 114;
  $('t-slider').dispatchEvent(new Event('input')); await sleep(100); return $('t-value').textContent + ' s: ' + $('t-stats').textContent; })()`);
log(`\n## Q2 in the app (Solid at time t): t = ${q2}`); await shot('results_slider_t114.png');
const q3 = await page.evaluate(`(async () => { ${UI} document.querySelector('[data-mode=temp]').click(); $('snap-slider').value = 12;
  $('snap-slider').dispatchEvent(new Event('input')); await sleep(100);
  return 'snapshot ' + $('snap-index').textContent + ', t = ' + $('snap-time').textContent + ' s, legend ' + $('legend-ticks').innerText.replace(/\\n/g, ' '); })()`);
log(`## Q3 snapshot in the app (Temperature mode): ${q3}`); await shot('results_temp_snap12.png');

// ---- 2. corrupted files (made by tools/make_broken_files.js from results_small.ayr)
const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr broken '));
execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'make_broken_files.js'), path.join(dataDir, 'results_small.ayr'), broken], { stdio: 'ignore' });
log('\n## corrupted files (expect: message, no mesh, Run disabled)');
for (const f of fs.readdirSync(broken).filter(f => f !== 'valid_html_case_name.ayr').sort()) {
  const r = await open(path.join(broken, f));
  log(`  ${r.error ? 'REJECTED' : 'OPENED!!'}  run-disabled=${r.runDisabled}  ${f}: ${r.error || ''}`);
  if (f === 'one_byte_flipped_in_positions.ayr') await shot('bad_file.png');
}

// ---- 3. HTML case name + solver: full run, fail-at 70, cancel x3
const html = await open(path.join(broken, 'valid_html_case_name.ayr'));
log(`\n## HTML case name: shown as ${JSON.stringify(html.name)}, <img> elements in page: ${html.imgs}`);
let r = await runSolver();
log(`## full run on it: ${r.state} | ${r.result} | progress ${r.progress} | ${r.distinctProgressValues} distinct progress values seen while polling | log rows in DOM ${r.rows} | <img> ${r.imgs} | alert() calls ${r.alerts}`);
await shot('solver_finished.png');
log(`   solver processes afterwards: ${solverProcesses()}`);

await open(path.join(dataDir, 'results.ayr'));
r = await runSolver({ failAt: 70 });
log(`\n## --fail-at 70: ${r.state} | ${r.result.replace(/\n/g, ' / ')}`);
await shot('solver_failed_70.png');

log(`\n## cancel (case folder: ${dataDir})`);
for (let k = 1; k <= 3; k++) {
  r = await runSolver({ cancelAfterMs: 4000 });
  const after = solverProcesses(); await sleep(5000); const later = solverProcesses();
  const hb = fs.existsSync(path.join(dataDir, '.solver_heartbeat'));
  log(`  cycle ${k}: ${r.state} | python solver processes: before cancel ${r.before}, right after ${after}, 5 s later ${later} | heartbeat file left: ${hb}`);
  if (k === 1) await shot('solver_cancelled.png');
}
const exc = page.events.filter(e => e.method === 'Runtime.exceptionThrown').length;
const errs = page.events.filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error').length;
log(`\n## page exceptions during the whole check: ${exc}, console.error calls: ${errs}`);
page.ws.close(); main.ws.close();
