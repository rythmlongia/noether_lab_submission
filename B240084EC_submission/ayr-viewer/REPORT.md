# REPORT — Noether Labs task round, Software Engineering Intern (Desktop)

Roll number B240084EC → **R = 84**.

> Every number below was produced by a check that was actually run; the raw outputs are in `verification/` (Linux / headless Chrome) and `verification/windows/` (the real Electron app on my Windows laptop).

How I worked: I used Claude (chat logs attached) to write most of the code. Because the AI could not install Electron in its sandbox, all logic was written so it can be tested without Electron: the parser and solver runner in plain Node, the page code in headless Chrome with a mocked preload bridge, and the main-process IPC code with a stubbed `electron` module.

Then, on my Windows laptop, a second AI session (Claude Code in the Claude desktop app; transcript attached) installed and started the real app. It ran the tests, fixed what broke, and upgraded Electron (see "Where the AI was wrong" 4–9). It drove the app through the Chrome DevTools Protocol, with only the native file dialog replaced by a stub (`tools/electron_check/app_check.mjs`). I reviewed the saved outputs, and the screen recording shows the same steps done by hand.

---

## Answers Q1–Q4 (results.ayr, R = 84)

How obtained: `node tools/answers.js results.ayr 84`, which imports **the app's parser** (`src/shared/ayr.js`). Cross-checked with an **independent implementation**, `tools/reference_reader.py` (numpy `>f4/>u4/>f2` dtypes + `zlib.crc32`, no shared code). Both outputs are saved in `verification/answers_js_parser.txt` and `verification/answers_python_reference.txt`; they agree on every value. Both were re-run on Windows with identical output (`verification/windows/answers_*.txt`). Q2 and Q3 are also shown live by the app. In Solid-at-time-t mode at t = 114 it shows "36,222 of 102,749 computed vertices". In Temperature mode, snapshot 12 is at t = 50.00 s. Screenshots: `verification/windows/screenshots/results_slider_t114.png` and `results_temp_snap12.png` (real Electron app), and `verification/screenshots/02_slider_t114.png` (headless Chrome).

| | Answer | How obtained |
|---|---|---|
| **Q1** | P(84) = (0.0008, 0.0345, 0.0163) **m** = (0.8, 34.5, 16.3) mm. Nearest vertex **53699** at (1.2000, 34.4717, 16.3371) mm, distance **0.403 mm**, solidification time **5.20 s**. (2nd nearest vertex is 0.691 mm away, so no tie.) | Script with the app's parser (`tools/answers.js`), brute-force distance over all vertices in mm. Cross-checked with the numpy reader: same index, 0.402713 mm, 5.199016 s. |
| **Q2** | t = 30 + 84 = **114 s**. Not yet fully solid (`solid_time > 114`, NaN excluded): **36222**; computed vertices: **102749**; fraction **0.3525** | Script with the app's parser; numpy reader gives the same counts. Also shown live in the app (Solid-at-time-t, t = 114). No value equals 114 exactly and none is ±∞, so `>` vs `≥` does not matter. |
| **Q3** | v = 500·84 = **42000**, s = 84 mod 24 = **12**. Snapshot time **50 s**, stored temperature **881.0 K** = **607.85 °C** | Script with the app's parser (snapshot-major index s·n_vert + v); numpy reader (`temp[s, v]`) agrees. Snapshot 12 shows t = 50.00 s in the app. |
| **Q4** | n_vert **104778**, n_tri **209568**, n_snap **24**, case name **"FH-203 housing"**, bounding box x **−60.000 … 60.500**, y **−40.000 … 40.000**, z **0.000 … 45.000** mm, stored CRC **E5F14D4A**, computed CRC E5F14D4A → **matches** | Script with the app's parser; numpy reader + `zlib.crc32` agree. The app's File panel shows the same values. The name bytes are pure ASCII (14 bytes, H = 33). |

Things in this file that the "obvious" reader gets wrong: `results.ayr` is **big-endian** (flags = 0x01) while `results_small.ayr` is little-endian; the header is 33 bytes so every section starts at an offset that is **not a multiple of 4**; the positions are in **mm** but P(R) is given in **metres**; 2029 solidification times are NaN.

---

## Task 1 — Results viewer

### What I did
* Electron app, no UI framework: plain DOM + **raw WebGL2** (one shader pair). Reason: the scene is one mesh with four vertex attributes, and keeping the only dependency Electron meant the whole renderer could be tested in headless Chrome. I can explain every line of it, which I could not claim for three.js internals.
* **Parsing off the UI thread** — data path and copies:
  1. Main process: `dialog.showOpenDialog` → `fs.promises.readFile` (async, main event loop stays free).
  2. `ipcMain.handle('case:open')` returns the bytes as a `Uint8Array`. Electron serialises it (structured clone) into the renderer process: **copy 1** (unavoidable between processes).
  3. Renderer posts the bytes to a **Web Worker** with the buffer in the **transfer list**: no copy, ownership moves.
  4. Worker validates and decodes into new typed arrays (`Float32Array`, `Uint32Array`, f16→`Float32Array`): **copy 2**, necessary because of byte order, unaligned offsets and f16 conversion. It also builds centred mm positions and vertex normals.
  5. Worker posts the result arrays back with their buffers in the **transfer list**: no copy.
  6. `gl.bufferData` uploads to the GPU: **copy 3** (driver).
  After step 4 the original file buffer is garbage. Measured: 9.2 MB file, worker parse 61 ms, whole open 94 ms (headless Chrome, `verification/browser_check.json`). In the Electron app on Windows: whole open 148–473 ms, worker parse 87–228 ms (range over several opens, as shown in the File panel; I did not investigate why one open was slower).
