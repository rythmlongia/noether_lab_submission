#!/usr/bin/env python3
"""Independent reference reader for .ayr files (numpy + struct + zlib).

Written separately from the JavaScript parser (src/shared/ayr.js) so the two
can be cross-checked. It uses numpy's own float16 decoder and Python's zlib
CRC-32, so it shares no decoding code with the app.

Usage:  python reference_reader.py <file.ayr> [R]
"""
import struct
import sys
import zlib

import numpy as np


def read(path):
    data = open(path, "rb").read()
    if len(data) < 23 or data[:4] != b"AYRN":
        raise ValueError("short file or bad magic")
    flags = data[4]
    if flags & 0xFE:
        raise ValueError("reserved flag bit set")
    e = ">" if flags & 1 else "<"
    units = data[5]
    (version,) = struct.unpack_from(e + "H", data, 6)
    n_vert, n_tri = struct.unpack_from(e + "II", data, 8)
    (n_snap,) = struct.unpack_from(e + "H", data, 16)
    name_len = data[18]
    H = 19 + name_len
    expected = H + 4 * n_snap + 12 * n_vert + 12 * n_tri + 4 * n_vert + 2 * n_snap * n_vert + 4
    if version != 1 or units not in (0, 1):
        raise ValueError("bad version/units")
    if len(data) != expected:
        raise ValueError("size %d != expected %d" % (len(data), expected))
    name = data[19:H].decode("utf-8")
    off = H
    times = np.frombuffer(data, dtype=e + "f4", count=n_snap, offset=off); off += 4 * n_snap
    pos = np.frombuffer(data, dtype=e + "f4", count=3 * n_vert, offset=off).reshape(-1, 3); off += 12 * n_vert
    tri = np.frombuffer(data, dtype=e + "u4", count=3 * n_tri, offset=off).reshape(-1, 3); off += 12 * n_tri
    st = np.frombuffer(data, dtype=e + "f4", count=n_vert, offset=off); off += 4 * n_vert
    temp = np.frombuffer(data, dtype=e + "f2", count=n_snap * n_vert, offset=off).reshape(n_snap, n_vert)
    off += 2 * n_snap * n_vert
    (crc_stored,) = struct.unpack_from(e + "I", data, off)
    crc_calc = zlib.crc32(data[:off]) & 0xFFFFFFFF
    return dict(flags=flags, units=units, version=version, n_vert=n_vert, n_tri=n_tri, n_snap=n_snap,
                name=name, H=H, times=times.astype(np.float64), pos=pos.astype(np.float64), tri=tri,
                st=st.astype(np.float64), temp=temp.astype(np.float64), crc_stored=crc_stored,
                crc_calc=crc_calc, size=len(data))


P_TABLE = {1: (-0.0214, -0.0027, 0.0325), 4: (0.0415, -0.0008, 0.0181), 12: (-0.0008, 0.0333, 0.0199),
           38: (0.0349, 0.0153, 0.0076), 60: (0.0457, -0.0306, 0.0163), 62: (0.0045, -0.0082, 0.0115),
           64: (-0.0173, 0.0345, 0.0004), 66: (0.0170, -0.0133, 0.0307), 76: (0.0433, -0.0008, 0.0259),
           84: (0.0008, 0.0345, 0.0163), 90: (0.0445, 0.0291, 0.0076), 103: (0.0440, -0.0134, 0.0205)}


def main():
    d = read(sys.argv[1])
    R = int(sys.argv[2]) if len(sys.argv) > 2 else None
    scale = 1000.0 if d["units"] == 0 else 1.0  # file units -> mm
    pmm = d["pos"] * scale
    st = d["st"]
    ok = ~np.isnan(st)
    print("byte order:", "big" if d["flags"] & 1 else "little", " units:", d["units"], " H:", d["H"])
    print("n_vert, n_tri, n_snap:", d["n_vert"], d["n_tri"], d["n_snap"])
    print("name:", repr(d["name"]))
    print("times:", d["times"].tolist())
    print("bbox mm min:", pmm.min(0).tolist(), " max:", pmm.max(0).tolist())
    print("tri max index:", int(d["tri"].max()), " times increasing:", bool(np.all(np.diff(d["times"]) > 0)))
    print("NaN solid_time:", int((~ok).sum()), " computed:", int(ok.sum()))
    print("solid_time min/max:", st[ok].min(), st[ok].max())
    t_ok = ~np.isnan(d["temp"])
    print("temperature min/max (K) over all snapshots:", d["temp"][t_ok].min(), d["temp"][t_ok].max())
    print("CRC stored %08X computed %08X match=%s" % (d["crc_stored"], d["crc_calc"], d["crc_stored"] == d["crc_calc"]))
    if R is not None:
        P = np.array(P_TABLE[R]) * 1000.0  # metres -> mm
        dist = np.sqrt(((pmm - P) ** 2).sum(1))
        i = int(np.argmin(dist))
        srt = np.sort(dist)
        print("\nQ1 P(R) mm:", P.tolist(), " nearest vertex", i, " dist %.6f mm" % dist[i],
              " (2nd nearest %.6f mm)" % srt[1], " solid_time %.6f s" % st[i])
        t = 30 + R
        n_liq = int((st[ok] > t).sum())
        print("Q2 t=%d s: not solid %d of %d computed, fraction %.6f" % (t, n_liq, int(ok.sum()), n_liq / ok.sum()))
        v = 500 * R
        s = R % d["n_snap"]
        T = d["temp"][s, v]
        print("Q3 v=%d s=%d time=%r s  T=%r K  = %.4f C" % (v, s, d["times"][s], T, T - 273.15))


if __name__ == "__main__":
    main()
