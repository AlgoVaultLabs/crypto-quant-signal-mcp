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
  * NEW in EDGE-SCORER-PREDICTIVE-CEILING-W1 (the discrimination layer, last section of this file):
    `auc_midrank`, the block-stratified AUC (`blocked_auc_prepare` / `blocked_auc_weighted` /
    `blocked_auc`), the JOINT cluster bootstrap of several scores (`cluster_bootstrap_blocked_auc`),
    order-statistic intervals (`percentile` / `ci_lower` / `ci_upper`), per-arm seeds and grouped
    folds, Kish / m* / ANOVA ICC, the label-blind AUC power floor (`auc_floor`), the registered
    decision map (`holdout_reading` / `verdict_state`), the temporal purge, the direction target, the
    side orientation, out-of-fold prediction, and the univariate re-map S* (`bin_map_fit` /
    `bin_map_apply`). Known answers K1-K13 live in the self-test, and the COMMITTED harness
    tests/unit/cluster-perm-stats.mutation.py proves each load-bearing line can turn it red.
  * NEW in EDGE-HURST-DISCRIMINATION-PROBE-W1 (the term-contribution layer, last section of this file):
    does an ADDITIVE TERM earn its place in a fixed score? `pair_reorder_share` / `untied_pair_share`
    (what a term or a tied ranker can move at all), `materiality_delta` (q-unit materiality),
    `counterfactual_without_stage` (the score with one stage removed, a later gated stage re-evaluated),
    `gap_reading` / `level_reading` / `term_side_reading` / `term_verdict` / `lodo_stable` (a TOTAL
    per-side map, an intersection-union verdict and a stability gate), the recommendation layer
    (`reliability_reading`, its registration precondition `oc_gate`, `remove_scope`, `outcome_contradicts`,
    `recommendation`, `flip_driven`, `keep_licence`, `native_sign`) and the label-free reliability statistics
    `cohen_kappa` / `stratified_kappa` / `cluster_bootstrap_kappa` / `twoway_cluster_bootstrap_kappa` /
    `total_variation`. Known answers: group KH; mutation set TERM.

CONVENTIONS
  * `clusters` is a parallel list of hashable cluster ids (e.g. "VENUE|COIN"); rows sharing an id
    are one independence unit. Aggregation is PER CLUSTER, never pooled, wherever a rate is formed.
  * Every function is deterministic given the `rng` (a `random.Random`) it is handed.