* **Validation** (FORMAT §4, in order) in `src/shared/ayr.js`: length ≥ 23 and magic; reserved flag bits, version, units; exact file size (truncation and trailing bytes); CRC-32; triangle index < n_vert; strictly increasing times (written as `!(t[i] > t[i-1])` so NaN times are rejected too). Also n_snap ≥ 1 (FORMAT §2). Each failure throws an `AyrError` with a message that says what is wrong, e.g. *"File size is wrong: the header (…) requires exactly 40514 bytes, but the file has 40513 bytes. The file is truncated or its header is corrupted."* On error the app clears the mesh (also a previously shown one) and shows the message; the solver cannot be run on a rejected file.
* **All reads use `DataView` with explicit endianness**, including header fields after `flags` and the CRC footer. I never create a typed-array view on the file buffer (unaligned offset → `RangeError`, and wrong byte order on BE files).
* **f16**: a 65 536-entry lookup table built from the FORMAT §5 formula (subnormals, ±0, ±∞, NaN).
* **Rendering**: camera frames the bounding sphere of the part (distance = r / sin(fov/2), fov taken on the narrower axis). Orbit / pan / zoom; +z up.
* **Colour**: viridis (256-entry table generated from matplotlib) in a lookup texture. **NaN never goes to the GPU**: each scalar is uploaded as a (value, valid) pair with NaN → (0, 0); the shader paints any fragment with valid < 1 grey. Reason: `isnan()` in GLSL is not reliable across drivers, and a NaN at one vertex would be interpolated across the whole triangle. Legend with numbers and units, and a grey swatch explaining "not computed".
* **Time slider**: only changes one uniform → no buffer work while dragging. Red = `solid_time > t` (not yet fully solid), already-solid regions are shown in faded viridis, grey = not computed. The panel shows the count and fraction of not-yet-solid computed vertices (same rule as Q2).
* **Temperature mode**: one global min/max over all snapshots (37.10 … 699.85 °C for results.ayr) so snapshots are comparable; °C in the legend; snapshot slider + Prev/Next showing the snapshot time. Changing snapshot uploads one attribute (`bufferSubData`, 0.8 MB).
* **Probe**: ray through the click (Möller–Trumbore over all triangles, ~10 ms for 210 k triangles), then nearest vertex to the hit point. Shows index, position in mm (from the file positions × unit factor), solidification time (s, or "not computed"), temperature at the current snapshot (°C and K).

### How I checked it
* **FORMAT.md §6.1 self-check values** all reproduced by the parser (test `results_small.ayr matches FORMAT.md section 6.1`): size 40514, H = 30, counts, units, times, vertex 0 position, first triangle (2,1,0), solid_time[0] = 45.021484375, NaN at vertices 18–25, min/max 14.668059 / 96.419121, vertex-0 temperatures 973 … 644.5 K, CRC 0C736579.
* **Independent reader** (numpy) agrees on header, bbox, NaN count (2029), solid-time range, temperature range (310.25 … 973 K), CRC, and Q1–Q3.
* **Probe** checked against the numpy reader: clicking the canvas centre picked vertex 66946; app showed (13.805, −17.128, 36.137) mm, 168.89 s, 699.85 °C @ snapshot 0 and 604.85 °C (878 K) @ snapshot 12; numpy gives (13.8053, −17.1283, 36.1371), 168.8908 s, 973.0 K, 878.0 K.
* **Corrupted files**: `tools/make_broken_files.js` writes 12 bad files (truncated by 1 byte / half / to 10 bytes, a flipped byte in positions and in temperatures, bad magic, reserved flag bit, bad units, an extra trailing byte, triangle index out of range, equal times, version 2 — the last three with a *correct* CRC, so they test the other rules, not just the CRC). Each gives its specific message in the real page code and no mesh (`verification/browser_check.json`, screenshot `05_bad_file.png`).
* **UI** driven in headless Chrome with only the Electron bridge mocked (`tools/browser_check.py`): screenshots of every mode in `verification/screenshots/`.
* **In the Electron app on Windows** (`verification/windows/app_check.txt`, screenshots in `verification/windows/screenshots/`):
  * Both files open and are framed. The File panel shows the FORMAT §6.1 values for `results_small.ayr` and the Q4 values for `results.ayr`.
  * All 12 broken files give their specific message, show no mesh, and leave Run disabled.
  * The page reported 0 exceptions during the whole check.
