"""DECISION-CALL-V2-W4 CH2 (AC2.1): the BM fixture vectors `noEdgeOdds` is checked against.

The study emits no BM vectors (its fixtures stage writes sigma-vectors.json and liquidation-grid.json
only), so this TEST-SCOPE harness imports the study's own `bm_probs`, `log_barriers` and
`liq_log_distance` and writes bm-vectors.json beside itself. Nothing here re-implements the model:
every raw value is the study's function, and every expected bin is the study's own rule,
`searchsorted(edges, v, side="right")`, applied to the edges of the generated table as committed.

Run from the repo root, with numpy pinned as the study's PEP 723 header pins it:
  uv run --no-project --python 3.12 --with numpy==2.5.4 python -I tests/fixtures/odds-calibration/gen_bm_vectors.py
"""
import hashlib
import importlib.util
import json
import math
import re
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STUDY = ROOT / "scripts" / "odds-calibration-study.py"
TABLE = ROOT / "src" / "lib" / "pre-trade-odds-calibration.ts"
OUT = HERE / "bm-vectors.json"

# The domain guard noEdgeOdds applies (the study's series is exact everywhere else): past the study's
# saturation ratio, the shortcut S = 1, up = 0 is exact only while both barriers sit at least this many
# sigma_H away (2*Phi(-8.2) ~ 2.4e-16, below a double's resolution at 1).
SATURATION_EXACT_SIGMA = 8.2
# Within this of a bin edge, TS and numpy may round a raw value to either side, so the vector allows BOTH
# bins beside that edge (and only those). 1e-12 is ~1000x the series' summation noise (~1e-15 absolute). The
# 0.0 edge is exempt: a clipped value is never below it and bin 0 is [-inf, 0), so 0.0 and a residue bin alike.
NEAR_EDGE = 1e-12

spec = importlib.util.spec_from_file_location("odds_study", STUDY)
st = importlib.util.module_from_spec(spec)
spec.loader.exec_module(st)

BIN = re.compile(r"\{ lo: ([^,]+), hi: ([^,]+), value: ([^,]+), nFit: (\d+) \}")


def table():
    text = TABLE.read_text()
    out = {}
    for field in ("timeout", "target_first", "liquidation"):
        start = text.index(f"    {field}: {{")
        block = text[start:text.index("      reliability:", start)]
        bins = [m.groups() for m in BIN.finditer(block)]
        assert len(bins) == st.RECAL_BINS, (field, len(bins))
        edges = np.array([float(b[1]) for b in bins[:-1]])
        values = [None if b[2] == "null" else float(b[2]) for b in bins]
        out[field] = (edges, values)
    return out, hashlib.sha256(text.encode()).hexdigest()


TAB, TABLE_SHA = table()


def bin_of(field, v):
    """(the study's bin, its value, every bin a TS value within NEAR_EDGE of v may legitimately land in)."""
    edges, values = TAB[field]
    j = int(np.searchsorted(edges, v, side="right"))
    allowed = {j}
    for i in np.nonzero((np.abs(edges - v) < NEAR_EDGE) & ~((edges == 0.0) & (v >= 0.0)))[0]:
        allowed |= {int(i), int(i) + 1}
    return j, values[j], sorted(allowed)


def bracket(side, stop_pct, target_pct, sigma_hold_pct, label=""):
    longs = np.array([side == "long"])
    s, t, sh = stop_pct / 100.0, target_pct / 100.0, sigma_hold_pct / 100.0
    with np.errstate(divide="ignore", invalid="ignore"):
        a, b = st.log_barriers(longs, np.array([s]), np.array([t]))
    a, b = float(a[0]), float(b[0])
    v = {"label": label, "side": side, "stopPct": stop_pct, "targetPct": target_pct, "sigmaHoldPct": sigma_hold_pct}
    guarded = (not (math.isfinite(a) and math.isfinite(b))) or (
        (a + b) / sh > st.BM_RATIO_SATURATION and min(a, b) / sh < SATURATION_EXACT_SIGMA)
    v["guarded"] = bool(guarded)
    if guarded:
        return v
    S, up = st.bm_probs(np.array([a]), np.array([b]), np.array([sh]))
    _S2, dn = st.bm_probs(np.array([b]), np.array([a]), np.array([sh]))
    timeout, target_first, stop_first = float(S[0]), float(up[0]), float(dn[0])
    assert abs(timeout + target_first + stop_first - 1.0) <= 1e-9, v
    jt, pt, at = bin_of("timeout", timeout)
    jf, pf, af = bin_of("target_first", target_first)
    v.update({"timeout": timeout, "targetFirst": target_first, "stopFirst": stop_first,
              "timeoutBin": jt, "targetFirstBin": jf, "timeoutBins": at, "targetFirstBins": af,
              "pTimeout": pt, "pTargetFirst": pf, "pStopFirst": max(0.0, 1.0 - pt - pf),
              "nearEdge": len(at) > 1 or len(af) > 1})
    return v


