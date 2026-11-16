#!/usr/bin/env python3
"""regime-diag/prims.py — EDGE-REGIME-DIAG-W1: the bridge to the pinned statistics primitives.

The harness reuses, and never re-implements, `src/scripts/cluster-perm-stats.py` (ci_lower, ci_upper, arm_seed,
kish_eff, bh, perm_test, FLOOR_CLUSTERS) and `ops/monitoring/population_comparison.py`
(attainable_bound_from_share). This file loads both by path and answers one JSON request on stdin with one JSON
reply on stdout. Standard library only. Any error is a non-zero exit with the reason on stderr: a caller never
reads a number from a failed call.

The request is framed (EDGE-REGIME-DIAG-BRIDGE-W1): `prims.py --bytes <n>` reads exactly n bytes of UTF-8 JSON
from stdin, answers and exits. It never waits for end-of-input, which once never came (a `bounds` child blocked
in `read()` for an hour inside `json.load(sys.stdin)`). Fewer than n bytes at end-of-input is a truncated
request: a non-zero exit, `truncated request` on stderr, nothing on stdout.

Request: {"ops": [ {"op": ...}, ... ]}   Reply: {"out": [ ... ]}  (one entry per op, in order)
  {"op": "seeds", "label": str, "arms": [str]}                      -> [int]
  {"op": "bounds", "alpha": float, "series": [[float]]}             -> [[lower, upper]]
  {"op": "kish", "sizes": [[float]]}                                -> [float]
  {"op": "bh", "q": float, "pvals": [float]}                        -> [bool]
  {"op": "attainable", "shares": [float]}                           -> [float | null]
  {"op": "perm", "levels": [int], "wins": [int], "clusters": [int], "B": int, "seed": int}
                                                                    -> {"rho" (null when undefined), "p", "s_obs", "centre"}
  {"op": "floor"}                                                   -> int
"""
import importlib.util
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(REPO, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def read_request(argv, stdin):
    """The framed request: `--bytes <n>`, then exactly n bytes from `stdin` (a binary stream). Never reads past
    them and never waits for end-of-input."""
    if len(argv) != 2 or argv[0] != "--bytes" or not re.fullmatch(r"[0-9]+", argv[1]):
        raise SystemExit("usage: prims.py --bytes <n>  (the request's exact length in bytes)")
    n = int(argv[1])
    data = stdin.read(n)
    if len(data) < n:
        raise SystemExit("truncated request: %d of %d bytes before end-of-input" % (len(data), n))
    return json.loads(data.decode("utf-8"))


def main():
    cps = _load("cluster_perm_stats", "src/scripts/cluster-perm-stats.py")
    pc = _load("population_comparison", "ops/monitoring/population_comparison.py")
    req = read_request(sys.argv[1:], sys.stdin.buffer)
    out = []
    for o in req["ops"]:
        op = o["op"]
        if op == "seeds":
            out.append([cps.arm_seed(o["label"], a) for a in o["arms"]])
        elif op == "bounds":
            a = o["alpha"]
            if not (0.0 < a < 0.5):
                raise ValueError("bounds: alpha must be inside (0, 0.5)")
            res = []
            for s in o["series"]:
                if not s or any(v is None or v != v for v in s):
                    raise ValueError("bounds: an empty series, or one with an undefined replicate")
                res.append([cps.ci_lower(s, a), cps.ci_upper(s, a)])
            out.append(res)
        elif op == "kish":
            out.append([cps.kish_eff(s) if s else 0.0 for s in o["sizes"]])
        elif op == "bh":
            out.append([bool(x) for x in cps.bh(o["pvals"], o["q"])])
        elif op == "attainable":
            out.append([pc.attainable_bound_from_share(q) for q in o["shares"]])
        elif op == "perm":
            rho, p, s_obs, centre = cps.perm_test(o["levels"], o["wins"], o["clusters"], o["B"], random.Random(o["seed"]))
            # a constant level or a constant win has no rank correlation: spearman is undefined, reported as null
            out.append({"rho": rho if rho == rho else None, "p": p, "s_obs": s_obs, "centre": centre})
        elif op == "floor":
            out.append(cps.FLOOR_CLUSTERS)
        else:
            raise ValueError("unknown op: %r" % (op,))
    json.dump({"out": out}, sys.stdout, allow_nan=False)


if __name__ == "__main__":
    main()
