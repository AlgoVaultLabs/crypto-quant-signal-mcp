#!/usr/bin/env python3
"""trend-mode-readout-gate.py — SIGNAL-TREND-MODE-ENABLE-W1 CH2.

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
  TMRG_MARKER         once-ever marker              (default /var/lib/algovault-monitoring/trend-mode-readout-due.fired)
  TMRG_FLIP_AT        flip instant, ISO-8601 UTC    (REQUIRED in prod; no default — a guessed
                      cutover is the lie this wave's own CH1 refused to ship)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import detector_envelope as de  # noqa: E402  (host-local sibling; see the inventory row)
import population_comparison as pc  # noqa: E402  (EDGE-POPULATION-COMPARISON-W1)

ALERT_ID_BREACH = "TREND_MODE_TRIGGER_BREACH"
ALERT_ID_DUE = "TREND_MODE_READOUT_DUE"
SEVERITY = "CRITICAL_PERSISTENT"
DETECTOR = "trend-mode-readout-gate"

PASS, FAIL, INDET = "PASS", "FAIL", "INDETERMINATE"

# ── Pre-declared thresholds. Contract file is the SoT; these mirror it and the self-test asserts
#    the mirror, so a silent divergence between code and contract is not writable. ──
EDGE_FLOOR_DROP_PP = 3.0      # A   v2 edge vs best naive baseline, below v1's by more than this
# A2 RETIRED by EDGE-POPULATION-COMPARISON-W1 — mix-coupled basis; see the block in evaluate().
EDGE_MIN_SCORED = 5000        # A/A2 minimum scored v2 rows
VOLUME_CEILING_MULT = 8.0     # B   TRENDING_* rows/day above this multiple of v1's
VOLUME_SUSTAIN_DAYS = 3       # B   consecutive days
CONCENTRATION_MULT = 3.0      # C   4h+1d share above this multiple of v1's
CONCENTRATION_MIN_N = 2000    # C   minimum v2 rows
GAP_MULT = 2.0                # D   emission gap above this multiple of v1's max
LOW_POWER_CELL_MIN_N = 30     # any per-cell figure below this is INDETERMINATE, never PASS
READOUT_DAYS = 30

POP = "regime_rule_version = 3 AND exchange <> 'BITMART'"

ARMS_SQL = f"""
SELECT verdict_rule_version,
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
SELECT verdict_rule_version, to_char(to_timestamp(created_at),'YYYY-MM-DD'), count(*)
FROM signals
WHERE {POP} AND regime IN ('TRENDING_UP','TRENDING_DOWN')
GROUP BY 1,2 ORDER BY 1,2
"""

MAX_GAP_SQL = f"""
WITH g AS (SELECT verdict_rule_version AS a,
                  created_at - lag(created_at) OVER (PARTITION BY verdict_rule_version
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


def evaluate(v1: Arm | None, v2: Arm | None, daily: dict, gaps: dict, now: datetime,
             flip_at: datetime | None) -> tuple[list[Check], dict]:
    """Pure — no I/O, so the self-test exercises the REAL predicate rather than a stand-in."""
    checks: list[Check] = []
    ev: dict = {}

    if v1 is None:
        checks.append(Check("population", INDET, "no v1 arm — the BEFORE arm is the comparator"))
        return checks, ev
    if v2 is None or v2.n == 0:
        # NOT vacuity: the world builds this corpus, and "the flag has not produced rows yet" is a
        # FACT with an obvious correct verdict. Reported as an explicit positive line, never silent.
        checks.append(Check("population", PASS,
                            f"no v2 rows yet (v1 n={v1.n}) — flag not flipped, or not yet emitting"))
        ev["v1_n"] = v1.n
        ev["v2_n"] = 0
        return checks, ev

    ev.update(v1_n=v1.n, v2_n=v2.n, v1_scored=v1.scored, v2_scored=v2.scored)

    # ── A — edge floor, via the ONE derivation, which REFUSES rather than repairs ──
    #
    # SHIPPED 2026-08-31 AS `engine - max(always_long, always_short)`, AND IT FIRED A FALSE FAIL ON
    # 2026-09-02. Measured decomposition: always_short moved +2.97pp between the windows, which
    # alone explained most of the -5.08pp "regression" with ZERO engine change. The comparator was
    # market-coupled — and `max()` is additionally SELECTION-coupled, silently changing which
    # quantity it names as the up-rate crosses 0.5.
    #
    # THE LAW WAS FOLLOWED, NOT BROKEN. CLAUDE.md's Benchmark-before-publish mandates edge against
    # the naive baselines ON THE SAME ROWS; that controls the market WITHIN an arm and is silent
    # BETWEEN arms. Following it is what produced this comparator.
    #
    # A2 (edge vs always_long) is DELETED as a gating trigger, not migrated: it is mix-coupled, it
    # reported +0.44pp IMPROVEMENT on the same rows and the same day trigger A reported a 5.08pp
    # regression, and migrating it to the mix-matched null just yields a second copy of A.
    arm1 = pc.Arm("verdict_rule_version=1", v1.scored, v1.engine_wins, v1.long_wins,
                  v1.short_wins, v1.buy_side)
    arm2 = pc.Arm("verdict_rule_version=2", v2.scored, v2.engine_wins, v2.long_wins,
                  v2.short_wins, v2.buy_side)
    n_clusters = len(daily.get(2, {}))
    cmpres = pc.compare_arms(arm1, arm2, EDGE_FLOOR_DROP_PP, n_clusters=n_clusters)
    ev.update({k: val for k, val in cmpres.evidence.items()
               if k in ("attainable_pp_a", "attainable_pp_b", "excess_pp_a", "excess_pp_b",
                        "capacity_ratio", "delta_excess_pp", "diagnostic_max_naive_drift_pp")})
    checks.append(Check("A_edge_floor", cmpres.verdict, cmpres.reason))

    # ── B — volume ceiling, sustained ──
    base_rate = v1.trending_per_day
    if not base_rate:
        checks.append(Check("B_volume_ceiling", INDET, "v1 trending rate unavailable"))
    else:
        ceiling = VOLUME_CEILING_MULT * base_rate
        recent = sorted(daily.get(2, {}).items())[-VOLUME_SUSTAIN_DAYS:]
        if len(recent) < VOLUME_SUSTAIN_DAYS:
            checks.append(Check("B_volume_ceiling", INDET,
                                f"only {len(recent)} v2 day(s), need {VOLUME_SUSTAIN_DAYS}"))
        else:
            over = [d for d, c in recent if c > ceiling]
            ev["v2_trending_recent"] = [c for _, c in recent]
            checks.append(Check(
                "B_volume_ceiling", FAIL if len(over) == VOLUME_SUSTAIN_DAYS else PASS,
                f"last {VOLUME_SUSTAIN_DAYS}d TRENDING_* {[c for _, c in recent]} vs ceiling "
                f"{ceiling:.0f}/day ({VOLUME_CEILING_MULT}x v1 {base_rate:.0f}/day); "
                f"{len(over)}/{VOLUME_SUSTAIN_DAYS} over"))

    # ── C — cell concentration ──
    if v2.n < CONCENTRATION_MIN_N:
        checks.append(Check("C_concentration", INDET,
                            f"v2 n={v2.n} < {CONCENTRATION_MIN_N} required"))
    else:
        limit = CONCENTRATION_MULT * v1.concentration_share
        ev["v2_concentration_pct"] = round(v2.concentration_share, 3)
        checks.append(Check(
            "C_concentration", FAIL if v2.concentration_share > limit else PASS,
            f"v2 4h+1d share {v2.concentration_share:.3f}% vs limit {limit:.3f}% "
            f"({CONCENTRATION_MULT}x v1 {v1.concentration_share:.3f}%)"))

    # The 1d cell, pre-declared as a DIRECTIONAL WATCH. Reported every run so its weakness is
    # visible in the log rather than rediscovered at readout.
    checks.append(Check(
        "C_1d_cell",
        INDET if v2.n_1d < LOW_POWER_CELL_MIN_N else PASS,
        f"v2 1d n={v2.n_1d} (floor {LOW_POWER_CELL_MIN_N}) — pre-declared DIRECTIONAL WATCH, "
        f"not a powered test"))

    # ── D — operator-visible anomaly (emission liveness) ──
    g1, g2 = gaps.get(1, -1), gaps.get(2, -1)
    if g1 <= 0 or g2 <= 0:
        checks.append(Check("D_emission_gap", INDET, "gap unavailable on one arm"))
    else:
        limit = GAP_MULT * g1
        ev["v2_max_gap_s"] = g2
        checks.append(Check("D_emission_gap", FAIL if g2 > limit else PASS,
                            f"v2 max gap {g2}s vs limit {limit:.0f}s ({GAP_MULT}x v1 max {g1}s)"))

    # ── the +30d readout ──
    if flip_at is None:
        checks.append(Check("readout_due", INDET, "TMRG_FLIP_AT unset — cannot date the readout"))
    else:
        due = flip_at + timedelta(days=READOUT_DAYS)
        ev["readout_due_at"] = due.strftime("%Y-%m-%dT%H:%M:%SZ")
        checks.append(Check("readout_due", PASS,
                            f"due {due:%Y-%m-%d} ({(due - now).days}d away)" if now < due
                            else f"DUE since {due:%Y-%m-%d}"))
    return checks, ev


def fold(checks: list[Check]) -> str:
    """INDETERMINATE never folds to PASS. A single FAIL is a FAIL."""
    if any(c.verdict == FAIL for c in checks):
        return FAIL
    if any(c.verdict == INDET for c in checks):
        return INDET
    return PASS


def readout_is_due(checks: list[Check], now: datetime, flip_at: datetime | None) -> bool:
    return flip_at is not None and now >= flip_at + timedelta(days=READOUT_DAYS)


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


def _iso(v: str | None):
    if not v:
        return None
    try:
        return datetime.strptime(v.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc)
    except ValueError:
        return None


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return _self_test()

    now = datetime.now(timezone.utc)
    started = now
    run_id = f"{DETECTOR}-{now:%Y%m%dT%H%M%SZ}"
    flip_at = _iso(os.environ.get("TMRG_FLIP_AT"))

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
    checks, ev = evaluate(v1, v2, daily, gaps, now, flip_at)
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
    marker = Path(os.environ.get("TMRG_MARKER",
                                 "/var/lib/algovault-monitoring/trend-mode-readout-due.fired"))

    if verdict == FAIL:
        body = "\n".join([f"🛑 {ALERT_ID_BREACH}", ""]
                         + [f"{c.verdict}  {c.name}: {c.detail}" for c in checks]
                         + ["",
                            "TREND_MODE=on breached a PRE-DECLARED rollback trigger.",
                            "Rollback (OPERATOR ACTION — this job never touches the flag):",
                            "  ssh signal-1; remove TREND_MODE=on from /opt/crypto-quant-signal-mcp/.env",
                            "  cd /opt/crypto-quant-signal-mcp && docker compose up -d --force-recreate mcp-server",
                            "  (`docker compose restart` does NOT reload env_file — do not use it)",
                            "Contract: audits/SIGNAL-TREND-MODE-ENABLE-W1-trigger-contract.md"])
        _send(wrapper, ALERT_ID_BREACH, body)

    else:
        # ADOPTED --clear. State hygiene, NOT a recovery announcement: send_telegram.sh writes its
        # cooldown marker on a delivered fire and nothing else ever removes it, so a breach that
        # heals would leave the channel's last word pinned to the worst thing that ever happened.
        # `announce_resolution` stays FALSE on this alert — the clear is SILENT, per the law's
        # default. A trigger flapping back and forth is chatter; the operator action here is a
        # rollback DECISION, not an acknowledgement of a blip.
        # CLEAR ON "NOT FAILING AND NOT BLIND", not on PASS.
        #
        # Clearing only on PASS was wrong the moment trigger A became a structural REFUSAL: A is
        # permanently INDETERMINATE for this pair of arms (NOT_IDENTIFIABLE is a determinate
        # statement that the test cannot be run, not a transient read failure), so the fold can
        # never reach PASS and the marker from the 2026-09-02 FALSE alarm would sit forever —
        # pinning the channel's last word to the worst thing that ever happened, which is the exact
        # defect the recovery-notice law names.
        #
        # But "clear whenever not FAIL" would clear while wholly blind, which is laundering. The
        # condition is therefore BOTH: nothing is failing AND at least one trigger was genuinely
        # evaluated. A run that measured nothing clears nothing.
        evaluated_something = any(c.verdict == PASS for c in checks)
        if verdict != FAIL and evaluated_something and Path(wrapper).exists():
            try:
                subprocess.run([wrapper, "--clear", ALERT_ID_BREACH,
                                "all pre-declared triggers within band"],
                               capture_output=True, text=True, timeout=60)
            except Exception as exc:  # noqa: BLE001
                print(f"[{DETECTOR}] WARNING: --clear failed: {exc}")

    if readout_is_due(checks, now, flip_at) and not marker.exists():
        body = "\n".join([f"📊 {ALERT_ID_DUE}", "",
                          f"{READOUT_DAYS} days of live v2 data have accrued since the flip"
                          f" ({flip_at:%Y-%m-%d}).",
                          f"v1 n={v1.n if v1 else 0} · v2 n={v2.n if v2 else 0}",
                          "",
                          "Action: dispatch SIGNAL-TREND-MODE-READOUT-W{NEXT}."])
        if _send(wrapper, ALERT_ID_DUE, body):
            try:
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text(now.strftime("%Y-%m-%dT%H:%M:%SZ\n"))
            except OSError as exc:
                print(f"[{DETECTOR}] WARNING: could not write once-ever marker: {exc}")

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
        if cond:
            print(f"  ok   {label}")
        else:
            print(f"  FAIL {label}")
            failures.append(label)

    now = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
    flip = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
    day = 86400
    # v1: engine 46.89, long 46.85, short 51.98 → edge_best -5.09, edge_long +0.04
    v1 = Arm(_row(1, 28616, 26559, 12453, 12442, 13806, 18769, 1116, 33, 0, 9 * day))
    daily_ok = {2: {"2026-09-27": 2000, "2026-09-28": 2100, "2026-09-29": 2050}}
    gaps_ok = {1: 1136, 2: 900}

    # 1. the world being empty of v2 rows is a FACT, not vacuity → PASS with a positive line
    checks, _ = evaluate(v1, None, {}, gaps_ok, now, flip)
    check("no v2 rows ⇒ PASS with an explicit line (fact, not vacuity)",
          fold(checks) == PASS and any("no v2 rows yet" in c.detail for c in checks))

    # 2. a healthy v2 arm passes the OPERATIONAL bounds
    v2_ok = Arm(_row(2, 30000, 27000, 12700, 12650, 14000, 19000, 1150, 40, 0, 9 * day, buy=21870))
    checks, ev = evaluate(v1, v2_ok, daily_ok, gaps_ok, now, flip)
    check("healthy v2 ⇒ B/C/D all PASS",
          all(c.verdict == PASS for c in checks if c.name.startswith(("B_", "C_conc", "D_"))))
    check("evidence carries the capacity scalars the refusal is built from",
          "attainable_pp_a" in ev and "excess_pp_a" in ev and "v2_n" in ev)

    # 3. THE REFUSAL, on the REAL 2026-09-02 shape. v1 is 99.5% one-sided, so its entire attainable
    #    excess range is ~1.06pp — narrower than the declared 3.0pp floor. The comparison is
    #    therefore NOT IDENTIFIABLE and must refuse rather than report a number.
    check("A REFUSES a one-sided v1 against a floor wider than its attainable range",
          any(c.name == "A_edge_floor" and c.verdict == INDET and "NOT_IDENTIFIABLE" in c.detail
              for c in evaluate(v1, v2_ok, daily_ok, gaps_ok, now, flip)[0]))

    # 3b. …and the refusal is NOT blanket. Give BOTH arms real two-sided capacity and A evaluates.
    #     Without this the previous assertion would be satisfied by a trigger that always refuses,
    #     which is a dark guard wearing a refusal's clothes.
    # 25 clusters, because the day is the independence unit and the contract floors at 20. The
    # first draft of this fixture carried 3 days and A returned "under-clustered" — correct
    # behaviour that the test mistook for a broken refusal.
    daily_many = {2: {f"2026-09-{d:02d}": 2000 for d in range(1, 26)}}
    v1_2s = Arm(_row(1, 30000, 28000, 13300, 13300, 14000, 19000, 1100, 33, 0, 9 * day, buy=15000))
    v2_2s = Arm(_row(2, 30000, 27000, 13000, 12900, 13900, 19000, 1150, 40, 0, 9 * day, buy=14000))
    a_two_sided = [c for c in evaluate(v1_2s, v2_2s, daily_many, gaps_ok, now, flip)[0]
                   if c.name == "A_edge_floor"]
    check("A EVALUATES when both arms have capacity (the refusal is not blanket)",
          bool(a_two_sided) and a_two_sided[0].verdict in (PASS, FAIL))

    # 3c. MUST-FAIL — with capacity present, a genuine edge collapse still fires.
    v2_bad = Arm(_row(2, 30000, 27000, 11200, 12900, 13900, 19000, 1150, 40, 0, 9 * day, buy=14000))
    check("A still FIRES on a real edge collapse once it is identifiable",
          any(c.name == "A_edge_floor" and c.verdict == FAIL
              for c in evaluate(v1_2s, v2_bad, daily_many, gaps_ok, now, flip)[0]))
    daily_hot = {2: {"2026-09-27": 99999, "2026-09-28": 99999, "2026-09-29": 99999}}
    check("B fires on 3 sustained days over the ceiling",
          any(c.name == "B_volume_ceiling" and c.verdict == FAIL
              for c in evaluate(v1, v2_ok, daily_hot, gaps_ok, now, flip)[0]))
    check("B does NOT fire on 2 of 3 days over",
          any(c.name == "B_volume_ceiling" and c.verdict == PASS
              for c in evaluate(v1, v2_ok,
                                {2: {"a": 99999, "b": 99999, "c": 10}}, gaps_ok, now, flip)[0]))
    v2_conc = Arm(_row(2, 30000, 27000, 12700, 12650, 14000, 19000, 9000, 40, 0, 9 * day))
    check("C fires on cell concentration",
          any(c.name == "C_concentration" and c.verdict == FAIL
              for c in evaluate(v1, v2_conc, daily_ok, gaps_ok, now, flip)[0]))
    check("D fires on an emission gap",
          any(c.name == "D_emission_gap" and c.verdict == FAIL
              for c in evaluate(v1, v2_ok, daily_ok, {1: 1136, 2: 5000}, now, flip)[0]))

    # 4. INDETERMINATE never folds to PASS
    v2_thin = Arm(_row(2, 100, 100, 50, 50, 50, 60, 5, 2, 0, day))
    checks, _ = evaluate(v1, v2_thin, daily_ok, gaps_ok, now, flip)
    check("underpowered v2 ⇒ INDETERMINATE, never PASS", fold(checks) == INDET)
    check("the 1d cell reports INDETERMINATE below its floor",
          any(c.name == "C_1d_cell" and c.verdict == INDET for c in checks))

    # 5. the readout fires only after +30d
    check("readout not due at +29d", not readout_is_due([], flip + timedelta(days=29), flip))
    check("readout due at +30d", readout_is_due([], flip + timedelta(days=30), flip))
    check("readout INDETERMINATE with no flip instant",
          any(c.name == "readout_due" and c.verdict == INDET
              for c in evaluate(v1, v2_ok, daily_ok, gaps_ok, now, None)[0]))

    # 6. THE BYPASSED ARTIFACTS — the seam replaces the DB, so these are the only code no scenario
    #    above executes. Assert their SHAPE rather than trusting them.
    for name, sql in (("ARMS_SQL", ARMS_SQL), ("DAILY_TRENDING_SQL", DAILY_TRENDING_SQL),
                      ("MAX_GAP_SQL", MAX_GAP_SQL)):
        check(f"{name} holds both arms on one instrument (regime_rule_version=3, no BITMART)",
              "regime_rule_version = 3" in sql and "BITMART" in sql)
        check(f"{name} groups by verdict_rule_version rather than filtering to one arm",
              "verdict_rule_version" in sql)
    env = build_envelope(PASS, {"v2_n": 1}, now, "rid", now, ("2026-09-01T00:00:00Z",
                                                             "2026-09-30T00:00:00Z"))
    try:
        errs = de.validate(env, de.load_schema())
    except Exception as exc:  # noqa: BLE001 — an assertion that RAISES is not an assertion
        errs = [f"schema unreadable: {exc}"]
    check(f"the envelope we BUILD validates against the shipped schema ({errs or 'clean'})", not errs)
    check("a deliberately broken envelope is REFUSED (the validator can say no)",
          bool(de.validate({"schema_version": 1, "detector": DETECTOR}, de.load_schema())))

    # 7. the code's thresholds match the in-repo contract — no silent divergence
    # Resolve by SEARCHING UPWARD, never by a hardcoded parent index. `parents[1]` is `ops/`, not
    # the repo root — and the first draft of this block used it, so the whole mirror assertion
    # skipped while printing `ok`. That is the installed-script-relative-path dark guard, written
    # into the very self-test whose job is to make dark guards unwritable. Kept visible.
    contract = None
    for anc in Path(__file__).resolve().parents:
        cand = anc / "audits" / "SIGNAL-TREND-MODE-ENABLE-W1-trigger-contract.md"
        if cand.exists():
            contract = cand
            break
    in_checkout = (Path(__file__).resolve().parents[2] / ".git").exists() \
        or (Path(__file__).resolve().parents[2] / "package.json").exists()
    if contract is None and in_checkout:
        # A checkout that cannot find its own contract is a DEFECT, not a host install.
        check("contract is reachable from a checkout", False)
    elif contract is not None:
        txt = contract.read_text()
        check("contract mirrors the edge floor", f"{EDGE_FLOOR_DROP_PP} pp" in txt)
        check("contract mirrors the volume multiple", f"{int(VOLUME_CEILING_MULT)}×" in txt)
        check("contract mirrors the concentration multiple", f"{int(CONCENTRATION_MULT)}×" in txt)
        check("contract mirrors the min-n for the edge floors", f"{EDGE_MIN_SCORED:,}" in txt)
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
