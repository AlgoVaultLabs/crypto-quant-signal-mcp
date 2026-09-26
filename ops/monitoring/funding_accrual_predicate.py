"""
OPS-BDIR-V3-PANEL-READINESS-W1 CH1 — the funding-accrual PREDICATE (pure, stdlib only).

Canonical home of the decision the funding-accrual canary makes. It is a SHARED PRIMITIVE:
`funding-accrual-freshness.py` (signal-1) imports it, and CH3's BDIR panel-readiness job on aoe-1
runs a vendored copy (sha-pinned) to derive its `fr=` field — so there is exactly ONE derivation
of "is this venue's funding accruing", never two that can drift. It performs no I/O: the caller
runs the SQL this module builds and hands back the rows.

WHAT IT MEASURES — the PRODUCER, not a rendered artifact: `funding_rates_hist`, written by
`backfill-funding-episodes.js raw --since-checkpoint` (nightly 02:23 AND the AOE hourly top-up at
:07). OKX rows there trailed real time by ~60 days from the 2026-07-05 seed until this wave, and
nothing paged, because nothing read the table.

THE THREE ARMS, per venue (thresholds ratified by the architect, 2026-09-26, Q-E):
  * AGE      — the venue's newest print is at most AGE_INTERVALS funding intervals old.
  * COVERAGE — of the venue's LIVE OI top-60 (the latest `oi_snapshots` bucket, an INDEPENDENT
               producer and the B-DIR K population), >= 80 % have printed within 14 days.
  * SHARE    — of those covered symbols, >= 90 % printed within the last AGE_INTERVALS intervals.
Why the OI top-60 and not "symbols that printed recently": a denominator built from the producer's
own output shrinks with it — measured 2026-09-26, "printed within 14 d" would have read OKX as 0/1
while the OI sampler listed 60 live OKX coins. The coverage floor is what catches a venue that
silently loses symbols; 80 % sits below the measured healthy 58–60/60 (and 57/60 KuCoin) so an
ordinary manifest wobble is not a page, and above the ~50 % at which half a venue could vanish.

ASTER is on the AGE arm only (declared, with its reason below): its funding manifest is bounded by
a >= $5M liquidity floor (14 symbols on 2026-09-26) while its OI top-60 is not liquidity-ranked, so
coverage there measures the manifest's design, not the producer's health.

VERDICTS: PASS | FAIL | INDETERMINATE. A check that could not run is INDETERMINATE, never PASS.
"""
from __future__ import annotations

# ── The venue set, parity-pinned to src/lib/funding-venues.ts FUNDING_VENUE_META by
#    tests/unit/funding-accrual-canary.test.ts. Interval = the venue's funding interval in hours.
FUNDING_VENUES: dict[str, int] = {
    "HL": 1,
    "BINANCE": 8,
    "BYBIT": 8,
    "GATE": 8,
    "KUCOIN": 8,
    "ASTER": 8,
    "OKX": 8,
}

# Declared exemptions from the coverage + share arms, each with its reason (never a bare list).
SHARE_ARM_EXEMPT: dict[str, str] = {
    "ASTER": (
        "funding manifest is liquidity-bound (>= $5M, 14 symbols on 2026-09-26) while its OI top-60 "
        "is not liquidity-ranked; coverage would measure the manifest's design, not accrual"
    ),
}

AGE_INTERVALS = 2          # "printed in the last two intervals" (spec R3)
COVERED_WINDOW_DAYS = 14   # a symbol the producer covered within this window counts as covered
COVERAGE_FLOOR = 0.80      # ruling Q-E: 80 %, not 50 %
SHARE_FLOOR = 0.90         # spec R3 / ruling Q-E: FAIL below 90 %
OI_BUCKET_MAX_AGE_H = 6    # an OI bucket older than this is not "live"; the arm is then INDETERMINATE

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
RESULT_FIELDS = ("venue", "interval_h", "age_h", "oi_top", "covered", "fresh")


def build_sql(
    venues: dict[str, int] | None = None,
    *,
    age_intervals: int = AGE_INTERVALS,
    covered_window_days: int = COVERED_WINDOW_DAYS,
    oi_bucket_max_age_h: int = OI_BUCKET_MAX_AGE_H,
) -> str:
    """ONE row per declared venue, in RESULT_FIELDS order. PURE — returned as a string so the
    caller's self-test can assert its SHAPE (a hermetic self-test is blind to SQL it never runs).

    Every venue is LEFT-joined from the declared list, so a venue with no prints at all still
    emits a row (age NULL): an absent row and a failing row must not look alike. No `%` anywhere —
    a LIKE wildcard once broke a sibling canary's %-formatting."""
    vs = venues if venues is not None else FUNDING_VENUES
    values = ", ".join(f"('{v}', {int(h)})" for v, h in vs.items())
    return (
        f"WITH v(venue, ih) AS (VALUES {values}), "
        "lb AS (SELECT exchange AS venue, max(ts) AS mts FROM oi_snapshots "
        "WHERE source IS NULL "
        f"AND ts > (extract(epoch FROM now()) * 1000)::bigint - {int(oi_bucket_max_age_h)}::bigint * 3600000 "
        "GROUP BY 1), "
        "oi AS (SELECT DISTINCT o.exchange AS venue, o.symbol FROM oi_snapshots o "
        "JOIN lb ON lb.venue = o.exchange AND o.ts = lb.mts WHERE o.source IS NULL), "
        "mx AS (SELECT venue, symbol, max(ts) AS mts FROM funding_rates_hist "
        "WHERE venue IN (SELECT venue FROM v) GROUP BY 1, 2) "
        "SELECT v.venue, v.ih, "
        "round((extract(epoch FROM now() - (SELECT max(mts) FROM mx WHERE mx.venue = v.venue)) / 3600.0)::numeric, 3), "
        "(SELECT count(*) FROM oi WHERE oi.venue = v.venue), "
        "(SELECT count(*) FROM oi JOIN mx ON mx.venue = oi.venue AND mx.symbol = oi.symbol "
        f"WHERE oi.venue = v.venue AND mx.mts > now() - interval '{int(covered_window_days)} days'), "
        "(SELECT count(*) FROM oi JOIN mx ON mx.venue = oi.venue AND mx.symbol = oi.symbol "
        f"WHERE oi.venue = v.venue AND mx.mts > now() - interval '{int(covered_window_days)} days' "
        f"AND mx.mts >= now() - make_interval(hours => {int(age_intervals)} * v.ih)) "
        "FROM v ORDER BY v.venue;"
    )


