#!/usr/bin/env python3
"""
book-liveness-canary.py — OPS-PFE-METRIC-INTEGRITY-W1 R8 recurrence guard.

Watches TWO things that must not silently drift after the emit-time book-liveness gate ships:

  1. FROZEN-ROW RATE (the defect itself).  Newly emitted signals landing in the S2 state
     (`pfe_candles = 0 AND mae_return_pct = 0` — price did not move in EITHER direction, i.e.
     a shut book) should trend toward ZERO once the gate is enforcing. A per-venue rise means
     the gate regressed, its pin drifted, or a new venue started serving synthetic flat bars.

  2. SUPPRESSION RATE (the gate's own blast radius).  A venue suppressing far above its
     measured baseline indicates a PARSE DEFECT — an adapter returning a string/null volume
     that reads as "not traded" — not a genuinely frozen book. That is the failure mode that
     would silently strangle a healthy venue, so it pages.

PER-VENUE CEILINGS, NOT A GLOBAL ONE (operator ruling Q8, 2026-07-19): ASTER's steady state is
~27% by design, so one fleet-wide ceiling would either be useless or page constantly.

CONTRACT (CLAUDE.md ## Automation-first recovery):
  - Operator-action-required only. Delegates ALL gating to send_telegram.sh — cooldown,
    severity, DRY_RUN_TG. This script MUST NOT re-implement any of them inline.
  - Fail-open: every error path exits 0. A broken canary must never look like a healthy system,
    but it also must never break a cron chain.
  - `recommended_wave` uses the TEMPLATE form OPS-<CLASS>-W{NEXT}; a literal W3 is HALT-class.
    send_telegram.sh resolves it at send time from status.md.
"""
import os
import subprocess
import sys
from datetime import datetime, timezone

PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
PG_DB = "signal_performance"
TG = "/opt/algovault-monitoring/send_telegram.sh"

# ── Per-venue ceilings (ruling Q8). Set from the R3/R4 measured baselines; every entry carries
#    a revisit date so a defensive threshold cannot become permanent by inertia.
#    TODO: revisit by 2026-08-03 — re-derive from >=14d of live emit_suppressions data, and
#    record the revision in defensive-reductions-to-revisit.md.
SUPPRESSION_CEILING_PCT = {
    "ASTER": 40.0,   # measured steady state ~27% at k=12/N=24; headroom for mix drift
    "_DEFAULT": 5.0, # every healthy venue measured EXACTLY 0.0% at k=12/N=24
}

# ── PRE-GATE BASELINES + headroom. These tolerate the defect the gate exists to remove, so
#    they are only correct while the gate is OFF or in shadow.
#
#    ⚠️ RATCHET REQUIRED AT ENFORCE. Once EMIT_BOOK_LIVENESS_MODE=enforce, newly emitted rows
#    should stop landing in S2 almost entirely, and these ceilings MUST be ratcheted down to
#    ~1% fleet-wide. Leaving them at the pre-gate baseline would mean the canary silently
#    tolerates a fully regressed gate — a defensive threshold that survives its own reason is
#    theatre (CLAUDE.md ## Defensive-threshold hygiene). The ratchet is a checklist item in
#    docs/RUNBOOK-BOOK-LIVENESS-FLIP.md stage 3.
#
#    Measured 2026-07-21, per-venue frozen rate on evaluated rows:
#      ASTER  8.35% (3d) / 6.20% (14d)   <- the dominant frozen venue
#      HTX    0.00% (3d) / 4.98% (14d)   <- episodic: a pre-delisting halt cohort, now clear
#      XT     0.00% (3d) / 0.15% (14d)
#      GATE   0.00% (3d) / 0.02% (14d)
#      every other venue: EXACTLY 0.00% on both windows
FROZEN_CEILING_PCT = {
    "ASTER": 12.0,   # baseline 8.35% (3d) — headroom for the mix drift of a growing venue
    "HTX": 6.0,      # baseline 4.98% (14d), episodic halts; 0.00% currently
    "EDGEX": 4.0,    # measured 1.94% all-time
    "XT": 2.0,       # baseline 0.15%
    "_DEFAULT": 1.0, # 12 of 16 venues sit at exactly 0.00%
}

LOOKBACK_DAYS = 3
MIN_DENOM = 200   # below this a percentage is noise, not a signal


