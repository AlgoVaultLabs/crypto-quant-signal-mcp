#!/usr/bin/env python3
"""owed-read-pre-trade-odds-forward.py — DECISION-CALL-V2-W4 CH3. Do the logged shadow odds match what happened?

Owner wave: DECISION-CALL-V2-W4. CH2 logs, on every pre_trade_check, the no-edge odds as the check stood
(pre_trade_checks.p_timeout / p_target_first / p_stop_first / p_liq_hold, odds_version); CH3's nightly labeler
writes what the price then did (pre_trade_check_outcomes, migrations/054). This read scores the first against
the second on LIVE checks — the forward calibration the study's hold-out could only promise — and prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

── THE RUNGS (architect ruling Q3 = A) ──
Six registry rows share this script: pre-trade-odds-forward-030d … -180d, not_before = first_label_at + 30/60/
90/120/150/180 d, expires_at = not_before + 72 h. `first_label_at` is a MEASURED anchor: this read refuses a
row whose value differs from the table's own earliest `labeled` outcome. Every rung records, per odds_version:
    n          labelled checks carrying odds (odds_version IS NOT NULL), per field:
                 timeout / target_first / stop_first — bracket_first IN (target, stop, timeout);
                 both_in_one_bar is EXCLUDED and counted (as the study's pre-registration excludes it)
                 liquidation — liq_touched NOT NULL
    projected  the date the bracketed n reaches 500, at the rate observed since first_label_at
    reliability once a field's n >= 500: 10 equal-count bins over the logged value (mean p, mean y, gap pp) and
               the n-weighted ECE in pp — the study's §1 instruments, never retuned here.
  PASS on a complete, consistent measurement (whatever n is: a small n is the finding, recorded).
  FAIL only on a LABEL-TABLE INTEGRITY BREAK — a labelled row whose prices, bracket or liquidation field
       contradict its own check, an unlabelable row without a reason, or an outcome written before its hold
       settled. Each break is counted with sample check ids.
  INDETERMINATE when the anchors are not this read's, the database cannot be read on one read-only snapshot,
       or first_label_at does not match the table.

Every database statement runs in ONE `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction as
`aoe_readonly`. Odds columns are read through to_jsonb(row), so a server that never wrote one reads NULL, never an
error. Stdlib only.

    owed-read-pre-trade-odds-forward.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-pre-trade-odds-forward.py --self-test
"""
from __future__ import annotations

import argparse
import json
import math
import shlex
import subprocess
import sys
import time

# ── the pre-registration (spec §7.3 + architect ruling Q3; never retuned by a registry row) ──
WAVE = "DECISION-CALL-V2-W4"
RUNG_DAYS = (30, 60, 90, 120, 150, 180)
N_MIN = 500                       # bracketed labelled checks before reliability is read
RELIABILITY_BINS = 10             # §1: 10 equal-count reliability bins, ECE
WINDOW_H = 72                     # expires_at = not_before + 72 h
BRACKET_SCORED = ("target", "stop", "timeout")
FIELDS = ("timeout", "target_first", "stop_first", "liquidation")
SETTLE_S = 3600                   # the labeler's settle (src/scripts/pre-trade-outcome-labeler.ts SETTLE_MS)
FIRST_LABEL_TOLERANCE_S = 1
ANCHOR_KEYS = ("first_label_at", "rung_days", "n_min", "reliability_bins")

PSQL_CMD = ("docker exec -i crypto-quant-signal-mcp-postgres-1 psql -X -U aoe_readonly -d signal_performance "
            "-q -tA -F | -v ON_ERROR_STOP=1")
PSQL_TIMEOUT_S = 240
STATEMENT_TIMEOUT = "60s"

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096
SAMPLE_MAX = 6
SECTIONS = ("first", "rows")
ROW_COLS = 18


def utc_iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


# ── anchors ──────────────────────────────────────────────────────────────────────────────────

