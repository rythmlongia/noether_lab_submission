// Minimal .ayr WRITER used only by the tests. It is written independently of the
// parser: it lays the file out straight from FORMAT.md sections 2-3 with Node's
// Buffer write methods, stores temperatures as raw f16 BIT PATTERNS (so no f16
// encoder is involved), and computes the CRC with Node's zlib.crc32 when available
// (zlib's C implementation), falling back to a bit-by-bit CRC (no lookup table,
// unlike the parser's table-driven CRC).
'use strict';
const zlib = require('zlib');

function crcBitwise(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
const crc = typeof zlib.crc32 === 'function' ? b => zlib.crc32(b) >>> 0 : crcBitwise;

/**
 * @param {object} o
 *   bigEndian, units (0|1), name (string), times[], positions[] (flat xyz),
 *   triangles[] (flat), solidBits[] (u32 bit patterns) OR solid[] (numbers),
 *   tempBits[] (u16 f16 bit patterns, snapshot-major), flags/version overrides
 */
function writeAyr(o) {
  const be = !!o.bigEndian;
  const nameBuf = Buffer.from(o.name ?? 'case', 'utf8');
  const nSnap = o.times.length, nVert = o.positions.length / 3, nTri = o.triangles.length / 3;
  const H = 19 + nameBuf.length;
  const size = H + 4 * nSnap + 12 * nVert + 12 * nTri + 4 * nVert + 2 * nSnap * nVert + 4;
  const b = Buffer.alloc(size);
  const u16 = (v, off) => (be ? b.writeUInt16BE(v, off) : b.writeUInt16LE(v, off));
  const u32 = (v, off) => (be ? b.writeUInt32BE(v >>> 0, off) : b.writeUInt32LE(v >>> 0, off));
  const f32 = (v, off) => (be ? b.writeFloatBE(v, off) : b.writeFloatLE(v, off));

  b.write('AYRN', 0, 'latin1');
  b[4] = o.flags ?? (be ? 1 : 0);
  b[5] = o.units ?? 1;
  u16(o.version ?? 1, 6);
  u32(o.nVertOverride ?? nVert, 8);
  u32(nTri, 12);
  u16(nSnap, 16);
  b[18] = nameBuf.length;
  nameBuf.copy(b, 19);
  let off = H;
  for (const t of o.times) { f32(t, off); off += 4; }
  for (const p of o.positions) { f32(p, off); off += 4; }
  for (const i of o.triangles) { u32(i, off); off += 4; }
  for (let i = 0; i < nVert; i++) {
    if (o.solidBits) u32(o.solidBits[i], off); else f32(o.solid[i], off);
    off += 4;
  }
  for (const h of o.tempBits) { u16(h, off); off += 2; }
  if (off !== size - 4) throw new Error('writer layout bug');
  u32(crc(b.subarray(0, size - 4)), size - 4);
  return b;
}

/** A small valid case: a tetrahedron (4 vertices, 4 triangles, 2 snapshots). */
function tetra(extra = {}) {
  return {
    name: 'tet', units: 1,
    times: [0, 10],
    positions: [0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30],
    triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    solid: [5, 12.5, 40, 7],
    // snapshot 0: 973, 910, 875.5, 853 ; snapshot 1: 786.5, 644.5, 1.0, -2.0 (bit patterns from FORMAT.md 6.1/5)
    tempBits: [0x639a, 0x631c, 0x62d7, 0x62aa, 0x6225, 0x6109, 0x3c00, 0xc000],
    ...extra,
  };
}

module.exports = { writeAyr, tetra, crcBitwise };
