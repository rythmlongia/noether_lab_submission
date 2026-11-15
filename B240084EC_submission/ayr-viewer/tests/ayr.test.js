// Parser tests. Run with:  npm test   (= node --test tests/)
//
// Where expected values come from (never from the parser itself):
//   [FMT]  FORMAT.md: section 5 test vectors, section 6.1 self-check values, section 3.6 CRC check value
//   [IEEE] IEEE 754 binary16 definition, worked by hand (e.g. smallest subnormal = 2^-24),
//          and confirmed with Python's struct module ('e' format) - see comments
//   [IN]   values the test itself wrote into the file through tests/ayrWriter.js
//   [PY]   tools/reference_reader.py (numpy + zlib), an independent reader
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseAyr, summarize, f16ToNumber, f16Table, crc32, finiteMinMax } = require('../src/shared/ayr.js');
const { prepareScalar, colorFor, normalize, NAN_GREY, VIRIDIS_HEX } = require('../src/shared/colormap.js');
const { writeAyr, tetra, crcBitwise } = require('./ayrWriter.js');

const f32 = x => Math.fround(x);

function expectReject(buf, code, re) {
  assert.throws(() => parseAyr(buf), err => {
    assert.equal(err.name, 'AyrError');
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    if (re) assert.match(err.message, re);
    return true;
  });
}

// ------------------------------------------------------------------ f16
// [IEEE] values; Python check: struct.unpack('<e', struct.pack('<H', bits))[0]
const F16_CASES = [
  ['+0', 0x0000, 0],
  ['-0', 0x8000, -0],
  ['smallest subnormal 2^-24', 0x0001, 5.960464477539063e-8],
  ['largest subnormal (1023/1024)*2^-14', 0x03ff, 6.097555160522461e-5],
  ['smallest normal 2^-14', 0x0400, 6.103515625e-5],
  ['largest finite 65504', 0x7bff, 65504],
  ['+inf', 0x7c00, Infinity],
  ['-inf', 0xfc00, -Infinity],
  ['NaN quiet 7E00', 0x7e00, NaN],
  ['NaN 7C01 (f=1)', 0x7c01, NaN],
  ['NaN FFFF (negative sign)', 0xffff, NaN],
  // [FMT] section 5 table and 6.1
  ['1.0', 0x3c00, 1], ['-2.0', 0xc000, -2], ['208.0', 0x5a80, 208], ['910.0', 0x631c, 910],
  ['negative subnormal', 0x8001, -5.960464477539063e-8], ['1/3 rounded', 0x3555, 0.333251953125],
];

test('f16ToNumber: special and boundary values', () => {
  for (const [label, bits, want] of F16_CASES) {
    const got = f16ToNumber(bits);
    // Object.is distinguishes +0 / -0 and treats NaN as equal to NaN
    assert.ok(Object.is(got, want), `${label}: bits ${bits.toString(16)} -> ${got}, want ${want}`);
  }
});

test('f16 lookup table agrees with the formula for every case (and preserves -0)', () => {
  const t = f16Table();
  for (const [label, bits, want] of F16_CASES) assert.ok(Object.is(t[bits], f32(want)), label);
});

test('f16 decoding through a whole file, both byte orders', () => {
  // Put each special bit pattern into the temperature section and read it back.
  const bits = F16_CASES.map(c => c[1]);
  const nVert = bits.length;
  const positions = [], solid = [];
  for (let i = 0; i < nVert; i++) { positions.push(i, 0, 0); solid.push(1); }
  for (const bigEndian of [false, true]) {
    const r = parseAyr(writeAyr({ bigEndian, name: 'f16', times: [0], positions, triangles: [0, 1, 2], solid, tempBits: bits }));
    F16_CASES.forEach(([label, , want], i) => assert.ok(Object.is(r.temperature[i], f32(want)), `${bigEndian ? 'BE' : 'LE'} ${label}`));
  }
});

