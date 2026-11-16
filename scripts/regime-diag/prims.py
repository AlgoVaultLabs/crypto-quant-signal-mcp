#!/usr/bin/env python3
"""regime-diag/prims.py — EDGE-REGIME-DIAG-W1: the bridge to the pinned statistics primitives.

The harness reuses, and never re-implements, `src/scripts/cluster-perm-stats.py` (ci_lower, ci_upper, arm_seed,
kish_eff, bh, perm_test, FLOOR_CLUSTERS) and `ops/monitoring/population_comparison.py`
(attainable_bound_from_share). This file loads both by path and answers one JSON request on stdin with one JSON
reply on stdout. Standard library only. Any error is a non-zero exit with the reason on stderr: a caller never
reads a number from a failed call.

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
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(REPO, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    cps = _load("cluster_perm_stats", "src/scripts/cluster-perm-stats.py")
    pc = _load("population_comparison", "ops/monitoring/population_comparison.py")
    req = json.load(sys.stdin)
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
