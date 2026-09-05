#!/usr/bin/env python3
"""Known-answer validation for src/scripts/cluster-perm-stats.py.

A null from an instrument that has not been shown to detect a signal is worthless. Every fixture
here has an ANSWER KNOWN IN ADVANCE, and each is PAIRED: the test must fire on signal AND stay
quiet on noise, so a one-sided pass is impossible. The first 22 checks are EDGE-SELL-FEATURE-
ATTRIBUTION-W1's, re-run against the committed module; the rest are new to
EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1 and cover the enforced floor, the linear-probability
model with cluster inference, the logistic propensity model and IPW.

Prints `SELF-TEST: PASS (N checks)` and exactly one `CLUSTER_PERM_SELFTEST=PASS|FAIL` token.
Deterministic: every rng is seeded here, so a count printed by this file is REPRODUCIBLE -- which
is the property W1's quoted "7/120 = 0.058" lacked (no surviving artifact could produce it).

Run:  python3 tests/unit/cluster-perm-stats.selftest.py
"""
import importlib.util
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(HERE, "..", "..", "src", "scripts", "cluster-perm-stats.py")
spec = importlib.util.spec_from_file_location("cps", MOD)
cps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cps)

checks = 0
fails = 0


def check(name, cond, detail=""):
    global checks, fails
    checks += 1
    if cond:
        print(f"SELF-TEST: ok   {name}")
    else:
        print(f"SELF-TEST: FAIL {name} {detail}")
        fails += 1


rng = random.Random(12345)


def make(n_clusters, rows_per, assoc, rnd):
    """assoc=0 -> level independent of win. assoc>0 -> higher level => higher P(win).
    Returns (levels, wins, clusters)."""
    L, W, C = [], [], []
    for c in range(n_clusters):
        for _ in range(rows_per):
            lv = rnd.choice([-60, -20, 0, 20, 60])
            p = 0.45 + assoc * (lv / 60.0)
            L.append(lv); W.append(1 if rnd.random() < p else 0); C.append(f"V|C{c}")
    return L, W, C


# ═══ W1 core (the 22) ═══════════════════════════════════════════════════════════════════════

# 1. STRONG association must be detected
L, W, C = make(120, 12, 0.20, rng)
rho_s, p_s, _, _ = cps.perm_test(L, W, C, 2000, rng)
check("strong association is DETECTED (p < 0.01)", p_s < 0.01, f"p={p_s}")
check("strong positive association gives positive rho", rho_s > 0, f"rho={rho_s}")

# 2. NO association: CALIBRATION as a RATE, deterministic, with a bound that can separate alpha=0.05
#    from 0.10 at ~80% power. TRIALS=200, bound fp<=16: under H0 (p=.05) P(X>16)~1.8%; under a true
#    FPR of 0.10 P(X<=16)~20% -> ~80% power; under W1's pre-fix 0.15 P(X<=16)<0.5%.
CAL_TRIALS, CAL_BOUND, CAL_B = 200, 16, 400
cal_rng = random.Random(20260904)
fp = 0
for _ in range(CAL_TRIALS):
    L0, W0, C0 = make(60, 8, 0.0, cal_rng)
    _, p_i, _, _ = cps.perm_test(L0, W0, C0, CAL_B, cal_rng)
    if p_i < 0.05:
        fp += 1
print(f"SELF-TEST: calibration fp={fp}/{CAL_TRIALS} rate={fp/CAL_TRIALS:.4f} B={CAL_B} seed=20260904")
check(f"noise false-positive rate is near alpha ({fp}/{CAL_TRIALS} <= {CAL_BOUND})", fp <= CAL_BOUND, f"fpr={fp/CAL_TRIALS}")

# 2b. the CENTRE is the EXACT null mean, pinned structurally (a calibration count cannot see this:
#     the simulated-mean centre biases the tail count only at O(1/B), invisible at any B this file runs).
#     Hand-computed: cluster A ranks {1,2,3} with 1 winner -> 1*2.0; cluster B ranks {4,5} with 2 winners
#     -> 2*4.5; exact E[S] = 11.0. Levels are distinct so midranks are 1..5 in level order.
_, _, s_obs_c, centre_c = cps.perm_test([10, 20, 30, 40, 50], [1, 0, 0, 1, 1], ["A", "A", "A", "B", "B"], 2000, random.Random(1))
check("perm_test centre is the EXACT null mean (hand-computed 11.0), not the simulated one", abs(centre_c - 11.0) < 1e-12, centre_c)
check("perm_test s_obs is the observed winner-rank sum (1+4+5 = 10)", abs(s_obs_c - 10.0) < 1e-12, s_obs_c)

