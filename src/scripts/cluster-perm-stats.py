#!/usr/bin/env python3
"""cluster-perm-stats — pure statistics over arrays for cluster-structured attribution analyses.

PURE BY CONSTRUCTION. No I/O, no store, no column names, no network. Callers map their own rows
onto the array arguments below. That purity is not a style choice: it is what lets this module live
under `src/` beneath both quarantine firewalls (tests/unit/counterfactual-quarantine.test.ts and
tests/unit/scorer-input-quarantine.test.ts), and tests/unit/cluster-perm-stats.test.ts pins it.

PROVENANCE
  * The permutation / Spearman / BH / split / cluster-mean core is EDGE-SELL-FEATURE-ATTRIBUTION-W1's
    validated instrument (22 known-answer assertions; the exact-null-mean `perm_test`). It had never
    been committed on any ref -- it lived only in a session scratchpad -- so W1's published result was
    unreproducible until EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1 committed it here. The algorithms
    are lifted verbatim; only the calling convention changed from row-dicts to parallel arrays.
  * NEW in EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1: `powered_levels` (the ENFORCED floor predicate
    that replaces W1's quoted-but-never-read literal), `ols` / `cluster_robust_se` /
    `cluster_bootstrap_ols` (linear probability model with cluster inference), `logistic_irls`,
    `ipw_weights`, `normal_sf`. Each carries its own known-answer assertions in
    tests/unit/cluster-perm-stats.selftest.py, and each was mutation-proven to be able to FAIL.

CONVENTIONS
  * `clusters` is a parallel list of hashable cluster ids (e.g. "VENUE|COIN"); rows sharing an id
    are one independence unit. Aggregation is PER CLUSTER, never pooled, wherever a rate is formed.
  * Every function is deterministic given the `rng` (a `random.Random`) it is handed.
"""
import hashlib
import math
import random
from collections import defaultdict

# The cluster floor a level must clear, PER ARM, to be tested. The shipped VALIDITY_POWERED_FLOOR in
# src/scripts/edge-stats.ts is 50 in decided ROWS; W1 declared 50 CLUSTERS, which is strictly
# stronger, and then never enforced it -- the constant was assigned once and never read, and three
# sub-floor cells were published as powered. This one is READ by `powered_levels`; nothing else may
# decide what is powered.
FLOOR_CLUSTERS = 50


# ── W1 core, verbatim algorithms ──────────────────────────────────────────────────────────────

def midranks(vals):
    """Midranks with ties -- the Spearman convention."""
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    out = [0.0] * len(vals)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        r = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            out[order[k]] = r
        i = j + 1
    return out


def spearman(a, b):
    ra, rb = midranks(a), midranks(b)
    n = len(a)
    ma, mb = sum(ra) / n, sum(rb) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    da = sum((x - ma) ** 2 for x in ra) ** 0.5
    db = sum((y - mb) ** 2 for y in rb) ** 0.5
    return num / (da * db) if da > 0 and db > 0 else float("nan")


def perm_test(levels, wins, clusters, B, rng):
    """Within-cluster permutation of level labels; two-sided p for Spearman(level, win).

    EXACT, not an approximation. Under this null the global level multiset and the win vector are
    both invariant, so Sum(rankL*rankW) -- and therefore rho -- is a strictly increasing LINEAR
    function of S = Sum over winners of rankL. Permuting S is permuting rho.

    The centre is the EXACT null mean E[S] = sum_c w_c * mean(ranks_c), never the simulated one:
    within a cluster the permutation draws w_c ranks uniformly without replacement. Using the
    SIMULATED mean adds Monte-Carlo noise to the CENTRE of a two-sided test and biased the tail
    count (W1 measured the inflated false-positive rate before use).
    Returns (rho, p, s_obs, centre).
    """
    rho = spearman(levels, wins)
    rl = midranks(levels)
    by_cluster = defaultdict(list)
    for c, rank, w in zip(clusters, rl, wins):
        by_cluster[c].append((rank, w))
    cl = [([x[0] for x in v], sum(x[1] for x in v)) for v in by_cluster.values()]
    s_obs = sum(rank * w for rank, w in zip(rl, wins))
    null = []
    for _ in range(B):
        s = 0.0
        for ranks, w_c in cl:
            if w_c:
                s += sum(rng.sample(ranks, w_c))
        null.append(s)
    centre = sum(w_c * (sum(ranks) / len(ranks)) for ranks, w_c in cl)
    d_obs = abs(s_obs - centre)
    hits = sum(1 for s in null if abs(s - centre) >= d_obs)
    p = (1 + hits) / (B + 1)
    return rho, p, s_obs, centre


