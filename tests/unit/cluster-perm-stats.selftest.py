#!/usr/bin/env python3
"""Known-answer validation for src/scripts/cluster-perm-stats.py.

A null from an instrument that has not been shown to detect a signal is worthless. Every fixture
here has an ANSWER KNOWN IN ADVANCE, and each is PAIRED: the test must fire on signal AND stay
quiet on noise, so a one-sided pass is impossible. The first 22 checks are EDGE-SELL-FEATURE-
ATTRIBUTION-W1's, re-run against the committed module; the rest of group CORE is new to
EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1 and covers the enforced floor, the linear-probability
model with cluster inference, the logistic propensity model and IPW. Groups K1-K13 / KP / KS / KT are
new to EDGE-SCORER-PREDICTIVE-CEILING-W1 and cover the discrimination layer: AUC exactness, the
block-stratified estimand, the JOINT cluster bootstrap, the order-statistic intervals, the label-blind
power floor, the registered decision map, the purge, the targets, S* and the whole engine under a null.

Prints `SELF-TEST: PASS (N checks)` and exactly one `CLUSTER_PERM_SELFTEST=PASS|FAIL` token.
Deterministic: every rng is seeded here, so a count printed by this file is REPRODUCIBLE -- which
is the property W1's quoted "7/120 = 0.058" lacked (no surviving artifact could produce it).

SUBSET MODE (for tests/unit/cluster-perm-stats.mutation.py only): `--only K1,K5` runs just those
groups and prints a DIFFERENT token, `CLUSTER_PERM_SELFTEST_SUBSET=PASS|FAIL`, so a partial run can
never be mistaken for the full PASS. An unknown group name is refused with
`CLUSTER_PERM_SELFTEST_SUBSET=INDETERMINATE` (exit 3), and a subset that ran zero checks is a FAIL.
A group that raises is recorded as a failed check, never a crash without a token.

Run:  python3 tests/unit/cluster-perm-stats.selftest.py
"""
import importlib.util
import math
import os
import random
import sys
import time
from statistics import NormalDist

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


# ═══ group CORE — the W1 core (the 22) + EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1 (48 in all) ═══
# Unchanged checks, seeds and order; only wrapped in a function so SUBSET MODE can skip them.

def core_w1():
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


# ═══ EDGE-SCORER-PREDICTIVE-CEILING-W1 — the discrimination layer ═══════════════════════════════
# The registered wave label (seeds and folds are derived from it exactly as the real run derives them).
LABEL = "EDGE-SCORER-PREDICTIVE-CEILING-W1"
ND = NormalDist()


def _blk(s, y):
    """Single-block (pooled) AUC through the sweep."""
    return cps.blocked_auc(s, y, [0] * len(s))[0]


def _sd(v):
    m = sum(v) / len(v)
    return math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))


def _ci95(reps):
    return cps.ci_lower(reps, 0.025), cps.ci_upper(reps, 0.025)


def segment(name, fn):
    """Run one fixture segment. A raise inside it is ONE failed line, `segment <name> completed without
    raising`, and the group goes on to its next segment. Without this, the first raise aborts every later
    check of its group, and a later ASSERTION that would have seen the defect never runs. Measured in
    review: an early IndexError hid the only K1 assertion able to see a mis-indexed bootstrap weight, and
    an early TypeError hid the only K9 assertion able to see a floor that passes whenever its SE exists.
    The mutation harness counts a `segment ... completed without raising` line as a RAISE, never as an
    assertion."""
    try:
        fn()
    except Exception as e:  # every exception, deliberately: it becomes a failed line, never a crash
        check(f"segment {name} completed without raising", False, f"{type(e).__name__}: {e}")


def _f(x, spec=".3f"):
    """Format a fixture value for a check NAME without raising on None (a name must never crash)."""
    return "None" if x is None else format(x, spec)


def _clustered_corpus(rng, G, D, sa, sb, sc, st, mu, sig, cap):
    """Synthetic known-answer corpus: score x = a_g + c_d + e and latent y* = b_g + t_d + u, so score
    and label EACH carry an instrument (g) and a day (d) component, and are independent of each other:
    the true AUC is 0.5 on every stratification. Cluster sizes are heavy-tailed (lognormal, capped).
    Returns (x, y, day, cluster)."""
    a = [rng.gauss(0, sa) for _ in range(G)]
    b = [rng.gauss(0, sb) for _ in range(G)]
    c = [rng.gauss(0, sc) for _ in range(D)]
    t = [rng.gauss(0, st) for _ in range(D)]
    X, Y, Dy, Cl = [], [], [], []
    for g in range(G):
        m = min(cap, max(1, int(rng.lognormvariate(mu, sig))))
        for _ in range(m):
            d = rng.randrange(D)
            X.append(a[g] + c[d] + rng.gauss(0, 1))
            Y.append(1 if b[g] + t[d] + rng.gauss(0, 1) > 0 else 0)
            Dy.append(d)
            Cl.append(f"COIN{g}")
    return X, Y, Dy, Cl


# ── K1 AUC exactness ─────────────────────────────────────────────────────────────────────────
# Segmented (see `segment`): each case and each fixture block runs even when an earlier one raised.
def k1_auc_exactness():
    cases = [
        ([1, 2, 3, 4], [0, 0, 1, 1], 1.0, "perfect ranking"),
        ([1, 2, 3, 4], [1, 1, 0, 0], 0.0, "reversed ranking"),
        ([5, 5, 5, 5], [0, 1, 0, 1], 0.5, "all ties"),
        ([1, 1, 2, 2], [0, 1, 0, 1], 0.5, "ties within each class pair"),
        ([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1], 0.75, "one discordant pair"),
        ([1, 2, 2, 3], [0, 1, 0, 1], 0.875, "a cross-class tie scores exactly one half (3.5/4)"),
    ]
    for ci, (s, y, want, what) in enumerate(cases):
        def one_case(s=s, y=y, want=want, what=what):
            a, b = cps.auc_midrank(s, y), _blk(s, y)
            check(f"K1 AUC {what}: {s}/{y} -> {want}", a == want and b == want, f"midrank={a} sweep={b}")
        segment(f"K1/case{ci}", one_case)

    def undefined_and_refusal():
        check("K1 AUC is UNDEFINED (None), never 0.5, with no negatives",
              cps.auc_midrank([1, 2], [1, 1]) is None and cps.blocked_auc([1, 2], [1, 1], [0, 0]) == (None, 0))
        try:
            cps.auc_midrank([1, 2], [0, 2])
            check("K1 a non-0/1 label is REFUSED", False)
        except ValueError:
            check("K1 a non-0/1 label is REFUSED", True)
    segment("K1/undefined", undefined_and_refusal)

    r = random.Random(101)

    def tied_vectors():
        worst_x = worst_rs = worst_neg = worst_mono = worst_perm = 0.0
        for _ in range(20):
            n = r.randint(40, 300)
            s = [round(r.gauss(0, 1), 1) for _ in range(n)]  # rounding forces many ties
            y = [r.randrange(2) for _ in range(n)]
            n1 = sum(y)
            n0 = n - n1
            a1 = cps.auc_midrank(s, y)
            a2 = _blk(s, y)
            _, _, s_obs, _ = cps.perm_test(s, y, ["one"] * n, 0, r)
            a3 = (s_obs - n1 * (n1 + 1) / 2.0) / (n1 * n0)
            worst_x = max(worst_x, abs(a1 - a2))
            worst_rs = max(worst_rs, abs(a1 - a3))
            ns = [-v for v in s]
            worst_neg = max(worst_neg, abs(cps.auc_midrank(ns, y) - (1 - a1)), abs(_blk(ns, y) - (1 - a2)))
            mono = [v ** 3 + v for v in s]
            ex = [math.exp(v) for v in s]
            worst_mono = max(worst_mono, abs(_blk(mono, y) - a2), abs(_blk(ex, y) - a2), abs(cps.auc_midrank(mono, y) - a1))
            order = list(range(n))
            r.shuffle(order)
            worst_perm = max(worst_perm, abs(_blk([s[i] for i in order], [y[i] for i in order]) - a2))
        check(f"K1 sweep == midrank-sum AUC on 20 tied vectors (max diff {worst_x:.1e})", worst_x < 1e-12)
        check(f"K1 AUC == the perm_test winner rank-sum identity (s_obs - n1(n1+1)/2)/(n1 n0) (max {worst_rs:.1e})", worst_rs < 1e-12)
        check(f"K1 AUC(-s) == 1 - AUC(s) with ties, both implementations (max {worst_neg:.1e})", worst_neg < 1e-12)
        check(f"K1 AUC invariant to monotone transforms (s^3+s, exp) (max {worst_mono:.1e})", worst_mono < 1e-12)
        check(f"K1 AUC invariant to row order (max {worst_perm:.1e})", worst_perm < 1e-12)
    segment("K1/tied-vectors", tied_vectors)

    # block decomposition: blocked AUC == sum_b n1b n0b AUC_b / sum_b n1b n0b, AUC_b by the midrank sum.
    # The corpus is drawn OUTSIDE the segments, so a raise in one segment cannot change the other's data.
    n = 600
    s = [round(r.gauss(0, 1), 1) for _ in range(n)]
    y = [r.randrange(2) for _ in range(n)]
    bl = [r.randrange(3) for _ in range(n)]
    w = [r.randrange(4) for _ in range(n)]

    def blocks():
        num = den = 0.0
        for b in range(3):
            sb = [s[i] for i in range(n) if bl[i] == b]
            yb = [y[i] for i in range(n) if bl[i] == b]
            wb = sum(yb) * (len(yb) - sum(yb))
            num += wb * cps.auc_midrank(sb, yb)
            den += wb
        got, pairs = cps.blocked_auc(s, y, bl)
        check("K1 blocked AUC == pair-weighted mean of per-block AUCs, only within-block pairs counted",
              abs(got - num / den) < 1e-12 and pairs == den, (got, num / den, pairs, den))
    segment("K1/blocks", blocks)

    def weights():
        # integer weights == duplicated rows (the bootstrap's multiplicity semantics), zero weight drops a row
        sd, yd, bd = [], [], []
        for i in range(n):
            sd += [s[i]] * w[i]
            yd += [y[i]] * w[i]
            bd += [bl[i]] * w[i]
        aw, pw = cps.blocked_auc_weighted(cps.blocked_auc_prepare(s, y, bl), w)
        ad, pd = cps.blocked_auc(sd, yd, bd)
        check("K1 weighted sweep: weight k on a row == the row duplicated k times (0 drops it)",
              abs(aw - ad) < 1e-12 and abs(pw - pd) < 1e-9, (aw, ad, pw, pd))
    segment("K1/weights", weights)

    # a NaN compares False with everything, so a sort that meets one returns a START-ORDER-dependent
    # order: unguarded, [3, nan, 1, 2, .5, nan] read AUC 0.667 and the same rows reordered read 1.0.
    # Every ranking entry point must REFUSE it (ValueError), never rank it.
    nan = float("nan")
    refusals = []
    for what, fn in (("auc_midrank", lambda: cps.auc_midrank([1.0, nan, 2.0], [0, 1, 1])),
                     ("blocked_auc", lambda: cps.blocked_auc([1.0, nan, 2.0], [0, 1, 1], [0, 0, 0])),
                     ("within_block_uniform", lambda: cps.within_block_uniform([nan, 1.0], [0, 0])),
                     ("bin_map_fit", lambda: cps.bin_map_fit([nan, 1.0], [0, 1], 2)),
                     ("bin_map_apply", lambda: cps.bin_map_apply({"edges": [1.0], "means": [0.2, 0.8]}, [nan]))):
        try:
            fn()
            refusals.append(f"{what}:accepted")
        except ValueError:
            refusals.append(f"{what}:refused")
        except Exception as e:  # any other exception is not a refusal
            refusals.append(f"{what}:{type(e).__name__}")
    check("K1 a NaN score is REFUSED by every ranking entry point (auc_midrank, blocked_auc, within_block_uniform, "
          "bin_map_fit, bin_map_apply)", all(x.endswith(":refused") for x in refusals) and len(refusals) == 5, refusals)


