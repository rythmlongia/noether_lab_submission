#!/usr/bin/env node
// Answers Q1-Q4 using the SAME parser the app uses (src/shared/ayr.js).
// Usage: node tools/answers.js <results.ayr> <R>
'use strict';
const fs = require('fs');
const path = require('path');
const { parseAyr, summarize, hex8 } = require('../src/shared/ayr.js');

const P_TABLE = { 1: [-0.0214, -0.0027, 0.0325], 4: [0.0415, -0.0008, 0.0181], 12: [-0.0008, 0.0333, 0.0199],
  38: [0.0349, 0.0153, 0.0076], 60: [0.0457, -0.0306, 0.0163], 62: [0.0045, -0.0082, 0.0115],
  64: [-0.0173, 0.0345, 0.0004], 66: [0.0170, -0.0133, 0.0307], 76: [0.0433, -0.0008, 0.0259],
  84: [0.0008, 0.0345, 0.0163], 90: [0.0445, 0.0291, 0.0076], 103: [0.0440, -0.0134, 0.0205] };

const file = process.argv[2];
const R = parseInt(process.argv[3], 10);
const r = parseAyr(fs.readFileSync(file));
const s = summarize(r);
const k = r.unitToMm; // file units -> mm

console.log(`File: ${path.basename(file)}  (${r.littleEndian ? 'little' : 'big'}-endian, units=${r.units} -> x${k} to mm, H=${r.headerLength})`);

// Q1: P(R) is in METRES; the file positions are in file units. Compare both in mm, in double precision.
const P = P_TABLE[R].map(c => c * 1000);
let best = -1, bestD2 = Infinity;
for (let i = 0; i < r.nVert; i++) {
  const dx = r.positions[3 * i] * k - P[0], dy = r.positions[3 * i + 1] * k - P[1], dz = r.positions[3 * i + 2] * k - P[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < bestD2) { bestD2 = d2; best = i; }
}
console.log(`\nQ1  P(${R}) = (${P_TABLE[R].join(', ')}) m = (${P.map(v => v.toFixed(1)).join(', ')}) mm`);
console.log(`    nearest vertex index ${best}, position (${[0, 1, 2].map(a => (r.positions[3 * best + a] * k).toFixed(4)).join(', ')}) mm`);
console.log(`    distance ${Math.sqrt(bestD2).toFixed(3)} mm   solid_time ${r.solidTime[best].toFixed(2)} s   (raw ${Math.sqrt(bestD2)}, ${r.solidTime[best]})`);

// Q2: NaN excluded from both counts; strict ">".
const t = 30 + R;
let computed = 0, liquid = 0;
for (let i = 0; i < r.nVert; i++) {
  const st = r.solidTime[i];
  if (Number.isNaN(st)) continue;
  computed++;
  if (st > t) liquid++;
}
console.log(`\nQ2  t = ${t} s: not yet fully solid = ${liquid}, computed = ${computed}, fraction = ${(liquid / computed).toFixed(4)}`);

// Q3
const v = 500 * R, sn = R % r.nSnap;
const TK = r.temperature[sn * r.nVert + v];
console.log(`\nQ3  v = ${v}, s = ${R} mod ${r.nSnap} = ${sn}: time = ${r.times[sn]} s, T = ${TK} K = ${(TK - 273.15).toFixed(2)} °C`);

// Q4
console.log(`\nQ4  n_vert=${r.nVert} n_tri=${r.nTri} n_snap=${r.nSnap} name="${r.name}"`);
console.log(`    bbox mm: x ${s.bboxMm.min[0]} .. ${s.bboxMm.max[0]}, y ${s.bboxMm.min[1]} .. ${s.bboxMm.max[1]}, z ${s.bboxMm.min[2]} .. ${s.bboxMm.max[2]}`);
console.log(`    CRC stored ${hex8(r.crcStored)}, computed ${hex8(r.crcComputed)}, match: ${r.crcMatches}`);
console.log(`\nExtra: solid_time range ${s.solid.min} .. ${s.solid.max} s (${s.solid.count} computed); temperature range ${s.temperature.min} .. ${s.temperature.max} K`);