"""
import bisect
import hashlib
import math
import random
from collections import defaultdict
from statistics import NormalDist

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


# ══ NEW (EDGE-SCORER-PREDICTIVE-CEILING-W1): discrimination with cluster inference ═══════════════
#
# The question this layer answers is RANKING SKILL: does a score order outcomes better than chance,
# and better than another score, on the same rows. Three properties are load-bearing and each is
# pinned by a known-answer fixture plus a committed mutation (tests/unit/cluster-perm-stats.mutation.py):
#   1. Pairs are formed WITHIN a block only (e.g. side x day x horizon x fold). A pooled AUC credits
#      discrimination BETWEEN strata -- the tape, the side, the day -- which is not skill, and its null
#      is not 0.5. A block's weight is n1_b * n0_b, i.e. every within-block pair counts once.
#   2. Intervals resample the registered INDEPENDENCE UNIT (cluster), never rows, and resample it
#      JOINTLY for every score compared, so a gap between two scores is a paired statistic.
#   3. Degenerate draws (no within-block pair) are COUNTED and reported, never silently dropped.
# Labels are 0/1 codes; mapping a store's outcome onto them is the caller's job (see
# `direction_target`). Nothing here names a column or touches a store.

_NORMAL = NormalDist()


def _refuse_nan(values, what):
    """Refuse a NaN before anything ranks it. Every comparison with a NaN is False, so a sort that meets
    one returns an order that depends on where the NaN STARTED: the same rows in another order gave
    AUC 0.667 and 1.0 (measured in review). A rank statistic must never be row-order dependent, so a NaN
    is an input error (ValueError naming the first bad row), never a rank."""
    for i, v in enumerate(values):
        if v != v:
            raise ValueError(f"{what}[{i}] is NaN")


def auc_midrank(scores, labels):
    """Mann-Whitney AUC from the midrank sum: P(s_pos > s_neg) + 1/2 P(s_pos == s_neg).

    `labels` are 0/1. Returns None when there are no positives or no negatives -- the statistic is
    undefined there, and reporting 0.5 would manufacture a null. Deliberately INDEPENDENT of the sweep
    in `blocked_auc_weighted` (rank-sum vs sorted sweep): the self-test cross-checks the two."""
    n = len(scores)
    if len(labels) != n:
        raise ValueError("scores and labels differ in length")
    _refuse_nan(scores, "scores")
    n1 = 0
    for y in labels:
        if y not in (0, 1):
            raise ValueError(f"label {y!r} is not a 0/1 code")
        n1 += 1 if y == 1 else 0
    n0 = n - n1
    if n1 == 0 or n0 == 0:
        return None
    r = midranks(scores)
    r1 = sum(ri for ri, y in zip(r, labels) if y == 1)
    return (r1 - n1 * (n1 + 1) / 2.0) / (n1 * n0)


def blocked_auc_prepare(scores, labels, blocks):
    """Build ONCE the sorted, tie-grouped structure `blocked_auc_weighted` sweeps, so a bootstrap
    replicate costs O(n) and never re-sorts.

    Opaque result. Per block, rows in ascending score order; a row alone at its score is stored as
    its index (``i`` for a positive, ``~i`` for a negative), a tie group as a tuple
    (positive_rows, negative_rows). Only rows sharing a block key are ever paired."""
    n = len(scores)
    if not (len(labels) == n == len(blocks)):
        raise ValueError("scores, labels and blocks differ in length")
    _refuse_nan(scores, "scores")
    by_block = {}
    for i in range(n):
        if labels[i] not in (0, 1):
            raise ValueError(f"label {labels[i]!r} at row {i} is not a 0/1 code")
        key = blocks[i]
        by_block.setdefault(key, []).append(i)
    seqs = []
    for rows in by_block.values():
        rows.sort(key=lambda i: scores[i])
        seq = []
        j = 0
        m = len(rows)
        while j < m:
            k = j
            sj = scores[rows[j]]
            while k + 1 < m and scores[rows[k + 1]] == sj:
                k += 1
            if k == j:
                i = rows[j]
                seq.append(i if labels[i] == 1 else ~i)
            else:
                grp = rows[j:k + 1]
                seq.append((tuple(i for i in grp if labels[i] == 1), tuple(i for i in grp if labels[i] == 0)))
            j = k + 1
        seqs.append(seq)
    return {"n": n, "blocks": seqs, "unit": [1] * n}


def blocked_auc_weighted(prep, row_weights=None):
    """Weighted block-stratified AUC in one O(n) sweep over the prepared order:

        sum_b sum_{i in pos_b, j in neg_b} w_i w_j [1(s_i > s_j) + 1/2 1(s_i == s_j)]
        -----------------------------------------------------------------------
                     sum_b (sum_{pos_b} w) (sum_{neg_b} w)

    A running sum of NEGATIVE weight strictly below the current score is carried up each block; a tie
    group contributes its positives against the negatives below it in full and against its own
    negatives at one half, which is exact. `row_weights` None means every row weighs 1 (the point
    estimate); a cluster bootstrap passes multiplicities. Returns (auc, pair_weight); (None, 0) when
    the pair weight is 0 -- a degenerate draw, which the caller must COUNT."""
    w = prep["unit"] if row_weights is None else row_weights
    if len(w) != prep["n"]:
        raise ValueError("row_weights has the wrong length")
    num = 0.0
    den = 0.0
    for seq in prep["blocks"]:
        below = 0.0
        ptot = 0.0
        for g in seq:
            if g.__class__ is int:
                if g >= 0:
                    pw = w[g]
                    num += pw * below
                    ptot += pw
                else:
                    below += w[~g]
            else:
                pos, neg = g
                pw = 0.0
                for i in pos:
                    pw += w[i]
                nw = 0.0
                for i in neg:
                    nw += w[i]
                num += pw * (below + 0.5 * nw)
                ptot += pw
                below += nw
        den += ptot * below
    if den <= 0.0:
        return None, 0
    return num / den, den


def blocked_auc(scores, labels, blocks):
    """Convenience: prepare + unit-weight sweep. Returns (auc, within-block pair count)."""
    return blocked_auc_weighted(blocked_auc_prepare(scores, labels, blocks))


def paired_diffs(reps_a, reps_b):
    """Replicate-aligned differences a - b (the paired gap). A replicate degenerate in either is
    skipped here; `cluster_bootstrap_blocked_auc` reports how many there were."""
    if len(reps_a) != len(reps_b):
        raise ValueError("replicate lists are not aligned")
    return [a - b for a, b in zip(reps_a, reps_b) if a is not None and b is not None]


def cluster_bootstrap_blocked_auc(score_sets, labels, blocks, clusters, B, seed):
    """Cluster bootstrap of the block-stratified AUC of SEVERAL scores on the same rows.

    `score_sets` maps a name to a score list parallel to `labels` / `blocks` / `clusters`. Each
    replicate draws G cluster units with replacement ONCE; a row's weight is its unit's multiplicity
    in that draw, and EVERY score set is evaluated under the SAME weights -- so `paired_diffs` of two
    names' replicates is the paired gap, whose variance carries the (1 - r) factor an independent
    draw would throw away. The RNG is a private `random.Random(seed)`; pass `arm_seed(...)`.
    Returns {point, reps, n_degenerate, B, seed, units, rows, pairs}: `point` at unit weights,
    `reps[name]` one entry per replicate (None where degenerate), degenerate draws COUNTED."""
    names = list(score_sets)
    if not names:
        raise ValueError("no score sets")
    n = len(labels)
    for nm in names:
        if len(score_sets[nm]) != n:
            raise ValueError(f"score set {nm!r} is not parallel to labels")
    if len(clusters) != n:
        raise ValueError("clusters is not parallel to labels")
    preps = {nm: blocked_auc_prepare(score_sets[nm], labels, blocks) for nm in names}
    point = {}
    pairs = 0
    for nm in names:
        point[nm], pairs = blocked_auc_weighted(preps[nm])
    units = clusters
    uid = {}
    row_unit = [uid.setdefault(u, len(uid)) for u in units]
    G = len(uid)
    rng = random.Random(seed)

    def draw():
        mult = [0] * G
        for _ in range(G):
            mult[rng.randrange(G)] += 1
        return [mult[u] for u in row_unit]

    reps = {nm: [] for nm in names}
    n_degenerate = 0
    for _ in range(B):
        w_joint = draw()
        degenerate = False
        for nm in names:
            w = w_joint
            a, _pw = blocked_auc_weighted(preps[nm], w)
            reps[nm].append(a)
            if a is None:
                degenerate = True
        if degenerate:
            n_degenerate += 1
    return {"point": point, "reps": reps, "n_degenerate": n_degenerate, "B": B, "seed": seed,
            "units": G, "rows": n, "pairs": pairs}


# ── order-statistic intervals ─────────────────────────────────────────────────────────────────

def percentile(values, q):
    """Nearest-rank percentile (Hyndman-Fan type 1, the inverse empirical CDF): the k-th smallest of
    the non-None values with k = ceil(q*m), clamped to [1, m]. 1e-9 is subtracted from q*m before the
    ceiling so binary noise in q can never push an exact integer rank up by one (0.0125 * 4000 must
    give k = 50). Examples: values 1..100 -> q=0.025 gives 3, q=0.5 gives 50, q=0.975 gives 98.
    Returns None when there are no values."""
    if not 0.0 <= q <= 1.0:
        raise ValueError(f"q={q} is outside [0, 1]")
    v = sorted(x for x in values if x is not None)
    m = len(v)
    if m == 0:
        return None
    k = math.ceil(q * m - 1e-9)
    k = min(max(k, 1), m)
    return v[k - 1]


def ci_lower(values, alpha_one_sided):
    """One-sided lower bound: the nearest-rank alpha percentile. It leaves ceil(alpha*m) - 1 order
    statistics strictly below it."""
    return percentile(values, alpha_one_sided)


def ci_upper(values, alpha_one_sided):
    """One-sided upper bound, the MIRROR of `ci_lower` (-ci_lower(-values)): it leaves ceil(alpha*m) - 1
    order statistics strictly above it, so a two-sided interval built from the pair is symmetric in
    rank by construction. Values 1..100 at alpha 0.025 -> (3, 98)."""
    lo = percentile([-x for x in values if x is not None], alpha_one_sided)
    return None if lo is None else -lo


# ── seeds and folds ──────────────────────────────────────────────────────────────────────────

def arm_seed(label, arm):
    """Per-arm RNG seed: uint32 of the first 8 hex digits of sha256(label + ':' + arm). One arm's draws
    never depend on how many draws another arm consumed."""
    return int(hashlib.sha256((label + ":" + arm).encode()).hexdigest()[:8], 16)


def grouped_fold(key, label, k=5):
    """Grouped k-fold assignment of an independence unit: int(md5(label|fold|key)[:8], 16) mod k.
    Every row of one unit lands in the same fold, so no unit is ever on both sides of a fit."""
    return int(hashlib.md5((label + "|fold|" + str(key)).encode()).hexdigest()[:8], 16) % k


# ── cluster structure ────────────────────────────────────────────────────────────────────────

def cluster_sizes(clusters):
    """Row count per distinct cluster id, in first-seen order."""
    cnt = {}
    for c in clusters:
        cnt[c] = cnt.get(c, 0) + 1
    return list(cnt.values())


def kish_eff(cluster_sizes):
    """Kish effective number of clusters, (sum m)^2 / sum m^2. Equal sizes -> the raw count; one giant
    cluster -> 1. A raw cluster count overstates independence whenever sizes are unequal."""
    s = float(sum(cluster_sizes))
    ss = float(sum(m * m for m in cluster_sizes))
    if ss <= 0.0:
        return 0.0
    return s * s / ss


def m_star(cluster_sizes):
    """Size-weighted mean cluster size, sum m^2 / sum m (= n / kish_eff): the m in the design effect
    1 + (m - 1) rho when cluster sizes are unequal."""
    s = float(sum(cluster_sizes))
    ss = float(sum(m * m for m in cluster_sizes))
    if s <= 0.0:
        return 0.0
    return ss / s


def icc_anova(values, clusters):
    """One-way ANOVA ICC(1) with unequal group sizes:

        (MSB - MSW) / (MSB + (n0 - 1) MSW),   n0 = (N - sum n_g^2 / N) / (k - 1)

    Reported RAW -- it may be negative; any flooring is the consumer's (see `auc_floor`). None when it
    is undefined: fewer than 2 clusters, no within-cluster degree of freedom (every cluster a single
    row), or a zero denominator (constant values)."""
    if len(values) != len(clusters):
        raise ValueError("values and clusters differ in length")
    groups = {}
    for x, c in zip(values, clusters):
        groups.setdefault(c, []).append(x)
    k = len(groups)
    N = len(values)
    if k < 2 or N - k <= 0:
        return None
    grand = sum(values) / N
    ssb = 0.0
    ssw = 0.0
    sq = 0
    for g in groups.values():
        ng = len(g)
        mg = sum(g) / ng
        ssb += ng * (mg - grand) ** 2
        ssw += sum((x - mg) ** 2 for x in g)
        sq += ng * ng
    msb = ssb / (k - 1)
    msw = ssw / (N - k)
    n0 = (N - sq / N) / (k - 1)
    den = msb + (n0 - 1.0) * msw
    if den <= 0.0:
        return None
    return (msb - msw) / den


def within_block_uniform(x, blocks):
    """Within-block rank uniform U = (midrank within block - 1/2) / n_b, in (0, 1). Label-free: this
    is the scale on which the AUC floor's variances and ICCs are measured."""
    if len(x) != len(blocks):
        raise ValueError("x and blocks differ in length")
    _refuse_nan(x, "x")
    by_block = {}
    for i, b in enumerate(blocks):
        by_block.setdefault(b, []).append(i)
    u = [0.0] * len(x)
    for idx in by_block.values():
        r = midranks([x[i] for i in idx])
        nb = float(len(idx))
        for j, i in enumerate(idx):
            u[i] = (r[j] - 0.5) / nb
    return u


