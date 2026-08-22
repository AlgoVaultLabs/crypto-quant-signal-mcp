#!/usr/bin/env python3
"""labeler_truncation_attribution.py — OPS-DEPLOY-LABELER-WINDOW-W1 CH1.

COUNTS WHAT THE DEPLOY POLICY COSTS, BECAUSE NOTHING DID.

`.github/workflows/deploy.yml:892` SIGTERMs any in-flight nightly labeler before
`docker compose up`. That is DELIBERATE, shipped by OPS-LABEL-FRESHNESS-W1 R2, and named in
`src/lib/graceful-stop.ts`'s own docstring. It is not collateral damage and it is not a race.

The defect was never that truncation happens. THE DEFECT IS THAT NOBODY KNEW WHAT THE POLICY
COST — 10 of 29 runs (34%) ended early for weeks and nothing counted it, so it was found only
because an unrelated capacity triage went looking. A degradation made SAFE without being made
VISIBLE runs until something else trips over it.

WHAT THIS IS NOT: a page. Truncation is safe (the graceful-stop handler checkpoints at a
venue/group boundary) and self-healing (`orderVenuesBySloDeadline` sorts a missed venue first the
next night; measured label completeness at age 3-30d is BINANCE/BITGET/BYBIT 100.0%). So this is
DIGEST-ONLY. Recovery chatter is noise; one bounded resolution per DELIVERED page is signal, and
this is not a page.

ATTRIBUTION, NOT GUESSWORK. A truncation is attributed to a deploy only when an mcp-server
container start follows its run inside a bounded window — the journal records those durably
(retention reaches 2026-07-19, before the earliest truncation). Anything else is labelled
`unattributable`, never assigned to a deploy on suspicion. The prior wave's "10/10 within ~90s of
an SSH login" was published with no base rate and is exactly the mistake this avoids.

Verdict contract: exactly one terminal DETECTOR_ENVELOPE, consumed AS SHIPPED by
OPS-MONITORING-SIGNAL-CONTRACT-W1 — this is its SECOND adopter. A truncated night has
`run_outcome: stopped`, which the schema calls non-conclusive, so the verdict is FORCED to
INDETERMINATE. A truncated run therefore CANNOT render as a capacity finding, which is the exact
defect that contract exists to prevent.

Exit: 0 = PASS or FAIL (evaluated) · 3 = INDETERMINATE (verified nothing).
Callers gate on the TOKEN, never the code.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import detector_envelope as de  # noqa: E402  (host-local sibling; see the inventory row)

LOG_PATH = os.environ.get("LTA_LABELER_LOG", "/var/log/carry-labeler.log")
CONTAINER = os.environ.get("LTA_CONTAINER", "crypto-quant-signal-mcp-mcp-server-1")
WINDOW_DAYS = int(os.environ.get("LTA_WINDOW_DAYS", "30"))
"""How long after a truncated run's end a container start still counts as its cause.