def resolve_anchors(anchors):
    """-> (anchors, None) or (None, reason). The rule constants must be this file's; first_label_at an epoch."""
    if not isinstance(anchors, dict):
        return None, "anchors are not a JSON object"
    keys = sorted(k for k in anchors if not str(k).startswith("_"))
    if keys != sorted(ANCHOR_KEYS):
        return None, "anchor keys %s are not %s" % (",".join(keys), ",".join(sorted(ANCHOR_KEYS)))
    if anchors["n_min"] != N_MIN or anchors["reliability_bins"] != RELIABILITY_BINS:
        return None, "the registry's n_min/reliability_bins differ from this read's pre-registration"
    if anchors["rung_days"] not in RUNG_DAYS:
        return None, "rung_days=%r is not one of %s" % (anchors["rung_days"], RUNG_DAYS)
    f = anchors["first_label_at"]
    if type(f) is not int or f < 1_793_000_000:
        return None, "first_label_at=%r is not an epoch after the wave" % (f,)
    return dict(anchors), None


# ── the one-snapshot bundle ──────────────────────────────────────────────────────────────────

def build_bundle():
    """psql stdin: ONE read-only repeatable-read transaction; each result set behind a MARK so a short read is
    visible. Odds columns through to_jsonb(c): absent columns read NULL."""
    p = ["\\set ON_ERROR_STOP on",
         "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
         "SET LOCAL statement_timeout = '%s';" % STATEMENT_TIMEOUT,
         "SELECT 'MARK|ro|' || current_setting('transaction_read_only');",
         "SELECT 'MARK|sec|first';",
         "SELECT COALESCE(floor(extract(epoch FROM min(labeled_at)))::bigint::text, '') FROM pre_trade_check_outcomes "
         "WHERE status = 'labeled';",
         "SELECT 'MARK|sec|rows';",
         "SELECT o.check_id, o.status, COALESCE(o.bracket_first, ''), COALESCE(o.liq_touched::text, ''), "
         "(o.reason IS NOT NULL)::int, COALESCE(o.ref_px::text, ''), COALESCE(o.end_px::text, ''), "
         "COALESCE(o.high_px::text, ''), COALESCE(o.low_px::text, ''), floor(extract(epoch FROM o.labeled_at))::bigint, "
         "floor(extract(epoch FROM c.checked_at + c.hold_hours * interval '1 hour'))::bigint, "
         "(c.stop_pct IS NOT NULL AND c.target_pct IS NOT NULL)::int, "
         "(c.leverage IS NOT NULL AND c.liq_distance_pct IS NOT NULL)::int, "
         "COALESCE(to_jsonb(c) ->> 'odds_version', ''), COALESCE(to_jsonb(c) ->> 'p_timeout', ''), "
         "COALESCE(to_jsonb(c) ->> 'p_target_first', ''), COALESCE(to_jsonb(c) ->> 'p_stop_first', ''), "
         "COALESCE(to_jsonb(c) ->> 'p_liq_hold', '') "
         "FROM pre_trade_check_outcomes o JOIN pre_trade_checks c ON c.id = o.check_id ORDER BY o.check_id;",
         "SELECT 'MARK|end';",
         "COMMIT;"]
    return "\n".join(p) + "\n"


def parse_bundle(stdout):
    """-> (bundle dict, None) or (None, reason). Every section must be present, in order, and the read read-only."""
    b = {"ro": None, "first": [], "rows": [], "end": False}
    sec = None
    for ln in (stdout or "").splitlines():
        if not ln.strip():
            continue
        if ln.startswith("MARK|ro|"):
            b["ro"] = ln.split("|", 2)[2]
        elif ln.startswith("MARK|sec|"):
            sec = ln.split("|", 2)[2]
        elif ln == "MARK|end":
            b["end"] = True
            sec = None
        elif sec in SECTIONS:
            b[sec].append(ln.split("|"))
        else:
            return None, "unexpected line outside a section: %r" % ln[:80]
    if b["ro"] != "on":
        return None, "the snapshot was not read-only (transaction_read_only=%r)" % b["ro"]
    if not b["end"]:
        return None, "the bundle ended before MARK|end (short read)"
    if len(b["first"]) != 1:
        return None, "the first-label section returned %d lines, not 1" % len(b["first"])
    bad = [r for r in b["rows"] if len(r) != ROW_COLS]
    if bad:
        return None, "%d outcome row(s) do not have %d columns" % (len(bad), ROW_COLS)
    return b, None