* **Probe vs. independent reader, in the real app**: 18 clicks over a grid of points on the part (9 per file, snapshot 3). Each one is compared with the numpy reader at the precision the app shows: index, position (0.001 mm), solidification time (0.01 s), °C and K (0.01). There were **0 mismatches** (`verification/windows/probe_vs_numpy.txt`).
* **Unusual valid files** (`verification/windows/edge_cases.txt`): positions in metres (both byte orders), one snapshot, no triangles, one vertex, zero vertices, an empty name, constant values, and all-NaN. All open without an exception. The all-NaN and zero-vertex files showed "NaN"/"Infinity" in the legend and panel; this is now fixed (see "Where the AI was wrong" 6).

### Frame times
Method: the **Frame-time benchmark** panel. "Drag time slider" moves the slider over its whole range and back for 5 s through the same code as a real input event (uniform update + vertex count), "Orbit" turns the camera 360° in 5 s. Each frame records the `requestAnimationFrame` timestamp and the CPU time of the draw call. Reported: mean / median / p95 / max frame interval. Note the interval cannot go below the display refresh (16.7 ms at 60 Hz) because `requestAnimationFrame` is v-synced.

Machine: ASUS VivoBook X515EA, Intel Core i5-1135G7, **Intel Iris Xe (integrated GPU)**, 7.7 GB RAM, 1920×1080 display at **60 Hz**, Windows scaling 125 %. Window 1400×900, canvas 1283×568 device pixels. Electron 45.3.2, window in front. Three 5-second runs of each benchmark; raw output, including the earlier runs on Electron 38.8.6 (very similar), is in `verification/windows/frame_times.txt`.

| results.ayr (104,778 vertices) | mean | median | p95 | max | draw CPU (median) |
|---|---|---|---|---|---|
| (a) time slider, 3 runs | 16.65–16.78 ms (≈60 fps) | 16.70 ms | 17.2–17.3 ms | 17.8–54.4 ms | 0.2 ms |
| (b) orbit, 3 runs | 16.66–16.67 ms (60.0 fps) | 16.70 ms | 16.8–17.1 ms | 17.0–17.3 ms | 0.1 ms |

So both are locked to the 60 Hz refresh. There was one 54.4 ms outlier in about 1,800 frames. One attempt at run 3 did not finish at all, because `requestAnimationFrame` stops while the window is hidden. I think another window covered it, which may also explain the outlier, but I did not confirm this. The run was repeated.

Because v-sync hides the headroom, I also started the app with `--disable-gpu-vsync --disable-frame-rate-limit`, so the interval shows what one frame really costs:

| uncapped, 2 runs | mean | median | p95 | max |
|---|---|---|---|---|
| (a) time slider | 4.00–4.18 ms | 4.0–4.1 ms | 5.0–5.1 ms | 7.2–8.5 ms |
| (b) orbit | 1.94–1.96 ms | 1.7–1.8 ms | 3.2–3.8 ms | 7.6–12.6 ms |

Orbit costs about 2 ms per frame on the integrated GPU. A slider frame costs more, about 4 ms, because each step also runs the not-yet-solid count over all vertices on the CPU and updates the text; on the GPU it is only a uniform change. Both are 4–8× below the 16.7 ms budget.

The benchmarks were started over the DevTools protocol by clicking the panel's own buttons, so they run the same code as a manual click.

For reference only: in the AI's sandbox (headless Chrome, **software rendering** via SwiftShader on 2 Xeon cores, no GPU) both benchmarks gave ~160 ms per frame. That number measures a CPU rasteriser and says nothing about the app on a real GPU; the draw call's own CPU time was 0.1 ms median, i.e. the JavaScript side is negligible and the cost is all GPU fill/vertex work. The count loop run on each slider event costs 0.3 ms (measured in Node).

### With more time
Spatial index (BVH) for picking; screen-space contour line at `solid_time = t`; legend tick placement for narrow ranges; an Electron end-to-end test with Playwright's `_electron` launcher.

---

## Task 2 — Solver runner

