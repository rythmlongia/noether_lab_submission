/*
 * Web Worker: parses and validates the file off the UI thread, then prepares
 * GPU-ready arrays (centred positions in mm, vertex normals).
 * Result arrays are sent back as TRANSFERABLES: ownership of the ArrayBuffers moves
 * to the UI thread, nothing is copied.
 */
/* global AYR */
importScripts('../shared/ayr.js');

self.onmessage = e => {
  const { id, buffer } = e.data;
  const t0 = performance.now();
  try {
    const r = AYR.parseAyr(buffer);
    const tParse = performance.now() - t0;
    const s = AYR.summarize(r);
    const k = r.unitToMm;
    const c = [0, 1, 2].map(a => (s.bboxMm.min[a] + s.bboxMm.max[a]) / 2);

    // Centred mm positions for the GPU (keeps float32 precision good near the part).
    const gpuPos = new Float32Array(3 * r.nVert);
    for (let i = 0; i < r.nVert; i++) for (let a = 0; a < 3; a++) gpuPos[3 * i + a] = r.positions[3 * i + a] * k - c[a];

    // Area-weighted vertex normals: sum of (b-a)x(c-a) of adjacent triangles (FORMAT 3.3: points outward).
    const normals = new Float32Array(3 * r.nVert);
    const T = r.triangles, P = gpuPos;
    for (let t = 0; t < r.nTri; t++) {
      const ia = 3 * T[3 * t], ib = 3 * T[3 * t + 1], ic = 3 * T[3 * t + 2];
      const ux = P[ib] - P[ia], uy = P[ib + 1] - P[ia + 1], uz = P[ib + 2] - P[ia + 2];
      const vx = P[ic] - P[ia], vy = P[ic + 1] - P[ia + 1], vz = P[ic + 2] - P[ia + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [ia, ib, ic]) { normals[i] += nx; normals[i + 1] += ny; normals[i + 2] += nz; }
    }
    for (let i = 0; i < r.nVert; i++) {
      const x = normals[3 * i], y = normals[3 * i + 1], z = normals[3 * i + 2];
      const l = Math.hypot(x, y, z) || 1;
      normals[3 * i] = x / l; normals[3 * i + 1] = y / l; normals[3 * i + 2] = z / l;
    }

    const msg = {
      id, ok: true,
      header: {
        name: r.name, littleEndian: r.littleEndian, units: r.units, version: r.version,
        nVert: r.nVert, nTri: r.nTri, nSnap: r.nSnap, headerLength: r.headerLength, fileSize: r.fileSize,
        crcStored: r.crcStored, crcComputed: r.crcComputed, unitToMm: k,
      },
      summary: s, center: c,
      times: r.times, positions: r.positions, triangles: r.triangles, solidTime: r.solidTime,
      temperature: r.temperature, gpuPos, normals,
      timing: { parseMs: tParse, totalMs: performance.now() - t0 },
    };
    self.postMessage(msg, [r.times.buffer, r.positions.buffer, r.triangles.buffer, r.solidTime.buffer,
      r.temperature.buffer, gpuPos.buffer, normals.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err), code: err && err.code });
  }
};