# 3. sign is recovered, not just magnitude
L, W, C = make(120, 12, -0.20, rng)
rho_g, p_g, _, _ = cps.perm_test(L, W, C, 2000, rng)
check("NEGATIVE association gives negative rho", rho_g < 0, f"rho={rho_g}")
check("negative association is DETECTED", p_g < 0.01, f"p={p_g}")

# 4. the null must respect CLUSTERING
L, W, C = [], [], []
for c in range(120):
    lv = rng.choice([-60, -20, 0, 20, 60])
    p = 0.45 + 0.20 * (lv / 60.0)
    for _ in range(12):
        L.append(lv); W.append(1 if rng.random() < p else 0); C.append(f"V|C{c}")
rho_b, p_b, _, _ = cps.perm_test(L, W, C, 2000, rng)
check("between-cluster-only association is NOT called significant", p_b > 0.05, f"p={p_b}")

# 5. midranks + spearman against hand-computed values
check("midranks handle ties", cps.midranks([10, 10, 20]) == [1.5, 1.5, 3.0], cps.midranks([10, 10, 20]))
check("spearman on a binary outcome tops out at 0.894427, not 1.0",
      abs(cps.spearman([1, 2, 3, 4], [0, 0, 1, 1]) - 0.894427) < 1e-6)
check("spearman is symmetric under reversal", abs(cps.spearman([1, 2, 3, 4], [1, 1, 0, 0]) + 0.894427) < 1e-6)
check("spearman DOES reach +1 with no ties", abs(cps.spearman([1, 2, 3], [1, 2, 3]) - 1.0) < 1e-9)
check("spearman DOES reach -1 with no ties", abs(cps.spearman([1, 2, 3], [3, 2, 1]) + 1.0) < 1e-9)
check("spearman is NaN on a constant vector", cps.spearman([5, 5, 5], [0, 1, 0]) != cps.spearman([5, 5, 5], [0, 1, 0]))

# 6. BH-FDR against hand-computed cases
check("BH rejects nothing when all p are large", cps.bh([0.9, 0.8, 0.7, 0.6], 0.05) == [False] * 4)
check("BH rejects the single tiny p", cps.bh([0.001, 0.8, 0.7, 0.6], 0.05) == [True, False, False, False])
check("BH step-up rejects the larger p when the smaller qualifies",
      cps.bh([0.001, 0.02, 0.9, 0.9], 0.05) == [True, True, False, False])
check("BH at q=0 rejects nothing", cps.bh([0.0001, 0.0002], 0.0) == [False, False])

# 7. the split must be disjoint, deterministic and ~70/30
cl = [f"V|C{i}" for i in range(1000)]
tr, ho = cps.split_clusters(cl, "SEED-A")
check("split is disjoint", not (tr & ho))
check("split is 70/30", len(tr) == 700 and len(ho) == 300)
tr2, _ = cps.split_clusters(cl, "SEED-A")
check("split is deterministic across runs", tr == tr2)
tr3, _ = cps.split_clusters(cl, "SEED-B")
check("a different seed gives a different split", tr != tr3)

# 8. cluster aggregation must be UNWEIGHTED
lopL = [0] * 1010
lopW = [1] * 1000 + [0] * 10
lopC = ["V|BIG"] * 1000 + [f"V|S{i}" for i in range(10)]
got = cps.cluster_level_means(lopL, lopW, lopC, [0], 500, rng)[0]
check("cluster mean ignores cluster SIZE (1 big win-cluster + 10 small loss-clusters -> ~0.09)",
      abs(got["cluster_mean"] - 1 / 11) < 1e-6, got["cluster_mean"])
check("pooled would have said ~0.99 -- reported separately, never used for the test", got["pooled"] > 0.98, got["pooled"])

# ═══ NEW: the enforced floor ════════════════════════════════════════════════════════════════
fl_L = [10] * 49 + [20] * 50 + [30] * 51
fl_C = [f"a{i}" for i in range(49)] + [f"b{i}" for i in range(50)] + [f"c{i}" for i in range(51)]
pw, ind = cps.powered_levels(fl_L, fl_C, 50)
check("floor is INCLUSIVE: 50 clusters is powered, 49 is not", pw == [20, 30] and ind == {10: 49}, (pw, ind))
pw2, ind2 = cps.powered_levels([10] * 200, ["same"] * 200, 50)
check("floor counts CLUSTERS, not rows: 200 rows in one cluster is INDETERMINATE", pw2 == [] and ind2 == {10: 1}, (pw2, ind2))
check("the module reads FLOOR_CLUSTERS=50 (not a stale quote)", cps.FLOOR_CLUSTERS == 50 and cps.powered_levels(fl_L, fl_C) == (pw, ind))

