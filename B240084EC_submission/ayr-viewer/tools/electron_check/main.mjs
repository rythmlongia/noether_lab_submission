// Evaluate an expression in the Electron MAIN process via the Node inspector (--inspect=9229).
// usage: node main.mjs "expr"
const port = process.env.MAIN_PORT || 9229;
const [t] = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
for (const expr of process.argv.slice(2)) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
  console.log('main>', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result));
}
ws.close();