Sized from the MEASURED 2026-08-22 sequence, the only one reconstructed end to end: SIGTERM at
~03:19:3x, labeler DONE 03:20:01, mcp-server stopped 03:20:17, container start 03:20:24 — 22.8s
from DONE. 15 minutes is generous against that and still far tighter than the ~24h gap between
nightly runs, so it cannot bridge two different nights. Recorded with its instrument, not chosen
as a round number.
"""
ATTRIB_WINDOW_S = int(os.environ.get("LTA_ATTRIB_WINDOW_S", "900"))

RUN_START = re.compile(r"^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] DWR backfill start .*?over (\d+) venues")
RUN_DONE = re.compile(r"^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] DONE \{")
VENUE_SUMMARY = re.compile(r"^\[venue-summary\] (\w+):")
BUDGET = re.compile(r"budget=(\d+)m")


def _iso(ts: str):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def parse_runs(text: str) -> list:
    """Every nightly run in the log, with whether it was TRUNCATED and by how much.

    A run is truncated iff the graceful-stop handler fired — that string is reachable only from
    SIGTERM/SIGINT (`graceful-stop.ts`), so it is a signal, not an inference.
    """
    lines = text.split("\n")
    starts = [i for i, l in enumerate(lines) if "DWR backfill start" in l]
    runs = []
    for n, s in enumerate(starts):
        e = starts[n + 1] if n + 1 < len(starts) else len(lines)
        seg = lines[s:e]
        m = RUN_START.match(seg[0])
        if not m:
            continue
        bm = BUDGET.search(seg[0])
        done = next((RUN_DONE.match(l).group(1) for l in seg if RUN_DONE.match(l)), None)
        venues = sorted({VENUE_SUMMARY.match(l).group(1) for l in seg if VENUE_SUMMARY.match(l)})
        runs.append({
            "started_at": m.group(1),
            "done_at": done,
            "venues_total": int(m.group(2)),
            "venues_reached": len(venues),
            "budget_min": int(bm.group(1)) if bm else None,
            "truncated": any("stop requested (SIGTERM)" in l for l in seg),
            "checkpointed": any("checkpointed at the" in l for l in seg),
        })
    return runs


def container_starts(since: str, journal_cmd=None) -> list:
    """Timestamps at which the mcp-server container joined the network — i.e. started.

    Read from the journal rather than `docker inspect`, which only knows the CURRENT container
    and would therefore be structurally blind to every historical recreate.
    """
    cmd = journal_cmd or ["journalctl", "-u", "docker", "--since", since, "--no-pager", "-o", "short-iso"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout
    except Exception:
        return []
    seen = []
    for l in out.split("\n"):
        if f"ep={CONTAINER}" not in l:
            continue
        m = re.match(r"^(\d{4}-\d\d-\d\dT[\d:]+[+-]\d\d:\d\d)", l)
        if m:
            seen.append(m.group(1))
    return sorted(set(seen))


def attribute(run: dict, starts: list, window_s: int = ATTRIB_WINDOW_S, coverage_since=None) -> dict:
    """Attribute one truncated run, or decline to.

    `unattributable` is a real answer and is never upgraded to a guess. Its two causes are kept
    DISTINCT because they mean opposite things: `no-recreate` says we looked and the truncation
    was something else; `no-journal` says we could not look at all.

    `coverage_since` is the journal window actually queried — NOT the first container start. The
    first version of this function used `starts[0]` as the coverage floor, which inverted the
    logic: a container start AFTER the run end is precisely what attribution looks for, so every
    genuine attribution was rejected as "predates coverage". Caught by the self-test.
    """
    if not run["truncated"]:
        return {"cause": "not-truncated", "at": None, "delta_s": None}
    end = _iso(run["done_at"] or run["started_at"])
    if coverage_since is not None and end < _iso(coverage_since):
        return {"cause": "unattributable-no-journal", "at": None, "delta_s": None}
    if not starts:
        return {"cause": "unattributable-no-journal", "at": None, "delta_s": None}
    for s in starts:
        st = _iso(s.replace("+00:00", "Z"))
        delta = (st - end).total_seconds()
        if 0 <= delta <= window_s:
            return {"cause": "deploy-preemption", "at": s, "delta_s": int(delta)}
    return {"cause": "unattributable-no-recreate", "at": None, "delta_s": None}


def summarise(runs: list, starts: list, window_days: int = WINDOW_DAYS) -> dict:
    """The RATE, which is the finding — a single truncated night is noise, 34% is not."""
    if not runs:
        return {"n": 0}
    cutoff = _iso(runs[-1]["started_at"]) - timedelta(days=window_days)
    win = [r for r in runs if _iso(r["started_at"]) >= cutoff]
    trunc = [r for r in win if r["truncated"]]
    attributed = [r for r in trunc if attribute(r, starts)["cause"] == "deploy-preemption"]
    return {
        "n": len(win),
        "truncated": len(trunc),
        "truncation_rate_pct": round(100.0 * len(trunc) / len(win), 1) if win else 0.0,
        "attributed_to_deploy": len(attributed),
        "attributed_share_pct": round(100.0 * len(attributed) / len(trunc), 1) if trunc else 0.0,
        "window_days": window_days,
        "first_run": win[0]["started_at"][:10],
        "last_run": win[-1]["started_at"][:10],
    }


def build(runs: list, starts: list, now_iso: str, window_days: int = WINDOW_DAYS) -> dict:
    """The DETECTOR_ENVELOPE for the most recent run, plus the rolling rate as evidence."""
    schema = de.load_schema()
    last = runs[-1]
    s = summarise(runs, starts, window_days)
    att = attribute(last, starts)
    outcome = "stopped" if last["truncated"] else "complete"
    return {
        "schema_version": schema["schema_version"],
        "detector": "labeler-truncation-attribution",
        # `stopped` is non-conclusive, so the contract FORCES INDETERMINATE here. A truncated
        # night can never render as a capacity finding — asserted, not merely intended.
        "verdict": "INDETERMINATE" if last["truncated"] else "PASS",
        "run_id": f"dwr-{last['started_at']}",
        "run_started_at": last["started_at"],
        "run_outcome": outcome,
        "produced_at": now_iso,
        "observation_window": {"from": last["started_at"], "to": last["done_at"] or now_iso},
        "evidence": {
            "venues_reached": last["venues_reached"],
            "venues_total": last["venues_total"],
            "budget_min": last["budget_min"],
            "checkpointed": last["checkpointed"],
            # STRUCTURED, never a sentence. The first version put a prose string here and the
            # contract REFUSED the envelope (8 words vs max_prose_words 7) — the schema catching
            # its own second adopter doing the thing it was written to prevent.
            "attributed_cause": att["cause"],
            "attributed_container_start_at": att["at"] or "none",
            "attribution_delta_s": att["delta_s"] if att["delta_s"] is not None else -1,
            "truncation_rate_pct": s["truncation_rate_pct"],
            "attributed_share_pct": s["attributed_share_pct"],
            "window_runs": s["n"],
            "window_days": s["window_days"],
        },
    }


def _emit(env: dict, s: dict) -> int:
    errs = de.validate(env, de.load_schema())
    if errs:
        # Refusing to emit a signal we would ourselves reject. One guard is how the class returns.
        print(f"labeler-truncation: REFUSING a non-conforming envelope: {'; '.join(errs[:3])}")
        print("DETECTOR_ENVELOPE_VERDICT=INDETERMINATE")
        return 3
    print(f"labeler-truncation: {s['n']} run(s) over {s['window_days']}d "
          f"({s['first_run']}..{s['last_run']}) — {s['truncated']} truncated "
          f"({s['truncation_rate_pct']}%), {s['attributed_to_deploy']} attributed to a deploy "
          f"({s['attributed_share_pct']}%)")
    print(de.render_body(env))
    print(json.dumps(env))
    print(f"DETECTOR_ENVELOPE_VERDICT={env['verdict']}")
    return 3 if env["verdict"] == "INDETERMINATE" else 0


def main(argv: list) -> int:
    try:
        text = Path(LOG_PATH).read_text(errors="replace")
    except Exception as exc:
        print(f"labeler-truncation: cannot read {LOG_PATH}: {exc}")
        print("DETECTOR_ENVELOPE_VERDICT=INDETERMINATE")
        return 3
    runs = parse_runs(text)
    # VACUITY GUARD — zero runs parsed means the PARSER broke, not that the labeler stopped
    # running. Reporting a clean rate off an empty corpus is the defect this estate keeps retiring.
    if not runs:
        print(f"labeler-truncation: parsed ZERO runs from {LOG_PATH} — the parser is broken, not the tree")
        print("DETECTOR_ENVELOPE_VERDICT=INDETERMINATE")
        return 3
    since = (_iso(runs[0]["started_at"]) - timedelta(days=1)).strftime("%Y-%m-%d")
    starts = container_starts(since)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return _emit(build(runs, starts, now), summarise(runs, starts))


def _self_test() -> int:
    fails = 0

    def ck(label, got, want):
        nonlocal fails
        ok = got == want
        if not ok:
            fails += 1
        print("  %s %s — got %r, want %r" % ("PASS" if ok else "FAIL", label, got, want))

    print("labeler-truncation-attribution --self-test")
    TRUNC = "\n".join([
        "[2026-08-22T02:33:26.139Z] DWR backfill start — 13499 groups over 17 venues (rotation: A>B) "
        "specs=[x] lookback=21d budget=210m/venue<=45m",
        "[venue-summary] EDGEX: groups 7/7 outcome=complete elapsed=0s",
        "[venue-summary] HL: groups 214/335 outcome=stopped elapsed=1819s",
        "[graceful-stop] stop requested (SIGTERM) — checkpointing at the next venue/group boundary",
        "[graceful-stop] checkpointed at the HL boundary — remaining venues resume from DB state next run",
        '[2026-08-22T03:20:01.165Z] DONE {"groups":722}',
    ])
    COMPLETE = TRUNC.replace(
        "[graceful-stop] stop requested (SIGTERM) — checkpointing at the next venue/group boundary\n", ""
    ).replace("[graceful-stop] checkpointed at the HL boundary — remaining venues resume from DB state next run\n", "")

    rt = parse_runs(TRUNC)
    rc = parse_runs(COMPLETE)
    ck("a truncated run is detected as truncated", rt[0]["truncated"], True)
    ck("a complete run is NOT detected as truncated", rc[0]["truncated"], False)
    ck("venues reached is counted from the summaries", rt[0]["venues_reached"], 2)
    ck("venues total is read from the start line", rt[0]["venues_total"], 17)
    ck("the budget is read from the start line", rt[0]["budget_min"], 210)

    STARTS = ["2026-08-22T03:20:24+00:00"]
    ck("a container start 23s after the run end ATTRIBUTES to a deploy",
       attribute(rt[0], STARTS)["cause"], "deploy-preemption")
    ck("a container start far outside the window does NOT attribute",
       attribute(rt[0], ["2026-08-22T09:00:00+00:00"])["cause"], "unattributable-no-recreate")
    ck("no journal coverage is its OWN answer, not 'no deploy'",
       attribute(rt[0], [])["cause"], "unattributable-no-journal")
    ck("a complete run is never attributed at all",
       attribute(rc[0], STARTS)["cause"], "not-truncated")

    env_t = build(rt, STARTS, "2026-08-22T09:00:00Z")
    env_c = build(rc, STARTS, "2026-08-22T09:00:00Z")
    ck("a truncated run FORCES INDETERMINATE", env_t["verdict"], "INDETERMINATE")
    ck("a truncated run can never be a capacity FAIL", env_t["verdict"] == "FAIL", False)
    ck("a complete run is PASS", env_c["verdict"], "PASS")
    ck("the truncated envelope is CONFORMING", de.validate(env_t, de.load_schema()), [])
    ck("the complete envelope is CONFORMING", de.validate(env_c, de.load_schema()), [])
    ck("the attributed cause reaches evidence", env_t["evidence"]["attributed_cause"], "deploy-preemption")
    ck("attribution evidence is MEASURED, not prose", env_t["evidence"]["attribution_delta_s"], 22)
    ck("the attributing container start is named", env_t["evidence"]["attributed_container_start_at"],
       "2026-08-22T03:20:24+00:00")
    ck("the rolling rate reaches evidence", env_t["evidence"]["truncation_rate_pct"], 100.0)
    ck("a complete run records NO truncation", env_c["evidence"]["truncation_rate_pct"], 0.0)

    if fails:
        print("SELF-TEST: %d failing check(s)" % fails)
        print("DETECTOR_ENVELOPE_VERDICT=FAIL")
        return 1
    print("DETECTOR_ENVELOPE_VERDICT=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(_self_test() if "--self-test" in sys.argv else main(sys.argv))
