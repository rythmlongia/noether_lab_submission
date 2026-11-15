/*
 * Electron main process.
 *  - serves the UI from a custom app:// scheme (no file:// pages, no remote content)
 *  - owns everything privileged: file dialogs, reading files, starting/stopping the solver
 *  - exposes a small, validated IPC surface to the renderer (see preload.js)
 */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { SolverRun } = require('./solverRunner');
const { detectPython, probe } = require('./python');

const SRC_ROOT = path.join(__dirname, '..');                 // .../src
const BUNDLED_SOLVER = path.join(__dirname, '..', '..', 'solver', 'fake_solver.py');
const CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ------------------------------------------------------------------ settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { python: null, pythonVersion: null, solverPath: BUNDLED_SOLVER };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
  if (!settings.solverPath || !fs.existsSync(settings.solverPath)) settings.solverPath = BUNDLED_SOLVER;
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}
const publicSettings = () => ({ python: settings.python, pythonVersion: settings.pythonVersion, solverPath: settings.solverPath });

// ------------------------------------------------------------------ state
let win = null;
let pendingCase = null;   // file read and sent to the renderer, not yet validated
let currentCase = null;   // file the renderer parsed and validated successfully
let run = null;           // active SolverRun
let openSeq = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'Ayrton results viewer',
    backgroundColor: '#15171c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,          // page JS and preload JS live in separate worlds
      sandbox: true,                   // renderer is an OS-sandboxed process without Node
      nodeIntegration: false,          // no require()/process in the page
      nodeIntegrationInWorker: false,  // ...nor in its Web Workers
      nodeIntegrationInSubFrames: false,
      webSecurity: true,               // same-origin policy stays on
      allowRunningInsecureContent: false,
      webviewTag: false,               // no <webview> (could load remote content with its own prefs)
      spellcheck: false,
      devTools: true,                  // kept for debugging/grading; see README
    },
  });
  win.removeMenu?.();
  win.loadURL('app://ayr/renderer/index.html');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));          // no window.open / target=_blank
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://ayr/')) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {                   // Ctrl+Shift+I / F12 toggle DevTools
    // before-input-event fires for keyDown AND keyUp. Reacting to both toggled twice per press:
    // DevTools could be opened (the second "open" was a no-op while it was still opening) but never closed.
    if (input.type !== 'keyDown') return;
    if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(() => {
  loadSettings();

  // app://ayr/<path> -> files under src/, nothing outside it.
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(SRC_ROOT, rel));
    if (url.host !== 'ayr' || !file.startsWith(SRC_ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    let res;
    try { res = await net.fetch(pathToFileURL(file).toString()); } catch { return new Response('Not found', { status: 404 }); }
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (file.endsWith('.js')) headers.set('Content-Type', 'text/javascript; charset=utf-8');
    return new Response(res.body, { status: res.status, headers });
  });

  // Deny every permission request (camera, notifications, ...) - the app needs none.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', async e => {
  if (run && run.state === 'running') { e.preventDefault(); await run.cancel(); run = null; app.quit(); }
});

// ------------------------------------------------------------------ IPC
// Only messages from our own page are accepted.
function fromOurPage(event) {
  try {
    const u = new URL(event.senderFrame.url);
    return !!win && event.sender === win.webContents && u.protocol === 'app:' && u.host === 'ayr';
  } catch { return false; }
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromOurPage(event)) throw new Error('IPC from unexpected sender');
    return fn(...args);
  });
}

handle('case:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open results file', properties: ['openFile'],
    filters: [{ name: 'Ayrton results', extensions: ['ayr'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const filePath = r.filePaths[0];
  const bytes = await fs.promises.readFile(filePath);   // async: the main process event loop stays free
  const token = ++openSeq;
  pendingCase = { token, filePath };
  // The Buffer is copied once into the renderer process by Electron's IPC (structured clone).
  return { token, fileName: path.basename(filePath), size: bytes.length, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) };
});

handle('case:confirm', token => {
  // Called by the renderer after the worker validated the file. Only then can the solver run on it.
  if (pendingCase && pendingCase.token === token) { currentCase = pendingCase; return true; }
  return false;
});

handle('case:reject', token => {
  if (pendingCase && pendingCase.token === token) pendingCase = null;
  currentCase = null;
  return true;
});

handle('settings:get', () => publicSettings());

handle('python:detect', async () => {
  const r = await detectPython();
  if (r.executable) { settings.python = r.executable; settings.pythonVersion = r.version; saveSettings(); }
  return { ...publicSettings(), tried: r.tried };
});

handle('python:browse', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the Python 3 executable', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return { ...publicSettings(), error: null };
  const p = await probe(r.filePaths[0]);
  if (!p) return { ...publicSettings(), error: 'That file did not run as Python.' };
  if (!p.ok) return { ...publicSettings(), error: `Python ${p.version} is too old (3.9 or newer is needed).` };
  settings.python = p.executable; settings.pythonVersion = p.version; saveSettings();
  return { ...publicSettings(), error: null };
});

handle('solver:browse', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose fake_solver.py', properties: ['openFile'], filters: [{ name: 'Python', extensions: ['py'] }] });
  if (!r.canceled && r.filePaths.length) { settings.solverPath = r.filePaths[0]; saveSettings(); }
  return publicSettings();
});

handle('solver:run', async opts => {
  if (run && run.state === 'running') throw new Error('A run is already in progress.');
  if (!currentCase) throw new Error('Open a valid .ayr file first.');
  if (!settings.python) throw new Error('No Python interpreter set. Press "Detect" or "Browse".');
  let failAt = null;
  if (opts && opts.failAt !== null && opts.failAt !== undefined && opts.failAt !== '') {
    failAt = Number(opts.failAt);
    if (!Number.isFinite(failAt) || failAt < 0 || failAt > 100) throw new Error('fail-at must be a number from 0 to 100.');
  }
  const r = new SolverRun({ python: settings.python, solverPath: settings.solverPath, casePath: currentCase.filePath, steps: 200, failAt });
  run = r;
  r.on('started', info => send('solver:event', { type: 'started', pid: info.pid, argv: info.argv }));
  r.on('lines', b => send('solver:event', { type: 'lines', lines: b.lines, progress: b.progress }));
  r.on('end', e => { send('solver:event', { type: 'end', ...e }); if (run === r) run = null; });
  r.start();
  return { pid: r.child.pid };
});

handle('solver:cancel', async () => {
  if (run && run.state === 'running') { send('solver:event', { type: 'cancelling' }); await run.cancel(); }
  return true;
});