def _within_block_variance(x, blocks):
    """Pooled within-block variance, sum_b sum_i (x_i - mean_b)^2 / n (divisor n: the U scale is
    centred exactly within every block, so no degree of freedom is spent estimating a mean)."""
    by_block = {}
    for xi, b in zip(x, blocks):
        by_block.setdefault(b, []).append(xi)
    n = len(x)
    ss = 0.0
    for v in by_block.values():
        mb = sum(v) / len(v)
        ss += sum((xi - mb) ** 2 for xi in v)
    return ss / n


# ── the AUC power floor (label-blind) ────────────────────────────────────────────────────────

def floor_k(alpha_one_sided, power=0.80):
    """K = z_{1 - alpha} + z_{power}. alpha 0.025 (two-sided 0.05) at 80% -> 2.8016;
    the Bonferroni one-sided 0.0125 -> 3.0830."""
    return _NORMAL.inv_cdf(1.0 - alpha_one_sided) + _NORMAL.inv_cdf(power)


def floor_deff(m_star_value, rho, rho_e=1.0):
    """Design effect 1 + (m* - 1) max(rho, 0) rho_e. A negative ICC is floored at 0 HERE ONLY -- the
    raw value is still reported -- so a design effect can never shrink the SE below the iid one."""
    return 1.0 + (m_star_value - 1.0) * max(rho, 0.0) * rho_e


def floor_se(sigma2, n, pi_lower, m_star_value, rho, rho_e=1.0):
    """SE = sqrt(sigma2 * V * DEFF / n), V = 1 / (pi (1 - pi)). At m* = 1, pi = 1/2 and
    sigma2 = 2(1 - r)/12 this is 2(1 - r)/(3n): Hanley-McNeil's AUC variance at A = 1/2, differenced."""
    V = 1.0 / (pi_lower * (1.0 - pi_lower))
    return math.sqrt(sigma2 * V * floor_deff(m_star_value, rho, rho_e) / n)


def floor_n_required(sigma2, pi_lower, m_star_value, rho, delta, alpha_one_sided, power=0.80, rho_e=1.0):
    """The row count at which K * SE = delta for this sigma2 / pi / cluster structure (real-valued;
    the integer requirement is its ceiling)."""
    K = floor_k(alpha_one_sided, power)
    V = 1.0 / (pi_lower * (1.0 - pi_lower))
    return K * K * sigma2 * V * floor_deff(m_star_value, rho, rho_e) / (delta * delta)


def auc_floor(u_f, u_s, blocks, clusters, delta, pi_lower, alpha_one_sided, power=0.80):
    """The registered, LABEL-BLIND power floor for one family on one holdout's rows.

    D = u_f - u_s (within-block rank uniforms of the family and the incumbent). sigma2_D, sigma2_Uf =
    pooled within-block variances; rho_D, rho_Uf = ANOVA ICC(1) within clusters; m* = sum m^2 / sum m;
    rho_e := 1 (the label ICC bound -- a constant, never estimated); V = 1/(pi (1 - pi)).
        SE_gap = sqrt(sigma2_D  V (1 + (m* - 1) rho_D  rho_e) / n)
        SE_lvl = sqrt(sigma2_Uf V (1 + (m* - 1) rho_Uf rho_e) / n)
        PASS  <=>  K SE_lvl <= delta  AND  K SE_gap <= delta,   K = z_{1-alpha} + z_{power}
    A negative rho is floored at 0 inside the design effect only. An ICC that is undefined while it
    still matters (m* > 1 and non-zero variance) makes that SE undefined and the floor FAILS --
    'could not measure' never passes. Returns every component."""
    n = len(u_f)
    if not (len(u_s) == n == len(blocks) == len(clusters)):
        raise ValueError("u_f, u_s, blocks and clusters differ in length")
    if n == 0:
        raise ValueError("no rows")
    if not 0.0 < pi_lower < 1.0:
        raise ValueError("pi_lower must lie in (0, 1)")
    d = [a - b for a, b in zip(u_f, u_s)]
    sigma2_d = _within_block_variance(d, blocks)
    sigma2_uf = _within_block_variance(u_f, blocks)
    rho_d = icc_anova(d, clusters)
    rho_uf = icc_anova(u_f, clusters)
    sizes = cluster_sizes(clusters)
    ms = m_star(sizes)
    rho_e = 1.0
    K = floor_k(alpha_one_sided, power)

    def _se(sigma2, rho):
        if rho is None:
            if ms == 1.0 or sigma2 == 0.0:
                rho = 0.0  # the design-effect term vanishes whatever rho is
            else:
                return None, None
        return floor_se(sigma2, n, pi_lower, ms, rho, rho_e), floor_n_required(
            sigma2, pi_lower, ms, rho, delta, alpha_one_sided, power, rho_e)

    se_gap, n_req_gap = _se(sigma2_d, rho_d)
    se_lvl, n_req_lvl = _se(sigma2_uf, rho_uf)
    pass_gap = se_gap is not None and K * se_gap <= delta
    pass_lvl = se_lvl is not None and K * se_lvl <= delta
    return {
        "n": n, "clusters": len(sizes), "kish_eff": kish_eff(sizes), "m_star": ms,
        "sigma2_gap": sigma2_d, "sigma2_lvl": sigma2_uf, "rho_gap": rho_d, "rho_lvl": rho_uf,
        "rho_e": rho_e, "V": 1.0 / (pi_lower * (1.0 - pi_lower)), "K": K, "delta": delta,
        "se_gap": se_gap, "se_lvl": se_lvl, "n_required_gap": n_req_gap, "n_required_lvl": n_req_lvl,
        "pass_gap": pass_gap, "pass_lvl": pass_lvl, "floor_pass": pass_gap and pass_lvl,
    }


# ── the registered decision map ──────────────────────────────────────────────────────────────

READINGS = ("C", "N", "U", "P")
STATES = ("CEILING_EXISTS", "NO_CEILING", "INDETERMINATE_UNDERPOWERED",
          "INDETERMINATE_DISAGREE", "INDETERMINATE_UNRESOLVED")


def family_bounds(boot, fam, incumbent, control, n_families, alpha_family=0.025, alpha_equiv=0.05):
    """Project one `cluster_bootstrap_blocked_auc` result onto `holdout_reading`'s inputs for family
    `fam`. The confirmatory bounds are Bonferroni over the `n_families` confirmatory families
    (one-sided alpha_family / n_families: 0.025 / 2 = 0.0125); the equivalence bound gap_hi95 is the
    unadjusted one-sided 95% upper bound (NO CEILING is an intersection-union test and needs no
    adjustment). All gaps are PAIRED -- replicate-aligned differences of the joint bootstrap."""
    a = alpha_family / n_families
    rf, rs, rv = boot["reps"][fam], boot["reps"][incumbent], boot["reps"][control]
    pf, ps, pv = boot["point"][fam], boot["point"][incumbent], boot["point"][control]
    gaps = paired_diffs(rf, rs)
    vols = paired_diffs(rf, rv)
    return {
        "a_hat": pf, "a_lo": ci_lower(rf, a),
        "gap_hat": None if pf is None or ps is None else pf - ps,
        "gap_lo": ci_lower(gaps, a), "gap_hi95": ci_upper(gaps, alpha_equiv),
        "vol_hat": None if pf is None or pv is None else pf - pv,
        "vol_lo": ci_lower(vols, a), "alpha_bonf": a, "draws_used": len(gaps),
    }


def _gt(x, t):
    return x is not None and x > t


