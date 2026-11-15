/*
 * ayr.js - reader for the Ayrton .ayr results format, version 1 (see FORMAT.md).
 *
 * Plain script, no dependencies. It runs in three places:
 *   - the renderer's Web Worker   (importScripts('../shared/ayr.js') -> self.AYR)
 *   - Node, for the tests/tools   (require('./ayr.js'))
 *
 * Design notes
 *   - Every multi-byte field (including header fields after `flags` and the CRC
 *     footer) is read through a DataView with the byte order from flags bit 0.
 *   - Sections start at offsets that are generally NOT multiples of 4 (the header
 *     is 19 + name_len bytes), so we never create a Float32Array/Uint32Array view
 *     directly on the file buffer (that would throw a RangeError for unaligned
 *     offsets and would also ignore the file's byte order). DataView reads are
 *     alignment-free and take an explicit endianness.
 *   - Validation follows FORMAT.md section 4, in that order, and every failure
 *     throws an AyrError whose message says what is wrong.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AYR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class AyrError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'AyrError';
      this.code = code; // short machine-readable reason, used by tests
    }
  }

  // ---------------------------------------------------------------- CRC-32
  // CRC-32/ISO-HDLC (zlib, PNG): reflected poly 0xEDB88320, init and xorout 0xFFFFFFFF.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------------------------------------------------------------- f16
  // Direct implementation of the table in FORMAT.md section 5.
  function f16ToNumber(h) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024); // zero / subnormal (gives -0 for 0x8000)
    if (e === 31) return f === 0 ? s * Infinity : NaN;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  // All 65536 values precomputed once (256 KB) so decoding the big temperature
  // array is one table lookup per value.
  let F16_TABLE = null;
  function f16Table() {
    if (!F16_TABLE) {
      F16_TABLE = new Float32Array(65536);
      for (let h = 0; h < 65536; h++) F16_TABLE[h] = f16ToNumber(h);
    }
    return F16_TABLE;
  }

  // ---------------------------------------------------------------- helpers
  /** min/max over finite values only; NaN (= "not computed") is skipped, never treated as 0 or +big. */
  function finiteMinMax(arr) {
    let min = Infinity, max = -Infinity, count = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
        count++;
      }
    }
    return count ? { min, max, count } : { min: NaN, max: NaN, count: 0 };
  }

  function expectedSize(H, nSnap, nVert, nTri) {
    // Number is exact here: the largest possible value is far below 2^53.
    return H + 4 * nSnap + 12 * nVert + 12 * nTri + 4 * nVert + 2 * nSnap * nVert + 4;
  }

  // ---------------------------------------------------------------- parse
  /**
   * Parse and validate an .ayr file.
   * @param {ArrayBuffer|Uint8Array} input  whole file
   * @returns {object} header fields + typed arrays (positions are in FILE units, see unitToMm)
   * @throws {AyrError}
   */
  function parseAyr(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const size = bytes.length;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Rule 1: length and magic
    if (size < 23) throw new AyrError('too_short', `File is too short to be an .ayr file (${size} bytes, at least 23 needed).`);
    if (bytes[0] !== 0x41 || bytes[1] !== 0x59 || bytes[2] !== 0x52 || bytes[3] !== 0x4e) {
      const got = Array.from(bytes.subarray(0, 4), b => b.toString(16).padStart(2, '0')).join(' ');
      throw new AyrError('bad_magic', `Not an .ayr file: magic bytes are ${got}, expected 41 59 52 4e ("AYRN").`);
    }

    // Rule 2: flags, version, units
    const flags = bytes[4];
    if (flags & 0xfe) throw new AyrError('reserved_flags', `Reserved bits are set in the flags byte (0x${flags.toString(16).padStart(2, '0')}); only bit 0 may be used.`);
    const littleEndian = (flags & 1) === 0;
    const units = bytes[5];
    const version = dv.getUint16(6, littleEndian);
    if (version !== 1) throw new AyrError('bad_version', `Unsupported format version ${version} (only version 1 is supported).`);
    if (units !== 0 && units !== 1) throw new AyrError('bad_units', `Invalid units value ${units} (must be 0 = metre or 1 = millimetre).`);

    const nVert = dv.getUint32(8, littleEndian);
    const nTri = dv.getUint32(12, littleEndian);
    const nSnap = dv.getUint16(16, littleEndian);
    const nameLen = bytes[18];
    const H = 19 + nameLen;

    // Rule 3: exact size (catches truncation and trailing garbage)
    const expected = expectedSize(H, nSnap, nVert, nTri);
    if (size !== expected) {
      const what = size < expected ? 'The file is truncated' : 'The file has extra bytes at the end';
      throw new AyrError('bad_size', `File size is wrong: the header (n_vert=${nVert}, n_tri=${nTri}, n_snap=${nSnap}, name_len=${nameLen}) requires exactly ${expected} bytes, but the file has ${size} bytes. ${what} or its header is corrupted.`);
    }
    if (nSnap < 1) throw new AyrError('no_snapshots', 'The file has n_snap = 0; FORMAT.md requires at least one temperature snapshot.');

    // Rule 4: CRC over everything before the footer
    const crcStored = dv.getUint32(size - 4, littleEndian);
    const crcComputed = crc32(bytes, 0, size - 4);
    if (crcStored !== crcComputed) {
      throw new AyrError('bad_crc', `Checksum mismatch: the file stores CRC-32 ${hex8(crcStored)} but its contents give ${hex8(crcComputed)}. The file is corrupted.`);
    }

    const name = new TextDecoder('utf-8').decode(bytes.subarray(19, H));

    // Section offsets (not aligned!)
    const offTimes = H;
    const offPos = offTimes + 4 * nSnap;
    const offTri = offPos + 12 * nVert;
    const offSolid = offTri + 12 * nTri;
    const offTemp = offSolid + 4 * nVert;

    const times = new Float64Array(nSnap);
    for (let i = 0; i < nSnap; i++) times[i] = dv.getFloat32(offTimes + 4 * i, littleEndian);

    const positions = new Float32Array(3 * nVert);
    for (let i = 0, o = offPos; i < 3 * nVert; i++, o += 4) positions[i] = dv.getFloat32(o, littleEndian);

    // Rule 5: triangle indices
    const triangles = new Uint32Array(3 * nTri);
    for (let i = 0, o = offTri; i < 3 * nTri; i++, o += 4) {
      const idx = dv.getUint32(o, littleEndian);
      if (idx >= nVert) {
        throw new AyrError('bad_index', `Triangle ${Math.floor(i / 3)} refers to vertex ${idx}, but the mesh has only ${nVert} vertices (indices must be < n_vert).`);
      }
      triangles[i] = idx;
    }

    // Rule 6: times strictly increasing. Written as !(b > a) so a NaN time is rejected too.
    for (let i = 1; i < nSnap; i++) {
      if (!(times[i] > times[i - 1])) {
        throw new AyrError('times_not_increasing', `Snapshot times are not strictly increasing: times[${i - 1}] = ${times[i - 1]} s, times[${i}] = ${times[i]} s.`);
      }
    }
    if (nSnap === 1 && Number.isNaN(times[0])) throw new AyrError('times_not_increasing', 'Snapshot time is NaN.');

    const solidTime = new Float32Array(nVert);
    for (let i = 0, o = offSolid; i < nVert; i++, o += 4) solidTime[i] = dv.getFloat32(o, littleEndian);

    // f16 temperatures, snapshot-major: element s*nVert + v
    const table = f16Table();
    const temperature = new Float32Array(nSnap * nVert);
    for (let i = 0, o = offTemp; i < nSnap * nVert; i++, o += 2) temperature[i] = table[dv.getUint16(o, littleEndian)];

    return {
      name, flags, littleEndian, units, version, nVert, nTri, nSnap, headerLength: H, fileSize: size,
      crcStored, crcComputed, crcMatches: crcStored === crcComputed,
      unitToMm: units === 0 ? 1000 : 1,
      times, positions, triangles, solidTime, temperature,
    };
  }

  function hex8(n) { return (n >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

  /** Derived quantities used by the viewer (bbox in mm, value ranges). */
  function summarize(r) {
    const k = r.unitToMm;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < r.nVert; i++) {
      for (let a = 0; a < 3; a++) {
        const v = r.positions[3 * i + a] * k;
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    return {
      bboxMm: { min, max },
      solid: finiteMinMax(r.solidTime),
      // One range over ALL snapshots so every snapshot uses the same colour scale.
      temperature: finiteMinMax(r.temperature),
    };
  }

  return { parseAyr, summarize, crc32, f16ToNumber, f16Table, finiteMinMax, expectedSize, hex8, AyrError };
});
