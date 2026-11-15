# Ayrton results viewer (Noether Labs task round)

Electron desktop app that opens `.ayr` result files, shows them in 3D (solidification time, "not yet solid at t", temperature per snapshot, probe) and runs `fake_solver.py` with live progress, a log pane and Cancel.

* **Only dependency:** Electron (dev dependency). The 3D view is plain WebGL2, the tests use Node's built-in test runner. No bundler, no build step.
* Author OS: **Windows 11 Home (x64, build 26200)**: Node **v22.13.0**, Python **3.13.5**, Electron **45.3.2** (installed by `npm install` from `package-lock.json`).
  The parser, solver runner and renderer were also tested on Linux (Node 22.23, Python 3.13, headless Chrome); see `REPORT.md`.

## Install and run (Windows, PowerShell)

Prerequisites: Node.js 18 or newer (https://nodejs.org, LTS) and Python 3.9 or newer (https://python.org; the `py` launcher is installed by default).

```powershell
cd ayr-viewer
npm install        # downloads Electron (~100 MB)
npm start          # starts the app
```

macOS / Linux: the same three commands in a terminal.

## Using the app

1. **Open .ayr…** → choose `results_small.ayr` or `results.ayr`. The file is read by the main process and parsed in a Web Worker; a corrupted file shows a red message that says what is wrong and no mesh.
2. Modes (top right): **Solidification time** (viridis, grey = not computed), **Solid at time t** (slider; red = `solid_time > t`, i.e. not yet fully solid; the panel also shows the count of such vertices), **Temperature** (snapshot slider / Prev / Next, °C, one colour scale for all snapshots).
3. Mouse: left-drag orbit, right-drag or Shift+drag pan, wheel zoom, click = probe (nearest vertex: index, position in mm, solidification time, temperature at the current snapshot). *Reset view* re-frames the part.
4. **Frame-time benchmark** panel: *Drag time slider (5 s)* and *Orbit (5 s)* drive the slider / camera for 5 s and print frame-interval statistics. The live figure at the top right shows the last second.
5. **Python**: detected automatically at start (`py -3`, `python`, `python3` on Windows; `python3`, `python` elsewhere). The detected interpreter's full path is stored. **Detect** re-runs detection, **Browse…** picks `python.exe` by hand. The solver script defaults to the bundled `solver/fake_solver.py`; **…** picks another one.
6. **Run solver** runs `python -u fake_solver.py --case <open file> --steps 200 [--fail-at N]` (fill *fail at %* to test the failure path). **Cancel** stops the solver and its worker process. The log keeps the last 200 000 lines (a full run prints about 16 000); if more arrive, the app says how many older lines were dropped.

DevTools: **Ctrl+Shift+I** or **F12** (left enabled for grading; see REPORT 3a).

## Tests

```powershell
npm test
```

Runs every `*.test.js` with Node's built-in runner (`node --test`), 33 tests, about 25 s on Windows (15 s on Linux):

* `tests/ayr.test.js` – parser (builds its own `.ayr` files with `tests/ayrWriter.js`)
* `tests/runner.test.js` – solver runner, including real runs of `fake_solver.py` and a Cancel check with the OS process list (needs Python on PATH; skipped otherwise)
* `tests/main.test.js` – main-process IPC / protocol logic with a stubbed `electron` module

Extra tools:

```powershell
npm run mutation                                   # makes 19 deliberate parser bugs, checks a test fails for each
node tools/answers.js path\to\results.ayr 84       # Q1-Q4 with the app's parser
py -3 tools/reference_reader.py path\to\results.ayr 84   # same, independent numpy reader (needs numpy)
node tools/make_broken_files.js path\to\results_small.ayr broken   # corrupted files for manual testing
```

End-to-end check of the real Electron app (Windows; drives the app over the DevTools protocol, only the native file dialog is stubbed; about 4 minutes):

```powershell
npx electron . --inspect=9229 --remote-debugging-port=9223        # terminal 1
node tools/electron_check/app_check.mjs C:\folder\with\results verification\windows\screenshots   # terminal 2
```

## Layout

```
src/main/main.js          Electron main: window, app:// protocol, IPC, dialogs
src/main/preload.js       the only bridge to the page (window.ayr)
src/main/solverRunner.js  spawn / line splitting / batching / process-tree cancel
src/main/python.js        Python detection
src/shared/ayr.js         .ayr parser + validation (used by the worker, tests, tools)
src/shared/colormap.js    viridis + NaN-safe colour mapping
src/renderer/*            page: index.html, app.js (UI), viewer.js (WebGL2), logview.js, parse-worker.js
solver/fake_solver.py     copy of the provided solver
tests/                    automated tests (+ fixtures/results_small.ayr)
tools/                    answers, reference reader, mutation check, broken-file maker, browser check
tools/electron_check/     end-to-end check of the real Electron app over the DevTools protocol (Windows)
verification/             saved outputs of the checks and screenshots (Linux / headless Chrome)
verification/windows/     the same checks in the real Electron app on Windows 11, plus frame times
```
