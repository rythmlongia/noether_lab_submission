// Tiny CDP client for the running Electron app (Node 22: global fetch + WebSocket).
// usage: node cdp.mjs [--reload] [--shot out.png] [--wait ms] [--eval "expr"]...
const args = process.argv.slice(2);
const opt = { reload: false, shot: null, wait: 1500, evals: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--reload') opt.reload = true;
  else if (args[i] === '--shot') opt.shot = args[++i];
  else if (args[i] === '--wait') opt.wait = +args[++i];
  else if (args[i] === '--eval') opt.evals.push(args[++i]);
}
const port = process.env.CDP_PORT || 9223;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && t.url.startsWith('app://')) || targets.find(t => t.type === 'page');
if (!page) { console.log('no page target', targets); process.exit(1); }
console.log('target:', page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
const out = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') out.push(`[console.${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; out.push(`[EXCEPTION] ${d.exception?.description || d.text} @ ${d.url || ''}:${d.lineNumber}`); }
  if (m.method === 'Log.entryAdded') { const e = m.params.entry; out.push(`[log.${e.level}/${e.source}] ${e.text} ${e.url || ''}`); }
  if (m.method === 'Network.loadingFailed') out.push(`[net-failed] ${m.params.errorText} ${m.params.blockedReason || ''} ${m.params.requestId}`);
  if (m.method === 'Network.responseReceived') { const r = m.params.response; out.push(`[net ${r.status}] ${r.url} ${r.mimeType}`); }
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
if (opt.reload) await send('Page.reload', { ignoreCache: true });
await new Promise(r => setTimeout(r, opt.wait));
for (const e of opt.evals) {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  console.log('eval>', e.slice(0, 80).replace(/\s+/g, ' '), '=>', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result));
}
if (opt.shot) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  (await import('fs')).writeFileSync(opt.shot, Buffer.from(r.result.data, 'base64'));
  console.log('screenshot', opt.shot);
}
console.log(out.join('\n'));
ws.close();