# ── K2 binormal known answer ─────────────────────────────────────────────────────────────────
def k2_binormal():
    for mu in (0.0, 0.1063, 0.1777):
        r = random.Random(2000 + int(mu * 10000))
        n1 = n0 = 10000
        s = [r.gauss(0.0, 1.0) for _ in range(n0)] + [r.gauss(mu, 1.0) for _ in range(n1)]
        y = [0] * n0 + [1] * n1
        A = ND.cdf(mu / math.sqrt(2.0))
        q1, q2 = A / (2 - A), 2 * A * A / (1 + A)
        se = math.sqrt((A * (1 - A) + (n1 - 1) * (q1 - A * A) + (n0 - 1) * (q2 - A * A)) / (n1 * n0))
        a1, a2 = cps.auc_midrank(s, y), _blk(s, y)
        check(f"K2 binormal mu={mu}: |AUC - Phi(mu/sqrt2)={A:.4f}| < 4 SE ({a1:.4f}, {a2:.4f}, SE {se:.4f})",
              abs(a1 - A) < 4 * se and abs(a2 - A) < 4 * se)


# ── K3 clustered + day null: coverage ────────────────────────────────────────────────────────
# Design (synthetic, seeded; true within-day AUC 0.5): G=160 instruments, lognormal(0.7, 0.5) rows each
# capped at 10 (~300 rows), D=5 days; score/label instrument SDs 1.5/1.0 and day SDs 1.0/0.7.
# R=200 corpora x B=100 draws (R and B bounded for runtime: this group is ~6 s of the <= 30 s budget).
# Nearest-rank 95% interval = (3rd, 98th) of 100. THIS fixture's seeds read blocked+cluster 187/200 =
# 0.935 and pooled+row 142/200 = 0.710 (both printed on every run). The same design on three other
# bootstrap-seed bases read blocked+cluster 0.950 each and pooled+row 0.670 / 0.735 / 0.805 (the day
# component is invisible to any row or instrument resampling of a POOLED AUC). A percentile interval
# over ~160 instruments sits a little under nominal, which is why the band is [0.91, 0.99], not 0.95.
K3_R, K3_B = 200, 100


def k3_coverage():
    cov_blk = cov_pool = 0
    first = None
    for rep in range(K3_R):
        rng = random.Random(6000 + rep)
        X, Y, Dy, Cl = _clustered_corpus(rng, 160, 5, 1.5, 1.0, 1.0, 0.7, 0.7, 0.5, 10)
        n = len(X)
        bc = cps.cluster_bootstrap_blocked_auc({"s": X}, Y, Dy, Cl, K3_B, 60000 + rep)
        lo, hi = _ci95(bc["reps"]["s"])
        cov_blk += lo <= 0.5 <= hi
        pr = cps.cluster_bootstrap_blocked_auc({"s": X}, Y, [0] * n, list(range(n)), K3_B, 70000 + rep)
        lo, hi = _ci95(pr["reps"]["s"])
        cov_pool += lo <= 0.5 <= hi
        if first is None:
            first = (bc, len(set(Cl)))
    rb, rp = cov_blk / K3_R, cov_pool / K3_R
    print(f"SELF-TEST: K3 coverage blocked+cluster={cov_blk}/{K3_R}={rb:.3f} pooled+row={cov_pool}/{K3_R}={rp:.3f} B={K3_B}")
    check(f"K3 blocked AUC + cluster bootstrap covers the true 0.5 at ~95% ({rb:.3f} in [0.91, 0.99])", 0.91 <= rb <= 0.99)
    check(f"K3 pooled AUC + row bootstrap UNDER-covers ({rp:.3f} <= 0.85)", rp <= 0.85)
    bc, g = first
    check(f"K3 the bootstrap resamples CLUSTER units ({bc['units']} units == {g} distinct clusters, not {bc['rows']} rows)",
          bc["units"] == g and g < bc["rows"])

    # structural: on a strongly clustered corpus the cluster bootstrap is WIDER than a row bootstrap
    rng = random.Random(6999)
    X, Y, Dy, Cl = _clustered_corpus(rng, 60, 3, 1.5, 1.2, 0.3, 0.3, 2.0, 0.4, 20)
    bc = cps.cluster_bootstrap_blocked_auc({"s": X}, Y, Dy, Cl, 200, 69991)
    br = cps.cluster_bootstrap_blocked_auc({"s": X}, Y, Dy, list(range(len(X))), 200, 69992)
    ratio = _sd([v for v in bc["reps"]["s"] if v is not None]) / _sd(br["reps"]["s"])
    check(f"K3 cluster-bootstrap SD > 1.3 x row-bootstrap SD under shared instrument effects ({ratio:.2f})", ratio > 1.3)

    # degenerate draws are COUNTED, never dropped: two clusters, one all-positive, one all-negative
    s = [1.0, 2.0, 3.0, 4.0]
    y = [1, 1, 0, 0]
    dg = cps.cluster_bootstrap_blocked_auc({"s": s}, y, [0] * 4, ["P", "P", "N", "N"], 200, 4242)
    nn = sum(1 for v in dg["reps"]["s"] if v is None)
    check(f"K3 degenerate draws are counted ({dg['n_degenerate']} of 200) and kept as None in reps",
          dg["n_degenerate"] == nn and 0 < nn < 200 and len(dg["reps"]["s"]) == 200)
    check("K3 interval functions skip degenerate (None) replicates",
          cps.ci_lower(dg["reps"]["s"], 0.025) == 0.0 and cps.ci_upper(dg["reps"]["s"], 0.025) == 0.0)
    pdg = _raised(lambda: cps.paired_diffs([None, 0.625, 0.75, None], [0.5, None, 0.5, None]))
    check("K3 paired_diffs skips a replicate degenerate in EITHER score (only the aligned pair survives)",
          pdg == [0.25], pdg)