// ------------------------------------------------------------------ byte order
for (const bigEndian of [false, true]) {
  test(`${bigEndian ? 'big' : 'little'}-endian file decodes to the values written [IN]`, () => {
    const spec = tetra({ bigEndian });
    const r = parseAyr(writeAyr(spec));
    assert.equal(r.littleEndian, !bigEndian);
    assert.equal(r.nVert, 4); assert.equal(r.nTri, 4); assert.equal(r.nSnap, 2);
    assert.equal(r.name, 'tet');
    assert.deepEqual([...r.times], [0, 10]);
    assert.deepEqual([...r.positions], spec.positions.map(f32));
    assert.deepEqual([...r.triangles], spec.triangles);
    assert.deepEqual([...r.solidTime], spec.solid.map(f32));
    // snapshot-major: s*nVert + v. Snapshot 1 of vertex 2 is 1.0, NOT snapshot 0 of vertex 1.
    assert.deepEqual([...r.temperature], [973, 910, 875.5, 853, 786.5, 644.5, 1, -2]);
    assert.equal(r.temperature[1 * r.nVert + 2], 1);
    assert.equal(r.crcMatches, true);
  });
}

test('header fields after flags really use the file byte order (n_vert > 255 so both bytes matter)', () => {
  // 300 vertices = 0x012C: a reader that ignores byte order would read 0x2C01 or 0x2C010000.
  const n = 300, positions = [], solid = [], tempBits = [];
  for (let i = 0; i < n; i++) { positions.push(i, i % 7, 0); solid.push(i); tempBits.push(0x3c00); }
  for (const bigEndian of [false, true]) {
    const r = parseAyr(writeAyr({ bigEndian, name: 'n', times: [0], positions, triangles: [0, 1, 299], solid, tempBits }));
    assert.equal(r.nVert, 300);
    assert.equal(r.triangles[2], 299);
    assert.equal(r.solidTime[299], 299);
  }
});

// ------------------------------------------------------------------ alignment
test('header lengths that put sections at offsets that are not multiples of 4', () => {
  for (const name of ['', 'a', 'ab', 'abc', 'abcd', 'Gehäuse']) { // H = 19..23, 'Gehäuse' is 8 UTF-8 bytes
    for (const bigEndian of [false, true]) {
      const spec = tetra({ name, bigEndian });
      const r = parseAyr(writeAyr(spec));
      assert.equal(r.headerLength, 19 + Buffer.byteLength(name));
      assert.equal(r.name, name);
      assert.deepEqual([...r.positions], spec.positions.map(f32), `H=${r.headerLength}`);
      assert.deepEqual([...r.solidTime], spec.solid.map(f32));
      assert.deepEqual([...r.temperature], [973, 910, 875.5, 853, 786.5, 644.5, 1, -2]);
    }
  }
});

test('parser works on a Uint8Array view that does not start at byte 0 of its buffer', () => {
  const file = writeAyr(tetra({ name: 'abc' }));
  const big = new Uint8Array(file.length + 3);
  big.set(file, 3);
  const r = parseAyr(big.subarray(3));
  assert.equal(r.name, 'abc');
  assert.deepEqual([...r.solidTime], [5, 12.5, 40, 7]);
});

