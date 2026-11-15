/*
 * app.js - UI glue. Talks to the main process only through window.ayr (preload.js).
 * All text that comes from files or from the solver is inserted with textContent.
 */
/* global AYRColor, AYRViewer, AYRLog */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.ayr;

  const viewer = new AYRViewer.Viewer($('gl'));
  const log = new AYRLog.LogView($('log'), $('log-notice'));
  const worker = new Worker('parse-worker.js');

  let data = null;          // parsed file (typed arrays from the worker)
  let mode = 'solid';
  let snap = 0;
  let openId = 0;
  let running = false;

  // ------------------------------------------------------------------ helpers
  const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : String(v));
  const K2C = k => k - 273.15;
  function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function kv(container, pairs) {
    container.replaceChildren();
    for (const [k, v] of pairs) { container.append(el('span', 'k', k), el('span', 'v', v)); }
  }

  // Legend gradient from the same viridis table the GPU uses (CSSOM, allowed by the CSP).
  $('legend-bar').style.background = `linear-gradient(to right, ${
    Array.from({ length: 11 }, (_, i) => { const c = AYRColor.VIRIDIS_HEX[Math.round(i * 25.5)]; return `#${c.toString(16).padStart(6, '0')} ${i * 10}%`; }).join(', ')})`;

  function drawLegend(title, min, max, unit, toDisplay) {
    $('legend-title').textContent = title;
    const box = $('legend-ticks');
    box.replaceChildren();
    const lo = toDisplay(min), hi = toDisplay(max);
    // A valid file can have no computed value at all (every value NaN): min/max are NaN then.
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { box.append(el('span', 'tick end-l', 'no computed values (all grey)')); return; }
    const ticks = AYRColor.ticks(lo, hi, 6).filter(v => v > lo + (hi - lo) * 0.12 && v < hi - (hi - lo) * 0.12); // keep ticks clear of the end labels
    const place = (v, label, cls) => { const s = el('span', cls || 'tick', label); s.style.left = `${((v - lo) / (hi - lo)) * 100}%`; box.append(s); };
    place(lo, `${fmt(lo, 1)}`, 'tick end-l');
    for (const v of ticks) place(v, String(v));
    place(hi, `${fmt(hi, 1)}`, 'tick end-r');
    box.append(el('span', 'unit', unit));
  }

  // ------------------------------------------------------------------ open + parse
  $('btn-open').addEventListener('click', openFile);

  async function openFile() {
    showError('');
    let res;
    try { res = await api.openCase(); } catch (e) { showError(`Could not read the file: ${e.message}`); return; }
    if (!res) return;
    const id = ++openId;
    $('bench-out').textContent = '';   // an old benchmark result belongs to the previous file's mesh
    $('loading').hidden = false;
    $('file-name').textContent = `${res.fileName} (${(res.size / 1e6).toFixed(2)} MB)`;
    $('case-name').textContent = '';
    const t0 = performance.now();
    // Transfer (not copy) the file bytes to the worker.
    worker.postMessage({ id, buffer: res.bytes }, [res.bytes.buffer]);
    const msg = await new Promise(resolve => {
      const on = e => { if (e.data.id === id) { worker.removeEventListener('message', on); resolve(e.data); } };
      worker.addEventListener('message', on);
    });
    if (id !== openId) return; // a newer open started meanwhile
    $('loading').hidden = true;
    if (!msg.ok) {
      data = null;
      viewer.clear();           // never leave a mesh on screen for a bad file
      await api.rejectCase(res.token);
      showError(`Cannot open ${res.fileName}: ${msg.error}`);
      $('case-name').textContent = '';
      $('file-details').textContent = '–';
      $('probe').textContent = 'Click on the part.';
      updateRunButtons();
      return;
    }
    await api.confirmCase(res.token);
    loadParsed(msg, performance.now() - t0);
  }

  function loadParsed(m, ms) {
    data = m;
    const h = m.header, s = m.summary;
    $('case-name').textContent = `“${h.name}”`;
    // NaN-safe GPU attributes
    const solid = AYRColor.prepareScalar(m.solidTime);
    const solidPairs = new Float32Array(2 * h.nVert);
    for (let i = 0; i < h.nVert; i++) { solidPairs[2 * i] = solid.value[i]; solidPairs[2 * i + 1] = solid.valid[i]; }
    const b = s.bboxMm;
    const radius = 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    viewer.setMesh({ gpuPos: m.gpuPos, normals: m.normals, triangles: m.triangles, solidPairs, nVert: h.nVert, radius });
    viewer.set({ solidRange: [s.solid.min, s.solid.max], tempRange: [s.temperature.min, s.temperature.max] });

    // time slider covers the whole range of computed solidification times
    const ts = $('t-slider');
    const smax = Number.isFinite(s.solid.max) ? s.solid.max : 0;   // all-NaN file: no range
    ts.min = 0; ts.max = Math.ceil(smax); ts.value = Math.round(smax / 2);
    // snapshots
    const ss = $('snap-slider');
    ss.max = h.nSnap - 1; ss.value = 0; snap = 0;
    $('snap-count').textContent = String(h.nSnap);
    setSnapshot(0);

    kv($('file-details'), [
      ['Case name', h.name], ['Byte order', h.littleEndian ? 'little-endian' : 'big-endian'],
      ['Units in file', h.units === 0 ? 'metre (shown in mm)' : 'millimetre'], ['Vertices', h.nVert.toLocaleString()],
      ['Triangles', h.nTri.toLocaleString()], ['Snapshots', String(h.nSnap)],
      ['Bounding box (mm)', h.nVert === 0 ? 'none (no vertices)' : `x ${fmt(b.min[0], 3)} … ${fmt(b.max[0], 3)}\ny ${fmt(b.min[1], 3)} … ${fmt(b.max[1], 3)}\nz ${fmt(b.min[2], 3)} … ${fmt(b.max[2], 3)}`],
      ['Solid. time', `${fmt(s.solid.min, 2)} … ${fmt(s.solid.max, 2)} s (${s.solid.count.toLocaleString()} computed, ${(h.nVert - s.solid.count).toLocaleString()} not computed)`],
      ['Temperature', `${fmt(K2C(s.temperature.min), 2)} … ${fmt(K2C(s.temperature.max), 2)} °C (all snapshots)`],
      ['CRC-32', `stored ${hex8(h.crcStored)}, computed ${hex8(h.crcComputed)} ✓`],
      ['Load time', `${ms.toFixed(0)} ms (worker parse ${m.timing.parseMs.toFixed(0)} ms)`],
    ]);
    $('probe').textContent = 'Click on the part.';
    setMode(mode);
    updateRunButtons();
  }

  const hex8 = n => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

  // ------------------------------------------------------------------ modes
  for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setMode(b.dataset.mode));

  function setMode(m) {
    mode = m;
    for (const b of document.querySelectorAll('.mode')) b.classList.toggle('active', b.dataset.mode === m);
    $('panel-slider').hidden = m !== 'slider';
    $('panel-snap').hidden = m !== 'temp';
    const extra = $('legend-extra');
    extra.replaceChildren();
    if (!data) return;
    const s = data.summary;
    if (m === 'temp') {
      viewer.set({ mode: 1, sliderOn: false });
      drawLegend('Surface temperature (same scale for all snapshots)', s.temperature.min, s.temperature.max, '°C', K2C);
      $('grey-text').textContent = 'Grey: temperature not computed (NaN in the file; these are the vertices whose solidification time is not computed)';
    } else {
      viewer.set({ mode: 0, sliderOn: m === 'slider' });
      drawLegend('Solidification time', s.solid.min, s.solid.max, 's', v => v);
      $('grey-text').textContent = 'Grey: solidification time not computed (NaN in the file, e.g. cells next to the ingate)';
      if (m === 'slider') {
        const a = el('div', 'legend-item'); a.append(el('span', 'swatch liquid'), el('span', '', 'Not yet fully solid at t (solid_time > t)'));
        const c = el('div', 'legend-item'); c.append(el('span', 'swatch faded'), el('span', '', 'Already solid at t (faded solidification-time colour)'));
        extra.append(a, c);
        setT(+$('t-slider').value);
      }
    }
  }

  // ------------------------------------------------------------------ time slider
  $('t-slider').addEventListener('input', e => setT(+e.target.value));
  function setT(t) {
    viewer.set({ t });
    $('t-value').textContent = fmt(t, 1);
    if (!data) return;
    // Same rule as Q2: NaN vertices are excluded from both counts.
    const st = data.solidTime;
    let computed = 0, liquid = 0;
    for (let i = 0; i < st.length; i++) { const v = st[i]; if (v === v) { computed++; if (v > t) liquid++; } }
    if (computed === 0) { $('t-stats').textContent = 'No vertex has a computed solidification time in this file.'; return; }
    $('t-stats').textContent = `${liquid.toLocaleString()} of ${computed.toLocaleString()} computed vertices not yet fully solid (${(100 * liquid / computed).toFixed(2)} %)`;
  }

  // ------------------------------------------------------------------ snapshots
  $('snap-slider').addEventListener('input', e => setSnapshot(+e.target.value));
  $('snap-prev').addEventListener('click', () => data && setSnapshot(Math.max(0, snap - 1)));
  $('snap-next').addEventListener('click', () => data && setSnapshot(Math.min(data.header.nSnap - 1, snap + 1)));
  function setSnapshot(i) {
    snap = i;
    $('snap-slider').value = i;
    const n = data.header.nVert;
    const T = data.temperature.subarray(i * n, (i + 1) * n);   // snapshot-major
    const pairs = new Float32Array(2 * n);
    for (let v = 0; v < n; v++) { const x = T[v]; if (x === x) { pairs[2 * v] = x; pairs[2 * v + 1] = 1; } }
    viewer.setTemperaturePairs(pairs);
    $('snap-index').textContent = String(i);
    $('snap-time').textContent = fmt(data.times[i], 2);
    if (lastProbe >= 0) showProbe(lastProbe);
  }

  // ------------------------------------------------------------------ probe
  let lastProbe = -1;
  viewer.onPick = (v) => { lastProbe = v; showProbe(v); };
  $('btn-frame').addEventListener('click', () => viewer.frame());

  function showProbe(v) {
    const box = $('probe');
    if (v < 0 || !data) { box.textContent = 'No part under the cursor.'; return; }
    const k = data.header.unitToMm, P = data.positions, n = data.header.nVert;
    const st = data.solidTime[v];
    const T = data.temperature[snap * n + v];
    kv(box, [
      ['Vertex index', String(v)],
      ['Position (mm)', `(${fmt(P[3 * v] * k, 3)}, ${fmt(P[3 * v + 1] * k, 3)}, ${fmt(P[3 * v + 2] * k, 3)})`],
      ['Solidification time', Number.isNaN(st) ? 'not computed (NaN)' : `${fmt(st, 2)} s`],
      [`Temperature @ snapshot ${snap} (t = ${fmt(data.times[snap], 2)} s)`, Number.isNaN(T) ? 'not computed (NaN)' : `${fmt(K2C(T), 2)} °C (${fmt(T, 2)} K)`],
    ]);
  }

  // ------------------------------------------------------------------ frame-time meter
  const frames = [];        // [timestamp, cpuMs]
  viewer.onFrame = cpu => {
    const now = performance.now();
    frames.push([now, cpu]);
    while (frames.length && frames[0][0] < now - 1000) frames.shift();
    if (bench) bench.samples.push([now, cpu]);
  };
  setInterval(() => {
    // Also drop old frames here: onFrame only runs when a frame is drawn, so without this the
    // meter kept showing the stats of the last burst of frames forever (e.g. "243 ms/frame" after loading).
    const now = performance.now();
    while (frames.length && frames[0][0] < now - 1000) frames.shift();
    if (frames.length < 2) { $('perf').textContent = 'idle (draws only on change)'; return; }
    const iv = []; for (let i = 1; i < frames.length; i++) iv.push(frames[i][0] - frames[i - 1][0]);
    const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
    const cpu = frames.reduce((a, f) => a + f[1], 0) / frames.length;
    $('perf').textContent = `${avg.toFixed(1)} ms/frame (${(1000 / avg).toFixed(0)} fps), draw CPU ${cpu.toFixed(2)} ms`;
  }, 500);

  let bench = null;
  function runBench(kind) {
    if (!data || bench) return;
    const out = $('bench-out');
    out.textContent = 'running…';
    const ts = $('t-slider');
    const prevMode = mode;
    if (kind === 'slider') setMode('slider');
    bench = { kind, samples: [] };
    const t0 = performance.now(), D = 5000, yaw0 = viewer.cam.yaw;
    const step = () => {
      const u = (performance.now() - t0) / D;
      if (u >= 1) return finish();
      if (kind === 'slider') {
        const max = +ts.max; const t = max * (0.5 - 0.5 * Math.cos(2 * Math.PI * u)); // sweep 0 -> max -> 0
        ts.value = t; setT(t);   // same code path as a real 'input' event, including the count
      } else {
        viewer.cam.yaw = yaw0 + 2 * Math.PI * u; viewer.dirty = true;
      }
      requestAnimationFrame(step);
    };
    const finish = () => {
      const s = bench.samples; bench = null;
      const iv = []; for (let i = 1; i < s.length; i++) iv.push(s[i][0] - s[i - 1][0]);
      iv.sort((a, b) => a - b);
      const q = p => iv[Math.min(iv.length - 1, Math.floor(p * iv.length))];
      const cpu = s.map(x => x[1]).sort((a, b) => a - b);
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      out.textContent = `${kind === 'slider' ? 'Time slider sweep' : 'Orbit 360°'}, ${s.length} frames in 5 s, ${data.header.nVert.toLocaleString()} vertices\n` +
        `frame interval: mean ${mean.toFixed(2)} ms (${(1000 / mean).toFixed(1)} fps), median ${q(0.5).toFixed(2)}, p95 ${q(0.95).toFixed(2)}, max ${iv[iv.length - 1].toFixed(2)} ms\n` +
        `draw call CPU: median ${cpu[Math.floor(cpu.length / 2)].toFixed(2)} ms, max ${cpu[cpu.length - 1].toFixed(2)} ms\n` +
        `canvas ${$('gl').width}x${$('gl').height} px, devicePixelRatio ${window.devicePixelRatio}`;
      if (kind === 'slider' && prevMode !== 'slider') setMode(prevMode);
      if (kind === 'orbit') { viewer.cam.yaw = yaw0; viewer.dirty = true; }
    };
    requestAnimationFrame(step);
  }
  $('bench-slider').addEventListener('click', () => runBench('slider'));
  $('bench-orbit').addEventListener('click', () => runBench('orbit'));

  // ------------------------------------------------------------------ solver
  async function refreshSettings(s) {
    s = s || await api.getSettings();
    $('py-path').textContent = s.python ? `${s.python} (${s.pythonVersion})` : 'not set – press Detect or Browse';
    $('solver-path').textContent = s.solverPath || '';
    $('solver-path').title = s.solverPath || '';
    window.__settings = s;
    updateRunButtons();
  }
  function updateRunButtons() {
    const s = window.__settings || {};
    $('btn-run').disabled = running || !data || !s.python;
    $('btn-cancel').disabled = !running;
  }

  $('btn-detect').addEventListener('click', async () => {
    const r = await api.detectPython();
    await refreshSettings(r);
    if (!r.python) showError(`No Python 3.9+ found. Tried: ${r.tried.join('; ')}. Use Browse… to pick python.exe.`);
    else showError('');
  });
  $('btn-browse-py').addEventListener('click', async () => {
    const r = await api.browsePython();
    if (r.error) showError(r.error); else showError('');
    await refreshSettings(r);
  });
  $('btn-browse-solver').addEventListener('click', async () => refreshSettings(await api.browseSolver()));

  function setState(text, cls) { const s = $('run-state'); s.textContent = text; s.className = `state ${cls || ''}`; }
  function setProgress(p) { $('progress').value = p; $('progress-text').textContent = `${p.toFixed(1)} %`; }

  $('btn-run').addEventListener('click', async () => {
    const fa = $('fail-at').value.trim();
    log.clear();
    $('run-result').hidden = true;
    setProgress(0);
    running = true; updateRunButtons();
    setState('starting…', 'running');
    try {
      await api.runSolver(fa === '' ? null : fa);
    } catch (e) {
      running = false; updateRunButtons();
      setState('not started', 'failed');
      showError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  });
  $('btn-cancel').addEventListener('click', () => { $('btn-cancel').disabled = true; api.cancelSolver(); });

  api.onSolverEvent(ev => {
    if (ev.type === 'started') {
      setState(`running (pid ${ev.pid})`, 'running');
      log.append([{ s: 'o', t: `$ ${ev.argv.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}` }]);
    } else if (ev.type === 'lines') {
      log.append(ev.lines);
      setProgress(ev.progress);
    } else if (ev.type === 'cancelling') {
      setState('cancelling…', 'running');
    } else if (ev.type === 'end') {
      running = false; updateRunButtons();
      const box = $('run-result');
      box.replaceChildren();
      box.hidden = false;
      box.className = `run-result ${ev.state}`;
      if (ev.state === 'finished') {
        setState('finished', 'finished');
        box.append(el('b', '', 'Finished'), el('span', '', ` – exit code 0 after ${ev.seconds.toFixed(1)} s.`));
      } else if (ev.state === 'cancelled') {
        setState('cancelled', 'cancelled');
        box.append(el('b', '', 'Cancelled'), el('span', '', ` by the user after ${ev.seconds.toFixed(1)} s. The solver and its worker process were stopped.`));
      } else {
        setState(`failed (exit code ${ev.code === null ? '–' : ev.code})`, 'failed');
        box.append(el('b', '', `Failed – exit code ${ev.code === null ? 'none (could not start)' : ev.code}${ev.signal ? `, signal ${ev.signal}` : ''}.`));
        if (ev.lastErrors.length) {
          box.append(el('div', 'small', 'Last error output:'));
          box.append(el('pre', 'errlines', ev.lastErrors.join('\n')));
        }
      }
    }
  });

  refreshSettings().then(s => { if (!window.__settings.python) $('btn-detect').click(); });
})();