def holdout_reading(fam, delta=0.05):
    """One holdout's reading from its per-family summaries.

    `fam` maps family -> {a_lo, gap_lo, gap_hat, gap_hi95, vol_lo, floor_pass}. Returns
    (reading, families_qualifying_for_C):
      P  the floor failed for ANY family (it must pass for every confirmatory family);
      C  some f has a_lo > 0.5 AND gap_lo > 0 AND gap_hat >= delta AND vol_lo > 0;
      N  every f has max(gap_hi95, gap_hat) < delta;
      U  anything else.
    C and N are mutually exclusive BY CONSTRUCTION: C needs gap_hat >= delta for some f, N needs
    gap_hat < delta for every f -- the max() makes that hold even for a skewed bootstrap interval
    whose upper bound sits below its own point estimate. A None bound (degenerate) qualifies for
    nothing. A NOT_ESTIMABLE family (registered: not converged or separated) is passed with None
    bounds: it can never qualify for C and it BLOCKS N, so the partner family alone can read C but
    never N. A floor_pass that is not literally True (e.g. None: never evaluated) is not a pass -> P."""
    if not fam:
        raise ValueError("no families")
    need = ("a_lo", "gap_lo", "gap_hat", "gap_hi95", "vol_lo", "floor_pass")
    for name, f in fam.items():
        missing = [k for k in need if k not in f]
        if missing:
            raise ValueError(f"family {name!r} lacks {missing}")
    if not all(f["floor_pass"] is True for f in fam.values()):
        return "P", []
    c_fams = sorted(name for name, f in fam.items()
                    if _gt(f["a_lo"], 0.5) and _gt(f["gap_lo"], 0.0)
                    and f["gap_hat"] is not None and f["gap_hat"] >= delta and _gt(f["vol_lo"], 0.0))
    if c_fams:
        return "C", c_fams
    if all(f["gap_hi95"] is not None and f["gap_hat"] is not None
           and max(f["gap_hi95"], f["gap_hat"]) < delta for f in fam.values()):
        return "N", []
    return "U", []


def verdict_state(reading_cluster, reading_temporal, c_fams_cluster, c_fams_temporal):
    """The registered 16-cell map over (cluster, temporal) readings to exactly one state:
      any P                      -> INDETERMINATE_UNDERPOWERED
      CN / NC                    -> INDETERMINATE_DISAGREE
      CC, a SAME family in both  -> CEILING_EXISTS
      CC, no common family       -> INDETERMINATE_DISAGREE
      NN                         -> NO_CEILING
      anything else              -> INDETERMINATE_UNRESOLVED
    Precedence P > disagree > unresolved. Inconsistent input (a C naming no family, or a non-C naming
    one) is REFUSED, never mapped."""
    for r, cf in ((reading_cluster, c_fams_cluster), (reading_temporal, c_fams_temporal)):
        if r not in READINGS:
            raise ValueError(f"reading {r!r} is not one of {READINGS}")
        if (r == "C") != bool(cf):
            raise ValueError(f"reading {r!r} with qualifying families {cf!r} is inconsistent")
    pair = (reading_cluster, reading_temporal)
    if "P" in pair:
        return "INDETERMINATE_UNDERPOWERED"
    if pair in (("C", "N"), ("N", "C")):
        return "INDETERMINATE_DISAGREE"
    if pair == ("C", "C"):
        return "CEILING_EXISTS" if set(c_fams_cluster) & set(c_fams_temporal) else "INDETERMINATE_DISAGREE"
    if pair == ("N", "N"):
        return "NO_CEILING"
    return "INDETERMINATE_UNRESOLVED"


def consumable_headroom(gap_lo):
    """max over families of min over holdouts of the Bonferroni gap lower bound. `gap_lo` maps
    family -> {holdout: bound}. A family with any None bound is not consumable. None if none is."""
    best = None
    for per_holdout in gap_lo.values():
        vals = list(per_holdout.values())
        if not vals or any(v is None for v in vals):
            continue
        m = min(vals)
        if best is None or m > best:
            best = m
    return best


# ── temporal purge ───────────────────────────────────────────────────────────────────────────

def purge_mask(decided_at, race_end, t_split):
    """(train_keep, test_flags) for a forward split at t_split. A TRAIN row must have its whole race
    resolved by the split (race_end <= t_split); a TEST row is decided after it (decided_at > t_split).
    A row decided before the split whose race ends after it is PURGED -- in neither set -- because its
    label was set by post-split prices, the same prices that set the test labels."""
    if len(decided_at) != len(race_end):
        raise ValueError("decided_at and race_end differ in length")
    train, test = [], []
    for d, e in zip(decided_at, race_end):
        if e < d:
            raise ValueError(f"race ends ({e}) before it starts ({d})")
        train.append(e <= t_split)
        test.append(d > t_split)
    return train, test


def assert_purged(train_race_ends, t_split):
    """Raise AssertionError if any training race ends after the split. An explicit raise, not an
    `assert` statement, so `python -O` cannot strip it. Returns the number of rows checked."""
    bad = [e for e in train_race_ends if e > t_split]
    if bad:
        raise AssertionError(f"purge violated: {len(bad)} training race(s) end after the split "
                             f"(latest {max(bad)} > {t_split})")
    return len(train_race_ends)


# ── targets and orientation ──────────────────────────────────────────────────────────────────

def direction_target(label_code, ambiguous_flag):
    """Direction target from a side-relative outcome code (+1 win / 0 timeout / -1 loss): 1 for a clean
    win, 0 for a clean loss, None otherwise. Timeouts carry no direction; an AMBIGUOUS race (both
    barriers inside one candle) is a volatility event, not a direction outcome, and is excluded even
    though a store may have coded it -1."""
    if label_code not in (-1, 0, 1):
        raise ValueError(f"outcome code {label_code!r} is not -1/0/+1")
    if ambiguous_flag not in (True, False):
        raise ValueError(f"ambiguous flag {ambiguous_flag!r} is not boolean")
    if ambiguous_flag:
        return None
    if label_code == 1:
        return 1
    if label_code == -1:
        return 0
    return None


def decided_flag(label_code):
    """Resolution target: 1 if the race resolved either way (code != 0), 0 for a timeout."""
    if label_code not in (-1, 0, 1):
        raise ValueError(f"outcome code {label_code!r} is not -1/0/+1")
    return 1 if label_code != 0 else 0


def orient_score(signed_score, side):
    """Orient a signed score to its side: side * score, so larger means MORE confident in the side's
    own direction (a SELL at -40 and a BUY at +40 both become 40). Side must be -1 or +1: a row with
    no side has no direction to orient to and is refused, never zeroed."""
    if side not in (-1, 1):
        raise ValueError(f"side {side!r} is not -1/+1")
    return side * signed_score


# ── out-of-fold prediction and the univariate re-map S* ──────────────────────────────────────

def crossfit_predict(fit, apply, xs, y, folds):
    """Out-of-fold predictions. For each fold k: fit(train_xs, train_y) on the rows whose fold is NOT k
    and whose target is defined, then apply(model, xs) to the rows OF fold k only. A row's prediction
    therefore never sees a label from its own fold. `fit` and `apply` are caller-supplied callables."""
    n = len(xs)
    if not (len(y) == n == len(folds)):
        raise ValueError("xs, y and folds differ in length")
    out = [None] * n
    for k in sorted(set(folds)):
        tr = [i for i in range(n) if folds[i] != k and y[i] is not None]
        te = [i for i in range(n) if folds[i] == k]
        model = fit([xs[i] for i in tr], [y[i] for i in tr])
        pred = apply(model, [xs[i] for i in te])
        for i, p in zip(te, pred):
            out[i] = p
    return out