# ── K4 Simpson two-day tape ──────────────────────────────────────────────────────────────────
def k4_simpson():
    r = random.Random(404)
    s, y, day, cl = [], [], [], []
    for d, (mu, p) in enumerate(((1.0, 0.75), (-1.0, 0.25))):
        for i in range(300):
            s.append(r.gauss(mu, 1.0))
            y.append(1 if r.random() < p else 0)
            day.append(d)
            cl.append(f"COIN{d}-{i // 5}")
    pooled = cps.cluster_bootstrap_blocked_auc({"s": s}, y, [0] * len(s), cl, 300, 4041)
    blocked = cps.cluster_bootstrap_blocked_auc({"s": s}, y, day, cl, 300, 4042)
    plo, phi = _ci95(pooled["reps"]["s"])
    blo, bhi = _ci95(blocked["reps"]["s"])
    check(f"K4 Simpson tape: POOLED AUC {pooled['point']['s']:.3f} has a CI excluding 0.5 ([{plo:.3f}, {phi:.3f}])", plo > 0.5)
    check(f"K4 Simpson tape: within-day BLOCKED AUC {blocked['point']['s']:.3f} ~ 0.5, CI covers it ([{blo:.3f}, {bhi:.3f}])",
          blo <= 0.5 <= bhi and abs(blocked["point"]["s"] - 0.5) < 0.05)


# ── K5 side artefact + orientation ───────────────────────────────────────────────────────────
def k5_side_artefact():
    r = random.Random(505)
    side, y = [], []
    for _ in range(2000):
        sd = 1 if r.random() < 0.4 else -1
        side.append(sd)
        y.append(1 if r.random() < (0.7 if sd == 1 else 0.4) else 0)  # a rising tape: BUYs are "right" more often
    pooled = _blk(side, y)
    within, pairs = cps.blocked_auc(side, y, side)
    check(f"K5 score = side on a pooled side-relative target reads as skill ({pooled:.3f} > 0.55)", pooled > 0.55)
    check(f"K5 score = side WITHIN side is exactly 0.5 ({within})", within == 0.5 and pairs > 0)
    # orientation: within each side |score| carries the signal; the SIGNED score reverses it on SELL rows
    raw, yy, ss = [], [], []
    for _ in range(2000):
        sd = 1 if r.random() < 0.5 else -1
        mag = r.uniform(1.0, 60.0)
        raw.append(sd * mag)
        ss.append(sd)
        yy.append(1 if r.random() < 0.25 + 0.5 * mag / 60.0 else 0)
    oriented = [cps.orient_score(v, sd) for v, sd in zip(raw, ss)]
    a_or = cps.blocked_auc(oriented, yy, ss)[0]
    a_sg = cps.blocked_auc(raw, yy, ss)[0]
    check(f"K5 oriented score ranks within side ({a_or:.3f} > 0.62) and beats the signed score ({a_sg:.3f}) by > 0.1",
          a_or > 0.62 and a_or - a_sg > 0.1)
    check("K5 orient_score(-30, SELL) == 30 and orient_score(40, BUY) == 40",
          cps.orient_score(-30, -1) == 30 and cps.orient_score(40, 1) == 40)


# ── K6 paired gap ────────────────────────────────────────────────────────────────────────────
def k6_paired_gap():
    r = random.Random(606)
    n = 600
    cl = [f"COIN{i // 10}" for i in range(n)]
    bl = [i % 2 for i in range(n)]
    s = [r.gauss(0, 1) for _ in range(n)]
    y = [r.randrange(2) for _ in range(n)]
    same = cps.cluster_bootstrap_blocked_auc({"S": s, "F": list(s)}, y, bl, cl, 200, 6061)
    gaps = cps.paired_diffs(same["reps"]["F"], same["reps"]["S"])
    check("K6 f == S gives a gap of EXACTLY 0 on every replicate (joint draw)",
          len(gaps) == 200 and all(g == 0.0 for g in gaps) and same["n_degenerate"] == 0)

    f = [v + r.gauss(0, 0.3) for v in s]
    jt = cps.cluster_bootstrap_blocked_auc({"S": s, "F": f}, y, bl, cl, 300, 6062)
    g = cps.paired_diffs(jt["reps"]["F"], jt["reps"]["S"])
    lo, hi = _ci95(g)
    ua = cps.cluster_bootstrap_blocked_auc({"F": f}, y, bl, cl, 300, 6063)["reps"]["F"]
    ub = cps.cluster_bootstrap_blocked_auc({"S": s}, y, bl, cl, 300, 6064)["reps"]["S"]
    se_p, se_u = _sd(g), _sd([a - b for a, b in zip(ua, ub)])
    check(f"K6 f = S + noise: paired gap CI covers 0 ([{lo:.4f}, {hi:.4f}])", lo <= 0.0 <= hi)
    check(f"K6 paired SE {se_p:.4f} < unpaired SE {se_u:.4f} / 1.5", se_p < se_u / 1.5)

    x1 = [r.gauss(0, 1) for _ in range(n)]
    x2 = [r.gauss(0, 1) for _ in range(n)]
    yi = [1 if a * b + 0.5 * r.gauss(0, 1) > 0 else 0 for a, b in zip(x1, x2)]
    lin = [a + b for a, b in zip(x1, x2)]
    orc = [a * b for a, b in zip(x1, x2)]
    bt = cps.cluster_bootstrap_blocked_auc({"lin": lin, "orc": orc}, yi, bl, cl, 300, 6065)
    glo = cps.ci_lower(cps.paired_diffs(bt["reps"]["orc"], bt["reps"]["lin"]), 0.0125)
    llo, lhi = _ci95(bt["reps"]["lin"])
    check(f"K6 planted x1*x2: the interaction score beats the linear score (Bonferroni gap CI_lo {glo:.3f} > 0)", glo > 0)
    check(f"K6 planted x1*x2: the linear score is at chance (CI [{llo:.3f}, {lhi:.3f}] covers 0.5)", llo <= 0.5 <= lhi)


# ── K7 leakage canary ────────────────────────────────────────────────────────────────────────
def k7_leakage_canary():
    r = random.Random(707)
    xs, y, cl = [], [], []
    for c in range(100):
        for _ in range(10):
            xs.append(r.gauss(0, 1))
            y.append(r.randrange(2))
            cl.append(f"COIN{c}")
    folds = [cps.grouped_fold(c, LABEL) for c in cl]

    def fit(a, b):
        return cps.bin_map_fit(a, b, 100)

    oof = cps.crossfit_predict(fit, cps.bin_map_apply, xs, y, folds)
    bo = cps.cluster_bootstrap_blocked_auc({"sstar": oof}, y, folds, cl, 300, 7071)
    lo, hi = _ci95(bo["reps"]["sstar"])
    check(f"K7 pure-noise S*, out-of-fold: blocked AUC CI covers 0.5 ([{lo:.3f}, {hi:.3f}])", lo <= 0.5 <= hi)
    leak = cps.bin_map_apply(fit(xs, y), xs)  # positive control: scored rows inside the fit
    bl = cps.cluster_bootstrap_blocked_auc({"leak": leak}, y, folds, cl, 300, 7072)
    llo = cps.ci_lower(bl["reps"]["leak"], 0.025)
    check(f"K7 positive control: an in-sample fit IS flagged (CI_lo {llo:.3f} > 0.5) -- the canary can fire", llo > 0.5)
    k0 = folds[0]
    y2 = [1 - v if f == k0 else v for v, f in zip(y, folds)]
    oof2 = cps.crossfit_predict(fit, cps.bin_map_apply, xs, y2, folds)
    held = [i for i in range(len(xs)) if folds[i] == k0]
    check(f"K7 flipping fold {k0}'s OWN labels leaves its {len(held)} out-of-fold predictions unchanged",
          len(held) > 0 and all(oof2[i] == oof[i] for i in held))

    # rows whose target is UNDEFINED (timeouts / ambiguous for the direction target) are never trained on,
    # yet each still receives an out-of-fold prediction. The recording fit filters its own input, so a
    # leak of None targets is an ASSERTION failure here, not a crash inside bin_map_fit.
    seen_none = []

    def fit_rec(a, b):
        seen_none.append(sum(1 for v in b if v is None))
        keep = [(x, v) for x, v in zip(a, b) if v is not None]
        return cps.bin_map_fit([x for x, _ in keep], [v for _, v in keep], 10)

    yn = [None if i % 7 == 0 else v for i, v in enumerate(y)]
    oofn = cps.crossfit_predict(fit_rec, cps.bin_map_apply, xs, yn, folds)
    check(f"K7 undefined targets are never trained on ({sum(seen_none)} None targets reached fit over "
          f"{len(seen_none)} folds) and still get an out-of-fold prediction",
          len(seen_none) == len(set(folds)) and sum(seen_none) == 0 and all(p is not None for p in oofn))