def _f(s):
    try:
        x = float(s)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


# ── the read ─────────────────────────────────────────────────────────────────────────────────

def integrity_breaks(rows):
    """{name: [check ids]} of every label-table integrity break in the outcome rows."""
    br = {"labeled_price_missing_or_nonpositive": [], "labeled_prices_out_of_range": [], "bracket_without_bracket_check": [],
          "bracketed_check_without_bracket_label": [], "liq_without_liq_check": [], "liq_check_without_liq_label": [],
          "unlabelable_without_reason": [], "labeled_before_settle": [], "unknown_status_or_value": []}
    for r in rows:
        cid, status, bf, liq, has_reason = r[0], r[1], r[2], r[3], r[4] == "1"
        ref, end, hi, lo = _f(r[5]), _f(r[6]), _f(r[7]), _f(r[8])
        labeled_at, settled_at = int(r[9]), int(r[10])
        has_bracket, has_liq = r[11] == "1", r[12] == "1"
        if status not in ("labeled", "unlabelable") or bf not in ("", "both_in_one_bar") + BRACKET_SCORED or liq not in ("", "true", "false"):
            br["unknown_status_or_value"].append(cid)
            continue
        if labeled_at < settled_at + SETTLE_S:
            br["labeled_before_settle"].append(cid)
        if status == "unlabelable":
            if not has_reason:
                br["unlabelable_without_reason"].append(cid)
            continue
        if None in (ref, end, hi, lo) or min(ref, end, hi, lo) <= 0:
            br["labeled_price_missing_or_nonpositive"].append(cid)
        elif not (lo <= min(ref, end) and max(ref, end) <= hi):
            br["labeled_prices_out_of_range"].append(cid)
        if bf and not has_bracket:
            br["bracket_without_bracket_check"].append(cid)
        if has_bracket and not bf:
            br["bracketed_check_without_bracket_label"].append(cid)
        if liq and not has_liq:
            br["liq_without_liq_check"].append(cid)
        if has_liq and not liq:
            br["liq_check_without_liq_label"].append(cid)
    return {k: v for k, v in br.items() if v}


def reliability(pairs):
    """§1: 10 equal-count bins over p (stable sort, array_split sizes), each (n, mean p, mean y, gap pp); ECE pp."""
    pairs = sorted(pairs, key=lambda t: t[0])
    n = len(pairs)
    k, extra = divmod(n, RELIABILITY_BINS)
    bins, i = [], 0
    for j in range(RELIABILITY_BINS):
        size = k + (1 if j < extra else 0)
        blk = pairs[i:i + size]
        i += size
        if not blk:
            continue
        pm = sum(p for p, _ in blk) / len(blk)
        ym = sum(y for _, y in blk) / len(blk)
        bins.append({"n": len(blk), "p": round(pm, 4), "y": round(ym, 4), "gap_pp": round((pm - ym) * 100, 3)})
    ece = sum(b["n"] / n * abs(b["gap_pp"]) for b in bins) if n else None
    return bins, (round(ece, 3) if ece is not None else None)


def score(rows, now, first_label_at):
    """Per odds_version: n per field, the bracketed n and its projection, reliability once a field's n >= N_MIN."""
    out = {}
    for r in rows:
        if r[1] != "labeled" or not r[13]:
            continue
        v = out.setdefault(r[13], {"labelled": 0, "bracketed": 0, "both_in_one_bar": 0,
                                   "pairs": {f: [] for f in FIELDS}})
        v["labelled"] += 1
        bf, liq = r[2], r[3]
        p = {"timeout": _f(r[14]), "target_first": _f(r[15]), "stop_first": _f(r[16]), "liquidation": _f(r[17])}
        if bf == "both_in_one_bar":
            v["both_in_one_bar"] += 1
        elif bf in BRACKET_SCORED:
            v["bracketed"] += 1
            for f, hit in (("timeout", "timeout"), ("target_first", "target"), ("stop_first", "stop")):
                if p[f] is not None:
                    v["pairs"][f].append((p[f], 1.0 if bf == hit else 0.0))
        if liq in ("true", "false") and p["liquidation"] is not None:
            v["pairs"]["liquidation"].append((p["liquidation"], 1.0 if liq == "true" else 0.0))
    days = max((now - first_label_at) / 86400.0, 1e-9)
    res = {}
    for ver, v in sorted(out.items()):
        fields = {}
        for f in FIELDS:
            pr = v["pairs"][f]
            e = {"n": len(pr)}
            if len(pr) >= N_MIN:
                e["bins"], e["ece_pp"] = reliability(pr)
            fields[f] = e
        rate = v["bracketed"] / days
        proj = None
        if v["bracketed"] >= N_MIN:
            proj = "reached"
        elif rate > 0:
            proj = utc_iso(int(now + (N_MIN - v["bracketed"]) / rate * 86400))
        res[ver] = {"labelled": v["labelled"], "bracketed": v["bracketed"], "both_in_one_bar": v["both_in_one_bar"],
                    "bracketed_per_day": round(rate, 3), "n500_projected": proj, "fields": fields}
    return res