# ═══ NEW: OLS + cluster inference ═══════════════════════════════════════════════════════════
r2 = random.Random(777)
n = 600
X = [[1.0, r2.uniform(-1, 1), r2.uniform(-1, 1), r2.choice([0.0, 1.0])] for _ in range(n)]
beta_true = [0.3, 1.5, -2.0, 0.7]
y_exact = [sum(b * v for b, v in zip(beta_true, row)) for row in X]
b_hat, resid = cps.ols(X, y_exact)
check("OLS recovers an exact linear model to 1e-9", max(abs(a - b) for a, b in zip(b_hat, beta_true)) < 1e-9, b_hat)
check("OLS residuals vanish on an exact model", max(abs(r) for r in resid) < 1e-9)
y_noisy = [v + r2.gauss(0, 0.3) for v in y_exact]
b_hat2, _ = cps.ols(X, y_noisy)
check("OLS recovers a noisy linear model within 0.1", max(abs(a - b) for a, b in zip(b_hat2, beta_true)) < 0.1, b_hat2)
try:
    cps.ols([[1.0, 2.0], [2.0, 4.0], [3.0, 6.0]], [1.0, 2.0, 3.0])
    check("OLS REFUSES a singular design (raises)", False)
except ValueError:
    check("OLS REFUSES a singular design (raises)", True)

# weighted OLS: doubling a row's weight == duplicating the row
Xw = [[1.0, 0.0], [1.0, 1.0], [1.0, 2.0], [1.0, 3.0]]
yw = [1.0, 3.0, 2.0, 5.0]
bw, _ = cps.ols(Xw, yw, [2.0, 1.0, 1.0, 1.0])
bd, _ = cps.ols([Xw[0]] + Xw, [yw[0]] + yw)
check("weighted OLS: weight 2 on a row equals duplicating it", max(abs(a - b) for a, b in zip(bw, bd)) < 1e-9)

# CR1 vs classical: iid errors -> ratio ~ 1; single-row clusters -> HC0 x small-sample factor
r3 = random.Random(31)
n, G = 2000, 200
X = [[1.0, r3.uniform(-1, 1)] for _ in range(n)]
C = [f"g{i % G}" for i in range(n)]
y = [0.5 + 1.0 * row[1] + r3.gauss(0, 1) for row in X]
b, res = cps.ols(X, y)
se_cl, Gn = cps.cluster_robust_se(X, res, C)
se_ho = cps.classical_se(X, res)
ratio = se_cl[1] / se_ho[1]
check(f"CR1 ~ classical under iid errors (ratio {ratio:.3f} in [0.8, 1.25])", 0.8 < ratio < 1.25 and Gn == G)
# cluster-constant regressor + cluster-shared error -> CR1 must be MUCH larger than classical
Xc, yc, Cc = [], [], []
for g in range(G):
    xg = r3.uniform(-1, 1); ug = r3.gauss(0, 1)
    for _ in range(10):
        Xc.append([1.0, xg]); yc.append(0.5 + 1.0 * xg + ug + r3.gauss(0, 0.1)); Cc.append(f"g{g}")
bc, resc = cps.ols(Xc, yc)
se_c, _ = cps.cluster_robust_se(Xc, resc, Cc)
se_h = cps.classical_se(Xc, resc)
check(f"CR1 >> classical under cluster-shared errors (ratio {se_c[1]/se_h[1]:.2f} > 2)", se_c[1] / se_h[1] > 2.0)
# single-row clusters: CR1 == HC0 * G/(G-1) * (n-1)/(n-k), HC0 computed independently here
Xs = X[:300]; ys = y[:300]; Cs = [f"row{i}" for i in range(300)]
bs, rs = cps.ols(Xs, ys)
se_s, _ = cps.cluster_robust_se(Xs, rs, Cs)
k = 2; nn = 300
xtx = [[sum(r[a] * r[b] for r in Xs) for b in range(k)] for a in range(k)]
det = xtx[0][0] * xtx[1][1] - xtx[0][1] * xtx[1][0]
inv = [[xtx[1][1] / det, -xtx[0][1] / det], [-xtx[1][0] / det, xtx[0][0] / det]]
meat = [[sum(rs[i] ** 2 * Xs[i][a] * Xs[i][b] for i in range(nn)) for b in range(k)] for a in range(k)]
V = [[sum(inv[a][c] * sum(meat[c][d] * inv[d][b] for d in range(k)) for c in range(k)) for b in range(k)] for a in range(k)]
hc0 = [math.sqrt(V[j][j]) for j in range(k)]
fac = math.sqrt((nn / (nn - 1)) * ((nn - 1) / (nn - k)))
check("CR1 with one row per cluster == HC0 x the small-sample factor", all(abs(se_s[j] - hc0[j] * fac) < 1e-9 for j in range(k)), (se_s, [h * fac for h in hc0]))