// ------------------------------------------------------------------ NaN
test('NaN solidification times: any bit pattern is NaN; min/max skip them; colour is grey', () => {
  // [IEEE] all of these are NaN bit patterns (exponent all ones, fraction != 0); checked with Python struct '<f'
  const solidBits = [0x7fc00000, 0x40a00000 /* 5.0 */, 0xffffffff, 0x7f800001, 0x42200000 /* 40.0 */, 0xffc00001];
  const n = solidBits.length, positions = [], tempBits = [];
  for (let i = 0; i < n; i++) { positions.push(i, 0, 0); tempBits.push(0x7e00); }
  const r = parseAyr(writeAyr({ name: 'nan', times: [0], positions, triangles: [0, 1, 2], solidBits, tempBits }));
  assert.deepEqual([...r.solidTime].map(Number.isNaN), [true, false, true, true, false, true]);

  const mm = finiteMinMax(r.solidTime);
  assert.deepEqual(mm, { min: 5, max: 40, count: 2 }); // NaN not treated as 0 nor as +big
  assert.deepEqual(summarize(r).solid, { min: 5, max: 40, count: 2 });

  // Colour mapping: NaN -> grey; finite ends -> first/last viridis entries [FMT-free: matplotlib viridis table]
  assert.deepEqual(colorFor(r.solidTime[0], mm.min, mm.max), NAN_GREY);
  assert.deepEqual(colorFor(5, mm.min, mm.max), [0x44, 0x01, 0x54]);
  assert.deepEqual(colorFor(40, mm.min, mm.max), [0xfd, 0xe7, 0x25]);
  assert.ok(Number.isNaN(normalize(NaN, 5, 40)));

  // GPU attribute: NaN is replaced by 0 plus valid=0; nothing NaN reaches the GPU.
  const g = prepareScalar(r.solidTime);
  assert.deepEqual([...g.valid], [0, 1, 0, 0, 1, 0]);
  assert.ok([...g.value].every(Number.isFinite));
  assert.deepEqual([...g.value], [0, 5, 0, 0, 40, 0]);
});

test('all-NaN array gives NaN range, not Infinity', () => {
  const mm = finiteMinMax(new Float32Array([NaN, NaN]));
  assert.equal(mm.count, 0);
  assert.ok(Number.isNaN(mm.min) && Number.isNaN(mm.max));
});

test('viridis table has 256 entries and the matplotlib end points', () => {
  assert.equal(VIRIDIS_HEX.length, 256);
  assert.equal(VIRIDIS_HEX[0], 0x440154);
  assert.equal(VIRIDIS_HEX[255], 0xfde725);
});

// ------------------------------------------------------------------ validation
test('truncated files are rejected with a size message', () => {
  const good = writeAyr(tetra());
  expectReject(good.subarray(0, good.length - 1), 'bad_size', /truncated/);
  expectReject(good.subarray(0, 60), 'bad_size', /truncated/);
  expectReject(good.subarray(0, 22), 'too_short', /23/);
  expectReject(Buffer.alloc(0), 'too_short');
  expectReject(Buffer.concat([good, Buffer.from([0])]), 'bad_size', /extra bytes/);
});

test('a single corrupted byte anywhere in the data is caught by the CRC', () => {
  const good = writeAyr(tetra({ name: 'abc' }));
  const H = 22;
  // one byte in each section: times, positions, triangles, solid_time, temperature, name
  for (const off of [H + 1, H + 8 + 5, H + 8 + 48 + 3, H + 8 + 48 + 48 + 2, good.length - 6, 20]) {
    const bad = Buffer.from(good);
    bad[off] ^= 0x10;
    expectReject(bad, 'bad_crc', /Checksum mismatch/);
  }
  // corrupt the stored CRC itself
  const bad = Buffer.from(good); bad[bad.length - 1] ^= 1;
  expectReject(bad, 'bad_crc');
});

test('a corrupted count in the header is caught by the size rule', () => {
  expectReject(writeAyr(tetra({ nVertOverride: 5 })), 'bad_size');
});

test('magic, reserved flags, version and units are checked', () => {
  const good = writeAyr(tetra());
  const badMagic = Buffer.from(good); badMagic[3] = 0x4d;
  expectReject(badMagic, 'bad_magic', /AYRN/);
  expectReject(writeAyr(tetra({ flags: 0x02 })), 'reserved_flags');
  expectReject(writeAyr(tetra({ flags: 0x81 })), 'reserved_flags');
  expectReject(writeAyr(tetra({ version: 2 })), 'bad_version');
  expectReject(writeAyr(tetra({ version: 256 })), 'bad_version'); // version 1 written in the wrong byte order
  expectReject(writeAyr(tetra({ units: 2 })), 'bad_units');
  assert.equal(parseAyr(writeAyr(tetra({ units: 0 }))).unitToMm, 1000);
  assert.equal(parseAyr(writeAyr(tetra({ units: 1 }))).unitToMm, 1);
});

