#!/usr/bin/env python3
"""owed-read-candle-request-24h.py — OPS-OWED-READ-RUNNER-W1 R3. The first owed read.

Owner wave: OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1. Its CH1 fixed the HL candle request for eight
`xyz:` coins (container start 2026-10-18T05:02:56Z, epoch 1792299776); its CLOSE_WHEN carries a
"read it 24 h later" leg. owed-read-runner.py runs this script when the registry row is due; this
script answers ONE question — did the fix's catch-up land — on ONE database snapshot, and prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

── LEGS (pre-registered in the wave's spec, R3 — this file implements them, never retunes them) ──
  L1  no request errors: producer-log lines after deploy_at naming a cohort coin (bare or `xyz:`)
      that are a `backfill error` carrying `HL API 500`, or a `Blocking HL:<coin>` line. Whole files
      streamed, newest rotation first. 0 lines => PASS. INDETERMINATE unless the chain is CONTIGUOUS
      back to a file whose first line is at or before deploy_at + 10 min; a found line is a FAIL.
  L2  under the cohort lens, per coin: fills = outcome_filled_at > deploy_at, retried_unfilled =
      outcome_price IS NULL AND outcome_last_attempt_at > deploy_at. FAIL iff a coin has
      retried_unfilled >= 1 and fills = 0.
  L3  the producer's own census_sql under the cohort lens: workable_reachable (the canary's own
      arithmetic, arm_reachability()) <= 26 (1 % of the 2,658 fillable rows). parked is reported.

  PASS iff L1 and L2 and L3. FAIL iff any leg failed on a complete measurement. Else INDETERMINATE.

── ONE SNAPSHOT, ONE DERIVATION ────────────────────────────────────────────────────────────────
Every database statement runs in ONE `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction,
as `aoe_readonly`: the parity proof, the plan guard and every leg read the same snapshot, so a
parity mismatch can never be a measurement artifact of two snapshots. The census SQL is the
producer's own (`backfill-queue-census.js --emit-sql`, via the outcome-backfill canary's
run_emitter(), which refuses label-reading or multi-statement SQL); the cohort is applied by
census_lens.lens(), which narrows the RELATION and never edits the SQL. Before any lensed statement
executes, census_lens.plan_guard_sql() EXPLAINs it and aborts the session on any CTE Scan.

Label-blind: cardinalities, timestamps and IS NULL predicates only; every `outcome:` log line is
dropped before any parse.

    owed-read-candle-request-24h.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-candle-request-24h.py --self-test
"""
from __future__ import annotations

import argparse
import calendar
import gzip
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import census_lens  # noqa: E402 — resolves beside this file, as installed and as in the repo

CANARY_FILE = os.path.join(HERE, "outcome-backfill-freshness.py")

# ── the pre-registration (OPS-OWED-READ-RUNNER-W1 spec R3; vault audit of the owner wave R0.4) ──
WAVE = "OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1"
DEPLOY_AT = 1792299776                 # 2026-10-18T05:02:56Z, CH1's container start
COHORT = ["HL|SKHY", "HL|SPCX", "HL|DRAM", "HL|CXMT", "HL|CBRS", "HL|NBIS", "HL|MRVL", "HL|BB"]
FILLABLE = {"SKHY": 674, "SPCX": 635, "DRAM": 561, "CXMT": 410, "CBRS": 214, "NBIS": 157, "MRVL": 5,
            "BB": 2}
FILLABLE_TOTAL = 2658
PAST_REACH_BASELINE = 2637
L3_CEILING = 26                        # 1 % of FILLABLE_TOTAL, rounded down
COVERAGE_SLACK_S = 600
# What the registry row's `anchors` must equal. The registry is inert data that arrives by
# declaration-sync; a row can SELECT this read but can never retune it — a differing anchor is
# INDETERMINATE, and the fix is a reviewed edit of this file.
ANCHORS = {"deploy_at": DEPLOY_AT, "cohort": COHORT, "fillable": FILLABLE,
           "past_reach_baseline": PAST_REACH_BASELINE, "l3_ceiling": L3_CEILING}
SANDBOX_KEY = "_sandbox_overrides"
SANDBOX_OVERRIDABLE = ("l3_ceiling",)  # R0.7: the forced-FAIL proof on a live snapshot, nothing else

PSQL_CMD = ("docker exec -i crypto-quant-signal-mcp-postgres-1 psql -X -U aoe_readonly -d signal_performance "
            "-q -tA -F | -v ON_ERROR_STOP=1")
PSQL_TIMEOUT_S = 480
STATEMENT_TIMEOUT = "120s"
BACKFILL_LOGS = ("/var/log/backfill.log", "/var/log/backfill.log.1", "/var/log/backfill.log.2.gz")