# cluster bootstrap: covers the truth, narrows with n, refuses to hide singular draws
bo = cps.cluster_bootstrap_ols(X, y, C, 300, random.Random(5))
lo, hi = bo["coef"][1]["ci95"]
check(f"cluster-bootstrap CI covers the true slope 1.0 ([{lo:.3f},{hi:.3f}])", lo < 1.0 < hi and bo["draws_used"] == 300)
check("cluster-bootstrap same-sign fraction is ~1 for a strong slope", bo["coef"][1]["same_sign_frac"] > 0.99)
bo_small = cps.cluster_bootstrap_ols(X[:200], y[:200], C[:200], 300, random.Random(5))
w_small = bo_small["coef"][1]["ci95"][1] - bo_small["coef"][1]["ci95"][0]
check("cluster-bootstrap CI is WIDER on a tenth of the data", w_small > (hi - lo) * 1.5, (w_small, hi - lo))

# ═══ NEW: logistic + IPW ════════════════════════════════════════════════════════════════════
r4 = random.Random(99)
n = 20000
Xl = [[1.0, r4.uniform(-2, 2), r4.choice([0.0, 1.0])] for _ in range(n)]
bl_true = [-0.5, 1.2, 0.8]
yl = [1 if r4.random() < 1 / (1 + math.exp(-sum(b * v for b, v in zip(bl_true, row)))) else 0 for row in Xl]
fit = cps.logistic_irls(Xl, yl)
check("logistic IRLS recovers the coefficients within 0.1 at n=20k", max(abs(a - b) for a, b in zip(fit["beta"], bl_true)) < 0.1, fit["beta"])
check("logistic IRLS converges and flags no separation", fit["converged"] and not fit["separated"])
check("logistic fitted probabilities lie strictly in (0,1)", all(0 < p < 1 for p in fit["p_hat"]))
# separable design: must return finite numbers and FLAG it, never raise
Xsep = [[1.0, float(i)] for i in range(-20, 21)]
ysep = [1 if i > 0 else 0 for i in range(-20, 21)]
fsep = cps.logistic_irls(Xsep, ysep)
check("logistic on a separable design returns finite numbers and FLAGS separation",
      all(math.isfinite(b) for b in fsep["beta"]) and fsep["separated"], fsep["beta"])

# IPW known answer: two strata with opposite true slopes (+1 / -1), equal population sizes, so the
# population-average slope is 0. Selection over-samples stratum A (0.9 vs 0.1). The unweighted
# slope on the selected rows is biased toward +1; IPW on P(select | stratum) recovers ~0.
r5 = random.Random(2024)
Xp, yp, Sp, PH = [], [], [], []
for i in range(40000):
    a = 1.0 if i % 2 == 0 else 0.0
    x = r5.uniform(-1, 1)
    yv = (1.0 if a else -1.0) * x + r5.gauss(0, 0.2)
    ps = 0.9 if a else 0.1
    Xp.append([1.0, x]); yp.append(yv); Sp.append(r5.random() < ps); PH.append(ps)
Xsel = [row for row, s in zip(Xp, Sp) if s]; ysel = [v for v, s in zip(yp, Sp) if s]
b_unw, _ = cps.ols(Xsel, ysel)
wts = cps.ipw_weights(PH, Sp)
wsel = [w for w, s in zip(wts, Sp) if s]
b_ipw, _ = cps.ols(Xsel, ysel, wsel)
check(f"unweighted slope on the selected sample is biased toward the over-sampled stratum ({b_unw[1]:.3f} > 0.5)", b_unw[1] > 0.5)
check(f"IPW slope recovers the population average ~0 ({b_ipw[1]:.3f})", abs(b_ipw[1]) < 0.1)
check("IPW gives unselected rows weight 0 and selected rows positive weight", all((w == 0.0) != s for w, s in zip(wts, Sp)))
try:
    cps.ipw_weights([0.0, 0.5], [True, True]); check("IPW refuses a selected row with p_hat=0", False)
except ValueError:
    check("IPW refuses a selected row with p_hat=0", True)
check("normal_sf(1.959964) ~= 0.05 two-sided", abs(cps.normal_sf(1.959964) - 0.05) < 1e-4)
check("normal_sf(0) == 1", abs(cps.normal_sf(0.0) - 1.0) < 1e-12)

print(f"SELF-TEST: {'PASS' if fails == 0 else 'FAIL'} ({checks} checks)")
print(f"CLUSTER_PERM_SELFTEST={'PASS' if fails == 0 else 'FAIL'} failures={fails} checks={checks}")
sys.exit(0 if fails == 0 else 1)