def liquidation(side, liq_pct, sigma_hold_pct, label=""):
    v = {"label": label, "side": side, "liqDistancePct": liq_pct, "sigmaHoldPct": sigma_hold_pct}
    d = liq_pct / 100.0
    if not d > 0:
        v["guarded"] = True
        return v
    with np.errstate(divide="ignore"):
        d_ln = float(st.liq_log_distance(np.array([side == "long"]), np.array([d]))[0])
    x = d_ln / (sigma_hold_pct / 100.0)
    v["guarded"] = not math.isfinite(x)
    if v["guarded"]:
        return v
    j, p, allowed = bin_of("liquidation", x)
    v.update({"dOverSigmaH": x, "liqBin": j, "liqBins": allowed, "pLiqHold": p, "nearEdge": len(allowed) > 1})
    return v


rng = np.random.default_rng(20261106)
SIGMAS = [0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 15.0, 30.0]
br, lq = [], []
for side in ("long", "short"):
    for s, t in ((0.5, 0.75), (1.0, 2.0), (2.5, 5.0), (5.0, 10.0)):
        for sh in SIGMAS:
            br.append(bracket(side, s, t, sh, "study bracket"))
    for sh in SIGMAS:
        br.append(bracket(side, sh, 2 * sh, sh, "study 1 sigma / 2 sigma"))
for _ in range(400):
    side = "long" if rng.integers(0, 2) else "short"
    s = float(round(10 ** rng.uniform(-2, math.log10(50)), 4))
    t = float(round(10 ** rng.uniform(-2, 3), 4))
    sh = float(round(10 ** rng.uniform(-2, math.log10(30)), 4))
    br.append(bracket(side, s, t, sh, "random production domain"))
# named edges: the inexact-shortcut region, a non-finite short barrier, the exact saturated region
br.append(bracket("long", 0.01, 1000.0, 0.11, "guard: saturated with a near stop"))
br.append(bracket("short", 2.0, 100.0, 1.0, "guard: short target 100% (barrier inf)"))
br.append(bracket("short", 2.0, 150.0, 1.0, "guard: short target 150% (barrier nan)"))
br.append(bracket("long", 50.0, 1000.0, 0.1, "exact saturation: both barriers far"))
# the clamp: the two calibrated values sum above 1, so p_stop_first is 0 (ruling Q1)
clamp = None
for t in np.arange(1.90, 2.30, 0.002):
    for s in np.arange(2.60, 3.20, 0.004):
        c = bracket("long", float(round(s, 4)), float(round(t, 4)), 1.0, "clamp: calibrated sum above 1")
        if not c["guarded"] and not c["nearEdge"] and c["pTimeout"] + c["pTargetFirst"] > 1.0 \
                and abs(c["timeout"] - 0.96) < 0.01 and abs(c["targetFirst"] - 0.036) < 0.006:
            clamp = c
            break
    if clamp:
        break
assert clamp is not None, "no clamp vector found"
br.append(clamp)

for side in ("long", "short"):
    for lp in (0.5, 1.0, 1.9, 4.6185, 9.6386, 19.6787, 45.0, 99.9):
        for sh in SIGMAS:
            lq.append(liquidation(side, lp, sh, "grid"))
lq.append(liquidation("long", 0.0, 1.0, "guard: zero distance"))
lq.append(liquidation("long", -0.5, 1.0, "guard: negative distance (1/L below m)"))
lq.append(liquidation("long", 100.0, 1.0, "guard: long at 100% (d_ln inf)"))

kept_b, kept_l = br, lq
doc = {
    "_generated_by": "tests/fixtures/odds-calibration/gen_bm_vectors.py (DECISION-CALL-V2-W4 CH2, AC2.1)",
    "_study_sha256": hashlib.sha256(STUDY.read_bytes()).hexdigest(),
    "_table_sha256": TABLE_SHA,
    "_numpy": np.__version__,
    "_near_edge": {"bracket": sum(1 for v in br if v.get("nearEdge")), "liquidation": sum(1 for v in lq if v.get("nearEdge"))},
    "saturationRatio": st.BM_RATIO_SATURATION,
    "saturationExactSigma": SATURATION_EXACT_SIGMA,
    "bracket": kept_b,
    "liquidation": kept_l,
}
OUT.write_text(json.dumps(doc, indent=1, allow_nan=False) + "\n")
g = sum(1 for v in kept_b if v["guarded"])
print(f"wrote {OUT.relative_to(ROOT)}: {len(kept_b)} bracket ({g} guarded), {len(kept_l)} liquidation; "
      f"near-edge {doc['_near_edge']}; clamp {clamp['stopPct']}/{clamp['targetPct']} "
      f"raw {clamp['timeout']:.6f}+{clamp['targetFirst']:.6f} -> {clamp['pTimeout']:.6f}+{clamp['pTargetFirst']:.6f}")
