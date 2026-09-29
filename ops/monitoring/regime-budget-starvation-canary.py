#!/usr/bin/env python3
"""
Paid `get_market_regime` refusal canary — OPS-ALARM-SINGLE-DERIVATION-W1 CH1 (born as
OPS-HL-INTERACTIVE-STARVATION-W1 CH3; alert id unchanged: `regime_budget_starvation`).

WHAT IT PAGES ON. Refusals among PAID `get_market_regime` calls over the trailing window:
`ERR_UPSTREAM_RATE_LIMIT` (a venue refused the candles leg; the call errored) ∪
`DEGRADED_FUNDING_BUDGET` (Hyperliquid refused the cross-venue funding leg; the call answered with a
silently-neutral funding field). Numerator and denominator come from ONE statement over ONE
population through `population_rate.py` — the numerator is a subset of the denominator by
construction. Paid = the subscription rail + the x402 rail (`src/lib/payment-rail.ts`), MCP and
x402 rows alike, across every requested exchange: ONE rate.

WHY IT WAS REBUILT (measured 2026-09-29, R0 of this wave). The previous predicate divided
Hyperliquid interactive `BUDGET_CEILING` throws by EVERY caller (no `caller` predicate) by
`get_market_regime` calls on EVERY venue (no `exchange` predicate) and labelled the quotient "PAID".
The page of 2026-09-28T21:43Z reproduced exactly — 203 / 3,920 — and was 189 `scan_trade_calls`
throws from an internal scan plus 14 from a nightly labeler: zero were the tool's own, and zero
paid calls were refused. It had paged on 11 of the previous 15 nights. The throws are real; they
are EVIDENCE here, printed by venue × caller, and never divided by a population they are not in.

SLICES. The same statement is split into `paid`, `internal` and `free_or_other`. Only `paid` can
page; the others are evaluated with the same rule and REPORTED, never paged.

PAID VERIFICATION (CLAUDE.md § Data Integrity — tier-tagged rows cross-check against the canonical
revenue source). The body says PAID only when both legs pass this run:
  1. the dev-key prefix hatch is CLOSED on the app container (`ALLOW_DEV_KEY_PREFIX` != 'true') —
     it is the only path by which a request can carry a paid tier without Stripe validation;
  2. distinct paid-tagged identities in the window are not > 2x, nor > 10 above, the paying
     customers (Stripe `active|past_due|trialing` + distinct x402 payer wallets in the window).
Otherwise the body says `paid-tagged (unverified)` and the run records
`instrumentation_artifact=operator_dev_key` when leg 2 tripped.

VERDICT TOKEN — callers gate on the TOKEN, never on the bare exit code:

    REGIME_STARVATION_VERDICT=PASS | FAIL | INDETERMINATE
    exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE   (3 is the token-law default for a NEW gate)

The decision order is `population_rate.evaluate`'s: an impossible count → INDETERMINATE; an empty
paid population → INDETERMINATE; refusals above tolerance → FAIL AT ANY VOLUME; below the paid
floor → INDETERMINATE (a quiet clean day cannot earn a green); otherwise PASS.

MODES
    --check                default. The alert.
    --observability-gate   asserts `request_log.verdict` is non-NULL on NEW `get_market_regime`
                           rows. Zero new rows ⇒ INDETERMINATE, never PASS.
    --self-test            hermetic; no DB, no network.

DETECT AND ALERT ONLY. This canary never mutates a budget, a reserve, a ceiling, a weight class or
a network rule. An unattended job must not change a rate budget — Detect → Alert → Escalate.

READ ROLE. `aoe_readonly`, NOT `algovault_autopilot`: measured 2026-08-31 ~16:00Z (the
OPS-HL-INTERACTIVE-STARVATION-W1 CH3 readout), `has_table_privilege('algovault_autopilot',
'rate_limit_events','SELECT')` is FALSE, and a table a role cannot read comes back as ABSENT rather
than DENIED — a silent zero on exactly the arm that matters.
"""
from __future__ import annotations

import os
import subprocess
import sys

