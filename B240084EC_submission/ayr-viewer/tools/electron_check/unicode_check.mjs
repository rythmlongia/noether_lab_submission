// Non-ASCII case name through the real runner on Windows, vs. a naive spawn without PYTHONIOENCODING.
// usage: node unicode_check.mjs <ayr-viewer dir>
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const root = path.resolve(process.argv[2] || '.');
const require = createRequire(path.join(root, 'package.json'));
const { SolverRun } = require('./src/main/solverRunner.js');
const { writeAyr, tetra } = require('./tests/ayrWriter.js');

const name = '鋳造ハウジング Gehäuse – Ø40';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr ünïcode '));
const casePath = path.join(dir, 'case é.ayr');
fs.writeFileSync(casePath, writeAyr(tetra({ name })));
const py = execFileSync('py', ['-3', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
const solver = path.join(root, 'solver', 'fake_solver.py');

// 1. the app's runner
const r = new SolverRun({ python: py, solverPath: solver, casePath, steps: 5, extraArgs: ['--step-time', '0.01'] });
const lines = [];
r.on('lines', b => lines.push(...b.lines));
const end = await new Promise(res => { r.on('end', res); r.start(); });
const nl = lines.find(l => l.t.startsWith('Case name'));
console.log(`app runner : ${end.state}, exit ${end.code} | ${nl ? nl.t : '(no Case name line)'} | exact match: ${!!nl && nl.t === 'Case name : ' + name}`);

// 2. naive: same command, but without PYTHONIOENCODING (and without PYTHONUTF8)
const env = { ...process.env }; delete env.PYTHONIOENCODING; delete env.PYTHONUTF8;
const n = spawnSync(py, ['-u', solver, '--case', casePath, '--steps', '5', '--step-time', '0.01'], { env, encoding: 'utf8' });
const errTail = (n.stderr || '').trim().split(/\r?\n/).slice(-1)[0];
console.log(`naive spawn: exit ${n.status} | ${(n.stdout.split(/\r?\n/).find(l => l.startsWith('Case name')) || '(no Case name line)')} | last stderr: ${errTail}`);
