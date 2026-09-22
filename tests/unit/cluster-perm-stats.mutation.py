#!/usr/bin/env python3
"""Mutation proof for the discrimination layer of src/scripts/cluster-perm-stats.py.

EDGE-SCORER-PREDICTIVE-CEILING-W1. A known-answer suite proves nothing until each load-bearing line
has been shown able to turn it red. The previous "mutation-proven 14/14" for this module lived in a
session-scratch script that no longer exists, so it could never be re-run. This harness is COMMITTED.

PROTOCOL (stdlib only):
  1. Every mutant gets its own temp tree holding a copy of the module and the self-test in their repo
     layout (the self-test locates the module relative to itself, so copying the tree relocates it).
  2. Each mutation is an EXACT source substitution. The target substring must occur EXACTLY ONCE in
     the committed module. A mutation that cannot apply, or whose result does not compile, is a
     HARNESS FAILURE -- counted as missed, never as caught.
  3. BASELINE: the unmutated copy must read CLUSTER_PERM_SELFTEST_SUBSET=PASS (with >= 1 check) on the
     union of every group the mutants use. A red baseline would make every mutant look "caught", so
     it fails the whole proof.
  4. Each mutant runs `selftest --only <its groups>` (the fixtures designed to see it). CAUGHT iff the
     run prints CLUSTER_PERM_SELFTEST_SUBSET=FAIL with failures >= 1, exits 1, AND at least one failed
     line is an ASSERTION -- not a `group <G> completed without raising` or `segment <S> completed
     without raising` line (the self-test's two raise records). A mutant
     that only makes a fixture RAISE is MISSED_RAISE_ONLY and counts as missed: a crash is not an
     assertion, and it aborts every later check in its group (measured in review: a Kish/m* swap
     "turned K9 red" only through a TypeError). A PASS token is MISSED. Anything else (no token, a
     crash before the token, a timeout) is a HARNESS FAILURE.
  5. Prints one line per mutant, then exactly `MUTATION_PROOF caught=N missed=M` for the REGISTERED
     set M1-M14, and `MUTATION_PROOF_SUPPLEMENTARY caught=N missed=M` for the S-set, and (EDGE-HURST-DISCRIMINATION-PROBE-W1)
     `MUTATION_PROOF_TERM caught=N missed=M` for the TERM set T1-T53 over the term-contribution layer (group
     KH). The S-set pins
     registered rules the M-set leaves open (found in adversarial review: every S-mutant read GREEN,
     or was caught only by a raise, against the fixtures as first committed). Exit 0 only when both
     sets (M, S and TERM) have missed == 0 (harness
     failures count as missed); 1 when a mutant survived; 2 when the harness itself could not run a
     fair trial (bad target, red baseline).

Run:  python3 tests/unit/cluster-perm-stats.mutation.py
"""
import concurrent.futures
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MODULE_REL = os.path.join("src", "scripts", "cluster-perm-stats.py")
SELFTEST_REL = os.path.join("tests", "unit", "cluster-perm-stats.selftest.py")
TOKEN = "CLUSTER_PERM_SELFTEST_SUBSET"
TIMEOUT_S = 300

# (id, what it breaks, exact target, replacement, the fixture groups designed to catch it)
MUTATIONS = [
    ("M1", "ties scored 0 instead of 1/2",
     "num += pw * (below + 0.5 * nw)", "num += pw * (below + 0.0 * nw)", ["K1", "K5"]),
    ("M2", "AUC orientation flipped (sweep sorts descending)",
     "rows.sort(key=lambda i: scores[i])", "rows.sort(key=lambda i: -scores[i])", ["K1", "K2"]),
    ("M3", "row bootstrap instead of cluster bootstrap",
     "units = clusters", "units = range(n)", ["K3"]),
    ("M4", "unpaired resampling (an independent draw per score set)",
     "w = w_joint", "w = draw()", ["K6"]),
    ("M5", "pooled pairs instead of within-block pairs",
     "key = blocks[i]", "key = 0", ["K4", "K5"]),
    ("M6", "percentile index off by one",
     "k = math.ceil(q * m - 1e-9)", "k = math.ceil(q * m - 1e-9) + 1", ["KP"]),
    ("M7", "Bonferroni dropped (alpha not divided over the families)",
     "a = alpha_family / n_families", "a = alpha_family", ["K10"]),
    ("M8", "leak: the out-of-fold fit sees the held-out fold's labels",
     "folds[i] != k and ", "", ["K7"]),
    ("M9", "purge disabled (train keeps races that cross the split)",
     "train.append(e <= t_split)", "train.append(d <= t_split)", ["K8"]),
    ("M10", "raw cluster count instead of Kish effective count",
     "return s * s / ss", "return float(len(cluster_sizes))", ["K9"]),
    ("M11", "decision branch deleted (the underpowered precedence)",
     'if "P" in pair:', "if False:", ["K10"]),
    ("M12", "ambiguous rows kept in the direction target",
     "if ambiguous_flag:", "if False:", ["KT"]),
    ("M13", "a shared RNG stream across arms (the global generator)",
     "rng = random.Random(seed)", "rng = random", ["K11"]),
    ("M14", "orient_score returns the signed score",
     "return side * signed_score", "return signed_score", ["K5", "KT"]),
]