# Sibling modules are installed beside this file (`/opt/algovault-monitoring/`) and live beside it in
# the repo. Put the directory on the path explicitly so a by-path load (the tests, a self-test run
# from elsewhere) resolves them the same way the cron does.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    import population_rate as pr

    _RATE_IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001 — a missing rate module is INDETERMINATE, never a crash
    pr = None  # type: ignore[assignment]
    _RATE_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

try:
    from canary_result_log import append_result as _append_result

    _RESULT_LOG_IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001
    _RESULT_LOG_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

    def _append_result(*_a, **_k):  # type: ignore[misc]
        return False, f"canary_result_log unavailable ({_RESULT_LOG_IMPORT_ERROR})"


PSQL_CMD = os.environ.get(
    "RS_PSQL_CMD",
    "docker exec crypto-quant-signal-mcp-postgres-1 psql -U aoe_readonly -d signal_performance -qtA",
)
APP_CONTAINER = os.environ.get("RS_APP_CONTAINER", "crypto-quant-signal-mcp-mcp-server-1")

CANARY = "regime_budget_starvation"
ALERT_ID = "regime_budget_starvation"
TOKEN = "REGIME_STARVATION_VERDICT"
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}

# Trailing window. The canary runs daily at 21:43Z; 24h matches its cadence.
WINDOW_HOURS = int(os.environ.get("RS_WINDOW_HOURS", "24"))

# Refusals per 100 PAID calls. Unchanged from the pre-rebuild tolerance: a healthy paid window is
# ~0 (measured 2026-09-15..28: 1 refusal in 36,361 paid calls), and the two real paid-harm days on
# record sit well above it (2026-08-31: 45 degraded; 2026-09-08: 73 degraded, on ~2,800 calls).
MAX_REFUSALS_PER_100 = float(os.environ.get("RS_MAX_REFUSALS_PER_100", "1.0"))

# THE PAID FLOOR — a PASS needs at least this many paid calls in the window; a FAIL needs none.
# p10 (nearest rank) of 14 full UTC days of paid `get_market_regime` volume, 2026-09-15..28,
# measured at R0 2026-09-29: [1151, 2030, 2657, … 2863] → 2030. The 1,151 day (09-19) is exactly
# the shape a floor exists for: too quiet to call clean.
MIN_PAID_CALLS = int(os.environ.get("RS_MIN_PAID_CALLS", "2030"))

# `--observability-gate`: how far back to look for NEW rows. MINUTES, on purpose: the gate's first
# run follows the deploy that ships an instrument, and an hours-wide window would sweep in
# pre-deploy rows whose verdict is legitimately NULL.
GATE_WINDOW_MINUTES = int(os.environ.get("RS_GATE_WINDOW_MINUTES", "360"))

