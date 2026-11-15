#!/usr/bin/env python3
"""
fake_solver.py - stand-in for the Ayrton solidification solver (task round).

It does not solve anything. It behaves, from the outside, like the real solver:
it takes a while, prints progress and logs, writes warnings, and runs its
number-crunching in a separate worker process.

Usage
  python fake_solver.py --case results.ayr [--steps 200] [--fail-at PCT] [--seed N]

Options
  --case PATH        .ayr case file (required). The solver checks the magic bytes.
  --steps N          number of time steps (default 200, about 80 s).
  --fail-at PCT      simulate a solver crash when progress reaches PCT percent.
  --seed N           seed for the simulated residuals and warnings (default 0).
  --step-time SEC    wall-clock seconds per time step (default 0.4).
  --heartbeat PATH   heartbeat file (default: .solver_heartbeat next to the case file).

Output
  stdout: log lines. Progress lines have the form
              PROGRESS <pct> <message>
          where <pct> is a decimal number from 0 to 100.
  stderr: warnings and errors.

Exit codes
  0  finished
  2  bad arguments or unreadable / invalid case file
  3  solver failure (for example with --fail-at)
  4  worker process died unexpectedly

Requires Python 3.9 or newer, standard library only. Works on Windows, Linux, macOS.
"""
import argparse
import math
import os
import random
import subprocess
import sys
import threading
import time

VERSION = "0.9.3"


# --------------------------------------------------------------------- worker
def worker_main(a):
    """Runs the time steps. Reports each finished step to the controller on stdout."""
    state = {"step": 0}
    stop = threading.Event()

    def heartbeat():
        tmp = a.heartbeat + ".tmp"
        while not stop.is_set():
            try:
                with open(tmp, "w") as f:
                    f.write("pid=%d step=%d time=%.3f\n" % (os.getpid(), state["step"], time.time()))
                os.replace(tmp, a.heartbeat)
            except OSError:
                pass
            stop.wait(0.5)

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()
    rng = random.Random(a.seed * 7919 + 1)
    report = True
    try:
        for i in range(1, a.steps + 1):
            t_end = time.time() + a.step_time
            # a little real arithmetic so the process shows up as busy
            acc = 0.0
            while time.time() < t_end:
                for k in range(2000):
                    acc += math.sin(k * 0.001 + i)
                time.sleep(0.01)
            state["step"] = i
            res = 10 ** (-1.0 - 4.0 * i / a.steps) * (1.0 + 0.3 * rng.random())
            if report:
                try:
                    sys.stdout.write("STEP %d %.6e %.6e\n" % (i, res, acc))
                    sys.stdout.flush()
                except (BrokenPipeError, OSError, ValueError):
                    report = False  # nobody listening any more; keep computing
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        hb.join(timeout=2)
        try:
            os.remove(a.heartbeat)
        except OSError:
            pass
    try:
        sys.stdout.close()
    except Exception:
        pass
    os._exit(0)


# ----------------------------------------------------------------- controller
def read_case(path):
    try:
        with open(path, "rb") as f:
            head = f.read(19 + 255)
            size = os.fstat(f.fileno()).st_size
    except OSError as e:
        return None, "cannot open case file: %s" % e
    if len(head) < 19 or head[0:4] != b"AYRN":
        return None, "not an .ayr case file (bad magic)"
    name = head[19:19 + head[18]].decode("utf-8", "replace")
    return {"size": size, "name": name}, None