# L2, the producer's own predicates (src/lib/performance-db.ts:3087 for `filled`). Unqualified
# `signals` on purpose: the lens's CTE is what it reads.
L2_SQL = ("SELECT coin, COUNT(*) FILTER (WHERE outcome_filled_at > %d) AS fills, "
          "COUNT(*) FILTER (WHERE outcome_price IS NULL AND outcome_last_attempt_at > %d) AS retried_unfilled "
          "FROM signals GROUP BY coin ORDER BY coin" % (DEPLOY_AT, DEPLOY_AT))
# Every lensed statement the bundle executes, each guarded by name before ANY of them runs.
GUARDED = ("census_all", "census_none", "census_cohort", "l2_cohort")

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096
L1_SAMPLES = 3
L1_SAMPLE_CHARS = 180

_TS = re.compile(r"^\[(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z\]")
_BLOCKING = re.compile(r"\] Blocking HL:(\S+) —")


def load_canary():
    """The outcome-backfill canary as a module — its emitter, census parser and reachability
    arithmetic are the ONE derivation this read re-uses, never re-codes."""
    spec = importlib.util.spec_from_file_location("outcome_backfill_freshness", CANARY_FILE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def psql_identity(cmd):
    """(container, role, database) of a `docker exec … psql -U … -d …` command, or None."""
    t = shlex.split(cmd) if isinstance(cmd, str) else list(cmd)
    try:
        i = t.index("exec")
        j = i + 1
        while j < len(t) and t[j].startswith("-"):
            j += 1
        return t[j], t[t.index("-U") + 1], t[t.index("-d") + 1]
    except (ValueError, IndexError):
        return None


# ── the anchors the runner hands over ────────────────────────────────────────────────────────

def resolve_anchors(anchors, sandbox):
    """-> (effective constants dict, None) or (None, reason)."""
    if not isinstance(anchors, dict):
        return None, "anchors are not a JSON object"
    overrides = anchors.get(SANDBOX_KEY)
    declared = {k: v for k, v in anchors.items() if k != SANDBOX_KEY}
    if declared != ANCHORS:
        diff = sorted(k for k in set(declared) | set(ANCHORS) if declared.get(k) != ANCHORS.get(k))
        return None, "the registry's anchors differ from this read's pre-registration on %s" % ",".join(diff)
    eff = dict(ANCHORS)
    if overrides is not None:
        if not sandbox:
            return None, "a sandbox override arrived without --sandbox — refused"
        if not isinstance(overrides, dict):
            return None, "sandbox overrides are not an object"
        bad = sorted(k for k in overrides if k not in SANDBOX_OVERRIDABLE)
        if bad:
            return None, "sandbox override key(s) %s are not overridable" % ",".join(bad)
        for k, v in overrides.items():
            if type(v) is not int:
                return None, "sandbox override %s=%r is not an int" % (k, v)
            eff[k] = v
    return eff, None


# ── the one-snapshot bundle ──────────────────────────────────────────────────────────────────

def lensed_statements(census_sql):
    return {"census_all": census_lens.lens(census_sql, census_lens.ALL),
            "census_none": census_lens.lens(census_sql, census_lens.NONE),
            "census_cohort": census_lens.lens(census_sql, COHORT),
            "l2_cohort": census_lens.lens(L2_SQL, COHORT)}


def build_bundle(census_sql):
    """psql stdin: ONE read-only repeatable-read transaction; every plan guard before any lensed
    statement executes; each result set behind a MARK so a short read is visible."""
    lensed = lensed_statements(census_sql)
    p = ["\\set ON_ERROR_STOP on",
         "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
         "SET LOCAL statement_timeout = '%s';" % STATEMENT_TIMEOUT,
         "SELECT 'MARK|ro|' || current_setting('transaction_read_only');"]
    for name in GUARDED:
        p.append(census_lens.plan_guard_sql(lensed[name], name) + ";")
        p.append("SELECT 'MARK|plan|%s|' || (%s);" % (name, census_lens.plan_guard_readback_sql(name)))
    for name, sql in (("census_unlensed", census_sql.strip()), ("census_all", lensed["census_all"]),
                      ("census_none", lensed["census_none"]), ("census_cohort", lensed["census_cohort"]),
                      ("l2_cohort", lensed["l2_cohort"])):
        p.append("SELECT 'MARK|sec|%s';" % name)
        p.append(sql + ";")
    p += ["SELECT 'MARK|end';", "COMMIT;"]
    return "\n".join(p) + "\n"


def parse_bundle(stdout):
    """-> {"ro": str|None, "plan": {name: (nodes, cte_scans)}, "sec": {name: [rows]}, "end": bool}."""
    out = {"ro": None, "plan": {}, "sec": {}, "end": False}
    cur = None
    for ln in (stdout or "").splitlines():
        s = ln.strip()
        if s.startswith("MARK|"):
            f = s.split("|")
            if f[1] == "ro" and len(f) == 3:
                out["ro"], cur = f[2], None
            elif f[1] == "plan" and len(f) == 5 and f[3].isdigit() and f[4].isdigit():
                out["plan"][f[2]], cur = (int(f[3]), int(f[4])), None
            elif f[1] == "sec" and len(f) == 3:
                cur = f[2]
                out["sec"][cur] = []
            elif f[1] == "end":
                out["end"], cur = True, None
            continue
        if cur is not None and "|" in s:
            out["sec"][cur].append([x.strip() for x in s.split("|")])
    return out


def snapshot_problems(b):
    """Why the snapshot proves nothing, as data. Empty list = the lens can be trusted this run."""
    probs = []
    if not b["end"]:
        probs.append("the bundle did not reach MARK|end — a short read")
    if b["ro"] != "on":
        probs.append("transaction_read_only=%r, expected 'on'" % b["ro"])
    for name in GUARDED:
        pl = b["plan"].get(name)
        if pl is None:
            probs.append("no plan-guard readback for %s" % name)
        elif pl[1] != 0 or pl[0] < 1:
            probs.append("plan guard %s: nodes=%d cte_scans=%d" % (name, pl[0], pl[1]))
    need = ("census_unlensed", "census_all", "census_none", "census_cohort", "l2_cohort")
    missing = [n for n in need if n not in b["sec"]]
    if missing:
        probs.append("result set(s) missing: %s" % ",".join(missing))
    else:
        probs += census_lens.parity_problems(b["sec"]["census_unlensed"], b["sec"]["census_all"],
                                             b["sec"]["census_none"])
    return probs


# ── the legs ─────────────────────────────────────────────────────────────────────────────────

def line_epoch(line):
    m = _TS.match(line)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
    return calendar.timegm((y, mo, d, h, mi, s)) + (float(m.group(7)) if m.group(7) else 0.0)


def _bare(coin):
    return coin[4:] if coin.startswith("xyz:") else coin


def leg_l1(paths, deploy_at, row_line, coins=None):
    """Stream the producer log's rotation chain, NEWEST FIRST, each file whole. -> leg dict.

    Coverage is CONTIGUOUS, not "some old line exists": rotation makes each file cover
    [its first line, the next newer file's first line), so the chain is walked newest-first and
    stops at the first file that reaches back to deploy_at + COVERAGE_SLACK_S. A file missing BEFORE
    that point is a gap — absence of error lines across a gap proves nothing. A found line needs no
    coverage: it is a FAIL on its own (more coverage can only add lines, never remove one)."""
    coins = set(coins or FILLABLE)
    hits, any500, read, files, covered_by, why = [], 0, 0, [], None, None
    for p in paths:
        name = os.path.basename(p)
        if not os.path.exists(p):
            files.append({"file": name, "present": False})
            why = why or "rotation %s is absent before coverage reached deploy_at + %ds" % (name, COVERAGE_SLACK_S)
            continue
        n, first = 0, None
        try:
            opener = gzip.open if p.endswith(".gz") else open
            with opener(p, "rt", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    n += 1
                    if "outcome:" in line:          # label-blind: dropped before any parse
                        continue
                    t = line_epoch(line)
                    if t is None:
                        continue
                    if first is None:
                        first = t
                    if t <= deploy_at:
                        continue
                    hit = False
                    if "backfill error" in line:
                        m = row_line.match(line)
                        if "HL API 500" in line:
                            any500 += 1
                            hit = bool(m) and _bare(m.group(1)) in coins
                    elif "Blocking HL:" in line:
                        m = _BLOCKING.search(line)
                        hit = bool(m) and _bare(m.group(1)) in coins
                    if hit:
                        hits.append(line.strip()[:L1_SAMPLE_CHARS])
        except (OSError, EOFError, ValueError) as e:
            files.append({"file": name, "present": True, "error": type(e).__name__})
            why = why or "%s unreadable: %s" % (name, type(e).__name__)
            break
        read += n
        files.append({"file": name, "present": True, "lines": n, "first": None if first is None else int(first)})
        if first is not None and first <= deploy_at + COVERAGE_SLACK_S:
            if why is None:
                covered_by = name
            break                                   # older rotations hold nothing after deploy_at
    leg = {"lines": len(hits), "hl500_any_coin": any500, "lines_read": read, "files": files,
           "covered_by": covered_by or "-", "samples": hits[:L1_SAMPLES]}
    if hits:
        leg["verdict"] = "FAIL"
    elif covered_by is None:
        leg.update(verdict="INDETERMINATE", reason="coverage: " + (why or "no file reaches back to deploy_at + %ds"
                                                                   % COVERAGE_SLACK_S))
    else:
        leg["verdict"] = "PASS"
    return leg


def leg_l2(rows, coins=None):
    """rows: [coin, fills, retried_unfilled]. Every cohort coin must appear — each had fillable rows."""
    coins = list(coins or FILLABLE)
    per = {}
    for r in rows:
        if len(r) != 3 or not (r[1].isdigit() and r[2].isdigit()):
            return {"verdict": "INDETERMINATE", "reason": "unparseable L2 row %r" % (r[:3],)}
        per[r[0]] = (int(r[1]), int(r[2]))
    missing = sorted(c for c in coins if c not in per)
    extra = sorted(c for c in per if c not in coins)
    if missing or extra:
        return {"verdict": "INDETERMINATE",
                "reason": "the lensed population is not the cohort: missing=%s extra=%s" % (missing, extra)}
    failing = sorted(c for c, (f, ru) in per.items() if ru >= 1 and f == 0)
    return {"verdict": "FAIL" if failing else "PASS", "failing": ",".join(failing) or "-",
            "fills": {c: per[c][0] for c in sorted(per)},
            "retried_unfilled": sum(ru for _, ru in per.values())}


def leg_l3(canary, census_rows, now, limit, ceiling):
    """The canary's own reachability arithmetic over the lensed census."""
    stdout = "\n".join("|".join(r) for r in census_rows)
    try:
        census = canary.parse_emitter_census(stdout)
    except canary.Indeterminate as e:
        return {"verdict": "INDETERMINATE", "reason": str(e)[:200]}, None
    arm = canary.arm_reachability(census, now, limit)
    wr = arm["workable_reachable"]
    return {"verdict": "PASS" if wr <= ceiling else "FAIL", "workable_reachable": wr, "ceiling": ceiling,
            "parked": census["parked"]}, census


def aggregate(legs):
    vs = [legs[k]["verdict"] for k in sorted(legs)]
    if "FAIL" in vs:
        return "FAIL"
    return "PASS" if vs and all(v == "PASS" for v in vs) else "INDETERMINATE"


def evaluate(canary, eff, now, em, bundle_stdout, bundle_err, l1):
    """Pure: everything gathered -> (verdict, metrics). `em`/`bundle_stdout` may be None with
    `bundle_err` naming why; L1 is judged on its own either way."""
    legs = {"L1": l1}
    snap = {"problems": [bundle_err] if bundle_err else []}
    reported = {"fillable_total": FILLABLE_TOTAL, "past_reach_baseline": PAST_REACH_BASELINE}
    if not bundle_err:
        b = parse_bundle(bundle_stdout)
        snap = {"ro": b["ro"], "plan": {k: list(v) for k, v in sorted(b["plan"].items())},
                "problems": snapshot_problems(b)}
        try:
            coin_sql = canary.coin_sql_of(em)
            if census_lens.VENUE_EXPR not in coin_sql:
                snap["problems"].append("the emitted coin_sql does not carry the lens's venue expression")
        except canary.Indeterminate as e:
            snap["problems"].append(str(e)[:200])
    if snap["problems"]:
        why = "snapshot unusable: " + "; ".join(snap["problems"])[:300]
        legs["L2"] = {"verdict": "INDETERMINATE", "reason": why}
        legs["L3"] = {"verdict": "INDETERMINATE", "reason": why}
    else:
        legs["L2"] = leg_l2(b["sec"]["l2_cohort"])
        legs["L3"], census = leg_l3(canary, b["sec"]["census_cohort"], now, em["constants"]["limit"],
                                    eff["l3_ceiling"])
        if census:
            reported.update(past_reach=census["past_reach"], parked=census["parked"],
                            servable_uncapped=census["servable_uncapped"], immature=census["immature"])
        if legs["L2"].get("fills"):
            reported["fills_total"] = sum(legs["L2"]["fills"].values())
    if isinstance(l1, dict) and "hl500_any_coin" in l1:
        reported["hl500_any_coin"] = l1["hl500_any_coin"]
    verdict = aggregate(legs)
    metrics = {"legs": legs, "reported": reported, "snapshot": snap, "deploy_at": DEPLOY_AT,
               "l3_ceiling": eff["l3_ceiling"], "l3_ceiling_overridden": eff["l3_ceiling"] != L3_CEILING,
               "now": int(now)}
    return verdict, fit_metrics(metrics)


def fit_metrics(m):
    """<= METRICS_MAX_BYTES: shed the L1 samples, then the per-file list, then the snapshot detail."""
    def size(x):
        return len(json.dumps(x, sort_keys=True).encode("utf-8"))
    for shed in (("legs", "L1", "samples"), ("legs", "L1", "files"), ("snapshot", "plan")):
        if size(m) <= METRICS_MAX_BYTES:
            break
        node = m
        for k in shed[:-1]:
            node = node.get(k, {})
        if shed[-1] in node:
            node[shed[-1]] = "(shed for size)"
    if size(m) > METRICS_MAX_BYTES:
        m["snapshot"] = {"problems": ["(shed for size)"]}
    return m


# ── the live run ─────────────────────────────────────────────────────────────────────────────

def run_bundle(sql):
    try:
        p = subprocess.run(shlex.split(PSQL_CMD), input=sql, capture_output=True, encoding="utf-8",
                           errors="replace", timeout=PSQL_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as e:
        return None, "psql could not run: %s: %s" % (type(e).__name__, str(e)[:160])
    if p.returncode != 0:
        guard = [ln for ln in p.stderr.splitlines() if "OWED_READ_PLAN_GUARD" in ln]
        return None, "psql rc=%d: %s" % (p.returncode, (guard[0] if guard else p.stderr.strip())[:240])
    return p.stdout, None


def run(now, anchors, sandbox):
    eff, err = resolve_anchors(anchors, sandbox)
    if err:
        return "INDETERMINATE", {"reason": err}
    canary = load_canary()
    if psql_identity(PSQL_CMD) != psql_identity(canary.PSQL_DEFAULT):
        return "INDETERMINATE", {"reason": "this read's psql identity %r is not the canary's %r"
                                 % (psql_identity(PSQL_CMD), psql_identity(canary.PSQL_DEFAULT))}
    l1 = leg_l1(BACKFILL_LOGS, DEPLOY_AT, canary._ROW_LINE)
    em, stdout, berr = None, None, None
    t0 = time.monotonic()
    try:
        em = canary.run_emitter(now)
        stdout, berr = run_bundle(build_bundle(em["census_sql"]))
    except canary.Indeterminate as e:
        berr = "emitter: %s" % str(e)[:240]
    except census_lens.LensRefused as e:
        berr = "lens refused the emitted SQL: %s" % e
    verdict, metrics = evaluate(canary, eff, now, em, stdout, berr, l1)
    metrics["db_s"] = round(time.monotonic() - t0, 1)
    metrics["sandbox"] = bool(sandbox)
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: candle-request-24h")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--now", type=int)
    ap.add_argument("--sandbox", action="store_true")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)
    if a.self_test:
        return self_test()
    if not a.run or a.now is None:
        ap.error("the runner invokes --run --now EPOCH with the anchors on stdin")
    try:
        anchors = json.loads(sys.stdin.read() or "null")
        verdict, metrics = run(a.now, anchors, a.sandbox)
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing
        verdict, metrics = "INDETERMINATE", {"reason": "fault %s: %s" % (type(e).__name__, str(e)[:200])}
    for name, leg in sorted((metrics.get("legs") or {}).items()):
        print("LEG %s %s %s" % (name, leg.get("verdict"), leg.get("reason", "")))
    for ln in emit(verdict, metrics):
        print(ln)
    return EXIT_FOR[verdict]


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

# Floor = the measured check count, so removing any scenario trips it.
_SELF_TEST_MIN_CHECKS = 49


def self_test():
    import tempfile
    failures, ran = [], []

    def check(name, fn):
        ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001 — an assertion that raises is a crash, not a verdict
            failures.append(name)
            print("  [FAIL] %s (raised %s: %s)" % (name, type(e).__name__, str(e)[:160]))
            return
        if not ok:
            failures.append(name)
        print("  [%s] %s" % ("ok" if ok else "FAIL", name))

    canary = load_canary()
    tmp = tempfile.mkdtemp(prefix="owed-read-c24.")
    NOW = DEPLOY_AT + 4 * 86400
    CENSUS = "SELECT COUNT(*) AS a FROM signals WHERE coin <> '' AND created_at > 5"
    EM = {"census_sql": CENSUS, "coin_sql": "SELECT %s AS venue, coin FROM signals GROUP BY 1, 2"
          % census_lens.VENUE_EXPR, "constants": {"limit": 2000}}

    # ── contract constants ──
    check("the pre-registration is internally consistent (Σ fillable 2,658; ceiling = 1 %; cohort = HL|<fillable coin>)",
          lambda: sum(FILLABLE.values()) == FILLABLE_TOTAL and L3_CEILING == FILLABLE_TOTAL // 100
          and COHORT == ["HL|" + c for c in FILLABLE])
    check("the psql identity (container, role, database) is the canary's own",
          lambda: psql_identity(PSQL_CMD) == psql_identity(canary.PSQL_DEFAULT)
          == ("crypto-quant-signal-mcp-postgres-1", "aoe_readonly", "signal_performance"))
    check("L2's SQL is label-blind (no outcome VALUE column) and one statement",
          lambda: not [t for t in canary.OUTCOME_VALUE_TOKENS if t in L2_SQL.lower()] and ";" not in L2_SQL)
    check("token -> exit code: PASS 0, FAIL 1, INDETERMINATE 3", lambda: EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})

    # ── anchors ──
    check("anchors equal to the pre-registration resolve to it", lambda: resolve_anchors(json.loads(json.dumps(ANCHORS)), False) == (ANCHORS, None))
    retuned = dict(ANCHORS, l3_ceiling=500)
    check("a registry row that retunes a rule is INDETERMINATE, naming the key",
          lambda: resolve_anchors(retuned, False)[0] is None and "l3_ceiling" in resolve_anchors(retuned, False)[1])
    ov = dict(ANCHORS, **{SANDBOX_KEY: {"l3_ceiling": -1}})
    check("a sandbox override without --sandbox is refused", lambda: resolve_anchors(ov, False)[0] is None)
    check("under --sandbox the l3_ceiling override is honoured", lambda: resolve_anchors(ov, True)[0]["l3_ceiling"] == -1)
    check("under --sandbox any other override key is refused",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"deploy_at": 1}}), True)[0] is None)

    # ── the bundle ──
    bundle = build_bundle(CENSUS)
    lines = bundle.splitlines()
    first_sec = next(i for i, ln in enumerate(lines) if ln.startswith("SELECT 'MARK|sec|"))
    guards = [i for i, ln in enumerate(lines) if ln.startswith("DO $")]
    check("one transaction: BEGIN REPEATABLE READ READ ONLY first, COMMIT last, ON_ERROR_STOP on",
          lambda: lines[0] == "\\set ON_ERROR_STOP on" and lines[1] == "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
          and lines[-1] == "COMMIT;" and sum(ln.startswith(("BEGIN", "COMMIT")) for ln in lines) == 2)
    check("every lensed statement is plan-guarded, and every guard precedes the first executed result set",
          lambda: len(guards) == len(GUARDED) and max(guards) < first_sec)
    check("each guard EXPLAINs exactly the statement the bundle later executes",
          lambda: all(("$owedsql$%s$owedsql$" % s) in bundle and (s + ";") in bundle
                      for s in lensed_statements(CENSUS).values()))

    # ── parse + snapshot ──
    def stdout_for(unl="5", all_="5", none="0", cohort="2", l2=None, ro="on", plan=(17, 0), end=True, drop=None):
        l2 = l2 if l2 is not None else ["%s|%d|0" % (c, 3) for c in FILLABLE]
        out = ["MARK|ro|%s" % ro]
        out += ["MARK|plan|%s|%d|%d" % (n, plan[0], plan[1]) for n in GUARDED]
        for name, rows in (("census_unlensed", [unl]), ("census_all", [all_]), ("census_none", [none]),
                           ("census_cohort", [cohort]), ("l2_cohort", l2)):
            if name == drop:
                continue
            out.append("MARK|sec|%s" % name)
            out += rows
        if end:
            out.append("MARK|end")
        return "\n".join(out) + "\n"

    def census_row(backlog=100, immature=10, parked=7, past_reach=80, servable=5, frontier=""):
        return "%d|%d|%d|%d|%d|%s" % (backlog, immature, parked, past_reach, servable, frontier)

    good_l1 = {"verdict": "PASS", "lines": 0, "hl500_any_coin": 0}
    EFF = dict(ANCHORS)

    def ev(stdout, l1=None, eff=None, err=None, em=None):
        return evaluate(canary, eff or EFF, NOW, em or EM, stdout, err, l1 or good_l1)

    full = census_row()
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|", cohort=census_row(100, 10, 7, 80)))
    check("a clean snapshot with workable_reachable 10 <= 26 and every coin filled: PASS",
          lambda: v == "PASS" and m["legs"]["L3"]["workable_reachable"] == 10 and m["snapshot"]["problems"] == [])
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|", cohort=census_row(100, 10, 7, 63)))
    check("L3 at 27 > 26: FAIL — and parked (7) is NOT subtracted (the canary's own arithmetic)",
          lambda: v == "FAIL" and m["legs"]["L3"]["workable_reachable"] == 27 and m["legs"]["L3"]["parked"] == 7)
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|", cohort=census_row(36, 10, 0, 0)))
    check("L3 at exactly 26: PASS (the ceiling is inclusive)", lambda: v == "PASS")
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|", cohort=census_row(10, 10, 0, 0)),
              eff=dict(ANCHORS, l3_ceiling=-1))
    check("the sandbox ceiling -1 forces L3 FAIL on the same snapshot that passes at 26, and says so",
          lambda: v == "FAIL" and m["legs"]["L3"]["workable_reachable"] == 0 and m["l3_ceiling_overridden"] is True)
    v, m = ev(stdout_for(unl=full, all_=census_row(101), none="0|0|0|0|0|"))
    check("parity: lens(ALL) != unlensed -> L2 and L3 INDETERMINATE, verdict INDETERMINATE",
          lambda: v == "INDETERMINATE" and m["legs"]["L2"]["verdict"] == m["legs"]["L3"]["verdict"] == "INDETERMINATE")
    v, m = ev(stdout_for(unl=full, all_=full, none="1|0|0|0|0|"))
    check("parity: lens(NONE) non-zero (a reference escaped the lens) -> INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|", plan=(17, 4)))
    check("plan guard: a CTE Scan in any lensed plan -> INDETERMINATE", lambda: v == "INDETERMINATE"
          and any("cte_scans=4" in p for p in m["snapshot"]["problems"]))
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|", ro="off"))
    check("a snapshot whose transaction is not read-only -> INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|", end=False))
    check("a bundle that never reached MARK|end (short read) -> INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|", drop="census_cohort"))
    check("a missing result set -> INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|"), em=dict(EM, coin_sql="SELECT exchange AS venue FROM signals"))
    check("an emitted coin_sql without the lens's venue expression -> INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = ev(None, err="psql rc=3: ERROR:  OWED_READ_PLAN_GUARD: 4 CTE Scan node(s) in the census_all plan")
    check("the plan guard's abort (psql rc 3) -> INDETERMINATE, the guard's own line carried",
          lambda: v == "INDETERMINATE" and "OWED_READ_PLAN_GUARD" in m["snapshot"]["problems"][0])
    v, m = ev(None, err="emitter: boom", l1={"verdict": "FAIL", "lines": 2, "hl500_any_coin": 2})
    check("L1 is judged even when the database is unreachable: an L1 FAIL is a FAIL",
          lambda: v == "FAIL" and m["legs"]["L1"]["verdict"] == "FAIL")

    # ── L2 ──
    rows = [[c, "3", "0"] for c in FILLABLE]
    check("L2: every coin present, none retried-and-unfilled -> PASS", lambda: leg_l2(rows)["verdict"] == "PASS")
    r = [list(x) for x in rows]
    r[-1] = ["BB", "0", "2"]
    check("L2: BB retried twice and never filled -> FAIL naming BB",
          lambda: leg_l2(r)["verdict"] == "FAIL" and leg_l2(r)["failing"] == "BB")
    r[-1] = ["BB", "1", "2"]
    check("L2: retried rows on a coin that also filled -> PASS (fills >= 1)", lambda: leg_l2(r)["verdict"] == "PASS")
    r[-1] = ["BB", "0", "0"]
    check("L2: a coin never retried and never filled -> PASS (the rule needs retried_unfilled >= 1)",
          lambda: leg_l2(r)["verdict"] == "PASS")
    check("L2: a cohort coin missing from the lensed rows -> INDETERMINATE",
          lambda: leg_l2(rows[:-1])["verdict"] == "INDETERMINATE")
    check("L2: a coin outside the cohort in the lensed rows -> INDETERMINATE",
          lambda: leg_l2(rows + [["BTC", "1", "0"]])["verdict"] == "INDETERMINATE")

    # ── L1 ──
    def ts(epoch):
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch)) + ".123Z"

    def logf(name, lines, gz=False):
        p = os.path.join(tmp, name)
        data = "".join("[%s] %s\n" % (ts(t), body) for t, body in lines)
        if gz:
            with gzip.open(p, "wt", encoding="utf-8") as fh:
                fh.write(data)
        else:
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(data)
        return p

    base = [(DEPLOY_AT - 3600, "SPCX BUY [15m] backfill error (1/3): HL API 500: Internal Server Error"),
            (DEPLOY_AT - 60, "Blocking HL:SPCX — failed 3 times, skipping")]
    clean = logf("clean.log", base + [(DEPLOY_AT + 60, "Backfill complete: filled 12")])
    L = lambda paths: leg_l1(paths, DEPLOY_AT, canary._ROW_LINE)  # noqa: E731
    check("L1: cohort 500s and breaker lines BEFORE deploy_at are not counted -> PASS",
          lambda: L([clean])["verdict"] == "PASS" and L([clean])["lines"] == 0)
    for label, body in (("a bare cohort coin's HL API 500", "SKHY SELL [5m] backfill error (2/3): HL API 500: Internal Server Error"),
                        ("an xyz:-prefixed cohort coin's HL API 500", "xyz:DRAM BUY [15m] backfill error (1/3): HL API 500: x"),
                        ("a Blocking HL:<cohort coin> line", "Blocking HL:BB — failed 3 times, skipping"),
                        ("a Blocking HL:xyz:<cohort coin> line", "Blocking HL:xyz:MRVL — failed 3 times, skipping")):
        p = logf("hit.log", base + [(DEPLOY_AT + 120, body)])
        check("L1: %s after deploy_at -> FAIL" % label, lambda p=p: L([p])["verdict"] == "FAIL" and L([p])["lines"] == 1)
    p = logf("other.log", base + [(DEPLOY_AT + 120, "BTC BUY [15m] backfill error (1/3): HL API 500: x")])
    check("L1: an HL API 500 on a NON-cohort coin is reported, never a hit",
          lambda: L([p])["verdict"] == "PASS" and L([p])["hl500_any_coin"] == 1)
    p = logf("o.log", base + [(DEPLOY_AT + 120, "SKHY BUY [5m] backfill error (1/3): HL API 500 — outcome: 0.42")])
    check("L1: an `outcome:` line is dropped before any parse, even one that would otherwise be a hit (label-blind)",
          lambda: L([p])["lines"] == 0 and L([p])["hl500_any_coin"] == 0)
    p = logf("e.log", base + [(DEPLOY_AT + 120, "SKHY BUY [5m] backfill error (1/3): HL API 429: rate")])
    check("L1: a cohort backfill error that is not HL API 500 is not a hit", lambda: L([p])["verdict"] == "PASS")
    late = logf("late.log", [(DEPLOY_AT + COVERAGE_SLACK_S + 5, "Backfill complete: filled 1")])
    check("L1: files that start after deploy_at + 10 min -> INDETERMINATE (coverage)",
          lambda: L([late])["verdict"] == "INDETERMINATE")
    gz = logf("old.log.2.gz", base, gz=True)
    absent = os.path.join(tmp, "absent.log.1")
    check("L1: a rotation chain reaching deploy_at through a .gz: PASS, covered_by names the .gz",
          lambda: L([late, gz])["verdict"] == "PASS" and L([late, gz])["covered_by"] == "old.log.2.gz")
    check("L1: a rotation ABSENT before coverage is a gap -> INDETERMINATE, even with an older file reaching back",
          lambda: L([late, absent, gz])["verdict"] == "INDETERMINATE" and "absent" in L([late, absent, gz])["reason"])
    check("L1: a rotation absent AFTER coverage is never needed -> PASS, and older files are not read",
          lambda: L([clean, absent, gz])["verdict"] == "PASS" and len(L([clean, absent, gz])["files"]) == 1)
    hit = logf("new.log", [(DEPLOY_AT + 120, "CBRS BUY [30m] backfill error (3/3): HL API 500: x")])
    check("L1: a found line is a FAIL even across a coverage gap (coverage only proves absence)",
          lambda: L([hit, absent, gz])["verdict"] == "FAIL")
    bad = os.path.join(tmp, "bad.log.2.gz")
    with open(bad, "wb") as fh:
        fh.write(b"not gzip")
    check("L1: an existing file that cannot be read before coverage -> INDETERMINATE",
          lambda: L([late, bad])["verdict"] == "INDETERMINATE")

    # ── metrics + output contract ──
    many = {"verdict": "FAIL", "lines": 9000, "hl500_any_coin": 9000, "samples": ["x" * 180] * 3,
            "files": [{"file": "f%d" % i, "present": True, "lines": 10 ** 7} for i in range(60)]}
    v, m = ev(stdout_for(unl=full, all_=full, none="0|0|0|0|0|"), l1=many)
    check("metrics stay <= 4 KiB however much L1 found", lambda: len(json.dumps(m, sort_keys=True).encode()) <= METRICS_MAX_BYTES)
    reserved = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script", "duration_s", "runner_reason")
    check("metrics never use a runner-owned key", lambda: not [k for k in m if k in reserved])
    out = emit(v, m)
    check("the output is exactly one metrics line then one verdict line",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=FAIL")
    check("aggregate: any FAIL -> FAIL; all PASS -> PASS; otherwise INDETERMINATE",
          lambda: aggregate({"a": {"verdict": "FAIL"}, "b": {"verdict": "INDETERMINATE"}}) == "FAIL"
          and aggregate({"a": {"verdict": "PASS"}, "b": {"verdict": "PASS"}}) == "PASS"
          and aggregate({"a": {"verdict": "PASS"}, "b": {"verdict": "INDETERMINATE"}}) == "INDETERMINATE")

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: %d check(s) ran, floor is %d" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
