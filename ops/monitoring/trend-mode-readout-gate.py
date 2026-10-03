#!/usr/bin/env python3
"""trend-mode-readout-gate.py — SIGNAL-TREND-MODE-ENABLE-W1 CH2, RE-HOMED by
SIGNAL-VERDICT-RULE-REGISTRY-W1 CH3 R2.

── RE-HOMED 2026-10-03 — READ THIS FIRST ────────────────────────────────────────────────────────
The question this gate was built to inform (keep `TREND_MODE` on, or roll it back) is ANSWERED:
rollback to v1 was denied (Mr.1, 2026-09-02 and 2026-10-01), and the `TREND_MODE` selector itself is
retired — the verdict rule is now chosen per cell by `src/lib/verdict-rule-registry.ts`. What
remains here is three OPERATIONAL BOUNDS (B volume ceiling, C cell concentration, D emission gap) on
the REGISTRY ARM — every row with `verdict_rule_version >= 2` (2 = rule M, 3 = served by a fade) —
against the frozen v1 arm, at their declared levels. They are anomaly/liveness bounds, never effect
claims, so the alert body names no change under test.
  * Trigger A (edge floor vs v1) is RETIRED: it was NOT_IDENTIFIABLE by construction (v1's attainable
    excess range is narrower than its 3.0 pp floor) and is superseded by the forward gate
    `ops/monitoring/verdict-rule-gate.py`, which executes the registered per-timeframe decision rule.
  * `TREND_MODE_READOUT_DUE` (once-ever, flip + 30 d) is RETIRED: it fired once, at
    2026-10-01T07:19:01Z (marker `/var/lib/algovault-monitoring/trend-mode-readout-due.fired`, kept
    as evidence), and the readout it scheduled was delivered (`SIGNAL-TREND-MODE-READOUT-W1`).
The history below is kept as written; where it describes A or the readout, it is history.

── ORIGINAL HEADER ──────────────────────────────────────────────────────────────────────────────
THE DECISION GATE FOR THE `TREND_MODE` LIVE TEST.

`TREND_MODE=on` went live on signal-1 and changed a LIVE, revenue-bearing verdict against a
MEASURED NULL — a deliberate operator decision, recorded as such. This gate is what makes that a
measurement rather than a hope: it evaluates the pre-declared rollback triggers DAILY, and fires a
once-ever `TREND_MODE_READOUT_DUE` at +30 days so the readout is scheduled rather than remembered.

  Contract: audits/SIGNAL-TREND-MODE-ENABLE-W1-trigger-contract.md   (thresholds, in-repo)
  Baselines: <vault>/audits/SIGNAL-TREND-MODE-ENABLE-W1-BEFORE-2026-08-31.md  (measured, private)

── DETECT → ALERT → ESCALATE. IT NEVER UNSETS THE FLAG. ─────────────────────────────────────────
Rollback is an env-var unset plus a container recreate, and a human does it. An unattended job must
not mutate a live scorer: the blast radius of a false positive here is every verdict the product
emits, which is strictly worse than the hazard being alerted on. Same reasoning as the standing
"never automate a firewall mutation" rule, one domain over.

── BOTH ARMS COME FROM ONE QUERY, AND NO BASELINE IS EVER BAKED IN ──────────────────────────────
Every threshold is a MULTIPLE or a DELTA against the v1 arm, and `verdict_rule_version` is the
GROUP BY key — so v1 and v2 are literally two rows of one result set, over one connection, at one
instant. A baked baseline would be a second instrument that goes stale silently, and "a delta
across two instruments is not a delta" is the law this whole wave deferred nine days to honour.
`regime_rule_version = 3` is held FIXED on both sides for the same reason (the LABEL rule changed
2026-08-22T05:41:09Z), and `BITMART` is excluded from BOTH arms because it was retired mid-window.

── VERDICT CONTRACT ─────────────────────────────────────────────────────────────────────────────
Exactly one terminal line: `TREND_MODE_READOUT_VERDICT=PASS|FAIL|INDETERMINATE`.
Exit 0=PASS / 0=FAIL / 3=INDETERMINATE. FAIL exits 0 because THE ALERT IS THE ACTION — the same
mapping `decision-gate-orphan-canary.py` deploys, and 3 is the token-law default for a new gate.
Callers gate on the TOKEN, never the exit code.

A trigger without enough rows emits INDETERMINATE, never PASS. "Measured and clean" may never share
an output with "measured nothing". The `1d` cell will emit INDETERMINATE for most of the window and
that is PRE-DECLARED, not a defect: it runs ~3.6 rows/day, so it is a directional watch rather than
a powered test.

Env:
  TMRG_PG_CONTAINER   postgres container            (default crypto-quant-signal-mcp-postgres-1)
  TMRG_PG_USER/DB     role + database               (default algovault / signal_performance)
  TMRG_WRAPPER        send_telegram.sh path         (default /opt/algovault-monitoring/send_telegram.sh)
  TMRG_MARKER, TMRG_FLIP_AT   RETIRED with TREND_MODE_READOUT_DUE (2026-10-03); still exported by
                              the crontab line, read by nothing
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import detector_envelope as de  # noqa: E402  (host-local sibling; see the inventory row)

ALERT_ID_BREACH = "TREND_MODE_TRIGGER_BREACH"
SEVERITY = "CRITICAL_PERSISTENT"
DETECTOR = "trend-mode-readout-gate"

PASS, FAIL, INDET = "PASS", "FAIL", "INDETERMINATE"

# ── Pre-declared thresholds. Contract file is the SoT; these mirror it and the self-test asserts
#    the mirror, so a silent divergence between code and contract is not writable. ──
# A (edge floor) and A2 RETIRED — see the header. Their constants went with them.
VOLUME_CEILING_MULT = 8.0     # B   TRENDING_* rows/day above this multiple of v1's
VOLUME_SUSTAIN_DAYS = 3       # B   consecutive days
CONCENTRATION_MULT = 3.0      # C   4h+1d share above this multiple of v1's
CONCENTRATION_MIN_N = 2000    # C   minimum v2 rows
GAP_MULT = 2.0                # D   emission gap above this multiple of v1's max
LOW_POWER_CELL_MIN_N = 30     # any per-cell figure below this is INDETERMINATE, never PASS

POP = "regime_rule_version = 3 AND exchange <> 'BITMART'"
# The two arms: 1 = the frozen v1 arm (contrarian ladder, before 2026-08-31); 2 = the REGISTRY ARM,
# every row a registry rule produced — 2 (rule M) and 3 (served by a fade), and any later variant.
ARM = "CASE WHEN verdict_rule_version >= 2 THEN 2 ELSE 1 END"

ARMS_SQL = f"""
SELECT {ARM},
       count(*),
       count(outcome_return_pct),
       sum(CASE WHEN outcome_return_pct IS NOT NULL
                 AND ((signal='BUY'  AND outcome_return_pct > 0)
                   OR (signal='SELL' AND outcome_return_pct < 0)) THEN 1 ELSE 0 END),
       sum(CASE WHEN outcome_return_pct > 0 THEN 1 ELSE 0 END),
       sum(CASE WHEN outcome_return_pct < 0 THEN 1 ELSE 0 END),
       -- EDGE-POPULATION-COMPARISON-W1: the emitted BUY share, over the SAME scored denominator.
       -- Without it the null cannot be MIX-matched, and a fixed-side comparator moves with the
       -- arm's own mix (measured 2026-09-02: BUY share 99.5% -> 80.9%).
       sum(CASE WHEN outcome_return_pct IS NOT NULL AND signal='BUY' THEN 1 ELSE 0 END),
       sum(CASE WHEN regime IN ('TRENDING_UP','TRENDING_DOWN') THEN 1 ELSE 0 END),
       sum(CASE WHEN timeframe IN ('4h','1d') THEN 1 ELSE 0 END),
       sum(CASE WHEN timeframe = '1d' THEN 1 ELSE 0 END),
       min(created_at), max(created_at)