def bin_map_fit(train_scores, train_y, n_bins):
    """S*: the best univariate re-map of a score, fitted on TRAIN only.

    Edges are LABEL-BLIND equal-count quantiles of the train scores: edge k is the score at sorted
    position floor(k n / n_bins); a bin is (edge_{j-1}, edge_j]; an edge equal to a previous edge or
    to the maximum is dropped, so TIED SCORES ALWAYS SHARE A BIN and no bin is empty. Each bin's value
    is its Laplace-smoothed train mean (sum y + 0.5) / (count + 1)."""
    n = len(train_scores)
    if n != len(train_y):
        raise ValueError("train_scores and train_y differ in length")
    if n == 0 or n_bins < 1:
        raise ValueError("need at least one train row and one bin")
    _refuse_nan(train_scores, "train_scores")
    v = sorted(train_scores)
    edges = []
    for k in range(1, n_bins):
        p = (k * n) // n_bins
        if p < 1:
            continue
        e = v[p - 1]
        if e >= v[-1] or (edges and e <= edges[-1]):
            continue
        edges.append(e)
    sums = [0.0] * (len(edges) + 1)
    counts = [0] * (len(edges) + 1)
    for s, yv in zip(train_scores, train_y):
        if yv not in (0, 1):
            raise ValueError(f"train target {yv!r} is not a 0/1 code")
        j = bisect.bisect_left(edges, s)
        sums[j] += yv
        counts[j] += 1
    means = [(sums[j] + 0.5) / (counts[j] + 1.0) for j in range(len(sums))]
    return {"edges": edges, "means": means, "counts": counts}


def bin_map_apply(model, scores):
    """Map scores through a fitted S*: each score takes its bin's train mean (scores beyond the train
    range fall in the end bins)."""
    edges, means = model["edges"], model["means"]
    _refuse_nan(scores, "scores")
    return [means[bisect.bisect_left(edges, s)] for s in scores]


# ── the term-contribution layer (EDGE-HURST-DISCRIMINATION-PROBE-W1) ─────────────────────────────
#
# "Does this ADDITIVE TERM earn its place in a fixed score?" Two FIXED rankings on identical rows --
# the score WITH the term and the score WITHOUT it -- compared by a paired, block-stratified AUC. No
# model is fitted, so no holdout is needed; the joint cluster bootstrap above supplies the paired
# interval. What this layer adds is everything the ceiling layer's decision map could not express:
#
#   * IDENTIFIABILITY. A term that changes the within-block order of only a share d of row pairs caps
#     |dAUC| at d (midrank weighting). Materiality is therefore stated in q-units -- the share of the
#     reordered pairs the WITH-term ranking orders correctly -- and converted per side with
#     delta = d (2 q* - 1). A threshold the mechanism cannot reach is not a threshold.
#   * A TOTAL per-side map over (paired gain) x (the term alone as a ranker), in which REMOVE needs an
#     equivalence bound and a significant-but-immaterial gain is NEVER read as REMOVE.
#   * An intersection-union verdict over sides, with a leave-one-day-out stability gate.
#   * Label-free estimator reliability: Cohen's kappa of a classifier against itself across windows,
#     with a cluster bootstrap, and total-variation distance between two class distributions.
# Every rule below is pinned by group KH of the self-test and by the committed TERM mutation set.


def pair_reorder_share(a, b, blocks):
    """Share of WITHIN-BLOCK row pairs whose order differs between rankings `a` and `b`, midrank-weighted:
    a strict reversal counts 1, a tie on one ranking against a strict order on the other counts 1/2, a
    pair ordered (or tied) identically counts 0. Label-free. Returns (share, pairs); (None, 0) when no
    block holds two rows. With the same tie weights as the AUC, |AUC(a) - AUC(b)| <= this share taken
    over positive-negative pairs, which is why it bounds what a term can move."""
    n = len(a)
    if not (len(b) == n == len(blocks)):
        raise ValueError("a, b and blocks differ in length")
    _refuse_nan(a, "a")
    _refuse_nan(b, "b")
    by_block = {}
    for i in range(n):
        by_block.setdefault(blocks[i], []).append(i)
    pairs = 0
    moved = 0.0
    for rows in by_block.values():
        m = len(rows)
        for x in range(m):
            i = rows[x]
            ai, bi = a[i], b[i]
            for y in range(x + 1, m):
                j = rows[y]
                sa = (ai > a[j]) - (ai < a[j])
                sb = (bi > b[j]) - (bi < b[j])
                pairs += 1
                if sa != sb:
                    moved += 1.0 if sa * sb == -1 else 0.5
    if pairs == 0:
        return None, 0
    return moved / pairs, pairs