# Registered rules the M-set leaves open. Each read GREEN (S1-S14), or was caught only by a raise
# (S15), against the fixtures as first committed; each is now pinned by a named ASSERTION. Same protocol, separate token, so the registered
# `MUTATION_PROOF caught=14 missed=0` line keeps its registered meaning.
SUPPLEMENTARY = [
    ("S1", "purge boundary made strict (a race ending exactly at the split is dropped from TRAIN)",
     "train.append(e <= t_split)", "train.append(e < t_split)", ["K8"]),
    ("S2", "assert_purged rejects a race ending exactly at the split",
     "bad = [e for e in train_race_ends if e > t_split]", "bad = [e for e in train_race_ends if e >= t_split]", ["K8"]),
    ("S3", "a NOT_ESTIMABLE (None-bound) family is skipped instead of blocking N",
     'if all(f["gap_hi95"] is not None and f["gap_hat"] is not None\n           and max(',
     'if all(f["gap_hi95"] is None or f["gap_hat"] is None\n           or max(', ["K10"]),
    ("S4", "the NO-CEILING equivalence bound taken at the Bonferroni level, not one-sided 95%",
     '"gap_hi95": ci_upper(gaps, alpha_equiv)', '"gap_hi95": ci_upper(gaps, a)', ["K10"]),
    ("S5", "the vol-control gap taken against the incumbent (the V condition silently vanishes)",
     "vols = paired_diffs(rf, rv)", "vols = paired_diffs(rf, rs)", ["K10"]),
    ("S6", "the gap bounds taken against the control instead of the incumbent",
     "gaps = paired_diffs(rf, rs)", "gaps = paired_diffs(rf, rv)", ["K10"]),
    ("S7", "the point gap taken against the control instead of the incumbent",
     '"gap_hat": None if pf is None or ps is None else pf - ps,',
     '"gap_hat": None if pf is None or pv is None else pf - pv,', ["K10"]),
    ("S8", "auc_floor ignores the alpha it is passed (K fixed at the two-sided-0.05 value)",
     "rho_e = 1.0\n    K = floor_k(alpha_one_sided, power)", "rho_e = 1.0\n    K = floor_k(0.025, power)", ["K9"]),
    ("S9", "the gap floor's ICC measured on U_f instead of D = U_f - U_S",
     "rho_d = icc_anova(d, clusters)", "rho_d = icc_anova(u_f, clusters)", ["K9"]),
    ("S10", "a floor that was never evaluated (floor_pass None) read as a pass",
     'if not all(f["floor_pass"] is True for f in fam.values()):',
     'if any(f["floor_pass"] is False for f in fam.values()):', ["K10"]),
    ("S11", "out-of-fold fit trained on rows whose target is undefined",
     "folds[i] != k and y[i] is not None", "folds[i] != k", ["K7"]),
    ("S12", "NaN scores ranked instead of refused (the AUC becomes row-order dependent)",
     "        if v != v:\n            raise ValueError", "        if False:\n            raise ValueError", ["K1"]),
    ("S13", "the floor's within-block variance taken about the wrong centre (sigma2_lvl no longer ~1/12)",
     "ss += sum((xi - mb) ** 2 for xi in v)", "ss += sum((xi + mb) ** 2 for xi in v)", ["K9"]),
    ("S14", "n_required divides by the design effect instead of multiplying (the 'n_eff needed' it names shrinks)",
     "return K * K * sigma2 * V * floor_deff(", "return K * K * sigma2 * V / floor_deff(", ["K9"]),
    ("S15", "the gap floor passes whenever its SE is defined (only an early raise used to reveal it)",
     "pass_gap = se_gap is not None and K * se_gap <= delta", "pass_gap = se_gap is not None or K * se_gap <= delta", ["K9"]),
]


