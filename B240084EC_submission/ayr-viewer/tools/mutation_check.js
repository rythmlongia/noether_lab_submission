#!/usr/bin/env node
// Makes one small deliberate bug at a time in a COPY of src/shared/ayr.js and
// checks that the test suite fails for each. Usage: node tools/mutation_check.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const MUTANTS = [
  ['ignore byte order (always LE)', 'const littleEndian = (flags & 1) === 0;', 'const littleEndian = true;'],
  ['byte order inverted', 'const littleEndian = (flags & 1) === 0;', 'const littleEndian = (flags & 1) === 1;'],
  ['f16 exponent bias 16', 'Math.pow(2, e - 15)', 'Math.pow(2, e - 16)'],
  ['f16 subnormal uses 2^-15', 'Math.pow(2, -14) * (f / 1024)', 'Math.pow(2, -15) * (f / 1024)'],
  ['f16 subnormal with implicit 1', 'Math.pow(2, -14) * (f / 1024)', 'Math.pow(2, -14) * (1 + f / 1024)'],
  ['f16 inf/NaN swapped', 'f === 0 ? s * Infinity : NaN', 'f !== 0 ? s * Infinity : NaN'],
  ['f16 sign ignored', "const s = (h & 0x8000) ? -1 : 1;", 'const s = 1;'],
  ['CRC init 0', 'let c = 0xffffffff;\n    for (let i = start', 'let c = 0;\n    for (let i = start'],
  ['CRC skips first byte', 'crc32(bytes, 0, size - 4)', 'crc32(bytes, 1, size - 4)'],
  ['CRC check removed', 'if (crcStored !== crcComputed) {', 'if (false) {'],
  ['header length off by one', 'const H = 19 + nameLen;', 'const H = 20 + nameLen;'],
  ['index check uses >', 'if (idx >= nVert) {', 'if (idx > nVert) {'],
  ['times allow equal', 'if (!(times[i] > times[i - 1])) {', 'if (times[i] < times[i - 1]) {'],
  ['size check removed', 'if (size !== expected) {', 'if (size < expected - 1e12) {'],
  ['units scale wrong', 'unitToMm: units === 0 ? 1000 : 1', 'unitToMm: 1'],
  ['solid_time offset wrong', 'const offSolid = offTri + 12 * nTri;', 'const offSolid = offTri + 12 * nTri + 4;'],
  ['temperature read vertex-major', 'temperature[i] = table[dv.getUint16(o, littleEndian)];',
    'temperature[(i % nSnap) * nVert + Math.floor(i / nSnap)] = table[dv.getUint16(o, littleEndian)];'],
  ['min/max treats NaN as 0', 'if (Number.isFinite(v)) {', 'if (true) { const w = v; if (Number.isNaN(w)) { if (0 < min) min = 0; continue; }'],
  ['reserved flags not checked', 'if (flags & 0xfe) throw', 'if (false) throw'],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr-mut-'));
fs.cpSync(path.join(root, 'src'), path.join(tmp, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'tests'), path.join(tmp, 'tests'), { recursive: true });
const target = path.join(tmp, 'src', 'shared', 'ayr.js');
const original = fs.readFileSync(target, 'utf8');
let killed = 0;
for (const [label, from, to] of MUTANTS) {
  if (!original.includes(from)) { console.log(`?? pattern not found: ${label}`); continue; }
  fs.writeFileSync(target, original.replace(from, to));
  const r = spawnSync(process.execPath, ['--test'], { cwd: tmp, encoding: 'utf8' });
  const failed = r.status !== 0;
  if (failed) killed++;
  const nfail = (r.stdout.match(/^# fail (\d+)/m) || [])[1];
  console.log(`${failed ? 'caught ' : 'MISSED '} ${label}${failed ? `  (${nfail} failing tests)` : ''}`);
}
fs.writeFileSync(target, original);
console.log(`\n${killed}/${MUTANTS.length} mutants caught`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(killed === MUTANTS.length ? 0 : 1);