# ── K8 purge ─────────────────────────────────────────────────────────────────────────────────
def k8_purge():
    tr, te = cps.purge_mask([10, 10, 25, 30], [20, 30, 40, 31], 25)
    check("K8 purge_mask: race inside train kept; race crossing the split PURGED; decided AT the split is not test",
          tr == [True, False, False, False] and te == [False, False, False, True], (tr, te))
    r = random.Random(808)
    t_split = 5000
    dec = [r.randint(0, 10000) for _ in range(3000)]
    end = [d + r.choice([96, 60, 40, 28]) * 36 for d in dec]
    tr, te = cps.purge_mask(dec, end, t_split)
    purged = sum(1 for d, e in zip(dec, end) if d <= t_split < e)
    kept_ends = [e for e, k in zip(end, tr) if k]
    try:
        checked = cps.assert_purged(kept_ends, t_split)
        ok = checked == len(kept_ends)
    except AssertionError:
        ok = False
    check(f"K8 purged training set passes assert_purged ({purged} crossing rows removed)",
          ok and purged > 0 and sum(tr) + purged + sum(te) == len(dec) and not any(a and b for a, b in zip(tr, te)))
    try:
        cps.assert_purged(kept_ends + [t_split + 1], t_split)
        check("K8 assert_purged RAISES on one violating training row", False)
    except AssertionError:
        check("K8 assert_purged RAISES on one violating training row", True)
    try:
        cps.purge_mask([10], [5], 7)
        check("K8 a race ending before it starts is REFUSED", False)
    except ValueError:
        check("K8 a race ending before it starts is REFUSED", True)

    # the registered boundary is INCLUSIVE: TRAIN := race_end <= T_split. The fixtures above never put a
    # race end ON the split (the 3,000 seeded rows hold 0 such rows), so '<' and '>=' mutants read green.
    tr_b, te_b = cps.purge_mask([10, 20, 25], [25, 25, 26], 25)
    check("K8 a race ending EXACTLY at the split is TRAIN; one ending a second later is purged",
          tr_b == [True, True, False] and te_b == [False, False, False], (tr_b, te_b))
    try:
        ok_b = cps.assert_purged([25, 24, 25], 25) == 3
    except AssertionError:
        ok_b = False
    check("K8 assert_purged ACCEPTS training races that end exactly at the split (race_end <= T_split)", ok_b)


# ── K9 arithmetic: Kish, m*, ICC, uniforms, the floor ────────────────────────────────────────
# Segmented (see `segment`). Every random corpus is drawn OUTSIDE the segments, in the original order,
# so a raise in one segment can never change another segment's data. The registered-constant floor runs
# BEFORE the edge-case floors: under a mutant, an edge case is exactly where a raise happens.
def _raised(fn):
    """fn() or the string 'raised <Type>' -- for checks whose subject must RETURN on this input."""
    try:
        return fn()
    except Exception as e:
        return f"raised {type(e).__name__}"