# EDGE-HURST-DISCRIMINATION-PROBE-W1: the term-contribution layer. Each load-bearing rule of the per-side
# map, the materiality conversion, the stage counterfactual, the verdict precedence and the reliability
# statistics must turn group KH red by an ASSERTION. Same protocol, its own token, so the M and S lines
# keep their registered meaning.
TERM = [
    ("T1", "a tie against a strict order counted as a full reversal in the reorder share",
     "moved += 1.0 if sa * sb == -1 else 0.5", "moved += 1.0 if sa * sb == -1 else 1.0", ["KH"]),
    ("T2", "reorder share pooled across blocks (cross-block pairs counted)",
     "        by_block.setdefault(blocks[i], []).append(i)\n    pairs = 0\n    moved = 0.0",
     "        by_block.setdefault(0, []).append(i)\n    pairs = 0\n    moved = 0.0", ["KH"]),
    ("T3", "materiality taken as the raw share (q* ignored)",
     "return share * (2.0 * q_star - 1.0)", "return share", ["KH"]),
    ("T4", "the downstream gate made non-strict (|pre| == gate boosted)",
     "if abs(pre) > gate:", "if abs(pre) >= gate:", ["KH"]),
    ("T5", "materiality dropped from G+ (any significant gain reads KEEP)",
     'if lo > 0.0 and point >= delta:\n        return "G+"', 'if lo > 0.0:\n        return "G+"', ["KH"]),
    ("T6", "a significant-but-immaterial gain routed to the equivalence test (it can read REMOVE)",
     '    if (lo > 0.0 or lo95 > 0.0) and point < delta:\n        return "Gs"', '    if False:\n        return "Gs"', ["KH"]),
    ("T7", "equivalence bounds taken at alpha instead of the one-sided 95%",
     "ci_lower(reps, alpha_equiv), ci_upper(reps, alpha_equiv))", "ci_lower(reps, alpha), ci_upper(reps, alpha))", ["KH"]),
    ("T8", "the level reading made one-sided (a backwards ranker reads unresolved)",
     '    if hi < null:\n        return "A-"', '    if False:\n        return "A-"', ["KH"]),
    ("T9", "an unevaluated level floor (None) read as a pass",
     "if level_floor_pass is not True:", "if level_floor_pass is False:", ["KH"]),
    ("T10", "REMOVE absorbs the unresolved region (Gu x A0 -> REMOVE)",
     '        return "MAPPING_PROVISIONAL"\n    return "UNRESOLVED"',
     '        return "MAPPING_PROVISIONAL"\n    return "REMOVE" if a_state == "A0" else "UNRESOLVED"', ["KH"]),
    ("T11", "the per-side floor gated on floor_pass (the irrelevant level half) instead of pass_gap",
     'if gap_floor.get("pass_gap") is not True:', 'if gap_floor.get("floor_pass") is not True:', ["KH"]),
    ("T12", "intersection-union dropped (sides in different families return SELL's reading)",
     '    if fams["SELL"] != fams["BUY"]:', '    if False:', ["KH"]),
    ("T13", "the underpowered precedence deleted",
     '    if "P" in rs:', '    if False:', ["KH"]),
    ("T14", "leave-one-day-out stability checks only the first deletion",
     "return all(r == full_reading for r in dropped_readings)", "return dropped_readings[0] == full_reading", ["KH"]),
    ("T15", "kappa's chance agreement taken from ONE marginal",
     "pe = sum((pa[k] / tot) * (pb.get(k, 0.0) / tot) for k in pa)", "pe = sum((pa[k] / tot) * (pa[k] / tot) for k in pa)", ["KH"]),
    ("T16", "kappa bootstrap resamples rows instead of clusters",
     "row_unit = [uid.setdefault(u, len(uid)) for u in clusters]", "row_unit = [uid.setdefault(u, len(uid)) for u in range(n)]", ["KH"]),
    ("T17", "total variation without the 1/2",
     "return 0.5 * sum(abs(p.get(k, 0.0) - q.get(k, 0.0)) for k in keys)", "return sum(abs(p.get(k, 0.0) - q.get(k, 0.0)) for k in keys)", ["KH"]),
    ("T18", "the counterfactual boosts even when the downstream stage is inactive",
     "    if not downstream_active:\n        return pre", "    if False:\n        return pre", ["KH"]),
    ("T19", "the untied share returns the TIED share",
     "return (pairs - tied) / pairs, pairs", "return tied / pairs, pairs", ["KH"]),
    # ── architect Q14 amendments + the reliability / recommendation layer (second GO, 2026-09-22) ──
    ("T20", "Gs tested at alpha only (a gain the TOST itself calls significant can read G0 -> REMOVE)",
     "if (lo > 0.0 or lo95 > 0.0) and point < delta:", "if lo > 0.0 and point < delta:", ["KH"]),
    ("T21", "Gs routed through the ordinary table (Gs x A+/- reads MAPPING_PROVISIONAL)",
     '    if g_state == "Gs":\n        return "NOT_IDENTIFIABLE"', '    if False:\n        return "NOT_IDENTIFIABLE"', ["KH"]),
    ("T22", "the NOT_IDENTIFIABLE precedence deleted from the verdict",
     '    if "NOT_IDENTIFIABLE" in rs:', '    if False:', ["KH"]),
    ("T23", "MAPPING accepted with the term-alone sign differing across sides",
     '    if fam == "MAPPING" and side_a["SELL"] != side_a["BUY"]:', '    if False:', ["KH"]),
    ("T24", "the native arm contradicts MAPPING on NEG instead of POS",
     '_NATIVE_AGAINST = {"KEEP": "NEG", "REMOVE": "POS", "MAPPING": "POS"}', '_NATIVE_AGAINST = {"KEEP": "NEG", "REMOVE": "POS", "MAPPING": "NEG"}', ["KH"]),
    ("T25", "a malformed native value is no longer refused (the check fails open)",
     "            if native[s] is not None and native[s] not in _NATIVE_SIGNS:\n                raise ValueError",
     "            if False:\n                raise ValueError", ["KH"]),
    ("T26", "the native sign requires a margin (a significant but immaterial native gain stops contradicting)",
     'if lo is not None and lo > 0.0:\n        return "POS"', 'if lo is not None and lo > 0.01:\n        return "POS"', ["KH"]),
    ("T27", "flip_driven ignores whether the subset reading survived",
     'return full_side_reading == "KEEP" and subset_side_reading != "KEEP"', 'return full_side_reading == "KEEP"', ["KH"]),
    ("T28", "the dead-cell licence granted on ONE side's native G+",
     'all(native[s] is not None and native_g[s] == "G+" for s in _SIDES)', 'any(native[s] is not None and native_g[s] == "G+" for s in _SIDES)', ["KH"]),
    ("T29", "oc_gate stops requiring precision under the null",
     "ok_null = p_below_under_null >= min_under_null", "ok_null = True", ["KH"]),
    ("T30", "oc_gate stops requiring the control to be ruled out",
     "ok_pc = p_below_under_pc <= max_under_pc", "ok_pc = True", ["KH"]),
    ("T31", "an unevaluated OC gate (None) read as passed by the reliability reading",
     "    if oc_pass is not True:\n        return \"NOT_IDENTIFIABLE\"", "    if oc_pass is False:\n        return \"NOT_IDENTIFIABLE\"", ["KH"]),
    ("T32", "ABOVE_PC1 deleted (a CI wholly above the control reads unresolved)",
     '    if lo >= kappa_pc1:\n        return "ABOVE_PC1"', '    if False:\n        return "ABOVE_PC1"', ["KH"]),
    ("T33", "the recommendation ignores a contradicting outcome arm (REMOVE on any INDETERMINATE)",
     '        if contra:\n            return "CONFLICT"', '        if False:\n            return "CONFLICT"', ["KH"]),
    ("T34", "a significant-but-immaterial gain no longer contradicts 'carries nothing'",
     'if side_g[s] in ("G+", "Gs")]', 'if side_g[s] in ("G+",)]', ["KH"]),
    ("T35", "a right-way-ranking term alone (A+) no longer contradicts 'carries nothing'",
     'if side_a[s] in ("A+", "A-", "As")]', 'if side_a[s] in ("A-", "As")]', ["KH"]),
    ("T36", "the stratified kappa's chance term no longer taken from each stratum",
     "        num_e += W * pe", "        num_e += W * 0.5", ["KH"]),
    ("T37", "the two-way bootstrap drops the time-block multiplicity (coin-only in disguise)",
     "k = stat([m1[x] * m2[y] for x, y in zip(r1, r2)])", "k = stat([m1[x] for x, y in zip(r1, r2)])", ["KH"]),
    ("T39", "G+ tested at the TOST's 0.05 instead of alpha 0.025 (KEEP at half the registered level)",
     'if lo > 0.0 and point >= delta:\n        return "G+"', 'if lo95 > 0.0 and point >= delta:\n        return "G+"', ["KH"]),
    ("T40", "G- tested at 0.05 instead of alpha",
     '    if hi < 0.0:\n        return "G-"', '    if hi95 < 0.0:\n        return "G-"', ["KH"]),
    ("T41", "A+ tested at 0.05 instead of alpha",
     '    if lo > null:\n        return "A+"', '    if lo95 > null:\n        return "A+"', ["KH"]),
    ("T42", "A- tested at 0.05 instead of alpha",
     '    if hi < null:\n        return "A-"', '    if hi95 < null:\n        return "A-"', ["KH"]),
    ("T43", "As deleted (an equivalence-level-only ranking can read A0 -> REMOVE)",
     '    if lo95 > null or hi95 < null:\n        return "As"', '    if False:\n        return "As"', ["KH"]),
    ("T44", "As routed as A0 in the side map",
     '        a_state = "Au"   # in the side map', '        a_state = "A0"   # in the side map', ["KH"]),
    ("T45", "outcome_contradicts reads the gain on SELL only",
     'for s in _SIDES if side_g[s] in ("G+", "Gs")]', 'for s in ("SELL",) if side_g[s] in ("G+", "Gs")]', ["KH"]),
    ("T46", "outcome_contradicts reads the term alone on SELL only",
     'for s in _SIDES if side_a[s] in ("A+", "A-", "As")]', 'for s in ("SELL",) if side_a[s] in ("A+", "A-", "As")]', ["KH"]),
    ("T47", "outcome_contradicts reads the native arm on SELL only",
     'for s in _SIDES if native[s] == "POS"]', 'for s in ("SELL",) if native[s] == "POS"]', ["KH"]),
    ("T48", "the stability gate checks SELL only",
     'unstable = [s for s in _SIDES if side_stable[s] is not True]', 'unstable = [s for s in ("SELL",) if side_stable[s] is not True]', ["KH"]),
    ("T49", "a truthy OC gate (1) read as passed",
     '    if oc_pass is not True:\n        return "NOT_IDENTIFIABLE"', '    if not oc_pass:\n        return "NOT_IDENTIFIABLE"', ["KH"]),
    ("T50", "the two-way bootstrap draws the time units G1 times",
     '        for _ in range(G2):\n            m2[gen2.randrange(G2)] += 1', '        for _ in range(G1):\n            m2[gen2.randrange(G2)] += 1', ["KH"]),
    ("T51", "remove_scope ignores each group's own gate",
     'if gate_pass is True and reading == "BELOW_PC1":', 'if reading == "BELOW_PC1":', ["KH"]),
    ("T52", "remove_scope ignores the pooled reading",
     '    if pooled_reading != "BELOW_PC1":\n        return []', '    if False:\n        return []', ["KH"]),
    ("T53", "an equivalence-level-only term ranking (As) no longer contradicts",
     'if side_a[s] in ("A+", "A-", "As")]', 'if side_a[s] in ("A+", "A-")]', ["KH"]),
    ("T38", "the two-way bootstrap ignores strata (plain kappa where the stratified one was asked for)",
     "stat = (lambda w: cohen_kappa(a, b, w)) if strata is None else (lambda w: stratified_kappa(a, b, strata, w))",
     "stat = lambda w: cohen_kappa(a, b, w)", ["KH"]),
]


