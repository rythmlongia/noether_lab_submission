// Tests src/main/main.js without Electron: a fake 'electron' module records the IPC
// handlers and the app:// protocol handler, which are then called directly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { writeAyr, tetra } = require('./ayrWriter.js');

const handlers = {};
let protocolHandler = null;
let nextDialogPath = null;
const sent = [];
const wcEvents = {};
let devToolsToggles = 0;
const fakeWebContents = { send: (ch, data) => sent.push([ch, data]), setWindowOpenHandler() {}, on: (ev, fn) => { wcEvents[ev] = fn; }, toggleDevTools: () => { devToolsToggles++; } };
const fakeElectron = {
  app: { whenReady: () => Promise.resolve(), on() {}, getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'ud-')), quit() {} },
  BrowserWindow: class { constructor(o) { this.opts = o; this.webContents = fakeWebContents; fakeElectron.lastWindow = this; } loadURL(u) { this.url = u; } on() {} removeMenu() {} isDestroyed() { return false; } },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  dialog: { showOpenDialog: async () => (nextDialogPath ? { canceled: false, filePaths: [nextDialogPath] } : { canceled: true, filePaths: [] }) },
  protocol: { registerSchemesAsPrivileged() {}, handle: (s, fn) => { protocolHandler = fn; } },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  net: { fetch: async url => new Response(fs.readFileSync(new URL(url))) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : origLoad.call(this, req, ...rest); };
require('../src/main/main.js');

const ok = { sender: fakeWebContents, senderFrame: { url: 'app://ayr/renderer/index.html' } };
const evil = { sender: fakeWebContents, senderFrame: { url: 'https://evil.example/' } };
const call = (ch, ev, ...a) => handlers[ch](ev, ...a);

test('window is created with the hardened webPreferences', async () => {
  await new Promise(r => setTimeout(r, 10));
  const w = fakeElectron.lastWindow.opts.webPreferences;
  assert.equal(w.contextIsolation, true); assert.equal(w.sandbox, true); assert.equal(w.nodeIntegration, false);
  assert.equal(w.webSecurity, true); assert.equal(w.webviewTag, false); assert.equal(w.nodeIntegrationInWorker, false);
  assert.equal(fakeElectron.lastWindow.url, 'app://ayr/renderer/index.html');
});

test('Ctrl+Shift+I / F12 toggle DevTools once per key press (keyDown only, not keyUp)', () => {
  // Electron emits before-input-event for keyDown AND keyUp; toggling on both made DevTools impossible to close.
  const press = input => { wcEvents['before-input-event']({ preventDefault() {} }, { type: 'keyDown', ...input }); wcEvents['before-input-event']({ preventDefault() {} }, { type: 'keyUp', ...input }); };
  devToolsToggles = 0;
  press({ key: 'F12', control: false, shift: false });
  assert.equal(devToolsToggles, 1);
  press({ key: 'I', control: true, shift: true });
  assert.equal(devToolsToggles, 2);
  press({ key: 'i', control: true, shift: false }); // Ctrl+I alone does nothing
  assert.equal(devToolsToggles, 2);
});

test('the exact list of IPC channels', () => {
  assert.deepEqual(Object.keys(handlers).sort(), ['case:confirm', 'case:open', 'case:reject', 'python:browse', 'python:detect',
    'settings:get', 'solver:browse', 'solver:cancel', 'solver:run']);
});

test('IPC from another origin is refused', async () => {
  await assert.rejects(() => call('settings:get', evil), /unexpected sender/);
});

test('app:// serves files under src/ only, with a CSP header', async () => {
  const r = await protocolHandler(new Request('app://ayr/renderer/index.html'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  for (const u of ['app://ayr/../package.json', 'app://ayr/%2e%2e/%2e%2e/package.json', 'app://ayr/renderer/..%2f..%2fpackage.json', 'app://other/renderer/index.html']) {
    const res = await protocolHandler(new Request(u));
    // '..' is either removed by the URL parser (-> src/package.json, which does not exist: 404)
    // or caught by the path guard (403). The real package.json is never served.
    assert.ok(res.status === 403 || res.status === 404, `${u} -> ${res.status}`);
  }
});

test('solver cannot run before a file was validated; fail-at is validated', async () => {
  await assert.rejects(() => call('solver:run', ok, { failAt: null }), /Open a valid/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'with space '));
  nextDialogPath = path.join(dir, 'c.ayr');
  fs.writeFileSync(nextDialogPath, writeAyr(tetra()));
  const opened = await call('case:open', ok);
  assert.equal(opened.fileName, 'c.ayr');
  assert.ok(opened.bytes instanceof Uint8Array);
  await assert.rejects(() => call('solver:run', ok, { failAt: null }), /Open a valid/); // not confirmed yet
  assert.equal(await call('case:confirm', ok, opened.token + 1), false);               // wrong token
  assert.equal(await call('case:confirm', ok, opened.token), true);
  for (const bad of ['abc', '-1', '101', 'NaN', '1; rm -rf /']) {
    await assert.rejects(() => call('solver:run', ok, { failAt: bad }), /fail-at must be|No Python/, bad);
  }
});
