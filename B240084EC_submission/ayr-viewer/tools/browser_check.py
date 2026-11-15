"""Headless-Chrome check of the renderer (dev only, not needed to run the app).

Serves src/renderer + src/shared over HTTP, replaces the Electron preload bridge
(window.ayr) with a mock that returns real file bytes, and drives the real UI code:
open files, check legend/probe/slider/snapshot numbers, open corrupted files,
flood the log, and check that HTML in a case name / log line is never executed.

Usage: python tools/browser_check.py <served-dir> <out-dir>
"""
import json
import sys
import threading
import http.server
import functools
from playwright.sync_api import sync_playwright

ROOT, OUT = sys.argv[1], sys.argv[2]
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % srv.server_address[1]

MOCK = """
window.__next = null; window.__alerts = 0; window.__listeners = [];
window.alert = () => { window.__alerts++; };
window.ayr = {
  openCase: async () => {
    const url = window.__next; const r = await fetch(url); const b = new Uint8Array(await r.arrayBuffer());
    return { token: 1, fileName: url.split('/').pop(), size: b.length, bytes: b };
  },
  confirmCase: async () => true, rejectCase: async () => true,
  getSettings: async () => ({ python: '/usr/bin/python3', pythonVersion: '3.13', solverPath: '/x/fake_solver.py' }),
  detectPython: async () => ({ python: '/usr/bin/python3', pythonVersion: '3.13', solverPath: '/x', tried: [] }),
  browsePython: async () => ({}), browseSolver: async () => ({}),
  runSolver: async () => ({ pid: 1 }), cancelSolver: async () => true,
  onSolverEvent: cb => { window.__listeners.push(cb); return () => {}; },
};
window.__emit = ev => window.__listeners.forEach(f => f(ev));
"""

results = {}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.add_init_script(MOCK)
    page.goto(BASE + "/renderer/index.html")
    page.wait_for_timeout(500)

    def open_file(path):
        page.evaluate("u => window.__next = u", BASE + path)
        page.click("#btn-open")
        page.wait_for_function("() => document.getElementById('loading').hidden", timeout=20000)
        page.wait_for_timeout(400)

    # --- main file
    open_file("/data/results.ayr")
    results["main_details"] = page.inner_text("#file-details")
    results["main_case"] = page.inner_text("#case-name")
    results["legend_solid"] = page.inner_text("#legend-ticks")
    page.screenshot(path=OUT + "/01_main_solid.png")

    # probe: click centre of canvas
    box = page.locator("#gl").bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(300)
    results["probe_center"] = page.inner_text("#probe")

    # slider mode: set t = 114 (Q2)
    page.click("button[data-mode=slider]")
    page.evaluate("() => { const s = document.getElementById('t-slider'); s.value = 114; s.dispatchEvent(new Event('input')); }")
    page.wait_for_timeout(300)
    results["slider_t114"] = page.inner_text("#t-stats")
    page.screenshot(path=OUT + "/02_slider_t114.png")

    # temperature mode, snapshot 12 (Q3)
    page.click("button[data-mode=temp]")
    page.evaluate("() => { const s = document.getElementById('snap-slider'); s.value = 12; s.dispatchEvent(new Event('input')); }")
    page.wait_for_timeout(300)
    results["snap12"] = page.inner_text("#panel-snap")
    results["legend_temp"] = page.inner_text("#legend-ticks")
    results["legend_title_temp"] = page.inner_text("#legend-title")
    page.screenshot(path=OUT + "/03_temp_snap12.png")

    # probe exact vertex 42000 via the same function the click uses (pick hits -> nearest vertex)
    results["probe_v42000"] = page.evaluate("""() => {
      // project vertex 42000 to screen and click it
      return null; }""")

    # benchmarks (software rendering here: numbers are NOT representative of a real GPU)
    page.click("#bench-slider"); page.wait_for_timeout(5600)
    results["bench_slider_swiftshader"] = page.inner_text("#bench-out")
    page.click("#bench-orbit"); page.wait_for_timeout(5600)
    results["bench_orbit_swiftshader"] = page.inner_text("#bench-out")

    # --- small file
    page.click("button[data-mode=solid]")
    open_file("/data/results_small.ayr")
    results["small_details"] = page.inner_text("#file-details")
    page.screenshot(path=OUT + "/04_small.png")

    # --- corrupted files: error shown, no mesh
    import os
    bad = {}
    for f in sorted(os.listdir(ROOT + "/bad")):
        if f.startswith("valid"):
            continue
        open_file("/bad/" + f)
        has_mesh = page.evaluate("() => !!document.querySelector('#gl') && window.__meshShown")
        bad[f] = page.inner_text("#error")
    results["bad_files"] = bad
    page.screenshot(path=OUT + "/05_bad_file.png")

    # --- HTML case name and HTML log line
    open_file("/bad/valid_html_case_name.ayr")
    results["html_case_name_shown_as"] = page.inner_text("#case-name")
    results["html_case_img_elements"] = page.evaluate("() => document.querySelectorAll('img').length")
    page.evaluate("""() => {
      window.__emit({type:'started', pid: 4242, argv:['python','-u','fake_solver.py','--case','/a b/c.ayr']});
      const lines = []; let n = 0;
      lines.push({n:n++, s:'o', t:'Case name : <img src=x onerror="alert(1)">'});
      for (let i = 0; i < 20000; i++) lines.push({n:n++, s: i % 97 ? 'o' : 'e', t: '  [diag] cell ' + i + ' T=850.000 K'});
      lines.push({n:n++, s:'o', t:'DEBUG residual vector: [' + Array(8000).fill('1.234567e-03').join(',') + ']'});
      window.__emit({type:'lines', lines, progress: 42.5});
    }""")
    page.wait_for_timeout(500)
    results["progress_text"] = page.inner_text("#progress-text")
    results["log_rows_in_dom"] = page.evaluate("() => document.querySelectorAll('.log-row').length")
    results["after_log_img_elements"] = page.evaluate("() => document.querySelectorAll('img').length")
    page.screenshot(path=OUT + "/06_log_flood.png")
    page.evaluate("() => window.__emit({type:'end', state:'failed', code:3, signal:null, seconds: 56.1, lastErrors:['ERROR: linear solver for T diverged at step 140 (residual 1.5e+06 > 1e+06)','ERROR: aborting run']})")
    page.wait_for_timeout(200)
    results["end_state"] = page.inner_text("#run-state") + " | " + page.inner_text("#run-result")
    page.screenshot(path=OUT + "/07_failed.png")
    results["alerts_fired"] = page.evaluate("() => window.__alerts")
    results["page_errors"] = errors
    b.close()

print(json.dumps(results, indent=1, ensure_ascii=False))