def cluster_level_means(levels, wins, clusters, levels_wanted, B, rng):
    """Per level: unweighted mean of CLUSTER win-rates (never pooled) + cluster-bootstrap percentile CI.
    The pooled rate is returned beside it for reference and must never feed a test."""
    out = {}
    for lv in levels_wanted:
        idx = [i for i, x in enumerate(levels) if x == lv]
        if not idx:
            continue
        per = defaultdict(lambda: [0, 0])
        for i in idx:
            per[clusters[i]][0] += wins[i]
            per[clusters[i]][1] += 1
        rates = [w / n for w, n in per.values()]
        k = len(rates)
        mean = sum(rates) / k
        boot = []
        for _ in range(B):
            samp = [rates[rng.randrange(k)] for _ in range(k)]
            boot.append(sum(samp) / k)
        boot.sort()
        out[lv] = {
            "rows": len(idx), "clusters": k,
            "cluster_mean": round(mean, 6),
            "ci95": [round(boot[int(0.025 * B)], 6), round(boot[int(0.975 * B)], 6)],
            "pooled": round(sum(wins[i] for i in idx) / len(idx), 6),
        }
    return out


def bh(pvals, q):
    """Benjamini-Hochberg step-up; returns a parallel list of rejection booleans."""
    idx = sorted(range(len(pvals)), key=lambda i: pvals[i])
    rej = [False] * len(pvals)
    m = len(pvals)
    kmax = -1
    for rank, i in enumerate(idx, start=1):
        if pvals[i] <= rank * q / m:
            kmax = rank
    for rank, i in enumerate(idx, start=1):
        if rank <= kmax:
            rej[i] = True
    return rej


def split_clusters(cluster_ids, seed, train_frac=0.70):
    """Deterministic cluster-wise split: order by md5(seed|cluster), first `train_frac` are TRAIN.
    Returns (train_set, holdout_set); disjoint by construction."""
    ordered = sorted(set(cluster_ids), key=lambda c: hashlib.md5(f"{seed}|{c}".encode()).hexdigest())
    n_train = int(len(ordered) * train_frac)
    train, hold = set(ordered[:n_train]), set(ordered[n_train:])
    assert not (train & hold), "leakage: a cluster on both sides"
    return train, hold


# ── NEW: the enforced floor ───────────────────────────────────────────────────────────────────

def powered_levels(levels, clusters, floor=FLOOR_CLUSTERS):
    """The floor as a PREDICATE. A level is powered iff it is carried by >= `floor` distinct clusters
    in THIS arm. Returns (powered_levels_sorted, indeterminate_by_level) where the second names every
    excluded level with its cluster count -- below-floor levels are reported by name, never dropped."""
    per = defaultdict(set)
    for lv, c in zip(levels, clusters):
        per[lv].add(c)
    powered = sorted(lv for lv, cs in per.items() if len(cs) >= floor)
    indet = {lv: len(cs) for lv, cs in sorted(per.items()) if len(cs) < floor}
    return powered, indet


# ── NEW: linear algebra (pure, small-k) ───────────────────────────────────────────────────────