def parse_rows(raw: str) -> list[dict]:
    """psql `-tA -F'|'` output → one dict per venue. Raises ValueError on any malformed row: input
    we were HANDED and could not PARSE is INDETERMINATE for the caller, never a silent skip."""
    rows: list[dict] = []
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) != len(RESULT_FIELDS):
            raise ValueError(f"expected {len(RESULT_FIELDS)} fields, got {len(parts)}: {line[:80]!r}")
        venue, ih, age, oi_top, covered, fresh = parts
        rows.append({
            "venue": venue,
            "interval_h": int(ih),
            "age_h": None if age == "" else float(age),
            "oi_top": int(oi_top),
            "covered": int(covered),
            "fresh": int(fresh),
        })
    return rows


def evaluate_venue(row: dict) -> tuple[str, dict]:
    """The whole per-venue decision, PURE. Returns (verdict, arms) where `arms` maps each arm to
    its own verdict plus the measured value, so a caller can render POSITIVE per-check output.

    ORDER-INDEPENDENT by construction: every arm is computed, then the worst wins."""
    venue, ih = row["venue"], row["interval_h"]
    limit_h = AGE_INTERVALS * ih
    arms: dict[str, dict] = {}

    age = row["age_h"]
    if age is None:
        # The declared venue has NO print at all: the producer never wrote it. That is a measured
        # fact about the producer (FAIL), not an unreadable input (INDETERMINATE).
        arms["age"] = {"verdict": "FAIL", "age_h": None, "limit_h": limit_h}
    else:
        arms["age"] = {"verdict": "PASS" if age <= limit_h else "FAIL", "age_h": age, "limit_h": limit_h}

    if venue in SHARE_ARM_EXEMPT:
        arms["coverage"] = {"verdict": "EXEMPT", "reason": SHARE_ARM_EXEMPT[venue]}
        arms["share"] = {"verdict": "EXEMPT"}
    else:
        oi_top, covered, fresh = row["oi_top"], row["covered"], row["fresh"]
        if oi_top <= 0:
            # the independent denominator is unavailable (OI sampler silent for this venue) — the
            # arm cannot be evaluated, which is never a pass
            arms["coverage"] = {"verdict": "INDETERMINATE", "oi_top": 0, "covered": covered}
            arms["share"] = {"verdict": "INDETERMINATE", "covered": covered, "fresh": fresh}
        else:
            coverage = covered / oi_top
            arms["coverage"] = {"verdict": "PASS" if coverage >= COVERAGE_FLOOR else "FAIL",
                                "oi_top": oi_top, "covered": covered, "ratio": round(coverage, 4)}
            if covered <= 0:
                # nothing covered: the coverage arm has already failed; a share of zero symbols is
                # undefined, and reporting it as a number would double-count one fact
                arms["share"] = {"verdict": "FAIL", "covered": 0, "fresh": fresh, "ratio": None}
            else:
                share = fresh / covered
                arms["share"] = {"verdict": "PASS" if share >= SHARE_FLOOR else "FAIL",
                                 "covered": covered, "fresh": fresh, "ratio": round(share, 4)}

    verdict = worst([a["verdict"] for a in arms.values() if a["verdict"] != "EXEMPT"])
    return verdict, arms


def worst(verdicts: list[str]) -> str:
    """FAIL > INDETERMINATE > PASS. An EMPTY list is INDETERMINATE — a vacuous set never passes."""
    if "FAIL" in verdicts:
        return "FAIL"
    if "INDETERMINATE" in verdicts or not verdicts:
        return "INDETERMINATE"
    return "PASS"


def evaluate_all(rows: list[dict], venues: dict[str, int] | None = None) -> tuple[str, dict[str, tuple[str, dict]]]:
    """Every DECLARED venue must come back exactly once. A missing declared venue is
    INDETERMINATE (we built the venue list, so its absence is a defect in the query, not a fact);
    an undeclared one is ignored, never silently counted."""
    vs = venues if venues is not None else FUNDING_VENUES
    by_venue = {r["venue"]: r for r in rows}
    out: dict[str, tuple[str, dict]] = {}
    for v in vs:
        if v not in by_venue:
            out[v] = ("INDETERMINATE", {"missing": {"verdict": "INDETERMINATE"}})
        else:
            out[v] = evaluate_venue(by_venue[v])
    return worst([verdict for verdict, _ in out.values()]), out