def _tree(module_src, selftest_src):
    root = tempfile.mkdtemp(prefix="cps-mutant-")
    for rel, src in ((MODULE_REL, module_src), (SELFTEST_REL, selftest_src)):
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(src)
    return root


RAISED = re.compile(r"^SELF-TEST: FAIL (group|segment) \S+ completed without raising")


def _run(module_src, selftest_src, groups):
    """Run the self-test subset in a fresh tree.
    Returns (verdict, failures, checks, exit, first_fails, tail, assertion_failures) where
    assertion_failures counts failed lines that are assertions, i.e. NOT a group's raise record."""
    root = _tree(module_src, selftest_src)
    try:
        p = subprocess.run([sys.executable, os.path.join(root, SELFTEST_REL), "--only", ",".join(groups)],
                           capture_output=True, text=True, timeout=TIMEOUT_S)
        out = p.stdout
        m = re.search(rf"^{TOKEN}=(PASS|FAIL) failures=(\d+) checks=(\d+)", out, re.M)
        fails = [ln for ln in out.splitlines() if ln.startswith("SELF-TEST: FAIL ")]
        n_assert = sum(1 for ln in fails if not RAISED.match(ln))
        first = [ln[len("SELF-TEST: FAIL "):][:110] for ln in fails][:2]
        tail = (out + p.stderr).strip().splitlines()[-3:]
        if not m:
            return "NO_TOKEN", 0, 0, p.returncode, first, tail, n_assert
        return m.group(1), int(m.group(2)), int(m.group(3)), p.returncode, first, tail, n_assert
    except subprocess.TimeoutExpired:
        return "TIMEOUT", 0, 0, None, [], [], 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    with open(os.path.join(REPO, MODULE_REL), encoding="utf-8") as fh:
        module_src = fh.read()
    with open(os.path.join(REPO, SELFTEST_REL), encoding="utf-8") as fh:
        selftest_src = fh.read()

    everything = MUTATIONS + SUPPLEMENTARY + TERM
    ids = [m[0] for m in everything]
    harness_errors = []
    if len(ids) != len(set(ids)):
        harness_errors.append("duplicate mutation ids")
    mutants = {}
    for mid, what, target, repl, groups in everything:
        n = module_src.count(target)
        if n != 1:
            harness_errors.append(f"{mid} target occurs {n} times (must be exactly 1): {target!r}")
            continue
        src = module_src.replace(target, repl, 1)
        if src == module_src:
            harness_errors.append(f"{mid} substitution changed nothing")
            continue
        try:
            compile(src, f"<{mid}>", "exec")
        except SyntaxError as e:
            harness_errors.append(f"{mid} mutant does not compile: {e}")
            continue
        mutants[mid] = src

    union = sorted({g for m in everything for g in m[4]})
    results = {}
    workers = max(2, min(8, os.cpu_count() or 2))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        fut_base = ex.submit(_run, module_src, selftest_src, union)
        futs = {ex.submit(_run, mutants[mid], selftest_src, groups): mid
                for mid, _w, _t, _r, groups in everything if mid in mutants}
        base = fut_base.result()
        for f in concurrent.futures.as_completed(futs):
            results[futs[f]] = f.result()

    b_verdict, b_fail, b_checks, b_exit, b_first, b_tail, _b_assert = base
    baseline_ok = b_verdict == "PASS" and b_fail == 0 and b_checks > 0 and b_exit == 0
    print(f"MUTATION_BASELINE={'PASS' if baseline_ok else 'FAIL'} groups={','.join(union)} checks={b_checks} "
          f"failures={b_fail} exit={b_exit}" + ("" if baseline_ok else f" first={b_first} tail={b_tail}"))
    if not baseline_ok:
        harness_errors.append("baseline is not green: a red baseline would make every mutant look caught")

    def judge(mset):
        caught = missed = 0
        for mid, what, _t, _r, groups in mset:
            if mid not in results:
                missed += 1
                print(f"MUTATION {mid} HARNESS_ERROR (not applied) -- {what}")
                continue
            verdict, nfail, nchk, code, first, tail, n_assert = results[mid]
            if baseline_ok and verdict == "FAIL" and nfail >= 1 and code == 1 and n_assert >= 1:
                caught += 1
                print(f"MUTATION {mid} CAUGHT groups={','.join(groups)} failed={nfail}/{nchk} "
                      f"assertions={n_assert} -- {what} | first: {first}")
            elif verdict == "FAIL" and code == 1 and n_assert == 0:
                missed += 1
                print(f"MUTATION {mid} MISSED_RAISE_ONLY groups={','.join(groups)} failed={nfail}/{nchk} "
                      f"-- {what} | only a group raised; no assertion failed | first: {first}")
            elif verdict == "PASS":
                missed += 1
                print(f"MUTATION {mid} MISSED groups={','.join(groups)} checks={nchk} -- {what}")
            else:
                missed += 1
                print(f"MUTATION {mid} HARNESS_ERROR verdict={verdict} exit={code} -- {what} | tail: {tail}")
        return caught, missed

    caught, missed = judge(MUTATIONS)
    s_caught, s_missed = judge(SUPPLEMENTARY)
    t_caught, t_missed = judge(TERM)
    for e in harness_errors:
        print(f"MUTATION_HARNESS_ERROR {e}")
    print(f"MUTATION_PROOF caught={caught} missed={missed}")
    print(f"MUTATION_PROOF_SUPPLEMENTARY caught={s_caught} missed={s_missed}")
    print(f"MUTATION_PROOF_TERM caught={t_caught} missed={t_missed}")
    if harness_errors:
        return 2
    return 0 if missed == 0 and s_missed == 0 and t_missed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