def k9_arithmetic():
    def kish_mstar():
        check("K9 kish [1,1,1,1]=4, [4]=1, [3,1]=1.6",
              cps.kish_eff([1, 1, 1, 1]) == 4.0 and cps.kish_eff([4]) == 1.0 and abs(cps.kish_eff([3, 1]) - 1.6) < 1e-12,
              (cps.kish_eff([1, 1, 1, 1]), cps.kish_eff([4]), cps.kish_eff([3, 1])))
        check("K9 m* [3,1]=2.5 (sum m^2 / sum m) and n / kish == m*",
              abs(cps.m_star([3, 1]) - 2.5) < 1e-12 and abs(4 / cps.kish_eff([3, 1]) - cps.m_star([3, 1])) < 1e-12)
        ke, me = _raised(lambda: cps.kish_eff([])), _raised(lambda: cps.m_star([]))
        check("K9 an empty corpus has kish 0 and m* 0 (a number, never a ZeroDivisionError)", ke == 0.0 and me == 0.0, (ke, me))
    segment("K9/kish", kish_mstar)

    def icc_hand():
        check("K9 ICC(1) hand values: [1,3|5,7] = 7/9, [1,2|4] = 11/13 (n0-adjusted)",
              abs(cps.icc_anova([1, 3, 5, 7], "aabb") - 7 / 9) < 1e-12 and abs(cps.icc_anova([1, 2, 4], "aab") - 11 / 13) < 1e-12)
    segment("K9/icc-hand", icc_hand)

    r = random.Random(909)
    vals, grp = [], []
    for gi in range(200):
        v = r.gauss(0, 1)
        for _ in range(r.randint(2, 8)):
            vals.append(v)
            grp.append(gi)
    iid = [r.gauss(0, 1) for _ in range(2000)]

    def icc_data():
        icc_iid = cps.icc_anova(iid, [i // 10 for i in range(2000)])
        check(f"K9 ICC == 1 for identical-within-group values, ~0 for iid ({_f(icc_iid, '.4f')})",
              abs(cps.icc_anova(vals, grp) - 1.0) < 1e-12 and abs(icc_iid) < 0.05)
        check("K9 ICC undefined (None) for one cluster and for all-singleton clusters",
              cps.icc_anova([1, 2, 3], "aaa") is None and cps.icc_anova([1, 2, 3], "abc") is None)
        ic = _raised(lambda: cps.icc_anova([2.0] * 6, "aabbcc"))
        check("K9 ICC undefined (None) for CONSTANT values (no variance at all): returned, never divided by zero",
              ic is None, ic)
    segment("K9/icc-data", icc_data)

    def uniform():
        u = cps.within_block_uniform([3, 1, 2, 2, 9, 8], [0, 0, 0, 0, 1, 1])
        check("K9 within-block uniform = (midrank - 1/2)/n_b", u == [0.875, 0.125, 0.5, 0.5, 0.75, 0.25], u)
    segment("K9/uniform", uniform)

    def k_and_n():
        K = cps.floor_k(0.025)
        check(f"K9 K = z_0.975 + z_0.80 = {K:.4f} (2.8016); Bonferroni K = {cps.floor_k(0.0125):.4f} (3.0830)",
              abs(K - 2.801585218) < 1e-6 and abs(cps.floor_k(0.0125) - 3.083023961) < 1e-6)
        ng = cps.floor_n_required(2.0 / 12.0, 0.5, 1.0, 0.0, 0.05, 0.025)
        nl = cps.floor_n_required(1.0 / 12.0, 0.5, 1.0, 0.0, 0.05, 0.025)
        print(f"SELF-TEST: K9 floor at pi=1/2 delta=0.05 K=2.8016 m*=1: gap r=0 n={ng:.4f} (ceil {math.ceil(ng)}) level n={nl:.4f} (ceil {math.ceil(nl)})")
        check(f"K9 floor gap r=0 needs n = K^2 (2/3) / delta^2 = {ng:.4f} -> 2,094 rows",
              abs(ng - 2093.0346) < 1e-3 and math.ceil(ng) == 2094)
        check(f"K9 floor level needs n = K^2 (1/3) / delta^2 = {nl:.4f} -> 1,047 rows",
              abs(nl - 1046.5173) < 1e-3 and math.ceil(nl) == 1047)
        ok = True
        for rr in (0.0, 0.5, 0.8):
            for n in (100, 2093):
                se = cps.floor_se(2 * (1 - rr) / 12.0, n, 0.5, 1.0, 0.7)
                ok = ok and abs(se * se - 2 * (1 - rr) / (3.0 * n)) < 1e-15
        check("K9 Hanley-McNeil identity: m*=1, sigma2 = 2(1-r)/12, pi=1/2 -> SE_gap^2 = 2(1-r)/(3n) exactly", ok)
        hm_ok = True
        for n in (100, 1000, 20000):
            hm = (n + 1) / (3.0 * n * n)  # Hanley-McNeil Var(AUC) at A=1/2, n1 = n0 = n/2: (n+1)/(12 n1 n0)
            se = cps.floor_se(1.0 / 12.0, n, 0.5, 1.0, 0.0)
            hm_ok = hm_ok and abs(hm / (se * se) - (n + 1) / n) < 1e-12
        check("K9 level SE^2 = 1/(3n) = Hanley-McNeil (n+1)/(3n^2) up to the (n+1)/n finite-sample factor", hm_ok)
        # the design effect itself, at values where every term matters (m* > 1, 0 < rho < 1, rho < 0)
        d1, d2 = cps.floor_deff(3.0, 0.25), cps.floor_deff(3.0, -0.5)
        se3 = cps.floor_se(1.0 / 12.0, 100, 0.5, 3.0, 0.25)
        check(f"K9 DEFF = 1 + (m*-1) max(rho, 0): (m*=3, rho=.25) -> {d1} (1.5), (m*=3, rho=-.5) -> {d2} (1.0); SE^2 = sigma2 V DEFF / n",
              d1 == 1.5 and d2 == 1.0 and abs(se3 * se3 - (1.0 / 12.0) * 4.0 * 1.5 / 100) < 1e-15)
        nq = cps.floor_n_required(1.0 / 12.0, 0.5, 3.0, 0.25, 0.05, 0.025)
        check(f"K9 n_required MULTIPLIES by the DEFF: (m*=3, rho=.25) needs 1.5 x the iid rows ({nq:.2f} = 1.5 x {nl:.2f})",
              abs(nq / nl - 1.5) < 1e-12)
    segment("K9/k-and-n", k_and_n)

    # the floor at the REGISTERED constants (delta 0.05, pi 0.15, Bonferroni alpha 0.0125): it must read
    # the alpha it is PASSED, and the gap's ICC is the ICC of D = U_f - U_S while the level's is the ICC
    # of U_f. The other floor fixtures pass alpha 0.025 and singleton or constant-within clusters, so a
    # hardcoded K or a gap ICC measured on U_f read green. Here U_f is strongly clustered and S tracks f,
    # so the two ICCs sit ~0.9 apart.
    r2 = random.Random(919)
    n2 = 1200
    cl2 = [i // 6 for i in range(n2)]
    blk2 = [i % 3 for i in range(n2)]
    base2 = [r2.gauss(0, 1) for _ in range(n2 // 6)]
    xf = [base2[i // 6] + 0.3 * r2.gauss(0, 1) for i in range(n2)]
    xs = [v + 0.2 * r2.gauss(0, 1) for v in xf]

    def registered_floor():
        uf2, us2 = cps.within_block_uniform(xf, blk2), cps.within_block_uniform(xs, blk2)
        rg = cps.icc_anova([a - b for a, b in zip(uf2, us2)], cl2)
        rl = cps.icc_anova(uf2, cl2)
        fr = cps.auc_floor(uf2, us2, blk2, cl2, 0.05, 0.15, 0.0125)
        k_reg = 3.083023961
        defined = fr["se_gap"] is not None and fr["se_lvl"] is not None
        check(f"K9 auc_floor reads the PASSED alpha: registered 0.0125 -> K = {_f(fr['K'], '.4f')} (3.0830), and PASS is K*SE <= delta",
              abs(fr["K"] - k_reg) < 1e-6 and defined
              and fr["pass_gap"] == (fr["K"] * fr["se_gap"] <= 0.05) and fr["pass_lvl"] == (fr["K"] * fr["se_lvl"] <= 0.05))
        check(f"K9 gap ICC is measured on D = U_f - U_S ({_f(fr['rho_gap'])}), level ICC on U_f ({_f(fr['rho_lvl'])}), and each SE uses its own",
              defined and fr["rho_gap"] == rg and fr["rho_lvl"] == rl and rl - rg > 0.5
              and fr["se_gap"] == cps.floor_se(fr["sigma2_gap"], n2, 0.15, fr["m_star"], rg)
              and fr["se_lvl"] == cps.floor_se(fr["sigma2_lvl"], n2, 0.15, fr["m_star"], rl), (fr["rho_gap"], rg, fr["rho_lvl"], rl))
        check("K9 ... and both PASS flags agree with n_required under clustering (m*=6): pass <=> n >= n_required",
              defined and fr["pass_gap"] == (n2 >= fr["n_required_gap"]) and fr["pass_lvl"] == (n2 >= fr["n_required_lvl"])
              and fr["pass_gap"] is True and fr["pass_lvl"] is False and fr["floor_pass"] is False,
              (fr["pass_gap"], fr["n_required_gap"], fr["pass_lvl"], fr["n_required_lvl"]))
        ngr = cps.floor_n_required(2.0 / 12.0, 0.15, 1.0, 0.0, 0.05, 0.0125)
        nlr = cps.floor_n_required(1.0 / 12.0, 0.15, 1.0, 0.0, 0.05, 0.0125)
        print(f"SELF-TEST: K9 floor at the REGISTERED constants pi=0.15 delta=0.05 K=3.0830 m*=1: gap r=0 n={ngr:.4f} "
              f"(ceil {math.ceil(ngr)}) level n={nlr:.4f} (ceil {math.ceil(nlr)})")
        check(f"K9 registered constants, m*=1, r=0: gap needs {math.ceil(ngr)} rows, level {math.ceil(nlr)} (K^2 sigma2 V / delta^2, V = 1/(0.15*0.85))",
              math.ceil(ngr) == 4970 and math.ceil(nlr) == 2485 and abs(ngr - 2.0 * nlr) < 1e-9)
    segment("K9/registered-floor", registered_floor)

    # the floor on data: singleton clusters, one block -> sigma2_D = 2(1-r)(n^2-1)/(12 n^2) exactly
    n = 2000
    x = [r.gauss(0, 1) for _ in range(n)]
    z = [0.6 * v + 0.8 * r.gauss(0, 1) for v in x]
    anti_f = [0.5 + (0.2 if i % 2 == 0 else -0.2) + 0.01 * r.gauss(0, 1) for i in range(n)]
    one = [0] * n
    se_lvl_iid = math.sqrt((n * n - 1) / (12.0 * n * n) * 4.0 / n)  # untied one-block uniform, m*=1, pi=1/2

    def floor_data():
        uf, us = cps.within_block_uniform(x, one), cps.within_block_uniform(z, one)
        fl = cps.auc_floor(uf, us, one, list(range(n)), 0.05, 0.5, 0.025)
        mf, ms = sum(uf) / n, sum(us) / n
        cov = sum((a - mf) * (b - ms) for a, b in zip(uf, us)) / n
        var = sum((a - mf) ** 2 for a in uf) / n
        rho_u = cov / var
        want = 2 * (1 - rho_u) * (n * n - 1) / (12.0 * n * n)
        check(f"K9 auc_floor on data: sigma2_gap == 2(1-r)(n^2-1)/(12n^2) (r={rho_u:.4f}), SE_gap^2 == sigma2 V / n, m*=1",
              fl["se_gap"] is not None and abs(fl["sigma2_gap"] - want) < 1e-12
              and abs(fl["se_gap"] ** 2 - want * 4 / n) < 1e-15 and fl["m_star"] == 1.0)
        check("K9 auc_floor sigma2_lvl == (n^2-1)/(12 n^2) on an untied one-block uniform: the variance about the BLOCK mean",
              abs(fl["sigma2_lvl"] - (n * n - 1) / (12.0 * n * n)) < 1e-15 and fl["se_lvl"] is not None
              and abs(fl["se_lvl"] - se_lvl_iid) < 1e-15, (fl["sigma2_lvl"], fl["se_lvl"], se_lvl_iid))
        check("K9 auc_floor PASS agrees with its own n_required (pass_gap <=> n >= n_required_gap)",
              fl["pass_gap"] == (n >= fl["n_required_gap"]) and fl["pass_lvl"] == (n >= fl["n_required_lvl"])
              and fl["floor_pass"] == (fl["pass_gap"] and fl["pass_lvl"]))
    segment("K9/floor-data", floor_data)

    def floor_small():
        # a defined SE is not a pass: 40 singleton rows at the registered constants fail BOTH floors. Every
        # other defined-SE fixture here passes its gap floor, so 'pass whenever the SE exists' read green.
        one40 = [0] * 40
        uf, us = cps.within_block_uniform(x[:40], one40), cps.within_block_uniform(z[:40], one40)
        fsm = cps.auc_floor(uf, us, one40, list(range(40)), 0.05, 0.15, 0.0125)
        check("K9 a 40-row corpus FAILS both floors: each SE is defined, K*SE > delta, so pass_gap and pass_lvl are False",
              fsm["se_gap"] is not None and fsm["se_lvl"] is not None
              and fsm["K"] * fsm["se_gap"] > 0.05 and fsm["K"] * fsm["se_lvl"] > 0.05
              and fsm["pass_gap"] is False and fsm["pass_lvl"] is False and fsm["floor_pass"] is False,
              (fsm["se_gap"], fsm["se_lvl"], fsm["pass_gap"], fsm["pass_lvl"]))
    segment("K9/floor-small", floor_small)

    def floor_clustered():
        # clustered: DEFF applied with the measured ICC
        uf, us = cps.within_block_uniform(x, one), cps.within_block_uniform(z, one)
        cl = [i // 4 for i in range(n)]
        ufc = [uf[(i // 4) * 4] for i in range(n)]  # constant within cluster -> rho_lvl = 1
        flc = cps.auc_floor(ufc, us, one, cl, 0.05, 0.5, 0.025)
        exp_lvl = cps.floor_se(flc["sigma2_lvl"], n, 0.5, 4.0, flc["rho_lvl"])
        check(f"K9 auc_floor applies DEFF 1 + (m*-1) rho (m*={flc['m_star']}, rho_lvl={_f(flc['rho_lvl'])})",
              flc["m_star"] == 4.0 and flc["se_lvl"] is not None and abs(flc["se_lvl"] - exp_lvl) < 1e-15
              and flc["se_lvl"] > 1.8 * se_lvl_iid)
        n_iid = cps.floor_n_required(flc["sigma2_lvl"], 0.5, 1.0, 0.0, 0.05, 0.025)
        check(f"K9 under clustering n_required_lvl carries DEFF = 4 ({_f(flc['n_required_lvl'], '.1f')} = 4 x {n_iid:.1f}) "
              "and pass_lvl <=> n >= n_required_lvl",
              flc["rho_lvl"] == 1.0 and abs(flc["n_required_lvl"] / n_iid - 4.0) < 1e-9
              and flc["pass_lvl"] == (n >= flc["n_required_lvl"]) and flc["pass_lvl"] is False)
    segment("K9/floor-clustered", floor_clustered)

    def floor_negative_icc():
        # a NEGATIVE ICC is floored at 0 inside the DEFF only
        fa = cps.auc_floor(anti_f, [0.5] * n, one, [i // 2 for i in range(n)], 0.05, 0.5, 0.025)
        check(f"K9 a negative ICC is REPORTED raw ({_f(fa['rho_lvl'])} < 0) but floored at 0 in the DEFF",
              fa["rho_lvl"] is not None and fa["rho_lvl"] < 0 and fa["se_lvl"] is not None
              and abs(fa["se_lvl"] - cps.floor_se(fa["sigma2_lvl"], n, 0.5, 2.0, 0.0)) < 1e-15)
    segment("K9/floor-negative-icc", floor_negative_icc)

    def floor_identical():
        # f == S: D is identically 0, so its ICC is undefined -- and that must not matter, because the gap's
        # variance is 0: SE_gap is exactly 0 and the gap floor passes (L nests S; this can happen)
        uf = cps.within_block_uniform(x, one)
        fi = cps.auc_floor(uf, list(uf), one, [i // 4 for i in range(n)], 0.05, 0.5, 0.025)
        check("K9 f == S (D identically 0): sigma2_gap 0, SE_gap exactly 0, the gap floor passes, the gap ICC is reported None",
              fi["sigma2_gap"] == 0.0 and fi["se_gap"] == 0.0 and fi["pass_gap"] is True and fi["rho_gap"] is None,
              (fi["sigma2_gap"], fi["se_gap"], fi["pass_gap"], fi["rho_gap"]))
    segment("K9/floor-identical", floor_identical)

    def floor_unmeasurable():
        uf, us = cps.within_block_uniform(x, one), cps.within_block_uniform(z, one)
        fu = cps.auc_floor(uf, us, one, ["one"] * n, 0.05, 0.5, 0.025)
        check("K9 an ICC that cannot be measured while it matters (one cluster) FAILS the floor, never passes",
              fu["se_gap"] is None and fu["floor_pass"] is False)
    segment("K9/floor-unmeasurable", floor_unmeasurable)


# ── KP order-statistic intervals ─────────────────────────────────────────────────────────────
def kp_percentile():
    r = random.Random(1111)
    v = list(range(1, 101)) + [None] * 7
    r.shuffle(v)
    got = (cps.percentile(v, 0.025), cps.percentile(v, 0.5), cps.percentile(v, 0.975),
           cps.percentile(v, 0.0), cps.percentile(v, 1.0))
    check("KP nearest-rank percentile on 1..100 (+Nones): q=.025/.5/.975/0/1 -> 3/50/98/1/100", got == (3, 50, 98, 1, 100), got)
    check("KP ci_lower/ci_upper at one-sided 0.025 on 1..100 -> (3, 98)",
          cps.ci_lower(v, 0.025) == 3 and cps.ci_upper(v, 0.025) == 98)
    w = list(range(1, 4001))
    check("KP B=4000 at the Bonferroni 0.0125: lower = 50th, upper = 3951st (0.0125*4000 is rank 50, not 51)",
          cps.ci_lower(w, 0.0125) == 50 and cps.ci_upper(w, 0.0125) == 3951 and cps.percentile(w, 0.0125) == 50)
    sym = True
    for m in (99, 100, 101, 160, 4000):
        vals = list(range(1, m + 1))
        for a in (0.0125, 0.025, 0.05):
            lo, hi = cps.ci_lower(vals, a), cps.ci_upper(vals, a)
            sym = sym and (lo - 1) == (m - hi) == math.ceil(a * m - 1e-9) - 1
    check("KP the two tails exclude the SAME number of order statistics, ceil(alpha m) - 1", sym)
    check("KP no values -> None; one value -> that value",
          cps.percentile([None], 0.5) is None and cps.percentile([7], 0.01) == 7 and cps.ci_upper([7], 0.01) == 7)
    lo_e, hi_e = _raised(lambda: cps.ci_lower([None, None], 0.05)), _raised(lambda: cps.ci_upper([None, None], 0.05))
    check("KP an all-degenerate replicate list has NO bound on either side (None), never a number such as 0.5",
          lo_e is None and hi_e is None, (lo_e, hi_e))


# ── K10 decision map ─────────────────────────────────────────────────────────────────────────
def _expect_reading(fam, delta):
    """Independent restatement of the registered reading, for the grid."""
    if any(f["floor_pass"] is not True for f in fam.values()):
        return "P"
    if any(f["a_lo"] > 0.5 and f["gap_lo"] > 0 and f["gap_hat"] >= delta and f["vol_lo"] > 0 for f in fam.values()):
        return "C"
    if all(f["gap_hat"] < delta and f["gap_hi95"] < delta for f in fam.values()):
        return "N"
    return "U"


def k10_decision_map():
    expected = {
        ("C", "C", True): "CEILING_EXISTS", ("C", "C", False): "INDETERMINATE_DISAGREE",
        ("C", "N"): "INDETERMINATE_DISAGREE", ("N", "C"): "INDETERMINATE_DISAGREE",
        ("N", "N"): "NO_CEILING",
        ("C", "U"): "INDETERMINATE_UNRESOLVED", ("U", "C"): "INDETERMINATE_UNRESOLVED",
        ("N", "U"): "INDETERMINATE_UNRESOLVED", ("U", "N"): "INDETERMINATE_UNRESOLVED",
        ("U", "U"): "INDETERMINATE_UNRESOLVED",
        ("P", "C"): "INDETERMINATE_UNDERPOWERED", ("C", "P"): "INDETERMINATE_UNDERPOWERED",
        ("P", "N"): "INDETERMINATE_UNDERPOWERED", ("N", "P"): "INDETERMINATE_UNDERPOWERED",
        ("P", "U"): "INDETERMINATE_UNDERPOWERED", ("U", "P"): "INDETERMINATE_UNDERPOWERED",
        ("P", "P"): "INDETERMINATE_UNDERPOWERED",
    }
    got, bad = {}, []
    for key, want in expected.items():
        rc, rt = key[0], key[1]
        cfc = ["L"] if rc == "C" else []
        cft = (["L"] if key[2] else ["T"]) if rc == "C" and rt == "C" else (["L"] if rt == "C" else [])
        st = cps.verdict_state(rc, rt, cfc, cft)
        got[key] = st
        if st != want or st not in cps.STATES:
            bad.append((key, st, want))
    tally = {s: sum(1 for v in got.values() if v == s) for s in cps.STATES}
    check(f"K10 all 16 cells (+ CC same/different family) map to exactly the registered state {tally}",
          not bad and len(got) == 17 and tally == {"CEILING_EXISTS": 1, "NO_CEILING": 1, "INDETERMINATE_UNDERPOWERED": 7,
                                                   "INDETERMINATE_DISAGREE": 3, "INDETERMINATE_UNRESOLVED": 5}, bad)
    refused = 0
    for args in (("C", "N", [], []), ("N", "N", ["L"], []), ("X", "N", [], [])):
        try:
            cps.verdict_state(*args)
        except ValueError:
            refused += 1
    check("K10 inconsistent input (C naming no family, N naming one, unknown reading) is REFUSED", refused == 3)

    d = 0.05
    base = {"a_lo": 0.51, "gap_lo": 0.01, "gap_hat": 0.06, "gap_hi95": 0.09, "vol_lo": 0.01, "floor_pass": True}
    check("K10 a qualifying family reads C and is named", cps.holdout_reading({"L": dict(base), "T": dict(base, a_lo=0.49)}, d) == ("C", ["L"]))
    check("K10 a family whose floor fails makes the holdout P, whatever else holds",
          cps.holdout_reading({"L": dict(base), "T": dict(base, floor_pass=False)}, d) == ("P", []))
    skew = dict(base, gap_hi95=0.04)  # upper bound BELOW its own point estimate
    check("K10 skewed interval (gap_hi95 0.04 < delta <= gap_hat 0.06) with C qualifiers reads C, never N",
          cps.holdout_reading({"L": skew}, d) == ("C", ["L"]))
    check("K10 the same skew without C qualifiers reads U (max(hi, hat) >= delta blocks N)",
          cps.holdout_reading({"L": dict(skew, a_lo=0.49)}, d) == ("U", []))
    check("K10 gap_hat == delta exactly qualifies for C (>=); a_lo == 0.5 exactly does not (>)",
          cps.holdout_reading({"L": dict(base, gap_hat=d)}, d)[0] == "C"
          and cps.holdout_reading({"L": dict(base, a_lo=0.5)}, d)[0] != "C")
    check("K10 N when every family's max(gap_hi95, gap_hat) < delta",
          cps.holdout_reading({"L": dict(base, gap_hat=0.01, gap_hi95=0.04), "T": dict(base, gap_hat=-0.02, gap_hi95=0.049)}, d) == ("N", []))

    # grid: the function equals an independent restatement, and C and N are never both true
    A = (0.49, 0.5, 0.51)
    GL = (-0.01, 0.0, 0.01, 0.06)
    GH = (0.03, 0.05, 0.07)
    HI = (0.02, 0.049, 0.05, 0.08)
    VL = (-0.01, 0.0, 0.01)
    FP = (True, False)
    singles = [dict(a_lo=a, gap_lo=gl, gap_hat=gh, gap_hi95=hi, vol_lo=vl, floor_pass=fp)
               for a in A for gl in GL for gh in GH for hi in HI for vl in VL for fp in FP]
    mismatch = both = 0
    rg = random.Random(1010)
    combos = [{"L": f} for f in singles] + [{"L": rg.choice(singles), "T": rg.choice(singles)} for _ in range(3000)]
    for fam in combos:
        rd, cf = cps.holdout_reading(fam, d)
        if rd != _expect_reading(fam, d) or (rd == "C") != bool(cf):
            mismatch += 1
        c_pred = any(f["a_lo"] > 0.5 and f["gap_lo"] > 0 and f["gap_hat"] >= d and f["vol_lo"] > 0 for f in fam.values())
        n_pred = all(max(f["gap_hi95"], f["gap_hat"]) < d for f in fam.values())
        both += c_pred and n_pred
    check(f"K10 grid of {len(combos)} readings (skewed intervals included): 0 mismatches, C and N never both true",
          mismatch == 0 and both == 0, (mismatch, both))

    # Bonferroni at an EXACT threshold: 4000 replicates whose 50th value is 0.495 and 100th is 0.505
    reps = [0.40] * 49 + [0.495] * 50 + [0.505] + [0.60] * 3900
    boot = {"point": {"L": 0.6, "S": 0.5, "V": 0.5}, "reps": {"L": reps, "S": [0.5] * 4000, "V": [0.5] * 4000}}
    fb = cps.family_bounds(boot, "L", "S", "V", n_families=2)
    check(f"K10 family_bounds is Bonferroni: alpha 0.025/2 = {fb['alpha_bonf']} -> a_lo = 50th of 4000 = {fb['a_lo']}",
          fb["alpha_bonf"] == 0.0125 and fb["a_lo"] == 0.495)
    fb["floor_pass"] = True
    check("K10 ... so a level bound that clears 0.5 only WITHOUT Bonferroni does not read C",
          cps.holdout_reading({"L": fb}, d)[0] != "C")
    check("K10 consumable headroom = max_f min_h gap_lo (0.01), None-bound families excluded",
          cps.consumable_headroom({"L": {"cl": 0.03, "tm": 0.01}, "T": {"cl": 0.05, "tm": -0.02}, "X": {"cl": 0.9, "tm": None}}) == 0.01
          and cps.consumable_headroom({"L": {"cl": None}}) is None)

    # family_bounds is a PROJECTION, and the fixture above cannot see a wrong pair: its incumbent and its
    # control carry IDENTICAL replicates, and it pins only a_lo. Here family, incumbent and control all
    # differ, and every value is an exact dyadic (multiples of 2^-16), so each output is one exact order
    # statistic: a gap taken against the control, a vol gap taken against the incumbent, a point gap on
    # the wrong pair, or the equivalence bound at the Bonferroni level instead of one-sided 95% each moves
    # it. Paired by construction: F - S is the gap multiset gq and F - V the multiset vq, REPLICATE-ALIGNED
    # under independent shuffles, so bounds of per-score intervals cannot reproduce them.
    Bq, U16 = 4000, 65536.0
    rq = random.Random(1020)
    jf, jg, jv = list(range(Bq)), list(range(Bq)), list(range(Bq))
    rq.shuffle(jf)
    rq.shuffle(jg)
    rq.shuffle(jv)
    Fq = [(32768 + j) / U16 for j in jf]   # r-th smallest = (32767 + r) / 2^16
    gq = [(j - 100) / U16 for j in jg]     # F - S: r-th smallest = (r - 101) / 2^16
    vq = [(j + 300) / U16 for j in jv]     # F - V: r-th smallest = (r + 299) / 2^16
    bq = {"point": {"L": 0.625, "S": 0.5625, "V": 0.53125},
          "reps": {"L": Fq, "S": [f - g for f, g in zip(Fq, gq)], "V": [f - v for f, v in zip(Fq, vq)]}}
    fq = cps.family_bounds(bq, "L", "S", "V", n_families=2)
    want = {"a_hat": 0.625, "a_lo": (32767 + 50) / U16, "gap_hat": 0.0625, "gap_lo": (50 - 101) / U16,
            "gap_hi95": (3801 - 101) / U16, "vol_hat": 0.09375, "vol_lo": (50 + 299) / U16,
            "alpha_bonf": 0.0125, "draws_used": 4000}
    check("K10 family_bounds takes each bound from the RIGHT pair at the RIGHT level: gap vs the incumbent (Bonferroni "
          "rank 50; one-sided-95% upper rank 3801 of 4000), vol gap vs the control, level on the family",
          fq == want, {k: (fq.get(k), want[k]) for k in want if fq.get(k) != want[k]})

    # NOT_ESTIMABLE (registered 8.1): such a family is passed with None bounds. It qualifies for nothing and
    # BLOCKS N -- the partner's equivalence alone must never read N. No fixture above carries a None bound.
    ne = {"a_lo": None, "gap_lo": None, "gap_hat": None, "gap_hi95": None, "vol_lo": None, "floor_pass": True}
    n_only = dict(base, gap_hat=0.01, gap_hi95=0.04)  # reads N on its own
    check("K10 a NOT_ESTIMABLE family BLOCKS N: (NE, N-qualifier) and (NE, NE) both read U, never N",
          cps.holdout_reading({"L": dict(n_only)}, d) == ("N", [])
          and cps.holdout_reading({"L": dict(ne), "T": dict(n_only)}, d) == ("U", [])
          and cps.holdout_reading({"L": dict(ne), "T": dict(ne)}, d) == ("U", []))
    check("K10 a NOT_ESTIMABLE family never qualifies for C; a qualifying partner is named alone",
          cps.holdout_reading({"L": dict(ne), "T": dict(base)}, d) == ("C", ["T"]))
    check("K10 a floor that was never evaluated (floor_pass None) is not a pass: the holdout reads P",
          cps.holdout_reading({"L": dict(base, floor_pass=None), "T": dict(base)}, d) == ("P", []))


# ── K11 determinism and arm independence ─────────────────────────────────────────────────────
def k11_determinism():
    sa, st = cps.arm_seed(LABEL, "cluster"), cps.arm_seed(LABEL, "temporal")
    check(f"K11 arm_seed pinned literals (cluster {sa}, temporal {st}) and distinct",
          sa == 3813886631 and st == 2952587518 and sa != st)
    folds = [cps.grouped_fold(f"COIN{i}", LABEL) for i in range(1000)]
    counts = [folds.count(k) for k in range(5)]
    check(f"K11 grouped_fold is pinned (BTC -> 2), stable per key, ~uniform over 1000 keys {counts}",
          cps.grouped_fold("BTC", LABEL) == 2 and cps.grouped_fold("BTC", LABEL, 5) == cps.grouped_fold("BTC", LABEL)
          and all(150 <= c <= 250 for c in counts))
    r = random.Random(1112)
    X, Y, Dy, Cl = _clustered_corpus(r, 60, 3, 1.0, 0.5, 0.3, 0.3, 1.0, 0.5, 10)
    run = lambda seed: cps.cluster_bootstrap_blocked_auc({"s": X}, Y, Dy, Cl, 50, seed)
    a1 = run(sa)
    b1 = run(st)
    a2 = run(sa)
    check("K11 same seed -> identical replicates, even after another arm drew in between", a1 == a2)
    check("K11 two arms' draws differ (first replicate and the whole list)",
          a1["reps"]["s"][0] != b1["reps"]["s"][0] and a1["reps"] != b1["reps"])


# ── KT targets and orientation ───────────────────────────────────────────────────────────────
def kt_targets():
    table = {(1, False): 1, (-1, False): 0, (0, False): None, (1, True): None, (-1, True): None, (0, True): None}
    got = {k: cps.direction_target(*k) for k in table}
    check("KT direction target: clean win 1, clean loss 0; timeouts and AMBIGUOUS rows excluded (None)", got == table, got)
    check("KT decided flag: +1/-1 -> 1, timeout -> 0",
          (cps.decided_flag(1), cps.decided_flag(-1), cps.decided_flag(0)) == (1, 1, 0))
    refused = 0
    for f, args in ((cps.direction_target, (2, False)), (cps.direction_target, (1, None)), (cps.decided_flag, (3,)),
                    (cps.orient_score, (5.0, 0)), (cps.orient_score, (5.0, 2))):
        try:
            f(*args)
        except ValueError:
            refused += 1
    check("KT bad codes, a missing ambiguous flag and side 0 / side 2 are REFUSED", refused == 5)
    check("KT orient_score = side * score", cps.orient_score(-12.5, -1) == 12.5 and cps.orient_score(-12.5, 1) == -12.5)


# ── KS the univariate re-map S* ──────────────────────────────────────────────────────────────
def ks_bin_map():
    m = cps.bin_map_fit([1, 2, 3, 4, 5, 6], [0, 0, 1, 0, 1, 1], 3)
    check("KS bin map: equal-count edges [2,4], Laplace means (0.5/3, 1.5/3, 2.5/3)",
          m["edges"] == [2, 4] and m["counts"] == [2, 2, 2]
          and all(abs(a - b) < 1e-15 for a, b in zip(m["means"], [0.5 / 3, 1.5 / 3, 2.5 / 3])), m)
    ap = cps.bin_map_apply(m, [0, 2, 2.5, 4, 100])
    check("KS bin map apply: out-of-range scores fall in the end bins, edges are inclusive above",
          ap == [m["means"][0], m["means"][0], m["means"][1], m["means"][1], m["means"][2]], ap)
    mt = cps.bin_map_fit([1, 1, 1, 1, 2, 3], [0, 1, 0, 1, 1, 1], 2)
    check("KS tied scores are never split across bins", mt["edges"] == [1] and mt["counts"] == [4, 2], mt)
    md = cps.bin_map_fit([1, 1, 1, 1, 1, 2], [0, 1, 0, 1, 1, 1], 3)  # two quantile edges land on the same tie
    mx = cps.bin_map_fit([1, 2, 2, 2, 2, 2], [0, 1, 0, 1, 1, 1], 3)  # every quantile edge lands on the maximum
    check("KS a repeated edge and an edge at the maximum are both dropped: edges strictly increase and NO bin is empty",
          md["edges"] == [1] and md["counts"] == [5, 1] and mx["edges"] == [] and mx["counts"] == [6], (md, mx))
    r = random.Random(1313)
    s = [r.gauss(0, 1) for _ in range(800)]
    y1 = [r.randrange(2) for _ in s]
    y2 = [1 - v for v in y1]
    check("KS edges are LABEL-BLIND (identical under relabelling)",
          cps.bin_map_fit(s, y1, 10)["edges"] == cps.bin_map_fit(s, y2, 10)["edges"])
    tr = [r.gauss(0, 1) for _ in range(3000)]
    te = [r.gauss(0, 1) for _ in range(3000)]
    lab = lambda v: 1 if r.random() < 0.2 + 0.6 * min(abs(v), 1.5) / 1.5 else 0  # a V-shaped relation
    ytr, yte = [lab(v) for v in tr], [lab(v) for v in te]
    sm = cps.bin_map_fit(tr, ytr, 10)
    a_raw, a_map = _blk(te, yte), _blk(cps.bin_map_apply(sm, te), yte)
    check(f"KS S* recovers a non-monotone relation on held-out rows ({a_map:.3f} > 0.62 and > raw {a_raw:.3f} + 0.1)",
          a_map > 0.62 and a_map > a_raw + 0.1)


# ── K13-lite whole engine under a null (+ a planted leg so the null cannot pass vacuously) ────
# R=100 synthetic corpora (G=80 instruments, lognormal(0.9, 0.5) rows each capped at 10, D=3 day blocks;
# score and label each carry instrument + day components; label independent of every score). Families
# L = S + N(0, .5^2), T = S + N(0, .8^2) (correlated with the incumbent, as fitted families are), control
# V independent. Joint bootstrap B=200, family_bounds at Bonferroni n_families=2, floor_pass FORCED
# True (the rate of C given a passed floor -- a failed floor would make C impossible and the test vacuous).
# BOUND: a calibrated engine has P(C) <= P(exists f: a_lo > 0.5) <= 2 x 0.0125 = 0.025 per corpus, so the
# count X ~ Bin(100, <= 0.025); the fixture bound is the smallest c with P(X > c) <= 0.005 (computed below, 7).
K13_R, K13_B, K13_P0, K13_TAIL = 100, 200, 0.025, 0.005


def _binom_bound(R, p, tail):
    cdf = 0.0
    for c in range(R + 1):
        cdf += math.comb(R, c) * p ** c * (1 - p) ** (R - c)
        if 1.0 - cdf <= tail:
            return c
    return R


def _k13_corpus(rng, planted):
    G, D = 80, 3
    a = [rng.gauss(0, 1.0) for _ in range(G)]
    b = [rng.gauss(0, 0.7) for _ in range(G)]
    c = [rng.gauss(0, 0.5) for _ in range(D)]
    t = [rng.gauss(0, 0.5) for _ in range(D)]
    S, L, T, V, Y, Dy, Cl = [], [], [], [], [], [], []
    for g in range(G):
        for _ in range(min(10, max(1, int(rng.lognormvariate(0.9, 0.5))))):
            d = rng.randrange(D)
            s = a[g] + c[d] + rng.gauss(0, 1)
            z = rng.gauss(0, 1)
            if planted:  # a component only the families see, which drives the label
                lat = b[g] + t[d] + 1.5 * z + rng.gauss(0, 1)
                L.append(0.3 * s + z)
                T.append(0.3 * s + z + rng.gauss(0, 0.5))
            else:
                lat = b[g] + t[d] + rng.gauss(0, 1)
                L.append(s + rng.gauss(0, 0.5))
                T.append(s + rng.gauss(0, 0.8))
            S.append(s)
            V.append(rng.gauss(0, 1))
            Y.append(1 if lat > 0 else 0)
            Dy.append(d)
            Cl.append(f"COIN{g}")
    return {"S": S, "L": L, "T": T, "V": V}, Y, Dy, Cl


def _k13_reading(rng, arm, planted):
    sets, Y, Dy, Cl = _k13_corpus(rng, planted)
    boot = cps.cluster_bootstrap_blocked_auc(sets, Y, Dy, Cl, K13_B, cps.arm_seed(LABEL, arm))
    fam = {}
    for f in ("L", "T"):
        fb = cps.family_bounds(boot, f, "S", "V", n_families=2)
        fb["floor_pass"] = True
        fam[f] = fb
    level_hit = any(fb["a_lo"] is not None and fb["a_lo"] > 0.5 for fb in fam.values())
    return cps.holdout_reading(fam, 0.05)[0], level_hit, boot["n_degenerate"]


def k13_engine_null():
    bound = _binom_bound(K13_R, K13_P0, K13_TAIL)
    n_c = n_lvl = n_deg = 0
    for rep in range(K13_R):
        rd, lvl, dg = _k13_reading(random.Random(130000 + rep), f"K13-null-{rep}", False)
        n_c += rd == "C"
        n_lvl += lvl
        n_deg += dg
    print(f"SELF-TEST: K13 null C={n_c}/{K13_R} level-exceedances={n_lvl}/{K13_R} bound={bound} "
          f"(Bin({K13_R},{K13_P0}) tail<={K13_TAIL}) B={K13_B} degenerate={n_deg}")
    check(f"K13 null corpora: holdout_reading returns C in {n_c}/{K13_R} <= {bound}", bound == 7 and n_c <= bound)
    check(f"K13 null corpora: a family's Bonferroni level bound clears 0.5 in {n_lvl}/{K13_R} <= {bound}", n_lvl <= bound)
    n_pc = sum(_k13_reading(random.Random(131000 + rep), f"K13-planted-{rep}", True)[0] == "C" for rep in range(10))
    check(f"K13 planted corpora: the same engine DOES return C ({n_pc}/10 >= 8) -- the null bound is not vacuous", n_pc >= 8)


GROUPS = [
    ("CORE", core_w1),
    ("K1", k1_auc_exactness),
    ("K2", k2_binormal),
    ("K3", k3_coverage),
    ("K4", k4_simpson),
    ("K5", k5_side_artefact),
    ("K6", k6_paired_gap),
    ("K7", k7_leakage_canary),
    ("K8", k8_purge),
    ("K9", k9_arithmetic),
    ("KP", kp_percentile),
    ("K10", k10_decision_map),
    ("K11", k11_determinism),
    ("KT", kt_targets),
    ("KS", ks_bin_map),
    ("K13", k13_engine_null),
]


def _only(argv):
    """`--only A,B` -> {"A", "B"}; absent -> None (the full run)."""
    for i, a in enumerate(argv):
        if a == "--only" and i + 1 < len(argv):
            return {g for g in argv[i + 1].split(",") if g}
        if a.startswith("--only="):
            return {g for g in a.split("=", 1)[1].split(",") if g}
    return None


only = _only(sys.argv[1:])
known = [name for name, _ in GROUPS]
if only is not None and (not only or only - set(known)):
    print(f"CLUSTER_PERM_SELFTEST_SUBSET=INDETERMINATE reason=unknown-or-empty-groups requested={sorted(only)} known={known}")
    sys.exit(3)
t_all = time.time()
for name, fn in GROUPS:
    if only is not None and name not in only:
        continue
    t0 = time.time()
    try:
        fn()
    except Exception as e:  # a group that raises is a FAILED check with a token, never a silent crash
        check(f"group {name} completed without raising", False, f"{type(e).__name__}: {e}")
    print(f"SELF-TEST: group {name} took {time.time() - t0:.2f}s")
print(f"SELF-TEST: total {time.time() - t_all:.2f}s")

if only is None:
    print(f"SELF-TEST: {'PASS' if fails == 0 else 'FAIL'} ({checks} checks)")
    print(f"CLUSTER_PERM_SELFTEST={'PASS' if fails == 0 else 'FAIL'} failures={fails} checks={checks}")
    sys.exit(0 if fails == 0 else 1)
ok = fails == 0 and checks > 0  # a subset that checked nothing never passes
groups_s = ",".join(n for n in known if n in only)
print(f"SELF-TEST: SUBSET {'PASS' if ok else 'FAIL'} ({checks} checks) groups={groups_s}")
print(f"CLUSTER_PERM_SELFTEST_SUBSET={'PASS' if ok else 'FAIL'} failures={fails} checks={checks} groups={groups_s}")
sys.exit(0 if ok else 1)