def psql(sql: str) -> list[list[str]]:
    """Read-only query via psql -tA. Returns [] on ANY failure (fail-open)."""
    try:
        out = subprocess.run(
            ["docker", "exec", PG_CONTAINER, "psql", "-U", "algovault", "-d", PG_DB,
             "-tA", "-F", "|", "-c", sql],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout.strip()
        return [ln.split("|") for ln in out.split("\n") if ln]
    except Exception as e:  # noqa: BLE001 — fail-open is the contract
        print(f"[book-liveness-canary] query failed (fail-open): {e}", file=sys.stderr)
        return []


def ceiling(table: dict, venue: str) -> float:
    return table.get(venue, table["_DEFAULT"])


def main() -> int:
    breaches: list[str] = []
    info: list[str] = []

    # ── 1. frozen-row rate on RECENTLY EMITTED, already-evaluated signals ──
    frozen = psql(f"""
        SELECT exchange,
               COUNT(*) FILTER (WHERE pfe_candles IS NOT NULL) AS n_eval,
               COUNT(*) FILTER (WHERE pfe_candles = 0 AND mae_return_pct = 0) AS n_frozen
        FROM signals
        WHERE signal IN ('BUY','SELL')
          AND created_at >= EXTRACT(EPOCH FROM NOW())::bigint - {LOOKBACK_DAYS}*86400
        GROUP BY 1 ORDER BY 1;
    """)
    for row in frozen:
        if len(row) < 3:
            continue
        venue, n_eval, n_frozen = row[0], int(row[1] or 0), int(row[2] or 0)
        if n_eval < MIN_DENOM:
            continue
        pct = 100.0 * n_frozen / n_eval
        cap = ceiling(FROZEN_CEILING_PCT, venue)
        line = f"{venue}: {pct:.2f}% frozen ({n_frozen}/{n_eval}), ceiling {cap:.1f}%"
        (breaches if pct > cap else info).append(line)

    # ── 2. suppression rate = suppressions / (suppressions + emitted) ──
    supp = psql(f"""
        WITH s AS (
          SELECT exchange, SUM(suppress_count)::bigint AS suppressed
          FROM emit_suppressions
          WHERE date >= (NOW() - INTERVAL '{LOOKBACK_DAYS} days')::date
          GROUP BY 1
        ), e AS (
          SELECT exchange, COUNT(*)::bigint AS emitted
          FROM signals
          WHERE signal IN ('BUY','SELL')
            AND created_at >= EXTRACT(EPOCH FROM NOW())::bigint - {LOOKBACK_DAYS}*86400
          GROUP BY 1
        )
        SELECT COALESCE(s.exchange, e.exchange),
               COALESCE(s.suppressed, 0), COALESCE(e.emitted, 0)
        FROM s FULL OUTER JOIN e ON s.exchange = e.exchange
        ORDER BY 1;
    """)
    for row in supp:
        if len(row) < 3:
            continue
        venue, suppressed, emitted = row[0], int(row[1] or 0), int(row[2] or 0)
        denom = suppressed + emitted
        if denom < MIN_DENOM:
            continue
        pct = 100.0 * suppressed / denom
        cap = ceiling(SUPPRESSION_CEILING_PCT, venue)
        line = f"{venue}: {pct:.2f}% suppressed ({suppressed}/{denom}), ceiling {cap:.1f}%"
        (breaches if pct > cap else info).append(line)

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if not breaches:
        # Silent success. Forensics go to logs, never to the alert channel.
        print(f"[book-liveness-canary] {stamp} OK — {len(info)} venue-metrics within ceilings")
        for ln in info:
            print(f"  {ln}")
        return 0

    body = "\n".join([
        "🧊 Book-liveness canary: per-venue ceiling breached",
        "",
        f"Window: last {LOOKBACK_DAYS}d · checked {stamp}",
        "",
        "BREACHED:",
        *[f"  • {b}" for b in breaches],
        "",
        "Read this as:",
        "  • frozen-rate up   → the emit gate regressed, its pin drifted, or a NEW venue",
        "                       started serving zero-volume synthetic bars.",
        "  • suppression up   → likely an ADAPTER PARSE DEFECT (volume read as string/null),",
        "                       NOT a genuinely frozen book. Check the adapter before the pin.",
        "",
        "Rollback is one env key (behaviour returns to legacy, byte-identical):",
        "  EMIT_BOOK_LIVENESS_ENABLED=0 && docker compose up -d mcp-server",
        "",
        "Runbook: docs/RUNBOOK-BOOK-LIVENESS-FLIP.md",
        "recommended_wave: OPS-BOOK-LIVENESS-W{NEXT}",
    ])

    try:
        subprocess.run([TG, "book_liveness_ceiling", "CRITICAL_PERSISTENT", "-"],
                       input=body, text=True, timeout=30, check=False)
    except Exception as e:  # noqa: BLE001
        print(f"[book-liveness-canary] TG dispatch failed (fail-open): {e}", file=sys.stderr)

    print(body)
    return 0   # fail-open: a breach is reported, not raised as a cron failure


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — the canary must never break its cron chain
        print(f"[book-liveness-canary] FATAL (fail-open): {e}", file=sys.stderr)
        sys.exit(0)