def main():
    ap = argparse.ArgumentParser(description="Ayrton solidification solver (fake, for the task round)")
    ap.add_argument("--case", required=True)
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--fail-at", type=float, default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--step-time", type=float, default=0.4)
    ap.add_argument("--heartbeat", default=None)
    ap.add_argument("--_worker", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.heartbeat is None:
        a.heartbeat = os.path.join(os.path.dirname(os.path.abspath(a.case)), ".solver_heartbeat")
    if a._worker:
        worker_main(a)
        return
    if a.steps < 1:
        print("ERROR: --steps must be >= 1", file=sys.stderr)
        sys.exit(2)

    case, err = read_case(a.case)
    if err:
        print("ERROR: " + err, file=sys.stderr)
        sys.exit(2)

    rng = random.Random(a.seed)
    print("Ayrton solidification solver %s (fake)" % VERSION)
    print("Case      : %s" % os.path.abspath(a.case))
    print("Case name : %s" % case["name"])
    print("Case size : %d bytes" % case["size"])
    print("Steps     : %d" % a.steps)
    print("Reading field <T> and <alpha.metal> from case")
    print("Building mesh topology ...")
    print("PROGRESS 0.0 initialising")

    cmd = [sys.executable, os.path.abspath(__file__), "--_worker", "--case", a.case, "--steps", str(a.steps),
           "--seed", str(a.seed), "--step-time", str(a.step_time), "--heartbeat", a.heartbeat]
    worker = subprocess.Popen(cmd, stdout=subprocess.PIPE, universal_newlines=True)
    print("Worker started (pid %d)" % worker.pid)

    warn_steps = set(rng.sample(range(2, a.steps + 1), min(12, a.steps - 1))) if a.steps > 2 else set()
    burst_steps = {max(1, round(a.steps * f)) for f in (0.25, 0.5, 0.8)}
    long_steps = {max(1, round(a.steps * f)) for f in (0.4, 0.7)}
    sim_t = 0.0
    for line in iter(worker.stdout.readline, ""):
        parts = line.split()
        if len(parts) < 3 or parts[0] != "STEP":
            continue
        i, res = int(parts[1]), float(parts[2])
        dt = 0.05 * (1.0 + 0.5 * math.sin(i / 17.0))
        sim_t += dt
        pct = 100.0 * i / a.steps
        print("  step %5d  t=%9.4f s  dt=%.4f s  residual(T)=%.3e  fs_max=%.3f" % (
            i, sim_t, dt, res, min(1.0, i / a.steps * 1.1)))
        if i in warn_steps:
            kind = rng.choice([
                "WARNING: Courant number %.2f exceeds 0.9 near cell %d; reducing dt" % (
                    0.9 + 0.1 * rng.random(), rng.randrange(1, 10 ** 5)),
                "WARNING: boundary patch <ingate> has no velocity BC; using zeroGradient",
                "WARNING: %d cells with negative liquid fraction clipped to 0" % rng.randrange(1, 400),
                "WARNING: latent heat source not converged in %d inner iterations" % rng.randrange(20, 60),
            ])
            print(kind, file=sys.stderr)
        if i in burst_steps:
            print("Writing diagnostics for all interface cells:")
            n = 3000 + rng.randrange(1000)
            for c in range(n):
                print("  [diag] cell %06d T=%8.3f K fs=%.4f grad=%.3e" % (
                    rng.randrange(10 ** 6), 830 + 58 * rng.random(), rng.random(), 10 ** (1 + 3 * rng.random())))
            print("Diagnostics written (%d cells)" % n)
        if i in long_steps:
            vals = ",".join("%.6e" % (rng.random() * 10 ** -rng.randrange(1, 9)) for _ in range(8000))
            print("DEBUG residual vector: [" + vals + "]")
        print("PROGRESS %.1f time step %d/%d" % (pct, i, a.steps))
        if a.fail_at is not None and pct >= a.fail_at:
            print("ERROR: linear solver for T diverged at step %d (residual %.3e > 1e+06)" % (i, 1e6 * (1 + rng.random())),
                  file=sys.stderr)
            print("ERROR: aborting run", file=sys.stderr)
            worker.kill()
            worker.wait()
            try:
                os.remove(a.heartbeat)
            except OSError:
                pass
            sys.exit(3)
    rc = worker.wait()
    if rc != 0:
        print("ERROR: worker process exited with code %d" % rc, file=sys.stderr)
        sys.exit(4)
    print("Results ready (the fake solver never modifies the case file)")
    print("PROGRESS 100.0 finished")
    print("Solver finished in %d steps, simulated time %.3f s" % (a.steps, sim_t))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