### What I did (`src/main/solverRunner.js`)
* `spawn(python, ['-u', fake_solver.py, '--case', path, '--steps', '200', ('--fail-at', N)])` with **no shell** (argument array → spaces, `&`, quotes in the path are safe), `cwd` = case folder, env `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8`.
* **Why `-u`**: Python block-buffers stdout when it is a pipe (not a terminal), so without it the PROGRESS lines arrive in 8 KB chunks, i.e. the bar would jump late. Demonstrated in `verification/naive_runner_demo.txt`: without `-u` *nothing* arrived in the first 3 s.
* **Why `PYTHONIOENCODING`**: on Windows a piped Python uses the ANSI code page for stdout; a case name outside it (e.g. CJK) would crash the solver's `print`. We decode as UTF-8 with `StringDecoder`, so a character split across two chunks is not broken.
* **Line handling**: `LineSplitter` keeps the partial last line between chunks, strips `\r` (Windows `\r\n`), flushes the remainder at exit. Every line gets a sequence number at receipt; stdout and stderr are tagged.
* **Batching**: lines are collected and sent to the renderer every 50 ms (or at 5000 lines), so a burst of 4000 lines becomes one or two IPC messages; the progress value travels with each batch.
* **Log pane** (`logview.js`): virtualised — only the ~30 visible rows exist in the DOM, so 20 000 lines cost the same as 30. stderr rows are red **and** tagged `ERR` (not colour only), stdout `OUT`. Long lines (the 8000-number DEBUG lines, ~100 KB) are kept complete on one row with horizontal scrolling. Auto-follows the end unless you scroll up. Limit: last 200 000 lines (a full run prints ~16 000); if exceeded the pane says how many were dropped.
* **Cancel**: the solver starts a **worker subprocess** (`fake_solver.py --_worker`), and the worker keeps computing even after its stdout breaks. Killing only the controller leaves it running — demonstrated in `verification/naive_runner_demo.txt` (`child.kill()` → the `--_worker` process is still there 1 s later). So:
  * Linux/macOS: the solver is spawned `detached` (own process group, pgid = pid). Cancel sends SIGTERM to the **group** (`process.kill(-pid)`), waits up to 2 s, then SIGKILL, then waits until no **non-zombie** process of the group remains (checked with `ps -A -o pid=,pgid=,stat=`).
  * Windows: `taskkill /PID <pid> /T /F` kills the whole tree.
  * Then the stale `.solver_heartbeat` is removed (the worker only removes it when it exits normally).
  * The "cancelled" state is shown only after this has finished, and is decided by a flag set before killing — so a cancelled run shows "cancelled", never "failed" (the kill gives a non-zero code).
  * End is reported on the child's `close` event (process exited **and** all its stdio pipes closed). The worker inherits our stderr pipe, so `close` also cannot fire while the worker is alive.
* **End states**: finished (exit 0) / failed (exit code + last stderr lines) / cancelled. A Python that cannot be started is reported as failed with the reason, not a crash.
* **Python**: auto-detected (`py -3`, `python`, `python3` on Windows); each candidate prints its own `sys.executable`, which is stored and used directly (avoids the Windows Store `python` alias). Or Browse… for `python.exe`.
* **Text**: every log line is inserted with `textContent`.

### How I checked it
`tests/runner.test.js`, real runs of the provided `fake_solver.py` (shortened with `--step-time`), on Linux, with `PYTHONUNBUFFERED` explicitly removed from the environment:
* full run → `finished`, exit 0; path with spaces and `&`; case name `<img src=x onerror="alert(1)">` arrives verbatim; > 20 distinct progress values seen during the run (live, not only at the end); both DEBUG lines complete (exactly 8000 comma-separated values, ending in `]`); number of `[diag]` lines equals the counts the solver announces; sequence numbers contiguous.
* `--fail-at 70` → `failed`, exit 3, last lines are the two ERROR lines.
* invalid case file → exit 2 with "bad magic"; non-existent Python → failed, no crash.
* **Cancel ×3**: before cancel the controller and worker are both in `ps`; after cancel no `fake_solver.py` process in `ps` (zombies excluded), no live member of the process group, and again 1.5 s later; heartbeat file gone.
* Log flood in the real page code: 20 000 lines + a 100 KB line in one batch → only 20 row elements in the DOM, progress 42.5 % shown, no `<img>` created, no alert (`browser_check.json`, `06_log_flood.png`).
* **Windows, in the real app** (`verification/windows/app_check.txt`). The case was in `C:\Users\rythm\Desktop\claude work\…`, a path with a space.
  * Full run: "finished", exit 0. The progress bar took 201 distinct values while the script polled it during the run.
  * `--fail-at 70`: "failed (exit code 3)" with the last error lines, ending in `ERROR: aborting run`.
  * **Cancel ×3**: python processes running `fake_solver.py`, counted with `Get-CimInstance Win32_Process` (the list Task Manager → Details shows): **2 before Cancel (controller + worker), 0 right after, 0 again 5 s later**, in all three cycles. The `.solver_heartbeat` file was removed each time. The screen recording shows the same with Task Manager.
  * `npm test` passes on Windows (33/33, 0 skipped, `verification/windows/test_output.txt`). Its Cancel test uses the same PowerShell process list.
* **More Windows checks in the real app** (`verification/windows/solver_checks.txt`, `tools/electron_check/solver_checks.mjs`):
  * **Responsive during the burst.** From 15 s to 26 s into a run, the window covering the 3,000–4,000-line diagnostics burst at 25 %, the camera orbited and the log was scrolled every 200 ms. Result: 667 frames, frame interval median 16.7 ms, max **17.0 ms**, none over 50 ms. Only 20 log rows existed in the DOM. Cancel then answered in 444 ms.
  * **Failed runs leave nothing behind.** After `--fail-at 5` and `--fail-at 30`: 0 solver processes, no `.solver_heartbeat` and no `.solver_heartbeat.tmp`.
  * **Closing the window during a run** stops the solver too: 2 processes before, 0 after (`before-quit` cancels the run first).
  * **Non-ASCII case name on Windows** (`verification/windows/unicode_case_name.txt`): the name `鋳造ハウジング Gehäuse – Ø40` arrives exactly. The same command spawned without `PYTHONIOENCODING` crashes the solver with `UnicodeEncodeError: 'charmap' codec …`, exit 1, because a piped Python on Windows writes in cp1252. This is now also a test in `tests/runner.test.js`.
  * The log pane states its limit ("Log keeps the last 200,000 lines") from the start, not only once the limit is reached.