TG = os.environ.get("RS_TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
# `CRITICAL_PERSISTENT` is the ONLY severity send_telegram.sh delivers.
SEVERITY_DELIVERED = "CRITICAL_PERSISTENT"

# Routes to demand/admission — never to a reserve bump. Templated; the resolver fills {NEXT}.
RECOMMENDED_WAVE = "OPS-PAID-INTERACTIVE-REFUSAL-W{NEXT}"

# ── The sets. Parity-tested against the TypeScript SoT so no list is hand-typed twice:
#    PAID_TIERS    == SUBSCRIPTION_TIERS ∪ X402_TIERS (src/lib/payment-rail.ts) == PaidPlanId ∪ {x402}
#    EVENT_VERDICTS == { regimeErrorVerdict(UpstreamRateLimitError), regimeSuccessVerdict(true) }
PAID_TIERS = ("enterprise", "pro", "starter", "x402")
EVENT_VERDICTS = ("DEGRADED_FUNDING_BUDGET", "ERR_UPSTREAM_RATE_LIMIT")
PAID_SLICE, INTERNAL_SLICE, OTHER_SLICE = "paid", "internal", "free_or_other"
SLICES = (PAID_SLICE, INTERNAL_SLICE, OTHER_SLICE)

# Which leg a budget-attributable verdict came from. The funding leg is Hyperliquid on EVERY call,
# whatever exchange was requested; the candles leg is the requested exchange's own adapter.
CAUSE_LEG = {
    "DEGRADED_FUNDING_BUDGET": "Hyperliquid funding leg",
    "ERR_UPSTREAM_RATE_LIMIT": "candles leg",
}

# Paid verification rule (CLAUDE.md § Data Integrity): > 2x OR > 10 absolute ⇒ unverified.
VERIFY_MAX_MULTIPLE = 2
VERIFY_MAX_ABSOLUTE_GAP = 10

EVIDENCE_TOP_N = 10


def _sql_list(values) -> str:
    return "(" + ", ".join(f"'{v}'" for v in values) + ")"


def window_request_log(hours: int) -> str:
    # `request_log.timestamp` is TEXT (ISO-8601 Z) and sorts lexicographically in that format.
    return (f"timestamp > to_char(now() - interval '{int(hours)} hours', "
            "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")


def slice_expr() -> str:
    return (f"CASE WHEN license_tier IN {_sql_list(PAID_TIERS)} THEN '{PAID_SLICE}' "
            f"WHEN license_tier = 'internal' THEN '{INTERNAL_SLICE}' ELSE '{OTHER_SLICE}' END")


def slice_spec(hours: int = WINDOW_HOURS):
    """THE page population: every `get_market_regime` row in the window, split by slice. PURE."""
    return pr.RateSpec(
        table="request_log",
        population_where="tool_name='get_market_regime'",
        event_where=f"verdict IN {_sql_list(EVENT_VERDICTS)}",
        window_where=window_request_log(hours),
        group_by=(slice_expr(),),
        label="get_market_regime refusals",
    )


def throws_spec(hours: int = WINDOW_HOURS):
    """EVIDENCE: interactive BUDGET_CEILING throws by venue × caller; event = landed at mm :00/:30.
    A share of throws among throws — one population — never throws divided by calls."""
    return pr.RateSpec(
        table="rate_limit_events",
        population_where="kind='throw' AND http_or_body_code='BUDGET_CEILING' AND class='interactive'",
        event_where="extract(minute from ts)::int IN (0, 30)",
        window_where=f"ts > now() - interval '{int(hours)} hours'",
        group_by=("venue", "caller"),
        label="interactive BUDGET_CEILING throws",
    )


def err_unknown_spec(hours: int = WINDOW_HOURS):
    """EVIDENCE: `ERR_UNKNOWN` among all `get_market_regime` rows (classified at R0: symbol-not-
    listed errors from an internal XAU poller; no rate-limit cause)."""
    return pr.RateSpec(
        table="request_log",
        population_where="tool_name='get_market_regime'",
        event_where="verdict = 'ERR_UNKNOWN'",
        window_where=window_request_log(hours),
        label="ERR_UNKNOWN",
    )


def build_refusal_evidence_sql(hours: int = WINDOW_HOURS) -> str:
    """Paid refusals by requested exchange × verdict. Counts only — never a rate. PURE."""
    return (
        "SELECT coalesce(exchange,'<null>'), verdict, count(*) FROM request_log "
        f"WHERE tool_name='get_market_regime' AND license_tier IN {_sql_list(PAID_TIERS)} "
        f"AND verdict IN {_sql_list(EVENT_VERDICTS)} AND {window_request_log(hours)} "
        "GROUP BY 1, 2 ORDER BY 3 DESC;"
    )


def build_verification_sql(hours: int = WINDOW_HOURS) -> str:
    """tagged identities | paying subscriptions | x402 payer wallets. PURE."""
    return (
        "SELECT (SELECT count(DISTINCT ip_hash) FROM request_log "
        f"WHERE license_tier IN {_sql_list(PAID_TIERS)} AND {window_request_log(hours)}), "
        "(SELECT count(*) FROM subscriber_profiles WHERE status IN ('active','past_due','trialing')), "
        "(SELECT count(DISTINCT payer_wallet) FROM processed_x402_payments "
        f"WHERE payer_wallet <> '' AND created_at > now() - interval '{int(hours)} hours');"
    )


def build_gate_sql(window_minutes: int) -> str:
    """`--observability-gate`: NEW `get_market_regime` rows and how many carry a verdict. PURE."""
    return (
        "SELECT count(*), count(verdict), count(regime) FROM request_log "
        "WHERE tool_name='get_market_regime' "
        f"AND timestamp > to_char(now() - interval '{window_minutes} minutes', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"');"
    )


def run_sql(sql: str) -> str:
    out = subprocess.run(
        PSQL_CMD.split() + ["-F", "|", "-c", sql],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql rc={out.returncode}: {out.stderr.strip()[:200]}")
    return out.stdout


def read_container_env(name: str):
    """One env var from the app container: its value, None when UNSET, raises when unreadable."""
    out = subprocess.run(["docker", "exec", APP_CONTAINER, "printenv", name],
                         capture_output=True, text=True, timeout=30)
    if out.returncode == 0:
        return out.stdout.strip()
    if out.returncode == 1 and not out.stderr.strip():
        return None  # printenv's "not set"
    raise RuntimeError(f"docker exec printenv rc={out.returncode}: {out.stderr.strip()[:160]}")


def parse_rows(raw: str, width: int) -> list[list[str]]:
    """Split psql -F'|' output into rows of exactly `width` fields; raises on a malformed row."""
    rows = []
    for line in (raw or "").strip().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) != width:
            raise ValueError(f"expected {width} fields, got {len(parts)}: {line[:80]!r}")
        rows.append(parts)
    return rows


def classify_verification(dev_prefix, tagged: int, paying: int, x402_payers: int) -> dict:
    """PURE. `dev_prefix` is the container value (None = unset). Returns the verification record."""
    rec = {"dev_key_prefix": "open" if dev_prefix == "true" else "closed",
           "tagged": tagged, "paying": paying + x402_payers, "x402_payers": x402_payers}
    if dev_prefix == "true":
        rec["status"] = "unverified:dev_key_prefix_open"
        return rec
    denominator = paying + x402_payers
    if tagged > VERIFY_MAX_MULTIPLE * denominator or tagged - denominator > VERIFY_MAX_ABSOLUTE_GAP:
        rec["status"] = "unverified:tagged_exceeds_paying"
        rec["instrumentation_artifact"] = "operator_dev_key"
        return rec
    rec["status"] = "verified"
    return rec


def verify_paid_slice(hours: int = WINDOW_HOURS) -> dict:
    """Both legs, each failure mode named. Never raises."""
    try:
        dev_prefix = read_container_env("ALLOW_DEV_KEY_PREFIX")
    except Exception as e:  # noqa: BLE001
        return {"status": f"unknown:container_env_unreadable ({type(e).__name__})"}
    try:
        rows = parse_rows(run_sql(build_verification_sql(hours)), 3)
        tagged, paying, x402_payers = (int(x or 0) for x in rows[0])
    except Exception as e:  # noqa: BLE001
        return {"status": f"unknown:revenue_source_unreadable ({type(e).__name__})"}
    return classify_verification(dev_prefix, tagged, paying, x402_payers)


def paid_label(verification: dict) -> str:
    return "PAID" if verification.get("status") == "verified" else "paid-tagged (unverified)"


def cause_lines(evidence_rows: list[list[str]]) -> list[str]:
    """Group refusals by the LEG that refused — never by requested exchange as if it were the cause."""
    funding = [(ex, int(n)) for ex, v, n in evidence_rows if v == "DEGRADED_FUNDING_BUDGET"]
    candles = [(ex, int(n)) for ex, v, n in evidence_rows if v == "ERR_UPSTREAM_RATE_LIMIT"]
    out = []
    if funding:
        total = sum(n for _, n in funding)
        on = ", ".join(f"{ex} {n}" for ex, n in funding)
        out.append(f"  {CAUSE_LEG['DEGRADED_FUNDING_BUDGET']} (DEGRADED_FUNDING_BUDGET): {total} "
                   f"— requested on: {on}")
    if candles:
        total = sum(n for _, n in candles)
        per = ", ".join(f"{ex} {n}" for ex, n in candles)
        out.append(f"  {CAUSE_LEG['ERR_UPSTREAM_RATE_LIMIT']} (ERR_UPSTREAM_RATE_LIMIT): {total} "
                   f"— refusing venue: {per}")
    return out


def build_body(paid, label: str, causes: list[str], throw_lines: list[str],
               err_unknown: str, other_slices: list[str]) -> str:
    """Evidence values only — no mechanism prose. `paid` is the paid slice's RateVerdict."""
    rate = paid.per_100
    lines = [
        f"get_market_regime refusals among {label} calls: "
        f"{pr.share_text(paid.counts, 'calls')} — tolerance {MAX_REFUSALS_PER_100} per 100",
        f"Window: trailing {WINDOW_HOURS}h · paid floor {MIN_PAID_CALLS} calls (PASS only)"
        + ("" if rate is not None else " · rate undefined"),
        "",
        "Refusals by leg:",
        *(causes or ["  (no per-exchange evidence row)"]),
        "",
        "Interactive BUDGET_CEILING throws by venue × caller (evidence, not divided):",
        *(throw_lines or ["  (none in window)"]),
        f"ERR_UNKNOWN: {err_unknown}",
        "Other slices (reported, never paged):",
        *(other_slices or ["  (none)"]),
        "",
        f"Action: dispatch {RECOMMENDED_WAVE}",
    ]
    return "\n".join(lines)


def fire(body: str) -> None:
    """Dispatch to the shared wrapper, which owns the cooldown and the severity gate — none of that
    is reimplemented here. Fail-open: a broken wrapper never turns a run into a crash."""
    try:
        subprocess.run([TG, ALERT_ID, SEVERITY_DELIVERED, "-"],
                       input=body, text=True, timeout=30, check=False)
    except Exception as e:  # noqa: BLE001
        print(f"[regime-starvation] TG dispatch failed (fail-open): {e}", file=sys.stderr)


def clear() -> None:
    """FIRING -> CLEAR state hygiene; `announce_resolution` stays false on the registry row."""
    try:
        subprocess.run([TG, "--clear", ALERT_ID, "paid get_market_regime refusals within tolerance"],
                       timeout=30, check=False, capture_output=True)
    except Exception as e:  # noqa: BLE001
        print(f"[regime-starvation] TG clear failed (fail-open): {e}", file=sys.stderr)


def _record(verdict: str, metrics: dict) -> None:
    ok, detail = _append_result(CANARY, verdict, EXIT_FOR[verdict], metrics)
    print(f"CANARY_RESULT_LOG={'ok ' + detail if ok else 'FAILED ' + detail}")


def _finish(verdict: str, metrics: dict) -> int:
    _record(verdict, metrics)
    print(f"{TOKEN}={verdict}")
    return EXIT_FOR[verdict]


def check() -> int:
    metrics: dict = {"window_hours": WINDOW_HOURS, "max_per_100": MAX_REFUSALS_PER_100,
                     "paid_floor": MIN_PAID_CALLS, "paged_slices": [], "recommended_wave": RECOMMENDED_WAVE}
    if pr is None:
        print(f"  reason=rate_module_unavailable ({_RATE_IMPORT_ERROR[:160]})")
        metrics["reason"] = "rate_module_unavailable"
        return _finish("INDETERMINATE", metrics)

    try:
        rows = pr.measure(run_sql, slice_spec())
    except Exception as e:  # noqa: BLE001 — any failure to READ is INDETERMINATE, never a pass
        print(f"  reason=query_failed — {type(e).__name__}: {str(e)[:160]}")
        metrics["reason"] = "query_failed"
        return _finish("INDETERMINATE", metrics)

    by_slice = {c.group[0]: c for c in rows}
    verdicts = {}
    for name in SLICES:
        counts = pr.counts_for(rows, (name,), "get_market_regime refusals")
        floor = MIN_PAID_CALLS if name == PAID_SLICE else 1
        verdicts[name] = pr.evaluate(counts, MAX_REFUSALS_PER_100, floor)
    unknown_slices = sorted(set(by_slice) - set(SLICES))

    verification = verify_paid_slice()
    label = paid_label(verification)
    metrics["paid_verification"] = verification

    # POSITIVE PER-SLICE OUTPUT, always — a slice silently skipped must not look like one that passed.
    other_lines = []
    for name in SLICES:
        v = verdicts[name]
        pages = "yes" if name == PAID_SLICE else "no"
        try:
            shown = pr.share_text(v.counts, "calls")
        except pr.InstrumentDefect as e:
            shown = f"instrument defect: {e}"
        tag = f" label={label}" if name == PAID_SLICE else " (report-only)"
        print(f"  slice={name:<14s} verdict={v.verdict:<13s} reason={v.reason:<22s} refusals={shown}"
              f"{tag} pages={pages}")
        metrics.setdefault("slices", {})[name] = {
            "num": v.counts.numerator, "den": v.counts.denominator, "verdict": v.verdict,
            "reason": v.reason, "per_100": None if v.per_100 is None else round(v.per_100, 4),
            "pages": name == PAID_SLICE}
        if name != PAID_SLICE:
            other_lines.append(f"  {name}: {shown} → {v.verdict} ({v.reason})")
    for name in unknown_slices:
        print(f"  slice={name} is not a declared slice — reported, never paged")
    print(f"  paid_verification={verification.get('status')} "
          + " ".join(f"{k}={verification[k]}" for k in ("dev_key_prefix", "tagged", "paying", "x402_payers",
                                                         "instrumentation_artifact") if k in verification))

    # ── EVIDENCE. Failures here are reported and never change the verdict.
    throw_lines: list[str] = []
    try:
        throws = pr.measure(run_sql, throws_spec())
        throws.sort(key=lambda c: -c.denominator)
        metrics["throws"] = [{"venue": c.group[0], "caller": c.group[1], "throws": c.denominator,
                              "at_mm00_30": c.numerator} for c in throws[:EVIDENCE_TOP_N]]
        for c in throws[:EVIDENCE_TOP_N]:
            line = (f"venue={c.group[0]} caller={c.group[1]} at_mm00_30="
                    f"{pr.share_text(c, 'throws')}")
            throw_lines.append(f"  {line}")
            print(f"  evidence {line}")
        if not throws:
            print("  evidence throws: none in window")
    except Exception as e:  # noqa: BLE001
        print(f"  evidence throws unavailable — {type(e).__name__}: {str(e)[:120]}")
    err_unknown = "unavailable"
    try:
        eu = pr.counts_for(pr.measure(run_sql, err_unknown_spec()), (), "ERR_UNKNOWN")
        err_unknown = pr.share_text(eu, "calls")
        metrics["err_unknown"] = {"n": eu.numerator, "den": eu.denominator}
        print(f"  evidence err_unknown={err_unknown}")
    except Exception as e:  # noqa: BLE001
        print(f"  evidence err_unknown unavailable — {type(e).__name__}: {str(e)[:120]}")
    causes: list[str] = []
    try:
        ev_rows = parse_rows(run_sql(build_refusal_evidence_sql()), 3)
        causes = cause_lines(ev_rows)
        metrics["refusal_evidence"] = [{"exchange": ex, "verdict": v, "n": int(n)}
                                       for ex, v, n in ev_rows[:EVIDENCE_TOP_N]]
        for line in causes:
            print(f"  evidence {line.strip()}")
    except Exception as e:  # noqa: BLE001
        print(f"  evidence refusals unavailable — {type(e).__name__}: {str(e)[:120]}")

    paid = verdicts[PAID_SLICE]
    metrics["reason"] = paid.reason
    print(f"  reason={paid.reason}")
    if paid.verdict == "FAIL":
        metrics["paged_slices"] = [PAID_SLICE]
        fire(build_body(paid, label, causes, throw_lines, err_unknown, other_lines))
    elif paid.verdict == "PASS":
        clear()
    return _finish(paid.verdict, metrics)


def observability_gate() -> int:
    """Are NEW `get_market_regime` rows carrying the instrument at all? (MCP and x402 rows alike.)"""
    try:
        rows = parse_rows(run_sql(build_gate_sql(GATE_WINDOW_MINUTES)), 3)
    except Exception as e:  # noqa: BLE001
        print(f"  gate INDETERMINATE — {type(e).__name__}: {str(e)[:160]}")
        print(f"{TOKEN}=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    total, with_verdict, with_regime = (int(x) for x in rows[0])
    print(f"  new rows (last {GATE_WINDOW_MINUTES}min): {total} · non-NULL verdict: {with_verdict} · "
          f"non-NULL regime: {with_regime}")
    if total == 0:
        print("  zero new rows — cannot distinguish a live instrument from a dead one")
        print(f"{TOKEN}=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]
    if with_verdict < total:
        print(f"  {total - with_verdict} of {total} new rows still carry a NULL verdict")
        print(f"{TOKEN}=FAIL")
        return EXIT_FOR["FAIL"]
    # `regime` is deliberately NOT required: the error arm writes `regime: null` by design.
    print(f"{TOKEN}=PASS")
    return EXIT_FOR["PASS"]


def _sibling_wave_templates(directory: str) -> dict:
    """Every `OPS-…-W{NEXT}` Action template emitted by another file in this directory."""
    import re
    found: dict = {}
    pat = re.compile(r"(OPS-[A-Z0-9-]+-W\{NEXT\})")
    for name in sorted(os.listdir(directory)):
        full = os.path.join(directory, name)
        if name == os.path.basename(__file__) or not name.endswith((".py", ".sh")) or not os.path.isfile(full):
            continue
        try:
            with open(full, encoding="utf-8", errors="replace") as fh:
                for w in pat.findall(fh.read()):
                    found.setdefault(w, set()).add(name)
        except OSError:
            continue
    return found


def self_test() -> int:
    failures: list[str] = []
    passed = 0

    def check_one(name: str, fn) -> None:
        nonlocal passed
        try:
            ok = bool(fn())
        except Exception as e:  # noqa: BLE001
            ok = False
            name = f"{name} [raised {type(e).__name__}: {str(e)[:80]}]"
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        if ok:
            passed += 1
        else:
            failures.append(name)

    if pr is None:
        print(f"  SELF-TEST: INDETERMINATE — population_rate unavailable ({_RATE_IMPORT_ERROR[:120]})")
        print(f"{TOKEN}=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    # ── exit-code mapping (a sibling once re-coded INDETERMINATE to 0 and stayed green).
    check_one("PASS maps to 0", lambda: EXIT_FOR["PASS"] == 0)
    check_one("FAIL maps to 1", lambda: EXIT_FOR["FAIL"] == 1)
    check_one("INDETERMINATE maps to 3", lambda: EXIT_FOR["INDETERMINATE"] == 3)

    # ── THE PAGE POPULATION, asserted by shape through the ONE builder.
    spec = slice_spec(24)
    sql = pr.build_sql(spec.table, spec.population_where, spec.event_where, spec.group_by, spec.window_where)
    check_one("the page rate is ONE statement over request_log", lambda: sql.count("FROM ") == 1
              and "FROM request_log" in sql)
    check_one("the population is the tool's own calls", lambda: "tool_name='get_market_regime'" in sql)
    check_one("the event is exactly the budget-attributable verdicts",
              lambda: all(f"'{v}'" in spec.event_where for v in EVENT_VERDICTS)
              and "ERR_UNKNOWN" not in spec.event_where)
    check_one("every paid tier is in the slice expression", lambda: all(f"'{t}'" in slice_expr() for t in PAID_TIERS))
    check_one("x402 is paid even though it is not a Stripe plan", lambda: "x402" in PAID_TIERS)
    check_one("the page population carries no caller and no venue predicate — it is not the throw table",
              lambda: "rate_limit_events" not in sql and "caller" not in sql)
    tsql = pr.build_sql(*(lambda s: (s.table, s.population_where, s.event_where, s.group_by, s.window_where))(throws_spec(24)))
    check_one("throw evidence is a share of THROWS among throws — never divided by calls",
              lambda: "FROM rate_limit_events" in tsql and "request_log" not in tsql)
    check_one("the page SQL has no % format token", lambda: "%" not in sql)

    # ── evaluate through the module: the regression shapes (F1 / F2) at the pure level.
    f1 = pr.evaluate(pr.counts_for(pr.parse_counts("paid|0|2800\n", spec), ("paid",), "x"), MAX_REFUSALS_PER_100, 2030)
    f2 = pr.evaluate(pr.counts_for(pr.parse_counts("paid|60|1000\n", spec), ("paid",), "x"), MAX_REFUSALS_PER_100, 2030)
    check_one("F1 shape: 0 paid refusals on 2,800 paid calls PASSes", lambda: f1.verdict == "PASS")
    check_one("F2 shape: 60 refusals on 1,000 paid calls FAILs below the floor", lambda: f2.verdict == "FAIL")
    absent = pr.evaluate(pr.counts_for([], ("paid",), "x"), MAX_REFUSALS_PER_100, 2030)
    check_one("an absent paid row is an empty population, not a pass",
              lambda: (absent.verdict, absent.reason) == ("INDETERMINATE", "empty_population"))

    # ── paid verification rule, both directions.
    check_one("closed hatch + tagged within paying → verified",
              lambda: classify_verification(None, 1, 7, 0)["status"] == "verified")
    check_one("open dev-key hatch → unverified",
              lambda: classify_verification("true", 1, 7, 0)["status"].startswith("unverified"))
    check_one("tagged > 2x paying → unverified + operator_dev_key",
              lambda: classify_verification(None, 15, 7, 0).get("instrumentation_artifact") == "operator_dev_key")
    check_one("tagged > paying + 10 → unverified",
              lambda: classify_verification(None, 30, 19, 0)["status"].startswith("unverified"))
    check_one("x402 payers count as paying", lambda: classify_verification(None, 3, 1, 1)["status"] == "verified")
    check_one("the label says PAID only when verified",
              lambda: paid_label({"status": "verified"}) == "PAID"
              and paid_label({"status": "unknown:x"}) == "paid-tagged (unverified)")

    # ── the body: evidence values only, causes grouped by LEG.
    causes = cause_lines([["BINANCE", "DEGRADED_FUNDING_BUDGET", "5"], ["HL", "ERR_UPSTREAM_RATE_LIMIT", "3"]])
    check_one("the funding leg is attributed to Hyperliquid, not to the requested exchange",
              lambda: causes[0].startswith("  Hyperliquid funding leg") and "requested on: BINANCE 5" in causes[0])
    check_one("the candles leg names the refusing venue", lambda: "refusing venue: HL 3" in causes[1])
    body = build_body(f2, "PAID", causes, ["  venue=Hyperliquid caller=scan_trade_calls at_mm00_30=150 of 150 throws (100.00%)"],
                      "0 of 1000 calls (0.00%)", ["  internal: 0 of 1087 calls (0.00%) → PASS (within_tolerance)"])
    check_one("the body carries the paid share through the bounded fraction", lambda: "60 of 1000 calls" in body)
    check_one("the body ends on the templated Action line", lambda: body.rstrip().endswith(f"Action: dispatch {RECOMMENDED_WAVE}"))
    check_one("the body carries no mechanism prose", lambda: "ON PURPOSE" not in body and "normalised" not in body)

    # ── the recommended wave: templated, and distinct from every sibling alert's wave.
    check_one("the recommended wave is templated (no literal wave number)",
              lambda: RECOMMENDED_WAVE.startswith("OPS-") and RECOMMENDED_WAVE.endswith("-W{NEXT}"))
    check_one("the overridden wave is gone", lambda: RECOMMENDED_WAVE != "OPS-HL-INTERACTIVE-STARVATION-W{NEXT}")
    siblings = _sibling_wave_templates(_HERE)
    if not siblings:
        print("  SELF-TEST: INDETERMINATE — no sibling Action templates found, so distinctness is unprovable here")
        print(f"{TOKEN}=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]
    check_one(f"the recommended wave is distinct from {len(siblings)} sibling templates",
              lambda: RECOMMENDED_WAVE not in siblings)

    # ── the bypassed artifacts: parsers.
    check_one("parser accepts a 3-field row", lambda: parse_rows("HL|ERR_UPSTREAM_RATE_LIMIT|3\n", 3) == [["HL", "ERR_UPSTREAM_RATE_LIMIT", "3"]])

    def rejects_short_row() -> bool:
        try:
            parse_rows("HL|3\n", 3)
            return False
        except ValueError:
            return True
    check_one("parser REFUSES a short row rather than reading a wrong column", rejects_short_row)
    gate_sql = build_gate_sql(360)
    check_one("gate SQL bounds in MINUTES", lambda: "minutes" in gate_sql and "hours" not in gate_sql)

    if failures:
        print(f"SELF-TEST: FAIL ({len(failures)})")
        print(f"{TOKEN}=FAIL")
        return EXIT_FOR["FAIL"]
    print(f"SELF-TEST: PASS ({passed} assertions, non-vacuous)")
    print(f"{TOKEN}=PASS")
    return EXIT_FOR["PASS"]


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--observability-gate" in argv:
        return observability_gate()
    return check()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
