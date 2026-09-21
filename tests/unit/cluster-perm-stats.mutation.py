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
     set M1-M14, and `MUTATION_PROOF_SUPPLEMENTARY caught=N missed=M` for the S-set, which pins
     registered rules the M-set leaves open (found in adversarial review: every S-mutant read GREEN,
     or was caught only by a raise, against the fixtures as first committed). Exit 0 only when both
     sets have missed == 0 (harness
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

    everything = MUTATIONS + SUPPLEMENTARY
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
    for e in harness_errors:
        print(f"MUTATION_HARNESS_ERROR {e}")
    print(f"MUTATION_PROOF caught={caught} missed={missed}")
    print(f"MUTATION_PROOF_SUPPLEMENTARY caught={s_caught} missed={s_missed}")
    if harness_errors:
        return 2
    return 0 if missed == 0 and s_missed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
