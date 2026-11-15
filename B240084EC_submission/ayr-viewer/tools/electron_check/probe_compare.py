# Compare app probe readings with the independent numpy reader.
# usage: py -3 -I probe_compare.py <reference_reader dir> <file.ayr> <probe.json>
import json, math, re, sys
sys.path.insert(0, sys.argv[1])
from reference_reader import read

r = read(sys.argv[2])
k = 1000.0 if r["units"] == 0 else 1.0
rows = json.load(open(sys.argv[3], encoding="utf-8"))  # Windows default would be the ANSI code page
bad = 0
for p in rows:
    i, s = p["index"], p["snap"]
    pos = [float(x) for x in re.findall(r"-?\d+\.\d+", p["pos"])]
    ref_pos = [r["pos"][i][a] * k for a in range(3)]
    st, T = r["st"][i], r["temp"][s][i]
    ok_pos = all(abs(a - b) <= 0.0005 + 1e-9 for a, b in zip(pos, ref_pos))
    if math.isnan(st):
        ok_st = "not computed" in p["solid"]
    else:
        ok_st = abs(float(re.findall(r"-?\d+\.\d+", p["solid"])[0]) - st) <= 0.005 + 1e-9
    if math.isnan(T):
        ok_T = "not computed" in p["temp"]
    else:
        c, kel = [float(x) for x in re.findall(r"-?\d+\.\d+", p["temp"])[:2]]
        ok_T = abs(c - (T - 273.15)) <= 0.005 + 1e-9 and abs(kel - T) <= 0.005 + 1e-9
    flag = "OK " if (ok_pos and ok_st and ok_T) else "BAD"
    bad += flag == "BAD"
    print(f"{flag} v{i:<6} snap {s}  app pos {p['pos']:<28} ref ({ref_pos[0]:.3f}, {ref_pos[1]:.3f}, {ref_pos[2]:.3f})  "
          f"app st {p['solid']:<20} ref {st:.2f}  app T {p['temp']:<22} ref {T - 273.15:.2f} °C ({T:.2f} K)")
print(f"{len(rows)} probes, {bad} mismatches")