test('triangle index n_vert-1 is accepted, n_vert is rejected', () => {
  parseAyr(writeAyr(tetra({ triangles: [0, 1, 3, 0, 1, 2, 0, 2, 3, 1, 2, 3] })));
  expectReject(writeAyr(tetra({ triangles: [0, 1, 4, 0, 1, 2, 0, 2, 3, 1, 2, 3] })), 'bad_index', /vertex 4/);
  expectReject(writeAyr(tetra({ bigEndian: true, triangles: [0, 1, 2, 0, 1, 2, 0, 2, 3, 1, 2, 0xffffffff] })), 'bad_index');
});

test('times must be strictly increasing (equal and NaN rejected)', () => {
  expectReject(writeAyr(tetra({ times: [10, 10] })), 'times_not_increasing');
  expectReject(writeAyr(tetra({ times: [10, 5] })), 'times_not_increasing');
  expectReject(writeAyr(tetra({ times: [0, NaN] })), 'times_not_increasing');
});

test('n_snap = 0 is rejected', () => {
  expectReject(writeAyr({ name: 'x', times: [], positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2], solid: [1, 1, 1], tempBits: [] }), 'no_snapshots');
});

// ------------------------------------------------------------------ CRC
test('CRC-32 check value [FMT 3.6] and agreement with an independent bitwise CRC', () => {
  const nine = Buffer.from('123456789', 'ascii');
  assert.equal(crc32(nine), 0xcbf43926);
  assert.equal(crcBitwise(nine), 0xcbf43926);
  const rnd = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7919) & 255));
  assert.equal(crc32(rnd), crcBitwise(rnd));
});

// ------------------------------------------------------------------ the provided small file
const SMALL = [path.join(__dirname, 'fixtures', 'results_small.ayr')].find(p => fs.existsSync(p));
test('results_small.ayr matches FORMAT.md section 6.1', { skip: !SMALL && 'fixture missing' }, () => {
  const buf = fs.readFileSync(SMALL);
  assert.equal(buf.length, 40514);
  const r = parseAyr(buf);
  const s = summarize(r);
  assert.equal(r.name, 'debug_small'); assert.equal(r.headerLength, 30);
  assert.deepEqual([r.nVert, r.nTri, r.nSnap, r.units], [778, 1556, 6, 1]);
  assert.deepEqual([...r.times], [0, 5, 15, 30, 60, 120]);
  assert.deepEqual([...r.positions.subarray(0, 3)], [-20, f32(-9.6), f32(2.4)]);
  assert.deepEqual([...r.triangles.subarray(0, 3)], [2, 1, 0]);
  assert.equal(r.solidTime[0], 45.021484375);
  const nanIdx = []; r.solidTime.forEach((v, i) => Number.isNaN(v) && nanIdx.push(i));
  assert.deepEqual(nanIdx, [18, 19, 20, 21, 22, 23, 24, 25]);
  assert.equal(s.solid.min.toFixed(6), '14.668059'); assert.equal(s.solid.max.toFixed(6), '96.419121');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k => r.temperature[k * r.nVert]), [973, 910, 875.5, 853, 786.5, 644.5]);
  assert.equal(r.crcStored, 0x0c736579); assert.equal(r.crcMatches, true);
  // bbox [FMT]: x -20..20, y -12..12, z 0..16 mm (f32 rounding allowed)
  const close = (a, b) => Math.abs(a - b) < 1e-5;
  [[-20, -12, 0], [20, 12, 16]].forEach((want, k) => want.forEach((w, a) => assert.ok(close((k ? s.bboxMm.max : s.bboxMm.min)[a], w))));
});