def untied_pair_share(x, blocks):
    """Share of within-block row pairs NOT tied on `x` -- the most a ranker with heavy ties can move its
    AUC away from 1/2 is half of this. Returns (share, pairs); (None, 0) when no block holds two rows."""
    n = len(x)
    if len(blocks) != n:
        raise ValueError("x and blocks differ in length")
    _refuse_nan(x, "x")
    by_block = {}
    for i in range(n):
        by_block.setdefault(blocks[i], {}).setdefault(x[i], 0)
        by_block[blocks[i]][x[i]] += 1
    pairs = 0
    tied = 0
    for counts in by_block.values():
        m = sum(counts.values())
        pairs += m * (m - 1) // 2
        tied += sum(c * (c - 1) // 2 for c in counts.values())
    if pairs == 0:
        return None, 0
    return (pairs - tied) / pairs, pairs


def materiality_delta(share, q_star):
    """The registered materiality margin on the AUC scale: share * (2 q* - 1). q* = 1/2 gives 0 (nothing is
    material); q* = 1 gives the whole attainable width."""
    if share is None:
        return None
    if not (0.0 <= share <= 1.0) or not (0.5 <= q_star <= 1.0):
        raise ValueError(f"share={share} or q_star={q_star} out of range")
    return share * (2.0 * q_star - 1.0)


def counterfactual_without_stage(pre, downstream_active, gate, bonus):
    """The score with ONE stage removed when a LATER, sign-reading, magnitude-gated stage follows it.
    `pre` is the running score before the removed stage; the downstream stage adds sign(score) * bonus only
    when it is active AND |score| > gate (strict). Re-evaluating the downstream stage on `pre` -- not
    subtracting the removed stage's delta from the final score -- is what "the score without that stage"
    means: the subtraction leaves the downstream stage's gate and sign evaluated on a score that no longer
    exists."""
    if not downstream_active:
        return pre
    if abs(pre) > gate:
        return pre + (bonus if pre > 0 else -bonus)
    return pre


def _bounds(reps, alpha, alpha_equiv):
    return (ci_lower(reps, alpha), ci_upper(reps, alpha), ci_lower(reps, alpha_equiv), ci_upper(reps, alpha_equiv))


def gap_reading(point, reps, delta, alpha=0.025, alpha_equiv=0.05):
    """One side's reading of the PAIRED gain (AUC with the term minus AUC without it).
    Returns (state, reason), state in G+ / G- / Gs / G0 / Gu, precedence in this order:
      G+  CI_lo(alpha) > 0 and point >= delta          -- a material gain;
      G-  CI_hi(alpha) < 0                              -- the term significantly HURTS the ranking;
      Gs  (CI_lo(alpha) > 0 or CI_lo95 > 0) and point < delta
                                                        -- statistically real but below materiality: NOT
                                                           identifiable at q*. Tested at the equivalence
                                                           test's OWN one-sided 0.05 level too, so a gain the
                                                           TOST itself calls significant can never read G0;
      G0  max(CI_hi95, point) < delta and min(CI_lo95, point) > -delta   -- equivalent to no gain;
      Gu  anything else (unresolved), including a degenerate bound.
    Without the Gs line a small, real gain would satisfy the equivalence test and read "adds nothing"."""
    if point is None or delta is None:
        return "Gu", "undefined point or delta"
    lo, hi, lo95, hi95 = _bounds(reps, alpha, alpha_equiv)
    if None in (lo, hi, lo95, hi95):
        return "Gu", "degenerate bootstrap"
    if lo > 0.0 and point >= delta:
        return "G+", "material gain"
    if hi < 0.0:
        return "G-", "significant harm"
    if (lo > 0.0 or lo95 > 0.0) and point < delta:
        return "Gs", "significant but below materiality (not identifiable at q*)"
    if max(hi95, point) < delta and min(lo95, point) > -delta:
        return "G0", "equivalent to no gain"
    return "Gu", "unresolved"


def level_reading(point, reps, delta, level_floor_pass, alpha=0.025, alpha_equiv=0.05, null=0.5):
    """The term ALONE as a ranker, two-sided about `null`. Returns (state, reason), state in A+ / A- / As /
    A0 / Au, in that precedence: a level floor that is not literally True -> Au; A+ CI_lo(alpha) > null;
    A- CI_hi(alpha) < null (a term that ranks BACKWARDS carries information with the wrong sign); As
    significant only at the equivalence test's own one-sided 0.05 (CI_lo95 > null or CI_hi95 < null) --
    never A0, so the TOST cannot certify 'no signal' for a ranking it itself calls significant (mirrors Gs);
    A0 max(CI_hi95, point) < null + delta and min(CI_lo95, point) > null - delta; Au otherwise."""
    if level_floor_pass is not True:
        return "Au", "level floor not met"
    if point is None or delta is None:
        return "Au", "undefined point or delta"
    lo, hi, lo95, hi95 = _bounds(reps, alpha, alpha_equiv)
    if None in (lo, hi, lo95, hi95):
        return "Au", "degenerate bootstrap"
    if lo > null:
        return "A+", "ranks the right way"
    if hi < null:
        return "A-", "ranks backwards"
    if lo95 > null or hi95 < null:
        return "As", "significant only at the equivalence level (never 'no signal')"
    if max(hi95, point) < null + delta and min(lo95, point) > null - delta:
        return "A0", "equivalent to no signal"
    return "Au", "unresolved"


TERM_SIDE_READINGS = ("P", "KEEP", "MAPPING", "MAPPING_INVERT", "MAPPING_PROVISIONAL", "REMOVE",
                      "REMOVE_HARMFUL", "DISAGREE", "UNRESOLVED", "NOT_IDENTIFIABLE")


def term_side_reading(g_state, a_state, gap_floor):
    """The registered per-side map. `gap_floor` is an `auc_floor` result for the paired primary; ONLY its
    `pass_gap` gates here -- the level half of that floor concerns AUC(score) > 1/2, which the paired
    question never asks, and it binds far above the gap half.
      floor pass_gap not True -> P
      G+ : A- -> DISAGREE;  otherwise -> KEEP
      G- : A- -> MAPPING_INVERT;  A+ -> DISAGREE;  A0/Au -> REMOVE_HARMFUL
      G0 : A+/A- -> MAPPING;  A0 -> REMOVE;  Au -> UNRESOLVED
      Gs : any A -> NOT_IDENTIFIABLE   (a real gain below materiality is not actionable either way)
      Gu : A+/A- -> MAPPING_PROVISIONAL;  A0/Au -> UNRESOLVED
    REMOVE is reached ONLY through G0 and A0 together: an unresolved gain can never be read as removal."""
    if g_state not in ("G+", "G-", "Gs", "G0", "Gu"):
        raise ValueError(f"gap state {g_state!r}")
    if a_state not in ("A+", "A-", "As", "A0", "Au"):
        raise ValueError(f"level state {a_state!r}")
    if a_state == "As":
        a_state = "Au"   # in the side map an equivalence-level-only ranking is unresolved: it can never read A0 / REMOVE
    if gap_floor.get("pass_gap") is not True:
        return "P"
    if g_state == "Gs":
        return "NOT_IDENTIFIABLE"
    if g_state == "G+":
        return "DISAGREE" if a_state == "A-" else "KEEP"
    if g_state == "G-":
        if a_state == "A-":
            return "MAPPING_INVERT"
        if a_state == "A+":
            return "DISAGREE"
        return "REMOVE_HARMFUL"
    if g_state == "G0":
        if a_state in ("A+", "A-"):
            return "MAPPING"
        if a_state == "A0":
            return "REMOVE"
        return "UNRESOLVED"
    if a_state in ("A+", "A-"):
        return "MAPPING_PROVISIONAL"
    return "UNRESOLVED"


_TERM_FAMILY = {"KEEP": "KEEP", "MAPPING": "MAPPING", "MAPPING_INVERT": "MAPPING",
                "MAPPING_PROVISIONAL": "MAPPING", "REMOVE": "REMOVE", "REMOVE_HARMFUL": "REMOVE"}
TERM_STATES = ("KEEP_AND_FIX", "MAPPING_ONLY", "REMOVE", "INDETERMINATE_UNDERPOWERED", "INDETERMINATE_DISAGREE",
               "INDETERMINATE_NOT_IDENTIFIABLE", "INDETERMINATE_UNRESOLVED", "INDETERMINATE_UNSTABLE")
_SIDES = ("SELL", "BUY")
_A_STATES = ("A+", "A-", "As", "A0", "Au")
_G_STATES = ("G+", "G-", "Gs", "G0", "Gu")
_NATIVE_SIGNS = ("POS", "NEG", "NS")
# the native-arm sign that CONTRADICTS each verdict family (its CI excludes 0 against the verdict)
_NATIVE_AGAINST = {"KEEP": "NEG", "REMOVE": "POS", "MAPPING": "POS"}


def _exact_sides(d, what):
    if not isinstance(d, dict) or set(d) != set(_SIDES):
        raise ValueError(f"{what} must name exactly SELL and BUY")


def native_sign(lo, hi):
    """The native arm's sign at alpha from its one-sided bounds: POS (lo > 0), NEG (hi < 0), NS otherwise
    (including an undefined bound). Materiality plays no part: a sign disagreement is about direction."""
    if lo is not None and lo > 0.0:
        return "POS"
    if hi is not None and hi < 0.0:
        return "NEG"
    return "NS"


def lodo_stable(full_reading, dropped_readings):
    """True iff EVERY leave-one-day-out reading equals the full-data reading. An empty list is refused:
    a stability gate over zero deletions verified nothing."""
    if not dropped_readings:
        raise ValueError("no leave-one-day-out readings")
    return all(r == full_reading for r in dropped_readings)


def term_verdict(side_readings, side_a, side_stable, native=None):
    """Intersection-union verdict over sides. `side_readings`, `side_a` (each side's level state) and
    `side_stable` must each name EXACTLY {"SELL", "BUY"}; `native` optionally maps the same sides to the
    native-served arm's sign ("POS"/"NEG"/"NS", or None where its floor failed). Every input is validated:
    a malformed value is REFUSED (ValueError), never read as "no objection". Precedence:
      any P                                   -> INDETERMINATE_UNDERPOWERED
      any DISAGREE                            -> INDETERMINATE_DISAGREE
      any NOT_IDENTIFIABLE                    -> INDETERMINATE_NOT_IDENTIFIABLE
      any UNRESOLVED                          -> INDETERMINATE_UNRESOLVED
      the two sides in different families     -> INDETERMINATE_DISAGREE
      MAPPING with the level sign differing   -> INDETERMINATE_DISAGREE   (two findings, not one mapping)
      a side not leave-one-day-out stable     -> INDETERMINATE_UNSTABLE
      the native arm's CI excluding 0 against the verdict (NEG under KEEP; POS under REMOVE or MAPPING)
                                              -> INDETERMINATE_DISAGREE
      else the common family: KEEP -> KEEP_AND_FIX, MAPPING -> MAPPING_ONLY, REMOVE -> REMOVE.
    Returns (state, detail). A native point-sign wobble is NOT an input here; callers print it, non-gating."""
    _exact_sides(side_readings, "side_readings"); _exact_sides(side_a, "side_a"); _exact_sides(side_stable, "side_stable")
    for s in _SIDES:
        if side_readings[s] not in TERM_SIDE_READINGS:
            raise ValueError(f"reading {side_readings[s]!r} for {s}")
        if side_a[s] not in _A_STATES:
            raise ValueError(f"level state {side_a[s]!r} for {s}")
        if side_stable[s] is not True and side_stable[s] is not False:  # identity: `1 in (True, False)` is True
            raise ValueError(f"stability {side_stable[s]!r} for {s}")
    if native is not None:
        _exact_sides(native, "native")
        for s in _SIDES:
            if native[s] is not None and native[s] not in _NATIVE_SIGNS:
                raise ValueError(f"native sign {native[s]!r} for {s}")
    rs = [side_readings[s] for s in _SIDES]
    if "P" in rs:
        return "INDETERMINATE_UNDERPOWERED", "below floor: " + ",".join(s for s in _SIDES if side_readings[s] == "P")
    if "DISAGREE" in rs:
        return "INDETERMINATE_DISAGREE", "gain and level disagree within: " + ",".join(
            s for s in _SIDES if side_readings[s] == "DISAGREE")
    if "NOT_IDENTIFIABLE" in rs:
        return "INDETERMINATE_NOT_IDENTIFIABLE", "a real gain below materiality on: " + ",".join(
            s for s in _SIDES if side_readings[s] == "NOT_IDENTIFIABLE")
    if "UNRESOLVED" in rs:
        return "INDETERMINATE_UNRESOLVED", "unresolved: " + ",".join(s for s in _SIDES if side_readings[s] == "UNRESOLVED")
    fams = {s: _TERM_FAMILY[side_readings[s]] for s in _SIDES}
    if fams["SELL"] != fams["BUY"]:
        return "INDETERMINATE_DISAGREE", f"sides disagree: SELL {side_readings['SELL']} vs BUY {side_readings['BUY']}"
    fam = fams["SELL"]
    if fam == "MAPPING" and side_a["SELL"] != side_a["BUY"]:
        return "INDETERMINATE_DISAGREE", f"the term alone ranks differently across sides: SELL {side_a['SELL']} vs BUY {side_a['BUY']}"
    unstable = [s for s in _SIDES if side_stable[s] is not True]
    if unstable:
        return "INDETERMINATE_UNSTABLE", "a single-day deletion changes the reading: " + ",".join(unstable)
    if native is not None:
        against = [s for s in _SIDES if native[s] == _NATIVE_AGAINST[fam]]
        if against:
            return "INDETERMINATE_DISAGREE", f"native-served arm's CI excludes 0 against {fam} on: {','.join(against)}"
    state = {"KEEP": "KEEP_AND_FIX", "MAPPING": "MAPPING_ONLY", "REMOVE": "REMOVE"}[fam]
    detail = f"SELL {side_readings['SELL']}, BUY {side_readings['BUY']}"
    if "MAPPING_PROVISIONAL" in rs:
        detail += " (provisional)"
    return state, detail


def flip_driven(full_side_reading, subset_side_reading):
    """A side's KEEP is flip-driven when it does NOT survive removing the MR flip/side-creation rows: the
    full reading is KEEP and the reading on the remaining rows is anything else."""
    if full_side_reading not in TERM_SIDE_READINGS or subset_side_reading not in TERM_SIDE_READINGS:
        raise ValueError("unknown side reading")
    return full_side_reading == "KEEP" and subset_side_reading != "KEEP"


def keep_licence(verdict_state, native, native_g):
    """The licence a verdict grants. KEEP_AND_FIX licenses 'keep firing where it fires'; enabling the term on
    dead cells needs the native arm to read G+ on BOTH sides (its floors passed -> native[s] not None).
    Anything else licenses nothing."""
    if verdict_state != "KEEP_AND_FIX":
        return "none"
    _exact_sides(native_g, "native_g")
    if native is not None and all(native[s] is not None and native_g[s] == "G+" for s in _SIDES):
        return "keep firing where it fires; enabling on dead cells permitted subject to the successor re-measure"
    return "keep firing where it fires"


# ── the reliability reading, its registration precondition, and the recommendation ──────────────

def oc_gate(p_below_under_pc, p_below_under_null, max_under_pc=0.20, min_under_null=0.80):
    """THE DISCRIMINATING-POWER PRECONDITION (EDGE-HURST-DISCRIMINATION-PROBE-W1, architect Q13): a
    reliability test may be REGISTERED only if its structure-matched operating characteristic shows it can
    tell the hypotheses apart -- P(reads 'below the positive control' | positive-control truth) <= 0.20 AND
    P(reads 'below the positive control' | null truth) >= 0.80. A test that returns the same answer under
    both is not evidence. Returns {"pass": bool, "reason": str}; an undefined probability never passes."""
    if p_below_under_pc is None or p_below_under_null is None:
        return {"pass": False, "reason": "operating characteristic not computed"}
    for v in (p_below_under_pc, p_below_under_null):
        if not 0.0 <= v <= 1.0:
            raise ValueError(f"probability {v} out of range")
    ok_pc = p_below_under_pc <= max_under_pc
    ok_null = p_below_under_null >= min_under_null
    if ok_pc and ok_null:
        return {"pass": True, "reason": f"P(below|PC)={p_below_under_pc:.3f} <= {max_under_pc}; P(below|null)={p_below_under_null:.3f} >= {min_under_null}"}
    why = []
    if not ok_pc:
        why.append(f"P(below|PC)={p_below_under_pc:.3f} > {max_under_pc} (cannot rule the control out)")
    if not ok_null:
        why.append(f"P(below|null)={p_below_under_null:.3f} < {min_under_null} (too imprecise to read below the control)")
    return {"pass": False, "reason": "; ".join(why)}


RELIABILITY_READINGS = ("BELOW_PC1", "ABOVE_PC1", "UNRESOLVED", "NOT_IDENTIFIABLE")


def reliability_reading(lo, hi, kappa_pc1, oc_pass):
    """Reading of a self-agreement kappa against ONE a-priori positive control. `oc_pass` must be literally
    True (the `oc_gate` result for THIS design); otherwise NOT_IDENTIFIABLE. BELOW_PC1: CI_hi < kappa_pc1.
    ABOVE_PC1: CI_lo >= kappa_pc1. UNRESOLVED otherwise, including an undefined bound."""
    if oc_pass is not True:
        return "NOT_IDENTIFIABLE"
    if lo is None or hi is None or kappa_pc1 is None:
        return "UNRESOLVED"
    if hi < kappa_pc1:
        return "BELOW_PC1"
    if lo >= kappa_pc1:
        return "ABOVE_PC1"
    return "UNRESOLVED"


def remove_scope(pooled_reading, group_readings):
    """Where may REMOVE_THIS_ESTIMATOR apply? Only if the pooled reading is BELOW_PC1, and then only to the
    interval groups that pass their OWN realized-skeleton gate AND read BELOW_PC1 on their own data.
    `group_readings` maps group -> (reading, gate_pass). A group whose own design cannot tell the null from
    the control (gate not literally True) is never in scope: a pooled reading cannot license removal where
    the design has no discriminating power. Returns the sorted list of licensed groups."""
    if pooled_reading not in RELIABILITY_READINGS:
        raise ValueError(f"reliability reading {pooled_reading!r}")
    if pooled_reading != "BELOW_PC1":
        return []
    out = []
    for g, (reading, gate_pass) in group_readings.items():
        if reading not in RELIABILITY_READINGS:
            raise ValueError(f"group reading {reading!r}")
        if gate_pass is True and reading == "BELOW_PC1":
            out.append(g)
    return sorted(out)


def outcome_contradicts(side_g, side_a, native):
    """Does the outcome arm CONTRADICT 'the estimator carries nothing'? Judged per side, never on the verdict
    state: any side with a statistically real positive gain (G+ or Gs), any side whose term alone ranks
    outcomes either way (A+, A-, or As at the equivalence level), or a native arm significantly positive.
    Floors play no part -- callers pass the level state and native sign computed WITHOUT floor gating, because
    a significant reading on an underpowered side is still evidence."""
    _exact_sides(side_g, "side_g"); _exact_sides(side_a, "side_a")
    for s in _SIDES:
        if side_g[s] not in _G_STATES:
            raise ValueError(f"gap state {side_g[s]!r} for {s}")
        if side_a[s] not in _A_STATES:
            raise ValueError(f"level state {side_a[s]!r} for {s}")
    if native is not None:
        _exact_sides(native, "native")
    reasons = [f"{s} gain {side_g[s]}" for s in _SIDES if side_g[s] in ("G+", "Gs")]
    reasons += [f"{s} term-alone {side_a[s]}" for s in _SIDES if side_a[s] in ("A+", "A-", "As")]
    if native is not None:
        reasons += [f"{s} native POS" for s in _SIDES if native[s] == "POS"]
    return bool(reasons), reasons


def recommendation(reliability, verdict_state, side_g, side_a, native):
    """The registered recommendation. Returns (recommendation, detail).
      reliability BELOW_PC1 and the outcome arm contradicting        -> CONFLICT (no serving change)
      reliability BELOW_PC1 and verdict REMOVE                       -> REMOVE_THIS_ESTIMATOR (outcome supporting)
      reliability BELOW_PC1 otherwise                                -> REMOVE_THIS_ESTIMATOR (outcome non-contradicting)
      any other reliability, verdict KEEP_AND_FIX / MAPPING_ONLY / REMOVE -> that verdict
      any other reliability, an INDETERMINATE verdict                -> NO_CHANGE
    Every recommendation except NO_CHANGE and CONFLICT is a serving change needing the operator's acknowledgement
    (registration §0 / §15); an empty-scope REMOVE_THIS_ESTIMATOR is NO_CHANGE in effect (registration §3.7)."""
    if reliability not in RELIABILITY_READINGS:
        raise ValueError(f"reliability reading {reliability!r}")
    if verdict_state not in TERM_STATES:
        raise ValueError(f"verdict state {verdict_state!r}")
    contra, why = outcome_contradicts(side_g, side_a, native)
    if reliability == "BELOW_PC1":
        if contra:
            return "CONFLICT", "estimator below the positive control but the outcome arm shows value: " + "; ".join(why)
        if verdict_state == "REMOVE":
            return "REMOVE_THIS_ESTIMATOR", "label-free basis; outcome arm supporting"
        return "REMOVE_THIS_ESTIMATOR", "label-free basis; outcome arm non-contradicting (" + verdict_state + ")"
    if verdict_state in ("KEEP_AND_FIX", "MAPPING_ONLY", "REMOVE"):
        return verdict_state, f"reliability {reliability}"
    return "NO_CHANGE", f"reliability {reliability}; outcome {verdict_state}"


# ── label-free estimator reliability ─────────────────────────────────────────────────────────

def cohen_kappa(a, b, w=None):
    """Cohen's kappa of two parallel categorical lists, optionally with row weights (a bootstrap passes
    multiplicities): (p_o - p_e) / (1 - p_e), with p_e from the TWO marginals. None when p_e == 1 (every
    row in one category on both sides) or the total weight is 0."""
    n = len(a)
    if len(b) != n or (w is not None and len(w) != n):
        raise ValueError("a, b (and w) differ in length")
    tot = 0.0
    agree = 0.0
    pa = {}
    pb = {}
    for i in range(n):
        wi = 1.0 if w is None else w[i]
        if wi == 0:
            continue
        tot += wi
        if a[i] == b[i]:
            agree += wi
        pa[a[i]] = pa.get(a[i], 0.0) + wi
        pb[b[i]] = pb.get(b[i], 0.0) + wi
    if tot <= 0.0:
        return None
    po = agree / tot
    pe = sum((pa[k] / tot) * (pb.get(k, 0.0) / tot) for k in pa)
    if pe >= 1.0:
        return None
    return (po - pe) / (1.0 - pe)


def cluster_bootstrap_kappa(a, b, clusters, B, seed):
    """Cluster bootstrap of `cohen_kappa`: each replicate draws the G cluster units with replacement and
    weights every pair by its unit's multiplicity. Returns {point, reps, n_degenerate, units, rows}."""
    n = len(a)
    if not (len(b) == n == len(clusters)):
        raise ValueError("a, b and clusters differ in length")
    uid = {}
    row_unit = [uid.setdefault(u, len(uid)) for u in clusters]
    G = len(uid)
    gen = random.Random(seed)  # a private stream, named apart from the AUC bootstrap's so each mutation target stays unique
    point = cohen_kappa(a, b)
    reps = []
    n_deg = 0
    for _ in range(B):
        mult = [0] * G
        for _ in range(G):
            mult[gen.randrange(G)] += 1
        k = cohen_kappa(a, b, [mult[u] for u in row_unit])
        reps.append(k)
        if k is None:
            n_deg += 1
    return {"point": point, "reps": reps, "n_degenerate": n_deg, "units": G, "rows": n}


def stratified_kappa(a, b, strata, w=None):
    """Stratum-conditioned (Mantel-Haenszel-type) kappa: chance agreement is taken from EACH stratum's own
    two marginals and pooled with the observed agreement,

        kappa_s = (sum_g W_g p_o,g - sum_g W_g p_e,g) / (sum_g W_g - sum_g W_g p_e,g),

    W_g = total (weighted) pairs in stratum g. With strata = calendar time blocks, a market-wide swing in
    the class shares of one block moves p_o AND p_e together and cancels, so what remains is agreement
    WITHIN coins beyond the common state -- a per-coin persistence estimand. None when the denominator is
    0. `w` are optional row weights (a bootstrap passes multiplicities)."""
    n = len(a)
    if not (len(b) == n == len(strata)) or (w is not None and len(w) != n):
        raise ValueError("a, b, strata (and w) differ in length")
    groups = {}
    for i in range(n):
        wi = 1.0 if w is None else w[i]
        if wi == 0:
            continue
        g = groups.setdefault(strata[i], [0.0, 0.0, {}, {}])
        g[0] += wi
        if a[i] == b[i]:
            g[1] += wi
        g[2][a[i]] = g[2].get(a[i], 0.0) + wi
        g[3][b[i]] = g[3].get(b[i], 0.0) + wi
    num_o = num_e = den = 0.0
    for W, agree, pa, pb in groups.values():
        pe = sum((pa[k] / W) * (pb.get(k, 0.0) / W) for k in pa)
        num_o += agree
        num_e += W * pe
        den += W
    if den - num_e <= 0.0:
        return None
    return (num_o - num_e) / (den - num_e)


def twoway_cluster_bootstrap_kappa(a, b, units1, units2, B, seed, strata=None):
    """Two-way (crossed) cluster bootstrap of `cohen_kappa`: each replicate draws the G1 units of `units1`
    (e.g. coin) AND, independently, the G2 units of `units2` (e.g. a calendar time block) with replacement;
    a pair's weight is the PRODUCT of its two multiplicities. It carries both dependence sources at once --
    a one-way coin bootstrap understates the SE when coins co-move within a time block. Returns
    {point, reps, n_degenerate, units1, units2, rows}. With `strata`, the statistic is `stratified_kappa`
    over those strata (the same multiplicity weights), else plain `cohen_kappa`."""
    n = len(a)
    if not (len(b) == n == len(units1) == len(units2)) or (strata is not None and len(strata) != n):
        raise ValueError("a, b, units1, units2 (and strata) differ in length")
    stat = (lambda w: cohen_kappa(a, b, w)) if strata is None else (lambda w: stratified_kappa(a, b, strata, w))
    id1, id2 = {}, {}
    r1 = [id1.setdefault(u, len(id1)) for u in units1]
    r2 = [id2.setdefault(u, len(id2)) for u in units2]
    G1, G2 = len(id1), len(id2)
    gen2 = random.Random(seed)
    point = stat(None)
    reps = []
    n_deg = 0
    for _ in range(B):
        m1 = [0] * G1
        for _ in range(G1):
            m1[gen2.randrange(G1)] += 1
        m2 = [0] * G2
        for _ in range(G2):
            m2[gen2.randrange(G2)] += 1
        k = stat([m1[x] * m2[y] for x, y in zip(r1, r2)])
        reps.append(k)
        if k is None:
            n_deg += 1
    return {"point": point, "reps": reps, "n_degenerate": n_deg, "units1": G1, "units2": G2, "rows": n}


def total_variation(p, q):
    """Total-variation distance 1/2 sum_k |p_k - q_k| between two class distributions given as dicts of
    probabilities; each must sum to 1 (within 1e-9) and hold no negative mass."""
    for name, d in (("p", p), ("q", q)):
        if any(v < 0 for v in d.values()) or abs(sum(d.values()) - 1.0) > 1e-9:
            raise ValueError(f"{name} is not a probability distribution")
    keys = set(p) | set(q)
    return 0.5 * sum(abs(p.get(k, 0.0) - q.get(k, 0.0)) for k in keys)