def evaluate(anchors, now, stdout, err):
    """-> (verdict, metrics). The single derivation of the verdict."""
    a, why = resolve_anchors(anchors)
    if why:
        return "INDETERMINATE", {"reason": why}
    if err:
        return "INDETERMINATE", {"reason": err}
    b, why = parse_bundle(stdout)
    if why:
        return "INDETERMINATE", {"reason": why}
    first = b["first"][0][0]
    if not first:
        return "INDETERMINATE", {"reason": "the outcome table holds no labelled row, so first_label_at is unverifiable"}
    if abs(int(first) - a["first_label_at"]) > FIRST_LABEL_TOLERANCE_S:
        return "INDETERMINATE", {"reason": "anchor first_label_at %d is not the table's earliest label %s" % (a["first_label_at"], first)}
    breaks = integrity_breaks(b["rows"])
    m = {"wave": WAVE, "rung_days": a["rung_days"], "first_label_at": utc_iso(a["first_label_at"]), "now": utc_iso(now),
         "outcome_rows": len(b["rows"]), "unlabelable": sum(1 for r in b["rows"] if r[1] == "unlabelable"),
         "by_version": score(b["rows"], now, a["first_label_at"]),
         "integrity": {k: {"n": len(v), "sample": v[:SAMPLE_MAX]} for k, v in breaks.items()}}
    return ("FAIL" if breaks else "PASS"), m


def fit_metrics(m):
    """The runner's 4 KiB budget: drop per-bin detail (ECE kept) before anything else, then samples."""
    def size(x):
        return len(json.dumps(x, sort_keys=True, separators=(",", ":")).encode())
    if size(m) <= METRICS_MAX_BYTES:
        return m
    m = json.loads(json.dumps(m))
    for ver in (m.get("by_version") or {}).values():
        for f in ver["fields"].values():
            f.pop("bins", None)
    m["_trimmed"] = "per-bin reliability dropped to fit 4 KiB (ECE kept)"
    if size(m) <= METRICS_MAX_BYTES:
        return m
    for v in (m.get("integrity") or {}).values():
        v.pop("sample", None)
    m["_trimmed"] += "; integrity samples dropped"
    return m


def run_bundle(sql):
    try:
        p = subprocess.run(shlex.split(PSQL_CMD), input=sql, capture_output=True, encoding="utf-8",
                           errors="replace", timeout=PSQL_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as e:
        return None, "psql could not run: %s: %s" % (type(e).__name__, str(e)[:160])
    if p.returncode != 0:
        return None, "psql rc=%d: %s" % (p.returncode, p.stderr.strip()[:240])
    return p.stdout, None


def run(now, anchors):
    _a, why = resolve_anchors(anchors)
    if why:
        return "INDETERMINATE", {"reason": why}
    t0 = time.monotonic()
    stdout, err = run_bundle(build_bundle())
    verdict, metrics = evaluate(anchors, now, stdout, err)
    metrics["db_s"] = round(time.monotonic() - t0, 1)
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: pre-trade-odds-forward")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--now", type=int)
    ap.add_argument("--sandbox", action="store_true", help="accepted for the runner contract; this read has no override")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)
    if a.self_test:
        return self_test()
    if not a.run or a.now is None:
        ap.error("the runner invokes --run --now EPOCH with the anchors on stdin")
    try:
        anchors = json.loads(sys.stdin.read() or "null")
        verdict, metrics = run(a.now, anchors)
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing
        verdict, metrics = "INDETERMINATE", {"reason": "fault %s: %s" % (type(e).__name__, str(e)[:200])}
    for ln in emit(verdict, metrics):
        print(ln)
    return EXIT_FOR[verdict]


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