### With more time
Save the full log to a file; heartbeat-based "solver looks stuck" warning; Windows Job Object instead of `taskkill` (guarantees children die even if the app crashes).

---

## Task 3a — Security

**BrowserWindow** (`src/main/main.js`):

| Setting | What it allows / prevents |
|---|---|
| `contextIsolation: true` | Page JS and preload JS run in separate JavaScript worlds; the page cannot reach `require`, `ipcRenderer` or tamper with preload objects/prototypes. |
| `sandbox: true` | Renderer is an OS-sandboxed Chromium process with no Node. Even code execution in the page cannot touch files or start processes. |
| `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `nodeIntegrationInSubFrames: false` | No Node APIs in the page, its Web Worker or frames, so an XSS is not remote code execution. |
| `webSecurity: true`, `allowRunningInsecureContent: false` | Same-origin policy stays on; no http content in the secure page. |
| `webviewTag: false` | No `<webview>`, which could load remote content with its own preferences. |
| `devTools: true` | Left on for grading (Ctrl+Shift+I / F12). DevTools only gives what the page already has (`window.ayr`). For a release I would disable it. |
| `setWindowOpenHandler → deny`, `will-navigate` blocks anything not `app://ayr/` | Injected links / `window.open` cannot open or navigate to attacker pages. |
| Permission request/check handlers → deny all | No camera, notifications, etc. |
| UI served from `app://ayr/` (`protocol.handle`) with a path guard | Only files under `src/` are served (`..` → 403/404, tested); not `file://`, so the page cannot read arbitrary local files. |
| CSP (meta tag **and** response header): `default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'` | No inline scripts, no `eval`, no remote scripts or connections. An injected `<img onerror=…>` would be blocked even if it reached the DOM. |

**Preload** (`src/main/preload.js`) exposes `window.ayr` with exactly these functions, each mapped to one IPC channel:

| Function → channel | What it allows | Why it is safe |
|---|---|---|
| `openCase()` → `case:open` | Main shows the open dialog and returns the chosen file's bytes + a token | The **user** picks the file; the page cannot name a path. |
| `confirmCase(token)` → `case:confirm` | Marks the opened file as validated so it can be run | Token must match the last opened file. |
| `rejectCase(token)` → `case:reject` | Marks it invalid | — |
| `getSettings()` → `settings:get` | Python path/version, solver path | Read only. |
| `detectPython()` → `python:detect` | Main probes fixed candidates (`py -3`, `python`, `python3`) | The page cannot supply a command. |
| `browsePython()` → `python:browse` | User picks an executable in a dialog; it must answer as Python ≥ 3.9 | The page cannot supply a path. |
| `browseSolver()` → `solver:browse` | User picks the solver script in a dialog | Same. |
| `runSolver(failAt)` → `solver:run` | Runs the stored Python on the stored solver with the **validated** case | The only page input is `failAt`, checked to be a number 0–100. No shell is used. |
| `cancelSolver()` → `solver:cancel` | Stops the current run | — |
| `onSolverEvent(cb)` ← `solver:event` | Receives started / lines / end events | The callback gets only the data, never the `IpcRendererEvent` (which would leak `ipcRenderer` via `event.sender`). Returns an unsubscribe function. |

Every `ipcMain.handle` checks that the sender is our window and its frame URL is `app://ayr/…` (tested: another origin is refused). `tests/main.test.js` also asserts the window settings and that these nine channels are the complete list.

**Electron version.** These settings only help if Electron itself is patched. The project first used `^38.2.0`, which resolved to 38.8.6. That line is end of life, and `npm audit` reports high-severity advisories that are fixed only in ≥ 42.11.16. Two of them concern features this app uses: GHSA-v3j7-r9gq-3gjw (a custom protocol with `supportFetchAPI` but without `corsEnabled` allows cross-origin reads, which is how `app://` is registered) and GHSA-h7rp-cf8h-j98x (a context-isolation bypass). I upgraded to **45.3.2**, the current stable release; `npm audit` now reports 0 vulnerabilities. No code change was needed. After the upgrade, `npm test` and the whole Windows end-to-end check were run again with identical results (`verification/windows/`). I did not check whether 38.8.6 is actually exploitable through these two advisories in this app; I upgraded rather than argue it.