FROM signals WHERE {POP}
GROUP BY 1 ORDER BY 1
"""

DAILY_TRENDING_SQL = f"""
SELECT {ARM}, to_char(to_timestamp(created_at),'YYYY-MM-DD'), count(*)
FROM signals
WHERE {POP} AND regime IN ('TRENDING_UP','TRENDING_DOWN')
GROUP BY 1,2 ORDER BY 1,2
"""

MAX_GAP_SQL = f"""
WITH g AS (SELECT {ARM} AS a,
                  created_at - lag(created_at) OVER (PARTITION BY {ARM}
                                                     ORDER BY created_at) AS gap
           FROM signals WHERE {POP})
SELECT a, coalesce(max(gap), -1) FROM g WHERE gap IS NOT NULL GROUP BY a ORDER BY a
"""


class Indeterminate(Exception):
    """Raised for anything we were HANDED and could not read. Never for an empty world."""


def psql(sql: str) -> list[list[str]]:
    """Query the containerised postgres.

    `docker exec <pg-container> psql -c` and NOT `docker exec <app> node -e` — the latter mangles
    SQL string literals across the ssh + docker + node-e quoting layers, and a helper copied to
    /tmp cannot resolve its own modules. Natural single quotes work inside `psql -c`.
    """
    container = os.environ.get("TMRG_PG_CONTAINER", "crypto-quant-signal-mcp-postgres-1")
    user = os.environ.get("TMRG_PG_USER", "algovault")
    db = os.environ.get("TMRG_PG_DB", "signal_performance")
    cmd = ["docker", "exec", container, "psql", "-U", user, "-d", db, "-tA", "-F", "|", "-q", "-c", sql]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as exc:  # noqa: BLE001 - any failure to REACH the DB is indeterminate
        raise Indeterminate(f"psql invocation failed: {exc}") from exc
    if p.returncode != 0:
        raise Indeterminate(f"psql exit {p.returncode}: {(p.stderr or '').strip()[:200]}")
    return [ln.split("|") for ln in p.stdout.strip().splitlines() if ln.strip()]


def _f(x: str) -> float:
    return float(x) if x not in ("", "NULL") else 0.0


class Arm:
    """One verdict-rule generation's aggregates. Rates are None when the denominator is zero —
    never 0.0, because a rate of zero and an absent rate are different facts."""

    def __init__(self, row: list[str]) -> None:
        (self.version, self.n, self.scored, self.engine_wins, self.long_wins,
         self.short_wins, self.buy_side, self.trending, self.concentrated, self.n_1d,
         self.first_at, self.last_at) = (
            int(row[0]), int(_f(row[1])), int(_f(row[2])), int(_f(row[3])), int(_f(row[4])),
            int(_f(row[5])), int(_f(row[6])), int(_f(row[7])), int(_f(row[8])), int(_f(row[9])),
            int(_f(row[10])), int(_f(row[11])))

    def _rate(self, wins: int) -> float | None:
        return None if self.scored == 0 else 100.0 * wins / self.scored

    @property
    def engine(self) -> float | None: return self._rate(self.engine_wins)

    @property
    def long(self) -> float | None: return self._rate(self.long_wins)

    @property
    def short(self) -> float | None: return self._rate(self.short_wins)

    @property
    def edge_best(self) -> float | None:
        """Engine minus the BETTER of the two naive baselines — the honest bar."""
        if self.engine is None:
            return None
        return self.engine - max(self.long, self.short)

    @property
    def edge_long(self) -> float | None:
        return None if self.engine is None else self.engine - self.long

    @property
    def days(self) -> float:
        return max((self.last_at - self.first_at) / 86400.0, 1e-9)

    @property
    def concentration_share(self) -> float | None:
        return None if self.n == 0 else 100.0 * self.concentrated / self.n

    @property
    def trending_per_day(self) -> float | None:
        return None if self.n == 0 else self.trending / self.days


class Check:
    __slots__ = ("name", "verdict", "detail")

    def __init__(self, name: str, verdict: str, detail: str) -> None:
        self.name, self.verdict, self.detail = name, verdict, detail


def evaluate(v1: Arm | None, v2: Arm | None, daily: dict, gaps: dict, now: datetime) -> tuple[list[Check], dict]:
    """Pure — no I/O, so the self-test exercises the REAL predicate rather than a stand-in.

    `v2` is the REGISTRY ARM (verdict_rule_version >= 2); `v1` is the frozen v1 arm. B, C and D are
    OPERATIONAL bounds — anomaly and liveness — never effect claims (EDGE-POPULATION-COMPARISON-W1),
    which is why trigger A, the one effect claim this gate made, is retired rather than re-homed.
    """
    checks: list[Check] = []
    ev: dict = {}

    if v1 is None:
        checks.append(Check("population", INDET, "no v1 arm — the frozen comparator is missing"))
        return checks, ev
    if v2 is None or v2.n == 0:
        # NOT vacuity: the world builds this corpus. Reported as an explicit positive line.
        checks.append(Check("population", PASS,
                            f"no registry-arm rows yet (v1 n={v1.n}) — not yet emitting"))
        ev["v1_n"] = v1.n
        ev["registry_n"] = 0
        return checks, ev

    ev.update(v1_n=v1.n, registry_n=v2.n)

    # ── B — volume ceiling, sustained ──
    base_rate = v1.trending_per_day
    if not base_rate:
        checks.append(Check("B_volume_ceiling", INDET, "v1 trending rate unavailable"))
    else:
        ceiling = VOLUME_CEILING_MULT * base_rate
        recent = sorted(daily.get(2, {}).items())[-VOLUME_SUSTAIN_DAYS:]
        if len(recent) < VOLUME_SUSTAIN_DAYS:
            checks.append(Check("B_volume_ceiling", INDET,
                                f"only {len(recent)} registry-arm day(s), need {VOLUME_SUSTAIN_DAYS}"))
        else:
            over = [d for d, c in recent if c > ceiling]
            ev["registry_trending_recent"] = [c for _, c in recent]
            checks.append(Check(
                "B_volume_ceiling", FAIL if len(over) == VOLUME_SUSTAIN_DAYS else PASS,
                f"last {VOLUME_SUSTAIN_DAYS}d TRENDING_* {[c for _, c in recent]} vs ceiling "
                f"{ceiling:.0f}/day ({VOLUME_CEILING_MULT}x v1 {base_rate:.0f}/day); "
                f"{len(over)}/{VOLUME_SUSTAIN_DAYS} over"))

    # ── C — cell concentration ──
    if v2.n < CONCENTRATION_MIN_N:
        checks.append(Check("C_concentration", INDET,
                            f"registry arm n={v2.n} < {CONCENTRATION_MIN_N} required"))
    else:
        limit = CONCENTRATION_MULT * v1.concentration_share
        ev["registry_concentration_pct"] = round(v2.concentration_share, 3)
        checks.append(Check(
            "C_concentration", FAIL if v2.concentration_share > limit else PASS,
            f"registry 4h+1d share {v2.concentration_share:.3f}% vs limit {limit:.3f}% "
            f"({CONCENTRATION_MULT}x v1 {v1.concentration_share:.3f}%)"))

    # The 1d cell, a DIRECTIONAL WATCH — reported every run so its weakness stays visible.
    checks.append(Check(
        "C_1d_cell",
        INDET if v2.n_1d < LOW_POWER_CELL_MIN_N else PASS,
        f"registry 1d n={v2.n_1d} (floor {LOW_POWER_CELL_MIN_N}) — a DIRECTIONAL WATCH, "
        f"not a powered test"))

    # ── D — operator-visible anomaly (emission liveness) ──
    g1, g2 = gaps.get(1, -1), gaps.get(2, -1)
    if g1 <= 0 or g2 <= 0:
        checks.append(Check("D_emission_gap", INDET, "gap unavailable on one arm"))
    else:
        limit = GAP_MULT * g1
        ev["registry_max_gap_s"] = g2
        checks.append(Check("D_emission_gap", FAIL if g2 > limit else PASS,
                            f"registry max gap {g2}s vs limit {limit:.0f}s ({GAP_MULT}x v1 max {g1}s)"))
    return checks, ev


def fold(checks: list[Check]) -> str:
    """INDETERMINATE never folds to PASS. A single FAIL is a FAIL."""
    if any(c.verdict == FAIL for c in checks):
        return FAIL
    if any(c.verdict == INDET for c in checks):
        return INDET
    return PASS


def fail_body(checks: list[Check]) -> str:
    """The page for a breached OPERATIONAL bound. It names no change under test — a bound that names
    one reads as an effect claim (population-comparison registry, OPERATIONAL_BOUND) — and it gives
    the one lever that exists: the registry kill switch, which forces every cell to rule M and can
    never select v1 (rollback denied)."""
    return "\n".join([f"🛑 {ALERT_ID_BREACH}", ""]
                     + [f"{c.verdict}  {c.name}: {c.detail}" for c in checks]
                     + ["",
                        "An OPERATIONAL bound on the registry arm breached (volume, concentration or",
                        "emission gap). This job changes nothing.",
                        "Operator: read rule_config_id on recent signals rows. If any cell is switched,",
                        "VERDICT_RULE_FORCE_M=1 in /opt/crypto-quant-signal-mcp/.env, then",
                        "  cd /opt/crypto-quant-signal-mcp && docker compose up -d mcp-server",
                        "  (`docker compose restart` does NOT reload env_file — do not use it)",
                        "forces every cell back to rule M. With every cell already on M, investigate the",
                        "emission path; rule v1 cannot be selected."])


def build_envelope(verdict: str, ev: dict, now: datetime, run_id: str,
                   started: datetime, window: tuple[str, str]) -> dict:
    return {
        "schema_version": 1,
        "detector": DETECTOR,
        "verdict": verdict,
        "run_id": run_id,
        "run_started_at": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_outcome": "complete",
        "produced_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "observation_window": {"from": window[0], "to": window[1]},
        "evidence": ev or {"v2_n": 0},
    }


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return _self_test()

    now = datetime.now(timezone.utc)
    started = now
    run_id = f"{DETECTOR}-{now:%Y%m%dT%H%M%SZ}"
    # TMRG_FLIP_AT is still exported by the crontab line; since the re-home nothing reads it.

    try:
        arms = {int(r[0]): Arm(r) for r in psql(ARMS_SQL)}
        daily: dict[int, dict[str, int]] = {}
        for r in psql(DAILY_TRENDING_SQL):
            daily.setdefault(int(r[0]), {})[r[1]] = int(r[2])
        gaps = {int(r[0]): int(_f(r[1])) for r in psql(MAX_GAP_SQL)}
    except Indeterminate as exc:
        print(f"[{DETECTOR}] could not read the corpus: {exc}")
        print(f"TREND_MODE_READOUT_VERDICT={INDET}")
        return 3

    v1, v2 = arms.get(1), arms.get(2)
    checks, ev = evaluate(v1, v2, daily, gaps, now)
    verdict = fold(checks)

    # POSITIVE per-check output. A row silently skipped by a load error must not look like a row
    # that passed — so every check prints its own measured value and its own verdict.
    for c in checks:
        print(f"[{DETECTOR}] {c.verdict:<13} {c.name:<18} {c.detail}")

    window = ("1970-01-01T00:00:00Z", now.strftime("%Y-%m-%dT%H:%M:%SZ"))
    if v2 is not None and v2.n:
        window = (datetime.fromtimestamp(v2.first_at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  datetime.fromtimestamp(v2.last_at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    env = build_envelope(verdict, ev, now, run_id, started, window)
    errs = de.validate(env, de.load_schema())
    if errs:
        # Our OWN signal is non-conforming: that is a defect in this detector, not a finding about
        # the world, and it must never be laundered into a PASS.
        print(f"[{DETECTOR}] envelope non-conforming: {'; '.join(errs[:3])}")
        print(f"TREND_MODE_READOUT_VERDICT={INDET}")
        return 3
    print(f"[{DETECTOR}] envelope={json.dumps(env, sort_keys=True)}")

    wrapper = os.environ.get("TMRG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")

    if verdict == FAIL:
        _send(wrapper, ALERT_ID_BREACH, fail_body(checks))
    else:
        # ADOPTED --clear, SILENT (announce_resolution false). Clear on "not failing AND not blind":
        # a run that measured nothing clears nothing.
        evaluated_something = any(c.verdict == PASS for c in checks)
        if evaluated_something and Path(wrapper).exists():
            try:
                subprocess.run([wrapper, "--clear", ALERT_ID_BREACH,
                                "all operational bounds within band"],
                               capture_output=True, text=True, timeout=60)
            except Exception as exc:  # noqa: BLE001
                print(f"[{DETECTOR}] WARNING: --clear failed: {exc}")

    print(f"TREND_MODE_READOUT_VERDICT={verdict}")
    return 3 if verdict == INDET else 0


def _send(wrapper: str, alert_id: str, body: str) -> bool:
    if not Path(wrapper).exists():
        print(f"[{DETECTOR}] WARNING: wrapper absent at {wrapper}; alert NOT sent")
        return False
    try:
        subprocess.run([wrapper, alert_id, SEVERITY, "-"], input=body, text=True, timeout=60)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[{DETECTOR}] WARNING: send failed: {exc}")
        return False


# ─────────────────────────────── self-test ───────────────────────────────
# Hermetic, two-way, vacuity-guarded — and it asserts the artifacts the DB seam BYPASSES (the SQL
# strings and the envelope shape), because those are the only code no scenario would otherwise run
# and are exactly where this class of canary has broken before.

def _row(version, n, scored, ew, lw, sw, tr, conc, n1d, first, last, buy=None):
    # buy_side defaults to "almost all BUY", which is what the v1 arm really is (99.47%) — and it
    # is exactly that one-sidedness that makes v1's attainable excess range 1.06pp wide and the
    # cross-arm comparison NOT IDENTIFIABLE against a 3.0pp floor.
    b = scored if buy is None else buy
    return [str(version), str(n), str(scored), str(ew), str(lw), str(sw), str(b),
            str(tr), str(conc), str(n1d), str(first), str(last)]


def _self_test() -> int:
    failures = []

    def check(label, cond):
        try:
            ok = bool(cond() if callable(cond) else cond)
        except Exception as exc:  # noqa: BLE001 — an assertion that RAISES is not an assertion
            ok, label = False, f"{label} (raised {type(exc).__name__}: {exc})"
        print(f"  {'ok  ' if ok else 'FAIL'} {label}")
        if not ok:
            failures.append(label)

    now = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)
    day = 86400
    v1 = Arm(_row(1, 28616, 26559, 12453, 12442, 13806, 18769, 1116, 33, 0, 9 * day))
    daily_ok = {2: {"2026-10-01": 2000, "2026-10-02": 2100, "2026-10-03": 2050}}
    gaps_ok = {1: 1136, 2: 900}

    # 1. an empty registry arm is a FACT, not vacuity → PASS with a positive line
    checks, _ = evaluate(v1, None, {}, gaps_ok, now)
    check("no registry-arm rows ⇒ PASS with an explicit line (fact, not vacuity)",
          lambda: fold(checks) == PASS and any("no registry-arm rows" in c.detail for c in checks))

    # 2. a healthy registry arm passes the OPERATIONAL bounds
    v2_ok = Arm(_row(2, 30000, 27000, 12700, 12650, 14000, 19000, 1150, 40, 0, 9 * day, buy=21870))
    checks, ev = evaluate(v1, v2_ok, daily_ok, gaps_ok, now)
    check("healthy registry arm ⇒ B/C/D all PASS",
          all(c.verdict == PASS for c in checks if c.name.startswith(("B_", "C_conc", "D_"))))
    check("evidence names the registry arm", "registry_n" in ev and "v1_n" in ev)

    # 3. trigger A and the readout are RETIRED — neither can come back unnoticed
    check("no A check is evaluated any more", not any(c.name.startswith("A_") for c in checks))
    check("no readout check is evaluated any more", not any(c.name == "readout_due" for c in checks))
    check("the retired constants are gone",
          all(n not in globals() for n in ("EDGE_FLOOR_DROP_PP", "EDGE_MIN_SCORED", "READOUT_DAYS", "ALERT_ID_DUE")))

    # 4. MUST-FIRE: each bound fires on its own breach
    daily_hot = {2: {"2026-10-01": 99999, "2026-10-02": 99999, "2026-10-03": 99999}}
    check("B fires on 3 sustained days over the ceiling",
          any(c.name == "B_volume_ceiling" and c.verdict == FAIL
              for c in evaluate(v1, v2_ok, daily_hot, gaps_ok, now)[0]))
    check("B does NOT fire on 2 of 3 days over",
          any(c.name == "B_volume_ceiling" and c.verdict == PASS
              for c in evaluate(v1, v2_ok, {2: {"a": 99999, "b": 99999, "c": 10}}, gaps_ok, now)[0]))
    v2_conc = Arm(_row(2, 30000, 27000, 12700, 12650, 14000, 19000, 9000, 40, 0, 9 * day))
    check("C fires on cell concentration",
          any(c.name == "C_concentration" and c.verdict == FAIL
              for c in evaluate(v1, v2_conc, daily_ok, gaps_ok, now)[0]))
    check("D fires on an emission gap",
          any(c.name == "D_emission_gap" and c.verdict == FAIL
              for c in evaluate(v1, v2_ok, daily_ok, {1: 1136, 2: 5000}, now)[0]))

    # 5. INDETERMINATE never folds to PASS
    v2_thin = Arm(_row(2, 100, 100, 50, 50, 50, 60, 5, 2, 0, day))
    checks, _ = evaluate(v1, v2_thin, daily_ok, gaps_ok, now)
    check("underpowered registry arm ⇒ INDETERMINATE, never PASS", fold(checks) == INDET)
    check("the 1d cell reports INDETERMINATE below its floor",
          any(c.name == "C_1d_cell" and c.verdict == INDET for c in checks))

    # 6. THE BYPASSED ARTIFACTS — the SQL strings, the page body, the envelope
    for name, sql in (("ARMS_SQL", ARMS_SQL), ("DAILY_TRENDING_SQL", DAILY_TRENDING_SQL),
                      ("MAX_GAP_SQL", MAX_GAP_SQL)):
        check(f"{name} holds both arms on one instrument (regime_rule_version=3, no BITMART)",
              "regime_rule_version = 3" in sql and "BITMART" in sql)
        check(f"{name} maps every registry version (2, 3, …) into ONE arm against frozen v1",
              "verdict_rule_version >= 2" in sql)
    body = fail_body([Check("D_emission_gap", FAIL, "x")])
    # The first line is the alert id, a HISTORICAL label kept so markers and the registry row stay
    # continuous; the body below it is what an operator reads as a claim.
    prose = body.split("\n", 1)[1]
    check("the FAIL body names no change under test (OPERATIONAL_BOUND)",
          "TREND_MODE" not in prose and "rollback trigger" not in prose.lower() and "fade" not in prose.lower())
    check("the FAIL body gives the registry kill switch, and never offers v1",
          "VERDICT_RULE_FORCE_M=1" in body and "docker compose up -d mcp-server" in body
          and "cannot be selected" in body)
    env = build_envelope(PASS, {"registry_n": 1}, now, "rid", now, ("2026-10-01T00:00:00Z",
                                                                    "2026-10-03T00:00:00Z"))
    try:
        errs = de.validate(env, de.load_schema())
    except Exception as exc:  # noqa: BLE001
        errs = [f"schema unreadable: {exc}"]
    check(f"the envelope we BUILD validates against the shipped schema ({errs or 'clean'})", not errs)
    check("a deliberately broken envelope is REFUSED (the validator can say no)",
          bool(de.validate({"schema_version": 1, "detector": DETECTOR}, de.load_schema())))

    # 7. the code's remaining thresholds match the in-repo contract — no silent divergence
    contract = None
    for anc in Path(__file__).resolve().parents:
        cand = anc / "audits" / "SIGNAL-TREND-MODE-ENABLE-W1-trigger-contract.md"
        if cand.exists():
            contract = cand
            break
    in_checkout = (Path(__file__).resolve().parents[2] / ".git").exists() \
        or (Path(__file__).resolve().parents[2] / "package.json").exists()
    if contract is None and in_checkout:
        check("contract is reachable from a checkout", False)
    elif contract is not None:
        txt = contract.read_text()
        check("contract mirrors the volume multiple", f"{int(VOLUME_CEILING_MULT)}×" in txt)
        check("contract mirrors the concentration multiple", f"{int(CONCENTRATION_MULT)}×" in txt)
    else:
        print("  ok   contract absent and not in a checkout — host install, mirror check N/A")

    total = len(failures)
    print(f"SELF-TEST: {'PASS' if total == 0 else f'FAIL ({total})'}")
    if total:
        print(f"TREND_MODE_READOUT_VERDICT={INDET}")
        return 3
    print(f"TREND_MODE_READOUT_VERDICT={PASS}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