_SELF_TEST_MIN_CHECKS = 24


def self_test():
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

    F = 1_793_500_000
    NOW = F + 30 * 86400 + 3600
    A = {"first_label_at": F, "rung_days": 30, "n_min": N_MIN, "reliability_bins": RELIABILITY_BINS}

    def row(cid, status="labeled", bf="timeout", liq="", reason=0, ref="100", end="101", hi="102", lo="99",
            labeled=F + 7200, settled=F, bracket=1, levered=0, ver="odds-v1", pt="0.6", pf="0.2", ps="0.2", pl=""):
        return [str(cid), status, bf, liq, str(reason), ref, end, hi, lo, str(labeled), str(settled), str(bracket),
                str(levered), ver, pt, pf, ps, pl]

    def stdout_for(rows, first=str(F), ro="on", end=True):
        lines = ["MARK|ro|" + ro, "MARK|sec|first", first, "MARK|sec|rows"] + ["|".join(r) for r in rows]
        if end:
            lines.append("MARK|end")
        return "\n".join(lines) + "\n"

    few = [row(i) for i in range(1, 40)] + [row(99, bf="both_in_one_bar")]
    check("contract constants: six rungs, 500, 10 bins, 72 h, exit codes",
          lambda: RUNG_DAYS == (30, 60, 90, 120, 150, 180) and N_MIN == 500 and RELIABILITY_BINS == 10 and WINDOW_H == 72
          and EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})
    check("the psql identity is aoe_readonly on signal_performance, read through docker exec -i",
          lambda: shlex.split(PSQL_CMD)[:4] == ["docker", "exec", "-i", "crypto-quant-signal-mcp-postgres-1"]
          and "aoe_readonly" in PSQL_CMD and "signal_performance" in PSQL_CMD)
    check("the bundle is ONE repeatable-read read-only transaction with every MARK",
          lambda: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" in build_bundle()
          and all(m in build_bundle() for m in ("MARK|ro|", "MARK|sec|first", "MARK|sec|rows", "MARK|end", "COMMIT;"))
          and not any(w in build_bundle().upper() for w in ("INSERT ", "UPDATE ", "DELETE ", "ALTER ", "DROP ", "CREATE ")))
    check("odds columns are read through to_jsonb (an absent column reads NULL, never an error)",
          lambda: build_bundle().count("to_jsonb(c) ->>") == 5)
    check("anchors equal to the pre-registration resolve", lambda: resolve_anchors(dict(A)) == (A, None))
    check("a retuned n_min is INDETERMINATE", lambda: resolve_anchors(dict(A, n_min=400))[0] is None)
    check("an unknown rung is INDETERMINATE", lambda: resolve_anchors(dict(A, rung_days=45))[0] is None)
    check("an extra anchor key is INDETERMINATE", lambda: resolve_anchors(dict(A, extra=1))[0] is None)
    check("a non-epoch first_label_at is INDETERMINATE", lambda: resolve_anchors(dict(A, first_label_at="x"))[0] is None)
    v, m = evaluate(A, NOW, stdout_for(few), None)
    check("n < 500: PASS, records n and a projected date, no reliability",
          lambda: v == "PASS" and m["by_version"]["odds-v1"]["bracketed"] == 39
          and m["by_version"]["odds-v1"]["fields"]["timeout"] == {"n": 39}
          and m["by_version"]["odds-v1"]["n500_projected"] is not None)
    check("both_in_one_bar is excluded from every bracket field and counted",
          lambda: m["by_version"]["odds-v1"]["both_in_one_bar"] == 1 and m["by_version"]["odds-v1"]["labelled"] == 40)
    many = [row(i, bf=("timeout" if i % 2 else "stop"), pt=("0.5"), ps="0.5", pf="0.0") for i in range(1, 601)]
    v2, m2 = evaluate(A, NOW, stdout_for(many), None)
    t = m2["by_version"]["odds-v1"]["fields"]["timeout"]
    check("n >= 500: reliability in 10 equal-count bins and the ECE (constructed: p 0.5, y 0.5 -> ECE 0)",
          lambda: v2 == "PASS" and len(t["bins"]) == 10 and sum(b["n"] for b in t["bins"]) == 600 and t["ece_pp"] == 0.0)
    skew = [row(i, bf="timeout", pt="0.9") for i in range(1, 501)]
    check("a miscalibrated field shows its gap: p 0.9, every outcome a time-out -> ECE 10 pp",
          lambda: evaluate(A, NOW, stdout_for(skew), None)[1]["by_version"]["odds-v1"]["fields"]["timeout"]["ece_pp"] == 10.0)
    check("a row without odds (logged before CH2) is not counted",
          lambda: evaluate(A, NOW, stdout_for(few + [row(500, ver="")]), None)[1]["by_version"]["odds-v1"]["labelled"] == 40)
    check("liquidation pairs come from liq_touched with p_liq_hold",
          lambda: evaluate(A, NOW, stdout_for([row(1, bf="", bracket=0, levered=1, liq="true", pl="0.3")]), None)[1]
          ["by_version"]["odds-v1"]["fields"]["liquidation"] == {"n": 1})
    for name, bad in (("a bracket label on a check without a bracket", row(7, bracket=0)),
                      ("a bracketed check without a bracket label", row(7, bf="")),
                      ("a liquidation label without leverage", row(7, liq="true")),
                      ("a levered check without its liquidation label", row(7, levered=1)),
                      ("a labelled price outside its own high/low", row(7, end="105")),
                      ("a labelled row with no price", row(7, ref="")),
                      ("an unlabelable row with no reason", row(7, status="unlabelable", bf="", ref="", end="", hi="", lo="")),
                      ("an outcome written before its hold settled", row(7, labeled=F + 60))):
        check("FAIL on an integrity break: " + name, lambda bad=bad: evaluate(A, NOW, stdout_for(few + [bad]), None)[0] == "FAIL")
    check("an unlabelable row WITH its reason is clean",
          lambda: evaluate(A, NOW, stdout_for(few + [row(8, status="unlabelable", bf="", reason=1, ref="", end="", hi="", lo="")]), None)[0] == "PASS")
    check("first_label_at not the table's: INDETERMINATE",
          lambda: evaluate(A, NOW, stdout_for(few, first=str(F + 10)), None)[0] == "INDETERMINATE")
    check("no labelled row at all: INDETERMINATE (the anchor is unverifiable)",
          lambda: evaluate(A, NOW, stdout_for([], first=""), None)[0] == "INDETERMINATE")
    check("a snapshot that was not read-only: INDETERMINATE",
          lambda: evaluate(A, NOW, stdout_for(few, ro="off"), None)[0] == "INDETERMINATE")
    check("a short read (no MARK|end): INDETERMINATE", lambda: evaluate(A, NOW, stdout_for(few, end=False), None)[0] == "INDETERMINATE")
    check("psql failure: INDETERMINATE", lambda: evaluate(A, NOW, None, "psql rc=2: boom")[0] == "INDETERMINATE")
    big = [row(i, bf=("timeout", "stop", "target")[i % 3], liq=("true" if i % 5 else "false"), levered=1, pl="0.2",
               ver=("odds-v1" if i % 2 else "odds-v2")) for i in range(1, 3001)]
    vb, mb = evaluate(A, NOW, stdout_for(big), None)
    check("metrics stay within the runner's 4 KiB at a large n (bins trimmed before anything else)",
          lambda: vb == "PASS" and len(json.dumps(fit_metrics(mb), sort_keys=True, separators=(",", ":")).encode()) <= METRICS_MAX_BYTES)
    out = emit(v, m)
    check("emit: METRICS then the token, exactly two lines",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=PASS")

    print("self-test: %d checks, %d failed" % (len(ran), len(failures)))
    if len(ran) < _SELF_TEST_MIN_CHECKS:
        print("self-test: FAIL — only %d checks ran (floor %d)" % (len(ran), _SELF_TEST_MIN_CHECKS))
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