**`<img src=x onerror="alert(1)">` as case name or log line:** nothing executes; it is shown as the literal text. Every place that shows file or solver text uses `textContent` (case name in the toolbar and File panel, log rows, error lines, probe); the code never uses `innerHTML`. Even if it did, the CSP blocks the inline handler. Demonstrated: `tools/make_broken_files.js` writes `valid_html_case_name.ayr`; in the real page code the name appears as text, `document.querySelectorAll('img').length` is 0 and the alert counter stays 0 — for the case name and for the same string as a log line (`verification/browser_check.json`, screenshot `06_log_flood.png`). The runner test shows the solver prints it verbatim, so the log path is exercised with real solver output. The same was done in the real Electron app on Windows:
* `valid_html_case_name.ayr` opened with the name shown literally in the toolbar and File panel, and 0 `<img>` elements in the page.
* A full solver run on that file printed the string in the log as text, and `alert()` was called 0 times (`verification/windows/app_check.txt`).
* Page code in the Windows app (`verification/windows/security_check.txt`):
  * It can reach only `window.ayr` (10 functions, frozen by `contextBridge`). `require`, `process`, `ipcRenderer`, `module` and `Buffer` are undefined, and `fetch('file:///…')` fails.
  * An injected inline `<script>`, an `<img onerror>` and a string `setTimeout` (= eval) were all blocked. Each was reported twice, by the `<meta>` CSP and by the response-header CSP.
  * Note for graders: `eval('1')` typed **into the DevTools console** does run. Chromium exempts code entered through DevTools from the page CSP. That is a DevTools privilege, not something page scripts or injected markup can use.

### 3a — With more time
Turn DevTools off in packaged builds; package with Electron Fuses (disable `RunAsNode`, enable ASAR integrity); add an automated check in CI that fails on `npm audit` high findings; set `corsEnabled` explicitly on the `app://` scheme even though Electron 45 fixes the advisory.

## Task 3b — Parser tests

`npm test` (Node built-in runner). `tests/ayrWriter.js` builds the files: written straight from FORMAT §2–3 with Node `Buffer` methods; temperatures are written as **raw f16 bit patterns** (no f16 encoder involved), the CRC comes from Node's `zlib.crc32` (zlib's C code; bit-by-bit fallback), not from the parser's table-driven CRC.

| Required case | Test | Source of expected values |
|---|---|---|
| big- and little-endian | `big/little-endian file decodes to the values written`, `header fields after flags really use the file byte order` (n_vert = 300 so both bytes matter) | values written by the test |
| header length not a multiple of 4 | `header lengths that put sections at offsets…` (names of 0–4 bytes and an 8-byte UTF-8 name → H = 19…27, both byte orders); also a `Uint8Array` that does not start at byte 0 of its buffer | values written |
| NaN solidification times, min/max and colour | `NaN solidification times…`: four different NaN bit patterns (quiet, negative, signalling, payload); min/max = 5/40 over the finite ones; colour of NaN = grey, ends = first/last viridis entries; GPU attribute has valid = 0 and no NaN; `all-NaN array gives NaN range` | IEEE 754 (exponent all ones, fraction ≠ 0), confirmed with Python `struct.unpack('<f')`; viridis ends from matplotlib |
| truncated / one corrupted byte | `truncated files…` (−1 byte, cut at 60 and at 22 bytes, empty, +1 byte); `a single corrupted byte…` (one byte flipped in each section + in the stored CRC); `a corrupted count in the header…` | FORMAT §4 rules 1, 3, 4 |
| f16: +0, −0, smallest subnormal, largest subnormal, smallest normal, largest finite, +∞, −∞, NaN | `f16ToNumber: special and boundary values` + the same through the lookup table + the same bit patterns decoded **from a file** in both byte orders | IEEE 754 binary16 worked by hand: 2⁻²⁴ = 5.960464477539063e-8, (1023/1024)·2⁻¹⁴ = 6.097555160522461e-5, 2⁻¹⁴ = 6.103515625e-5, 65504; checked against Python `struct.unpack('<e')`; FORMAT §5 vectors (3C00, C000, 7BFF, 7C00, 7E00, 5A80). `Object.is` is used so −0 ≠ +0 and NaN = NaN. |
| other §4 rules | magic, reserved flag bits, version (incl. 1 written in the wrong byte order = 256), units, index n_vert−1 accepted / n_vert rejected, equal / decreasing / NaN times, n_snap = 0 | FORMAT §4 |
| CRC | check value `123456789` → CBF43926, agreement with bitwise CRC | FORMAT §3.6 |
| real file | `results_small.ayr matches FORMAT.md section 6.1` | FORMAT §6.1 table |

**Do the tests catch bugs?** `npm run mutation` makes 19 deliberate single bugs in a copy of the parser (ignore/invert byte order, f16 bias, subnormal formula, implicit 1 on subnormals, ∞/NaN swap, sign, CRC init / range / removed, header off by one, `>` instead of `>=` for indices, equal times allowed, size check removed, unit scale, section offset, vertex-major temperature indexing, NaN as 0 in min/max, reserved flags unchecked). **19/19 are caught** (`verification/mutation_output.txt`).

### 3b — With more time
Property-based tests (random valid files from the writer, round-tripped through the parser), a fuzz run that flips random bytes and checks that the parser either rejects the file or returns arrays of the declared size, and a test for invalid UTF-8 in the case name.

## Task 3c — Design note: 20 GB, 30 M vertices, 300 snapshots

Sizes (FORMAT §3, n_tri ≈ 2·n_vert = 60 M for a closed surface): positions 12·30 M = 0.36 GB, triangles 12·60 M = 0.72 GB, solid_time 0.12 GB, temperatures 2·300·30 M = **18 GB**; total 19.2 GB ≈ the file. **94 % is temperatures, and a view needs only one snapshot (60 MB).**