def _solve(A, b):
    """Solve A x = b by Gaussian elimination with partial pivoting. Raises ValueError if singular."""
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-12:
            raise ValueError(f"singular system at column {col}")
        M[col], M[piv] = M[piv], M[col]
        for r in range(col + 1, n):
            f = M[r][col] / M[col][col]
            if f != 0.0:
                for c in range(col, n + 1):
                    M[r][c] -= f * M[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = M[r][n] - sum(M[r][c] * x[c] for c in range(r + 1, n))
        x[r] = s / M[r][r]
    return x


def _inv(A):
    n = len(A)
    cols = [_solve(A, [1.0 if i == j else 0.0 for i in range(n)]) for j in range(n)]
    return [[cols[j][i] for j in range(n)] for i in range(n)]


def _suffstats(X, y, w=None):
    """X'WX and X'Wy accumulated in one pass."""
    k = len(X[0])
    xtx = [[0.0] * k for _ in range(k)]
    xty = [0.0] * k
    for i, row in enumerate(X):
        wi = 1.0 if w is None else w[i]
        yi = y[i]
        for a in range(k):
            ra = row[a] * wi
            if ra == 0.0:
                continue
            xty[a] += ra * yi
            xa = xtx[a]
            for b in range(a, k):
                xa[b] += ra * row[b]
    for a in range(k):
        for b in range(a):
            xtx[a][b] = xtx[b][a]
    return xtx, xty


def ols(X, y, w=None):
    """(Weighted) least squares. Returns (beta, residuals). X is a list of rows; include the
    intercept column yourself. Raises ValueError on a singular design."""
    xtx, xty = _suffstats(X, y, w)
    beta = _solve(xtx, xty)
    resid = [y[i] - sum(b * v for b, v in zip(beta, row)) for i, row in enumerate(X)]
    return beta, resid


def classical_se(X, resid, w=None):
    """Homoskedastic SE, for the CR1 ratio diagnostics only. Never a test input on clustered data."""
    n, k = len(X), len(X[0])
    xtx, _ = _suffstats(X, [0.0] * n, w)
    inv = _inv(xtx)
    if w is None:
        s2 = sum(r * r for r in resid) / (n - k)
    else:
        s2 = sum(w[i] * resid[i] * resid[i] for i in range(n)) / (n - k)
    return [math.sqrt(max(s2 * inv[j][j], 0.0)) for j in range(k)]


def cluster_robust_se(X, resid, clusters, w=None):
    """CR1 cluster-robust standard errors (Liang-Zeger sandwich with the G/(G-1)*(n-1)/(n-k)
    small-sample factor). Returns (se_list, G)."""
    n, k = len(X), len(X[0])
    xtx, _ = _suffstats(X, [0.0] * n, w)
    inv = _inv(xtx)
    scores = defaultdict(lambda: [0.0] * k)
    for i, row in enumerate(X):
        wi = 1.0 if w is None else w[i]
        s = scores[clusters[i]]
        ru = resid[i] * wi
        for a in range(k):
            s[a] += row[a] * ru
    meat = [[0.0] * k for _ in range(k)]
    for s in scores.values():
        for a in range(k):
            if s[a] == 0.0:
                continue
            for b in range(k):
                meat[a][b] += s[a] * s[b]
    G = len(scores)
    factor = (G / (G - 1)) * ((n - 1) / (n - k)) if G > 1 else float("nan")
    # V = inv * meat * inv
    tmp = [[sum(inv[a][c] * meat[c][b] for c in range(k)) for b in range(k)] for a in range(k)]
    V = [[sum(tmp[a][c] * inv[c][b] for c in range(k)) for b in range(k)] for a in range(k)]
    return [math.sqrt(max(V[j][j] * factor, 0.0)) for j in range(k)], G


def cluster_bootstrap_ols(X, y, clusters, B, rng, w=None):
    """Cluster bootstrap of the (weighted) OLS coefficients via PER-CLUSTER sufficient statistics:
    resample clusters with replacement, sum their X'WX / X'Wy, solve. Returns per-coefficient
    (lo, hi) percentile 95% intervals and the fraction of draws with the same sign as the point
    estimate. Draws that hit a singular resample are counted and skipped, never silently dropped."""
    k = len(X[0])
    per_x = {}
    per_y = {}
    for i, row in enumerate(X):
        c = clusters[i]
        if c not in per_x:
            per_x[c] = [[0.0] * k for _ in range(k)]
            per_y[c] = [0.0] * k
        wi = 1.0 if w is None else w[i]
        px, py = per_x[c], per_y[c]
        yi = y[i]
        for a in range(k):
            ra = row[a] * wi
            if ra == 0.0:
                continue
            py[a] += ra * yi
            pa = px[a]
            for b in range(k):
                pa[b] += ra * row[b]
    ids = list(per_x.keys())
    G = len(ids)
    beta0, _ = ols(X, y, w)
    draws = [[] for _ in range(k)]
    singular = 0
    for _ in range(B):
        xtx = [[0.0] * k for _ in range(k)]
        xty = [0.0] * k
        for _g in range(G):
            c = ids[rng.randrange(G)]
            px, py = per_x[c], per_y[c]
            for a in range(k):
                xty[a] += py[a]
                xa, pa = xtx[a], px[a]
                for b in range(k):
                    xa[b] += pa[b]
        try:
            bb = _solve(xtx, xty)
        except ValueError:
            singular += 1
            continue
        for j in range(k):
            draws[j].append(bb[j])
    out = []
    for j in range(k):
        d = sorted(draws[j])
        m = len(d)
        if m == 0:
            out.append({"ci95": [float("nan"), float("nan")], "same_sign_frac": float("nan")})
            continue
        lo, hi = d[int(0.025 * m)], d[min(int(0.975 * m), m - 1)]
        same = sum(1 for v in d if (v > 0) == (beta0[j] > 0)) / m
        out.append({"ci95": [lo, hi], "same_sign_frac": same})
    return {"beta": beta0, "coef": out, "draws_used": B - singular, "singular_draws": singular, "clusters": G}


# ── NEW: logistic regression + IPW ────────────────────────────────────────────────────────────

def logistic_irls(X, y, max_iter=25, tol=1e-8, ridge=1e-8):
    """Logistic regression by iteratively reweighted least squares with a tiny ridge for stability.
    Returns dict(beta, p_hat, converged, iterations, separated). `separated` flags fitted
    probabilities at the numeric boundary -- a separable design -- so a caller can refuse rather
    than trust a diverging estimate."""
    n, k = len(X), len(X[0])
    beta = [0.0] * k
    converged = False
    it = 0
    for it in range(1, max_iter + 1):
        eta = [sum(b * v for b, v in zip(beta, row)) for row in X]
        p = [1.0 / (1.0 + math.exp(-min(max(e, -35.0), 35.0))) for e in eta]
        wv = [pi * (1.0 - pi) for pi in p]
        z = [eta[i] + (y[i] - p[i]) / max(wv[i], 1e-12) for i in range(n)]
        xtx, xty = _suffstats(X, z, wv)
        for j in range(k):
            xtx[j][j] += ridge
        new = _solve(xtx, xty)
        delta = max(abs(a - b) for a, b in zip(new, beta))
        beta = new
        if delta < tol:
            converged = True
            break
    eta = [sum(b * v for b, v in zip(beta, row)) for row in X]
    p_hat = [1.0 / (1.0 + math.exp(-min(max(e, -35.0), 35.0))) for e in eta]
    separated = any(pi < 1e-8 or pi > 1.0 - 1e-8 for pi in p_hat)
    return {"beta": beta, "p_hat": p_hat, "converged": converged, "iterations": it, "separated": separated}


def ipw_weights(p_hat, selected, stabilize=True):
    """Inverse-probability weights for the SELECTED rows: w_i = P(S=1) / p_hat_i (stabilized) or
    1 / p_hat_i. Rows with selected=False get weight 0. p_hat must be strictly positive on
    selected rows; a zero-probability selected row is a contradiction and raises."""
    n = len(p_hat)
    sel_rate = sum(1 for s in selected if s) / n
    out = [0.0] * n
    for i in range(n):
        if not selected[i]:
            continue
        if p_hat[i] <= 0.0:
            raise ValueError(f"selected row {i} has p_hat <= 0")
        out[i] = (sel_rate / p_hat[i]) if stabilize else (1.0 / p_hat[i])
    return out


def normal_sf(z):
    """Two-sided normal tail probability P(|Z| >= |z|)."""
    return math.erfc(abs(z) / math.sqrt(2.0))