**Reading breaks first.** `fs.readFile` refuses files over 2 GiB (`ERR_FS_FILE_TOO_LARGE`, confirmed on Windows), so the app fails at "Open". Without that limit: 20 GB takes ~10 s from a fast SSD, ~100 s at 200 MB/s; the IPC structured clone would copy 20 GB into the renderer, and the worker's f16→f32 temperature array alone is **36 GB**, on laptops with 8–32 GB RAM.
**Change:** never load the whole file. The main process (or a utility process) reads **byte ranges** with `fs.read` (every offset follows from the header): header + positions + triangles + solid_time (1.2 GB), plus **one snapshot on demand** (60 MB, contiguous because the layout is snapshot-major). Keep temperatures f16 end to end (`HALF_FLOAT` attributes). Hand data over by range requests or a `SharedArrayBuffer`, not one giant IPC copy.

**Memory in the renderer.** The mesh alone as typed arrays (positions, normals, indices, scalars) is ~2 GB, near Chromium's per-renderer limits, and briefly doubled during upload. **Change:** build GPU buffers in chunks (e.g. 1 M vertices) and free the CPU copies after upload; picking moves to a worker with a BVH over chunk bounds.

**GPU memory and frame rate.** My layout is 40 B per vertex (position 12, normal 12, two value/valid pairs 16) → 1.2 GB, plus 0.72 GB of 32-bit indices = **1.92 GB**, more than a 2–4 GB laptop GPU can spare. At an assumed 1–2 G triangles/s (estimate, not measured) 60 M triangles take 30–60 ms per frame (17–33 fps at best, integrated GPUs far worse). **Change:** level of detail. Precompute a decimated mesh of ~1–2 M triangles for interaction plus octree **tiles** of the full mesh, streamed in when zoomed and frustum-culled; quantise positions to u16 per tile, normals to 4 B (octahedral), scalars to f16 → 14 B/vertex. Only visible tiles live on the GPU. The time slider stays a uniform, cheap at any size.

**Validating integrity.** One CRC over 20 GB means reading everything before showing anything: ~57 s at the 0.35 GB/s my JS CRC reaches on my laptop (26 ms for 9.2 MB), ~7 s with native `zlib.crc32` (measured 2.9 GB/s), where the 10–100 s disk read is the real limit. **Change (format v2):** a header plus a **chunk table** at the start (offset, length and CRC-32 or xxHash per e.g. 64 MB chunk, plus per-snapshot min/max so the colour scale needs no full scan), data chunks aligned to 4096 B for direct typed-array/mmap access. Verify the table first, each chunk when first read (mesh before display, a snapshot when selected), the rest in a background worker with progress. A corrupted chunk is reported with its location instead of rejecting the file after a minute.

*(Outside the one-page note.)* **How I checked:** every size above is re-derived from FORMAT §3. The 2 GiB `readFile` limit and both CRC speeds were measured on my laptop. The triangle throughput is an assumption and is marked as one. **With more time:** prototype the range reader and one-snapshot loading on a synthetic 3 GB file to measure real load times.

---

## Where the AI was wrong (and how I found out)

1. **It "verified" the stdout buffering problem away — wrongly.** To show why `-u` is needed, the AI ran the naive spawn (no `-u`) and progress lines arrived live, so it looked as if buffering was not an issue. The result did not fit what Python is documented to do, so we checked the environment: the AI's sandbox has `PYTHONUNBUFFERED=1` set globally, which hid the bug. Rerun with the variable removed: no output at all in the first 3 s. Since then the runner tests run with `PYTHONUNBUFFERED` removed, and the fix (`-u` + env) is tested under realistic conditions. Lesson: a passing check proves nothing until you know its environment matches the user's.
2. **Its first Cancel check treated zombie processes as running.** The first version checked "is the process group gone?" with `process.kill(-pgid, 0)`. The cancel test failed: `ps` showed the worker in state `Z` (exited, never reaped, because PID 1 in that container does not reap orphans). `kill(…, 0)` succeeds for zombies, so Cancel waited for its timeouts and the "cancelled" event came before cleanup finished. Fixed: liveness = a group member whose `ps` state is not `Z`, and the "cancelled" state is reported only after cleanup completes. The test now checks `ps` right after Cancel and again 1.5 s later, three times.
3. **Main-process code that would have failed without anyone noticing.** The stubbed-Electron test (`tests/main.test.js`) found three bugs in the AI's `main.js`: (a) the IPC sender check compared `new URL(url).origin === 'app://ayr'`, but WHATWG `URL` returns `"null"` as origin for a non-special scheme in Node — I am not sure what Electron returns for a registered standard scheme, so the check now compares protocol and host, which is correct in both; (b) the wrapper threw synchronously instead of returning a rejected promise; (c) a request for a missing file under `app://` threw instead of answering 404.
4. **The DevTools shortcut toggled twice per key press, so DevTools could never be closed.** The AI's `main.js` called `toggleDevTools()` from `before-input-event` without checking the event type. Electron fires that event for **keyDown and keyUp**.
   * Opening worked only by luck: on keyUp DevTools was still opening, so the second toggle was another "open".
   * Closing failed: keyDown closed DevTools and keyUp reopened it.

   *Found:* on Windows, with the main process's inspector, `toggleDevTools` was wrapped to log its calls. One F12 press logged a toggle on `keyDown:F12` and another on `keyUp:F12`, and a second press left DevTools open.
   *Fix:* `if (input.type !== 'keyDown') return;`
   *Why the tests missed it:* the stubbed `electron` in `tests/main.test.js` had `webContents.on() {}`, which simply dropped the handler. The stub now records handlers, and a new test sends keyDown+keyUp and expects exactly one toggle. It fails on the old code (expected 1, actual 2) and passes now.
   *Lesson:* a stub only tests what it records.
5. **The frame-time meter showed stale numbers.** After `results.ayr` was opened, the top-right meter kept saying "243.7 ms/frame (4 fps)" while the app was idle. That number was just the gap between the few redraws during loading, and it could easily have gone into the table above.
   *Cause:* frames older than 1 s were only removed in `onFrame`, which runs only when a frame is drawn. With no new frames the 500 ms timer kept reporting the last burst, although the README says the figure shows the last second.
   *Fix:* the timer also drops frames older than 1 s. Checked live: the meter returns to "idle" about 1 s after the last frame.
   It went unnoticed in headless Chrome because the benchmark loops there drew continuously.
   A similar stale display: the benchmark panel kept showing a previous file's result, e.g. "Orbit 360° … 104,778 vertices" with a 4-vertex file open. It is now cleared whenever a file is opened.
6. **Valid but degenerate files showed "NaN" and "Infinity".** The parser accepts a valid file in which every solidification time is NaN, or which has no vertices (FORMAT §4 does not forbid either). The page then printed the legend as "NaNNaN" off the left edge, "0 of 0 (NaN %)", a slider with `max = NaN`, and a bounding box of "Infinity … -Infinity". There was no crash, but it looked broken.
   *Found:* by opening hand-made edge-case files in the real app (`verification/windows/edge_cases.txt`).
   *Fix:* only in `app.js`; the parser is unchanged. The legend says "no computed values (all grey)", the stats line explains, the slider range falls back to 0, and the bounding box shows "none (no vertices)". In the same pass, legend ticks now keep 12 % (was 8 %) away from the end labels, because "600" overlapped "699.9" on a small file. The legends for `results.ayr` are unchanged.
7. **The AI pinned an end-of-life Electron with known security advisories.** `package.json` asked for `^38.2.0`, and the security section (3a) argued in detail about window settings on top of it. A clean `npm ci` on Windows printed an audit warning, and `npm audit` listed high-severity Electron advisories fixed only in ≥ 42.11.16. Two of them touch features this app uses (see 3a, "Electron version").
   *Fix:* upgraded to 45.3.2 (`npm audit`: 0 vulnerabilities), then re-ran all tests and the full Windows end-to-end check.
   *Lesson:* a security review has to include the platform version, not just the app's own settings.
8. **A requirement implemented too narrowly: the log limit was only announced once reached.** The task says "if your app limits how much log it keeps or shows, it must say so". The AI's log pane said so only after more than 200,000 lines had arrived. A full run prints about 16,000 lines, so in practice the user would never be told there is a limit.
   *Found:* by rereading the grading text line by line against the app.
   *Fix:* the notice ("Log keeps the last 200,000 lines …") is shown from the start. When lines are dropped it changes to say how many.
9. **The Windows AI session also got things wrong itself, and was caught by checks.**
   * It first reported a syntax error (a missing `}`) in `colormap.js`. It had looked at the file with `head`/`tail`, which cut out the middle. `node --check` on every file showed there was no error, and it withdrew the claim before changing anything.
   * While filling in this report it wrote a cause for one slow file-open time that it had never measured. On review the sentence was replaced by what was actually observed.
   * Lesson: the same as item 1. A claim needs the check that backs it, even when it comes from the AI that is doing the checking.

## Honest limits
* The first AI's sandbox had no network, so it could not install or start Electron. The Electron-specific glue (`main.js`, `preload.js`) was tested with a stubbed `electron` module and then in the real app on Windows 11. That run found bugs the stubbed tests had missed (items 4–6). The renderer code was also tested in headless Chrome with software WebGL.
* The Windows checks in `verification/windows/` were driven by an AI session through the DevTools protocol, with the native file dialog stubbed. The dialog itself, and Task Manager during Cancel, are shown by hand in the screen recording.
* The Windows Cancel path (`taskkill /T /F`) was exercised on my laptop only, with 0 processes left every time: 3 cycles in each of four `npm test` runs, and 3 cycles in the real app on two separate occasions. It is not covered by the automated Linux runs, and it was not tested on Windows 10.
* Cosmetic: at the default window size the solver bar wraps its last button ("…", choose solver script) onto a second line.
* stdout and stderr are two separate pipes; "the order received" is the order the main process read them. Two lines written to different pipes at nearly the same moment can arrive in either order — no reader can recover the exact write order from two pipes.
* Frame times in the table are from my laptop; the sandbox numbers are software rendering and not meaningful.
* The probe picks the nearest vertex to the ray's first hit with the surface (what the user sees), not the vertex nearest to the ray.
