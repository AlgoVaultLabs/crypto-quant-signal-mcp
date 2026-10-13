#!/usr/bin/env python3
"""GROWTH-AGENT-SIGNIN-STEPUP-W1-V2 R2.6 — `stepup-readout`, the daily record the move to N is ruled on.

Host-side (signal-1, /opt/algovault-monitoring/), root cron, once a day. It answers the questions the
CH4 ruling packet asks, from production data, and writes ONE structured line to `canary-results.jsonl`
(`canary_result_log.append_result`), which `monitoring-results-sync.sh` pulls into the vault:

  * free-tier metered calls for the last complete UTC day, by POOL (Anthropic egress vs other) and
    CLIENT FAMILY, with distinct ip BUCKETS beside them — buckets, labelled as buckets: `request_log`
    carries no key or identity column, so a bucket is the finest unit this instrument can see (M7);
  * `stepup_would_gate` (shadow) / `stepup_gated` (live) events for that day, by family and pool;
  * `quota_hit_block` events for that day, by session pool;
  * Anthropic-egress metered calls over the trailing 30 d — the number `CLAUDE_POOL=EMPTY` is ruled
    on — and `OAUTH_TRIGGER=MET|NOT_MET` at >= 1,000 (the deferred OAuth wave's measured trigger);
  * the ACTIVATION GUARD (Mr.1's CH4 ruling, Q1 = C amended; windows re-derived by
    OPS-STEPUP-ACTIVATION-W1): an ACTIVATION is a bucket whose FIRST-EVER successful free metered
    call fell in a window. A VERDICT ABOUT THE STEP-UP OBSERVES ONLY POST-FLIP TIME. Every window is
    classified against the frozen change instant `flipped_at` by window_phase() — nothing else
    decides — with P0 = the first UTC midnight at or after the flip and the flip day [R0, P0)
    belonging to neither side (R0 = the envelope's reference_day). Two legs:
      - WEEKLY, per client family. Due once L = whole UTC days in [P0, REF) >= 7, i.e. once the
        judged week cur = [REF - 7 d, REF) is `post`. prior = [REF - 14 d, REF - 7 d) when that is
        `post` too, else the envelope's weekly[0] — the last whole PRE-flip week, frozen. Pages at
        `live` only when ALL hold: prior >= ACT_MIN_PRIOR_WEEK (5), drop >= GUARD_DROP (30 %), and
        drop LARGER than that family's largest weekly drop over the 6 pre-flip weeks (the
        ENVELOPE, computed once at the flip by `--freeze-envelope` and frozen in ENVELOPE_PATH).
        Before it is due: `not_due`, with the UTC day of its first due run — recorded, never paged.
      - EARLY, pooled over every family, post-flip days 2..6: post_L = activations in [P0, REF)
        against pre_min_L = the smallest pooled total of any L-day run inside [R0 - 42 d, R0).
        Pages `early_collapse` iff pre_min_L >= EARLY_MIN_PRE and post_L is below half of it.
        L < 2 → `not_due`; L >= 7 → `retired` (the weekly leg owns it). post and pre_min are in
        every record whatever the state.
    WHY: the first run after the flip (2026-10-13 05:29Z) anchored its weeks at the run date, judged
    a week that was 92.5 % PRE-flip, and paged node 36 → 13 — every one of the 13 activations
    predated the flip (OPS-STEPUP-ACTIVATION-W1 audit). Anchored that way the guard would have kept
    paging on pre-flip drift for a week AND been blind to a real post-flip break for the same week.
    Why activations and not calls: at N = 20 call volume falls BY DESIGN (Aug/Sep had 4,754–8,348
    calls a month above N), while a caller's first success is exactly what the step-up must not
    break — and `checkQuota` cannot refuse a bucket whose count is 0.
  * call VOLUME per family (last 7 complete days vs the 7 before) stays in every record — REPORTED,
    NEVER PAGED. Measured before install (2026-10-12, mode off, nothing changed for anyone): `node`
    1,190 → 555 (−53 %) and `python-httpx` 459 → 7 (−98.5 %) week over week, which is why volume
    was never a sound alarm.

EVERY PAGE PASSES THROUGH THE DETECTOR_ENVELOPE CONTRACT (OPS-STEPUP-ACTIVATION-W1 CH2). Each
pageable finding — a weekly breach per family, an early collapse — is built as a DETECTOR_ENVELOPE
(detector `stepup-activation`, observation_window = the judged window, change_point = {the frozen
flipped_at, the envelope file}, evidence = measured scalars incl. the per-day series) and pages only
when `detector_envelope.decide()` FORWARDs it as FAIL. The contract refuses a change-attributed
window that starts before the change, so even a regression in the window logic above cannot page on
pre-flip time: a self-built envelope the contract refuses is INDETERMINATE (exit 3), never a FAIL.
The body is `render_body(envelope)` — measured fields only — plus the rollback and action lines.

THE INSTRUMENT IS A CHANGE POINT TOO. Activations are filtered on the ip-hash version tag the
RUNNING image derives (`IP_HASH_VERSION`, read in-container beside `hashIp`), never a literal. A
version that differs from the one the envelope froze under (absent ⇒ `v2`, the version at the
2026-10-12 freeze, measured) would end every pre-rotation bucket's history at once and read as a
total collapse, so in `live` the guard is INDETERMINATE ("re-freeze at the rotation"), never a page.

ARMED ONLY IN `live`, REPORTED IN EVERY MODE. The activation states are computed and recorded in
every run, but the page fires only when the resolved STEPUP_MODE is `live` — the only mode in which
the step-up changes what a caller receives. In `live`, a guard that cannot decide — no readable
frozen envelope, no `flipped_at`, an ip-hash version change — makes the run INDETERMINATE (exit 3),
never a quiet PASS.

ONE DERIVATION, RESOLVED IN THE RUNNING IMAGE. Pool membership (set A = `hashIp` of the eight masked
/24 network addresses of 160.79.104.0/21), the metered predicate (`call-class.ts` `billablePredicate()`)
and the step-up mode + N (`plans.ts` `resolveStepupMode()` / `FREE_KEYLESS_MONTHLY_CALLS_RULED`) are
all computed by a `node -e` probe INSIDE the app container from its deployed `dist/` — never mirrored
here. The ip-hash key never leaves the container; the probe returns SQL, and psql (`aoe_readonly`,
read-only transaction) returns aggregates only — no ip hash, key or session id is printed or stored.
ONE FIRST-ACTIVATION DERIVATION: a single CTE yields each bucket's first free metered row; the
weekly counts, the per-day series, the early leg and `--freeze-envelope` all project from its
(family, UTC day) counts — never a second scan of `request_log`.

Verdict token: exactly one terminal `STEPUP_READOUT_VERDICT=PASS|FAIL|INDETERMINATE`.
  PASS          record written, every family evaluated, nothing paged (in off/shadow a breach is
                REPORTED in the record and the log, never paged)                    → exit 0
  FAIL          `live`, and an activation breach was handed to the wrapper          → exit 0
                (a paging canary must not also mail cron; the TOKEN carries the verdict)
  INDETERMINATE the probe or the query could not be evaluated, or (live) the guard
                cannot decide — nothing was judged                                  → exit 3
A failed record append never changes the verdict; it prints `CANARY_RESULT_LOG_FAILED=` instead of
`CANARY_RESULT_LOG=`, so a run that wrote nothing never looks like one that did.

Usage:
  stepup-readout.py                 # the scheduled run
  stepup-readout.py --self-test     # hermetic: no docker, no psql, no wrapper, no result file
Env: TG_WRAPPER · STEPUP_READOUT_LOG · ALGOVAULT_TG_TEST_INERT=1 (wrapper: no POST, no marker).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ALERT_ID = "STEPUP_ACTIVATION_DROP"
CANARY = "stepup-readout"
APP_CONTAINER = "crypto-quant-signal-mcp-mcp-server-1"
PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
PG_ROLE = "aoe_readonly"
PG_DB = "signal_performance"
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
LOG = os.environ.get("STEPUP_READOUT_LOG", "/var/log/algovault-stepup-readout.log")

GUARD_DROP = 0.30               # >= 30 % week-over-week drop in ACTIVATIONS (and beyond the envelope) pages
ACT_MIN_PRIOR_WEEK = 5          # a family needs >= 5 activating buckets in the prior week to page
ENVELOPE_WEEKS = 6              # the envelope = the largest of the 6 pre-flip weekly drops (7 weeks of counts)
ENVELOPE_PATH = os.environ.get("STEPUP_ENVELOPE_PATH", "/var/lib/algovault-monitoring/stepup-activation-envelope.json")
OAUTH_TRIGGER_CALLS = 1000      # Anthropic-egress metered calls, trailing 30 d (V2 R-6)
TOP_FAMILIES = 12               # bounds the record under canary_result_log's 8 KiB line cap

WEEK_DAYS = 7                   # the weekly leg is due once a whole post-flip week exists
EARLY_FIRST_DAY = 2             # the early leg judges post-flip days 2..6; day 1 is one day of noise
EARLY_LOOKBACK_DAYS = 42        # pre_min_L is taken over the 6 whole weeks before the flip day
# A COLLAPSE is post_L below HALF of the worst pre-flip run of the same length — "worst", so an
# ordinary slow stretch can never page, and "half", so the page means a break, not a dip.
EARLY_COLLAPSE_FACTOR = 2
# The FLOOR keeps a zero meaningful: when the worst pre-flip L-day run is under 4 activations, a
# post-flip zero is something the pre-flip tape already did, so it is evidence of nothing. Measured
# at the 2026-10-12 freeze: pre_min_L = 0, 3, 8, 13, 16 for L = 2..6, so this leg can first page at
# L = 4 and records `below_floor` before that (OPS-STEPUP-ACTIVATION-W1 ruling Q4 = ship as specced).
EARLY_MIN_PRE = 4
# The ip-hash version an envelope that predates the field was frozen under. Measured, not assumed:
# request_log carried ONLY `v2` ids for the 14 days before 2026-10-13 and the image exported 'v2'.
ENVELOPE_DEFAULT_IP_HASH_VERSION = "v2"

DETECTOR = "stepup-activation"                       # the DETECTOR_ENVELOPE `detector` of every page
CHANGE_POINT_SOURCE = "stepup-activation-envelope.json"  # where change_point.at comes from (the frozen flip)

DAY = timedelta(days=1)
LAST_FIRE: dict = {}
LAST_CLEAR: dict = {}
LAST_RECORD: list = []

# The probe runs INSIDE the app container. It prints ONE JSON object
# {mode, n, d0, d1, ref, weeks, ip_hash_version, series_from, sql}. The activation windows end at
# REF: today 00:00Z for the daily run, or the flip's UTC day for `--freeze-envelope` (STEPUP_REF_ISO).
# The `actd` SELECT is the ONE first-activation derivation: the inner DISTINCT ON keeps each
# bucket's earliest free metered row tagged with the DEPLOYED ip-hash version (never a literal),
# and the outer SELECT counts those first rows per (family, UTC day) from SERIES_FROM to REF —
# the earlier of STEPUP_SERIES_FROM (the guard's pre-flip lookback) and REF - WEEKS weeks. Only
# aggregates leave psql. (No `//` comments inside PROBE_JS: the ops-surface guards strip them as
# comments, and they are string CONTENT here.) `sql` is a set of labelled SELECTs whose rows are
# `label|a|b|c|d`; nothing in it is printed.
PROBE_JS = r"""
const { hashIp, IP_HASH_VERSION } = require('/app/dist/lib/analytics.js');
const { billablePredicate } = require('/app/dist/lib/call-class.js');
const plans = require('/app/dist/lib/plans.js');
const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const DAY = 86400e3;
const now = Date.now();
const d1 = new Date(Math.floor(now / DAY) * DAY);          // today 00:00Z — the last complete day ends here
const D1 = d1.toISOString();
const D0 = new Date(d1.getTime() - DAY).toISOString();    // yesterday 00:00Z
const W7 = new Date(d1.getTime() - 7 * DAY).toISOString();
const W14 = new Date(d1.getTime() - 14 * DAY).toISOString();
const W30 = new Date(now - 30 * DAY).toISOString();
const REF = process.env.STEPUP_REF_ISO ? new Date(Math.floor(Date.parse(process.env.STEPUP_REF_ISO) / DAY) * DAY) : d1;
const RISO = REF.toISOString();
const WEEKS = Math.max(2, Math.min(12, parseInt(process.env.STEPUP_WEEKS || '2', 10) || 2));
const VER = String(IP_HASH_VERSION);
if (!/^[A-Za-z0-9]+$/.test(VER)) throw new Error('IP_HASH_VERSION is not a plain tag: ' + VER);
const SF = process.env.STEPUP_SERIES_FROM ? Math.floor(Date.parse(process.env.STEPUP_SERIES_FROM) / DAY) * DAY : NaN;
const FROM = new Date(Math.min(Number.isFinite(SF) ? SF : Infinity, REF.getTime() - WEEKS * 7 * DAY));
const FISO = FROM.toISOString();
const A = [];
for (let i = 104; i <= 111; i++) A.push(hashIp('160.79.' + i + '.0'));
const p = billablePredicate();
let k = 0;
const BILL = p.sql.replace(/\?/g, () => q(p.params[k++]));
const IN_A = '(' + A.map(q).join(',') + ')';
const FREE = "license_tier = 'free' AND coalesce(is_bot_internal, false) = false AND " + BILL;
const pool = (col) => 'CASE WHEN ' + col + ' IN ' + IN_A + " THEN 'anthropic' ELSE 'other' END";
const sql = [
  "SELECT 'calls_1d', " + pool('ip_hash') + ", coalesce(client_name, '<null>'), count(*), count(DISTINCT ip_hash) FROM request_log WHERE " + FREE +
    ' AND "timestamp" >= ' + q(D0) + ' AND "timestamp" < ' + q(D1) + ' GROUP BY 2, 3;',
  "SELECT 'anthropic_30d', count(*), count(DISTINCT ip_hash), '', '' FROM request_log WHERE " + FREE +
    ' AND "timestamp" >= ' + q(W30) + ' AND ip_hash IN ' + IN_A + ';',
  "SELECT 'stepup_1d', event_type, coalesce(meta_json::jsonb->>'client_family', '<null>'), " +
    pool("substr(meta_json::jsonb->>'bucket', 6)") + ", count(*) FROM funnel_events WHERE event_type IN ('stepup_would_gate', 'stepup_gated') AND ts >= " +
    q(D0) + '::timestamptz AND ts < ' + q(D1) + '::timestamptz GROUP BY 2, 3, 4;',
  "SELECT 'qhb_1d', " + pool('session_id') + ", count(*), count(DISTINCT session_id), '' FROM funnel_events WHERE event_type = 'quota_hit_block' AND ts >= " +
    q(D0) + '::timestamptz AND ts < ' + q(D1) + '::timestamptz GROUP BY 2;',
  "SELECT 'act', coalesce(client_name, '<null>'), count(*) FILTER (WHERE \"timestamp\" >= " + q(W7) + '), count(*) FILTER (WHERE "timestamp" < ' + q(W7) +
    '), count(DISTINCT ip_hash) FILTER (WHERE "timestamp" >= ' + q(W7) + ') FROM request_log WHERE ' + FREE +
    ' AND "timestamp" >= ' + q(W14) + ' AND "timestamp" < ' + q(D1) + ' GROUP BY 2;',
  "SELECT 'actd', family, to_char(first_ts::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*), '' FROM (SELECT DISTINCT ON (ip_hash) ip_hash, " +
    "coalesce(client_name, '<null>') AS family, \"timestamp\" AS first_ts FROM request_log WHERE " + FREE +
    ' AND ip_hash LIKE ' + q(VER + ':%') + ' AND "timestamp" < ' + q(RISO) + ' ORDER BY ip_hash, "timestamp") f WHERE first_ts >= ' + q(FISO) + ' GROUP BY 2, 3;',
].join('\n');
process.stdout.write(JSON.stringify({ mode: plans.resolveStepupMode(process.env), n: plans.FREE_KEYLESS_MONTHLY_CALLS_RULED, d0: D0, d1: D1, ref: RISO, weeks: WEEKS, ip_hash_version: VER, series_from: FISO, sql }));
"""


def _fd_is_file(fd: int, path: str) -> bool:
    """True when file descriptor `fd` IS `path` (same device + inode)."""
    try:
        a, b = os.fstat(fd), os.stat(path)
        return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)
    except (OSError, ValueError):
        return False


def log(msg: str) -> None:
    """Print, and append to LOG — unless stdout already IS the log, or this is the self-test.

    The cron line appends stdout to LOG, so appending here as well wrote every line TWICE (measured
    on the first cron-faithful run, 2026-10-12T08:28:56Z). Same class, same fix as the sibling
    client-claim-freshness.py: detected by inode, not an env flag, so a manual run still logs. The
    self-test prints only — its fixture rows read as live activation data in the production log
    (same day, 08:28:46Z)."""
    line = "%s %s" % (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), msg)
    print(line, flush=True)
    if _selftest_mode():
        return
    try:
        stdout_fd = sys.stdout.fileno()
    except (AttributeError, OSError, ValueError):
        stdout_fd = -1
    if stdout_fd >= 0 and _fd_is_file(stdout_fd, LOG):
        return
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # the log is evidence, not the contract; the token is the contract


# ── pure logic (fixture-drivable — what --self-test exercises) ──────────────────────────────────


def _int(s: str) -> int:
    try:
        return int(str(s).strip())
    except (TypeError, ValueError):
        return 0


_TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$")


def parse_ts(value):
    """A strict ISO-8601 instant → aware UTC datetime, or None. Strict on purpose: the windows this
    guard judges are decided by these values, so an unparseable one must be a refusal, never a guess
    (and `datetime.fromisoformat` differs between the hosts' 3.12 and an operator's 3.9)."""
    m = _TS_RE.match(str(value or ""))
    if not m:
        return None
    y, mo, d, h, mi, s, frac, tz = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), int((frac or "0").ljust(6, "0")))
    except ValueError:
        return None
    if tz == "Z":
        off = timedelta(0)
    else:
        sign = 1 if tz[0] == "+" else -1
        off = sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[4:6]))
    return (dt - off).replace(tzinfo=timezone.utc)


def midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def first_midnight_at_or_after(ts: datetime) -> datetime:
    """P0: the first UTC midnight at or after the change instant."""
    m = midnight(ts.date())
    return m if m == ts else m + DAY


def window_phase(start: datetime, end: datetime, change_at: datetime) -> str:
    """'post' iff the window starts at or after the change; 'pre' iff it ends at or before it;
    else 'straddles'. THE ONE classifier: every window this guard judges is classified here."""
    if start >= change_at:
        return "post"
    if end <= change_at:
        return "pre"
    return "straddles"


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_rows(text: str) -> dict:
    """psql `-tA -F|` output → structured aggregates. Unknown labels are ignored, never fatal."""
    out = {"calls_1d": [], "anthropic_30d": {"calls": 0, "buckets": 0}, "stepup_1d": [], "qhb_1d": [], "act": [], "actd": []}
    for line in text.splitlines():
        parts = line.split("|")
        if len(parts) < 2:
            continue
        label = parts[0]
        if label == "calls_1d" and len(parts) >= 5:
            out["calls_1d"].append({"pool": parts[1], "family": parts[2], "calls": _int(parts[3]), "buckets": _int(parts[4])})
        elif label == "anthropic_30d" and len(parts) >= 3:
            out["anthropic_30d"] = {"calls": _int(parts[1]), "buckets": _int(parts[2])}
        elif label == "stepup_1d" and len(parts) >= 5:
            out["stepup_1d"].append({"event": parts[1], "family": parts[2], "pool": parts[3], "count": _int(parts[4])})
        elif label == "qhb_1d" and len(parts) >= 4:
            out["qhb_1d"].append({"pool": parts[1], "events": _int(parts[2]), "sessions": _int(parts[3])})
        elif label == "act" and len(parts) >= 5:
            out["act"].append({"family": parts[1], "cur7": _int(parts[2]), "prev7": _int(parts[3]), "buckets7": _int(parts[4])})
        elif label == "actd" and len(parts) >= 4:
            try:
                day = date.fromisoformat(parts[2])
            except ValueError:
                continue
            out["actd"].append({"family": parts[1], "day": day, "n": _int(parts[3])})
    return out


def daily_by_family(actd: list[dict]) -> dict:
    """{family: {UTC day: first activations that day}} — the ONE first-activation series."""
    out: dict = {}
    for r in actd:
        fam = out.setdefault(r["family"], {})
        fam[r["day"]] = fam.get(r["day"], 0) + r["n"]
    return out


def pooled_daily(daily: dict) -> dict:
    out: dict = {}
    for series in daily.values():
        for d, n in series.items():
            out[d] = out.get(d, 0) + n
    return out


def window_total(series: dict, start: datetime, end: datetime) -> int:
    """Activations on the UTC days in [start, end) — both bounds are midnights."""
    total, d = 0, start.date()
    while d < end.date():
        total += series.get(d, 0)
        d += DAY
    return total


def window_daily(series: dict, start: datetime, end: datetime) -> str:
    """The per-day counts of [start, end), comma-joined, oldest first ('' for an empty window)."""
    out, d = [], start.date()
    while d < end.date():
        out.append(str(series.get(d, 0)))
        d += DAY
    return ",".join(out)


def weekly_from_daily(daily: dict, ref: datetime, weeks: int) -> dict:
    """{family: [A_0, …, A_(weeks-1)]}: A_j = activations in the j-th 7-day window before REF
    (j = 0 the most recent) — a projection of the daily series, never a second query."""
    out = {}
    for fam, series in daily.items():
        out[fam] = [window_total(series, ref - (j + 1) * WEEK_DAYS * DAY, ref - j * WEEK_DAYS * DAY)
                    for j in range(weeks)]
    return out


def evaluate_volume(act: list[dict]) -> list[dict]:
    """Call volume per family, last 7 complete days vs the 7 before. REPORTED, NEVER PAGED (Q1)."""
    out = []
    for row in sorted(act, key=lambda r: -r["prev7"]):
        prev, cur = row["prev7"], row["cur7"]
        drop = (prev - cur) / prev if prev > 0 else 0.0  # ratio-exempt: week-over-week change of ONE measure (one statement, one FROM/WHERE, two adjacent 7-day FILTER windows) — a signed delta, not an event rate over a population
        out.append({**row, "drop_pct": round(drop * 100, 1)})
    return out


def week_drop(prev: int, cur: int):
    """(prev - cur) / prev, or None when there was no prior week to fall from."""
    return (prev - cur) / prev if prev > 0 else None  # ratio-exempt: week-over-week change of ONE measure (one family's activating buckets in two adjacent 7-day windows of one statement) — a signed delta, not an event rate over a population


def compute_envelope(weekly: dict) -> dict:
    """Per family: the 7 pre-flip weekly counts, the 6 weekly drops (week j against week j+1; None
    where week j+1 had no activations) and their MAXIMUM — the envelope a live drop must exceed."""
    fams = {}
    for fam, a in weekly.items():
        a = (list(a) + [0] * (ENVELOPE_WEEKS + 1))[:ENVELOPE_WEEKS + 1]
        drops = [week_drop(a[j + 1], a[j]) for j in range(ENVELOPE_WEEKS)]
        defined = [d for d in drops if d is not None]
        fams[fam] = {
            "weekly": a,
            "drops_pct": [None if d is None else round(d * 100, 1) for d in drops],
            "envelope_pct": round(max(defined) * 100, 1) if defined else None,
        }
    return fams


def judge_week(prior: int, cur: int, env_pct):
    """(state, drop_pct) for one family's judged week — the CH4 ruling's rule, unchanged. States, in
    order: below_floor (prior < ACT_MIN_PRIOR_WEEK) · ok (drop < GUARD_DROP, or growth) ·
    no_envelope (no defined pre-flip drop — UNDEFINED, never a page) · within_envelope (drop <= the
    envelope) · breach. WHICH weeks reach it is decided by evaluate_weekly_leg, never here."""
    d = week_drop(prior, cur)
    drop_pct = None if d is None else round(d * 100, 1)
    if prior < ACT_MIN_PRIOR_WEEK:
        return "below_floor", drop_pct
    if d is None or d < GUARD_DROP:
        return "ok", drop_pct
    if env_pct is None:
        return "no_envelope", drop_pct
    if drop_pct <= env_pct:
        return "within_envelope", drop_pct
    return "breach", drop_pct


def change_point(env_doc, probe_version: str):
    """The guard's change instant and instrument, from the frozen envelope: ((flip, r0, version), None)
    when the guard can decide, else (None, reason). The reason is what an INDETERMINATE says."""
    if env_doc is None:
        return None, "no frozen activation envelope"
    flip = parse_ts(env_doc.get("flipped_at"))
    if flip is None:
        return None, ("the frozen envelope carries no readable flipped_at (%r) — the guard cannot tell "
                      "post-flip time from pre-flip time" % env_doc.get("flipped_at"))
    r0 = parse_ts(env_doc.get("reference_day"))
    if r0 is None or r0 != midnight(r0.date()) or r0 > flip:
        return None, "the frozen envelope's reference_day %r is not the flip's UTC midnight" % env_doc.get("reference_day")
    version = env_doc.get("ip_hash_version") or ENVELOPE_DEFAULT_IP_HASH_VERSION
    if probe_version != version:
        return None, ("ip-hash instrument changed since the envelope froze (envelope %s, deployed %s) — "
                      "re-freeze at the rotation" % (version, probe_version))
    return (flip, r0, version), None


def evaluate_weekly_leg(daily: dict, env_doc: dict, ref: datetime, flip: datetime):
    """(leg, rows). The judged week is cur = [REF - 7 d, REF); it is judged only when window_phase
    calls it `post` — before that every family is `not_due`, reported with the REF-anchored counts
    so the record still shows what moved. prior = [REF - 14 d, REF - 7 d) when `post`, else the
    envelope's weekly[0] (the last whole pre-flip week, frozen)."""
    p0 = first_midnight_at_or_after(flip)
    post_days = max(0, (ref - p0).days)
    cur_from, cur_to = ref - WEEK_DAYS * DAY, ref
    prior_from, prior_to = ref - 2 * WEEK_DAYS * DAY, ref - WEEK_DAYS * DAY
    phase = window_phase(cur_from, cur_to, flip)
    prior_phase = window_phase(prior_from, prior_to, flip)
    due = phase == "post"
    prior_source = "measured" if (not due or prior_phase == "post") else "envelope_week0"
    env_fams = env_doc.get("families") or {}
    rows = []
    for fam in set(daily) | set(env_fams):
        series = daily.get(fam, {})
        env_row = env_fams.get(fam) or {}
        cur = window_total(series, cur_from, cur_to)
        if prior_source == "measured":
            prior = window_total(series, prior_from, prior_to)
        else:
            prior = _int((env_row.get("weekly") or [0])[0])
        env_pct = env_row.get("envelope_pct")
        state, drop_pct = judge_week(prior, cur, env_pct)
        rows.append({"family": fam, "prev_w": prior, "cur_w": cur, "drop_pct": drop_pct,
                     "envelope_pct": env_pct, "state": state if due else "not_due",
                     "daily": window_daily(series, cur_from, cur_to)})
    rows.sort(key=lambda j: (-j["prev_w"], -j["cur_w"], j["family"]))
    leg = {"state": "judged" if due else "not_due", "window_from": iso(cur_from), "window_to": iso(cur_to),
           "phase": phase, "prior_from": iso(prior_from), "prior_to": iso(prior_to), "prior_phase": prior_phase,
           "prior_source": prior_source, "post_days": post_days, "flipped_at": iso(flip)}
    if not due:
        leg["due_run"] = (p0 + WEEK_DAYS * DAY).date().isoformat()
    return leg, rows


def evaluate_early_leg(daily: dict, ref: datetime, flip: datetime, r0: datetime) -> dict:
    """Pooled activations over the first post-flip days [P0, REF), against the smallest pooled total
    of any run of the same length inside [R0 - 42 d, R0). post and pre_min are recorded in every
    state; only 2 <= L <= 6 can page."""
    p0 = first_midnight_at_or_after(flip)
    post_days = max(0, (ref - p0).days)
    pooled = pooled_daily(daily)
    start = p0 if ref > p0 else ref
    post = window_total(pooled, start, ref)
    pre_min = None
    if 1 <= post_days <= EARLY_LOOKBACK_DAYS:
        lo = r0 - EARLY_LOOKBACK_DAYS * DAY
        pre_min = min(window_total(pooled, lo + i * DAY, lo + (i + post_days) * DAY)
                      for i in range(EARLY_LOOKBACK_DAYS - post_days + 1))
    if post_days < EARLY_FIRST_DAY:
        state = "not_due"
    elif post_days >= WEEK_DAYS:
        state = "retired"
    elif pre_min is None or pre_min < EARLY_MIN_PRE:
        state = "below_floor"
    elif EARLY_COLLAPSE_FACTOR * post < pre_min:
        state = "early_collapse"
    else:
        state = "ok"
    leg = {"state": state, "window_from": iso(start), "window_to": iso(ref), "phase": window_phase(start, ref, flip),
           "post_days": post_days, "post": post, "pre_min": pre_min, "daily": window_daily(pooled, start, ref),
           "flipped_at": iso(flip)}
    if state == "not_due":
        leg["due_run"] = (p0 + EARLY_FIRST_DAY * DAY).date().isoformat()
    return leg


def load_envelope(path=None):
    """(document, None) for a readable frozen envelope, else (None, reason)."""
    target = path or ENVELOPE_PATH
    try:
        doc = json.loads(Path(target).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "absent at %s" % target
    except (OSError, ValueError) as e:
        return None, "unreadable: %s" % str(e)[:120]
    if not isinstance(doc, dict) or not isinstance(doc.get("families"), dict) or not doc.get("reference_day"):
        return None, "malformed (no families / reference_day)"
    return doc, None


def series_from_for(env_doc) -> str | None:
    """The lookback the probe must cover for the early leg: [R0 - 42 d, …). None ⇒ the probe's own
    default (REF - 2 weeks), which is all the weekly leg needs."""
    r0 = parse_ts((env_doc or {}).get("reference_day"))
    return iso(r0 - EARLY_LOOKBACK_DAYS * DAY) if r0 else None


def build_metrics(probe: dict, rows: dict, weekly_rows: list, volume=None, envelope=None, envelope_reason=None,
                  weekly_leg=None, early_leg=None, guard_reason=None) -> dict:
    """The record body. Compact on purpose: canary_result_log refuses a line over 8 KiB."""
    by_pool: dict = {}
    for r in rows["calls_1d"]:
        p = by_pool.setdefault(r["pool"], {"calls": 0, "buckets": 0, "families": {}})
        p["calls"] += r["calls"]
        p["buckets"] += r["buckets"]
        p["families"][r["family"]] = r["calls"]
    for p in by_pool.values():
        top = sorted(p["families"].items(), key=lambda kv: -kv[1])[:TOP_FAMILIES]
        p["families"] = dict(top)
    a30 = rows["anthropic_30d"]
    breaches = sum(1 for j in weekly_rows if j["state"] == "breach") + (1 if (early_leg or {}).get("state") == "early_collapse" else 0)
    return {
        "mode": probe.get("mode"),
        "n_ruled": probe.get("n"),
        "day": (probe.get("d0") or "")[:10],
        "free_metered_1d": by_pool,
        "stepup_events_1d": rows["stepup_1d"][:TOP_FAMILIES * 2],
        "quota_hit_block_1d": rows["qhb_1d"],
        "anthropic_calls_30d": a30["calls"],
        "anthropic_buckets_30d": a30["buckets"],
        "oauth_trigger": "MET" if a30["calls"] >= OAUTH_TRIGGER_CALLS else "NOT_MET",
        "activation": [
            {k: j[k] for k in ("family", "prev_w", "cur_w", "drop_pct", "envelope_pct", "state", "daily")}
            for j in weekly_rows[:TOP_FAMILIES]
        ],
        "activation_breaches": breaches,
        "activation_legs": ({"weekly": weekly_leg, "early": early_leg} if guard_reason is None
                            else {"state": "undecidable", "reason": guard_reason[:200]}),
        "ip_hash_version": probe.get("ip_hash_version"),
        "envelope": ({"reference_day": envelope.get("reference_day"), "frozen_at": envelope.get("computed_at"),
                      "flipped_at": envelope.get("flipped_at"),
                      "ip_hash_version": envelope.get("ip_hash_version") or ENVELOPE_DEFAULT_IP_HASH_VERSION}
                     if envelope else {"state": envelope_reason or "absent"}),
        "volume": [
            {k: v[k] for k in ("family", "prev7", "cur7", "drop_pct", "buckets7")}
            for v in (volume or [])[:TOP_FAMILIES]
        ],
        "guard_armed": probe.get("mode") == "live",
        "units": "activation = buckets whose FIRST successful free metered call fell in the window; volume = calls (reported, never paged); buckets are distinct ip buckets, not people",
    }


def should_page(mode: str) -> bool:
    """The guard is ARMED only in `live` — the only mode in which the step-up changes what a caller
    receives. In off/shadow a breach is organic churn by construction, so it is reported, not paged."""
    return mode == "live"


def _day_span(frm: str, to: str) -> str:
    """'[2026-10-13, 2026-10-20)' — the judged UTC days, end exclusive."""
    return "[%s, %s)" % (frm[:10], to[:10])


def finding_envelopes(weekly_leg, weekly_rows: list, early_leg, run_id: str, started_at: str, produced_at: str,
                      schema_version: int) -> list:
    """One DETECTOR_ENVELOPE per pageable finding: each weekly breach (one per client family) and an
    early collapse. change_point = the frozen flip, so the contract itself refuses any of them whose
    observation window starts before it. Evidence is measured scalars only (the D2 rule)."""
    def envelope(leg: dict, evidence: dict) -> dict:
        return {
            "schema_version": schema_version, "detector": DETECTOR, "verdict": "FAIL", "run_id": run_id,
            "run_started_at": started_at, "run_outcome": "complete", "produced_at": produced_at,
            "observation_window": {"from": leg["window_from"], "to": leg["window_to"]},
            "change_point": {"at": leg["flipped_at"], "source": CHANGE_POINT_SOURCE},
            "evidence": evidence,
        }
    out = []
    for j in weekly_rows:
        if j["state"] == "breach":
            out.append(envelope(weekly_leg, {
                "client_family": j["family"], "cur": j["cur_w"], "prior": j["prev_w"],
                "prior_source": weekly_leg["prior_source"], "drop_pct": j["drop_pct"],
                "envelope_pct": j["envelope_pct"], "post_days": weekly_leg["post_days"], "daily": j["daily"]}))
    if (early_leg or {}).get("state") == "early_collapse":
        out.append(envelope(early_leg, {
            "pooled": "all client families", "cur": early_leg["post"], "pre_min": early_leg["pre_min"],
            "post_days": early_leg["post_days"], "daily": early_leg["daily"]}))
    return out


def build_body(envelopes: list, render) -> str:
    """Operator-facing body: `render_body(envelope)` for every finding — measured fields only, so it
    names the judged window, its post-flip day count and the per-day series and cannot assert a
    mechanism — then the rollback and action lines. Every envelope that reaches here was FORWARDed
    as FAIL by the contract, which refuses a window that starts before the change."""
    lines = ["\U0001F6D1 %s" % ALERT_ID, ""]
    for env in envelopes:
        lines += [render(env), ""]
    lines += ["Read the daily stepup-readout records (vault Claude files/canary-results.jsonl) beside the",
              "STEPUP_MODE in force. Rollback lever: STEPUP_MODE=shadow|off through an interlocked recreate.",
              "Action: dispatch OPS-STEPUP-ACTIVATION-W{NEXT}"]
    return "\n".join(lines)


def envelope_module():
    """`detector_envelope.py` is an ARTIFACT installed BESIDE this file on the host (a sibling in the
    repo), never vendored — the same import every other adopter makes."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import detector_envelope as de  # noqa: E402,PLC0415
    return de


def gate_findings(envelopes: list, run_id: str):
    """(forwarded envelopes, None) when the contract FORWARDs every finding as FAIL, else
    (None, reason). An unavailable module, an unreadable schema or ANY refusal is the reason —
    the caller turns it into INDETERMINATE, never into a page and never into a silent pass."""
    try:
        de = envelope_module()
        schema = de.load_schema()
    except Exception as e:  # noqa: BLE001 — a contract we cannot load decides nothing
        return None, "detector_envelope unavailable: %s" % str(e)[:160]
    for env in envelopes:
        d = de.decide(env, run_id, schema=schema)
        if not (d.action == de.FORWARD and d.verdict == "FAIL"):
            return None, "DETECTOR_ENVELOPE refused a self-built envelope (%s %s): %s" % (d.action, d.verdict, d.reason[:200])
    return (envelopes, lambda env: de.render_body(env, schema)), None


# ── effects ───────────────────────────────────────────────────────────────────────────────────────


def _selftest_mode() -> bool:
    return os.environ.get("STEPUP_READOUT_SELFTEST") == "1"


def fire(body: str) -> None:
    LAST_FIRE[ALERT_ID] = body
    if _selftest_mode():
        log("WOULD_FIRE: %s (self-test — wrapper skipped)" % ALERT_ID)
        return
    proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"],
                          input=body, capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def clear(reason: str) -> None:
    LAST_CLEAR[ALERT_ID] = reason
    if _selftest_mode():
        log("WOULD_CLEAR: %s (self-test — wrapper skipped)" % ALERT_ID)
        return
    with open(os.devnull, "rb") as devnull:
        proc = subprocess.run([WRAPPER, "--clear", ALERT_ID, reason],
                              stdin=devnull, capture_output=True, text=True, timeout=30)
    log("wrapper --clear exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


PROBE_KEYS = ("mode", "n", "d0", "d1", "ref", "weeks", "ip_hash_version", "series_from", "sql")


def run_probe(ref_iso=None, weeks=None, series_from=None) -> dict:
    env_args = []
    if ref_iso:
        env_args += ["-e", "STEPUP_REF_ISO=%s" % ref_iso]
    if weeks:
        env_args += ["-e", "STEPUP_WEEKS=%d" % int(weeks)]
    if series_from:
        env_args += ["-e", "STEPUP_SERIES_FROM=%s" % series_from]
    proc = subprocess.run(["docker", "exec"] + env_args + [APP_CONTAINER, "node", "-e", PROBE_JS],
                          capture_output=True, text=True, timeout=90)
    if proc.returncode != 0:
        raise RuntimeError("probe exit %d: %s" % (proc.returncode, (proc.stderr or "").strip()[:200]))
    probe = json.loads(proc.stdout)
    for key in PROBE_KEYS:
        if key not in probe:
            raise RuntimeError("probe output lacks %r" % key)
    if probe["mode"] not in ("off", "shadow", "live"):
        raise RuntimeError("probe mode %r is not a resolved mode" % probe["mode"])
    return probe


def run_sql(sql: str) -> str:
    proc = subprocess.run(
        ["docker", "exec", "-i", "-e", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=60000",
         PG_CONTAINER, "psql", "-U", PG_ROLE, "-d", PG_DB, "-tA", "-F", "|", "-q", "-v", "ON_ERROR_STOP=1"],
        input=sql, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError("psql exit %d: %s" % (proc.returncode, (proc.stderr or "").strip()[:200]))
    return proc.stdout


def record(verdict: str, exit_code: int, metrics: dict) -> None:
    if _selftest_mode():
        LAST_RECORD[:] = [verdict, exit_code, metrics]
        print("CANARY_RESULT_LOG=selftest-skipped", flush=True)
        return
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import canary_result_log  # noqa: E402 — lives beside this file on the host
        ok, detail = canary_result_log.append_result(CANARY, verdict, exit_code, metrics)
    except Exception as e:  # noqa: BLE001 — a recorder failure must never change the verdict
        ok, detail = False, "import/append raised: %s" % str(e)[:160]
    print("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail, flush=True)


def finish(verdict: str, code: int) -> int:
    print("STEPUP_READOUT_VERDICT=%s" % verdict, flush=True)
    return code


SCHEMA_VERSION = 1  # the DETECTOR_ENVELOPE schema_version this producer emits; the consumer's own check rejects a drift


def main() -> int:
    started_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run_id = "stepup-readout-%s" % started_at
    env_doc, env_reason = load_envelope()
    try:
        probe = run_probe(series_from=series_from_for(env_doc))
        rows = parse_rows(run_sql(probe["sql"]))
        ref = parse_ts(probe["ref"])
        if ref is None:
            raise RuntimeError("probe ref %r is not an ISO-8601 instant" % probe["ref"])
    except Exception as e:  # noqa: BLE001 — could not evaluate: INDETERMINATE, never a default
        log("INDETERMINATE: %s" % str(e)[:240])
        record("INDETERMINATE", 3, {"reason": str(e)[:200]})
        return finish("INDETERMINATE", 3)
    volume = evaluate_volume(rows["act"])
    daily = daily_by_family(rows["actd"])
    cp, guard_reason = change_point(env_doc, probe["ip_hash_version"])
    if env_doc is None:
        guard_reason = "no frozen activation envelope (%s) — run --freeze-envelope --flip-at <flip instant>" % env_reason
    weekly_leg = early_leg = None
    weekly_rows: list = []
    if cp is not None:
        flip, r0, _ver = cp
        need_from = parse_ts(series_from_for(env_doc))
        got_from = parse_ts(probe["series_from"])
        if got_from is None or need_from is None or got_from > need_from:
            guard_reason = ("the probe's series starts at %s, after the %s the early leg needs"
                            % (probe["series_from"], series_from_for(env_doc)))
        else:
            weekly_leg, weekly_rows = evaluate_weekly_leg(daily, env_doc, ref, flip)
            early_leg = evaluate_early_leg(daily, ref, flip, r0)
    metrics = build_metrics(probe, rows, weekly_rows, volume, env_doc, env_reason, weekly_leg, early_leg, guard_reason)
    if weekly_leg is not None:
        log("ACTIVATION_LEG leg=weekly state=%s window=%s phase=%s post_days=%d prior=%s(%s)%s"
            % (weekly_leg["state"], _day_span(weekly_leg["window_from"], weekly_leg["window_to"]), weekly_leg["phase"],
               weekly_leg["post_days"], weekly_leg["prior_source"], weekly_leg["prior_phase"],
               (" due_run=%s" % weekly_leg["due_run"]) if "due_run" in weekly_leg else ""))
        for j in weekly_rows:
            log("ACTIVATION family=%s prev_w=%d cur_w=%d drop_pct=%s envelope_pct=%s state=%s daily=%s"
                % (j["family"], j["prev_w"], j["cur_w"], j["drop_pct"], j["envelope_pct"], j["state"], j["daily"]))
        log("ACTIVATION_LEG leg=early state=%s window=%s phase=%s post_days=%d post=%d pre_min=%s daily=%s%s"
            % (early_leg["state"], _day_span(early_leg["window_from"], early_leg["window_to"]), early_leg["phase"],
               early_leg["post_days"], early_leg["post"], early_leg["pre_min"], early_leg["daily"],
               (" due_run=%s" % early_leg["due_run"]) if "due_run" in early_leg else ""))
    else:
        log("ACTIVATION_LEGS undecidable: %s" % guard_reason)
    for v in volume:
        log("VOLUME family=%s prev7=%d cur7=%d drop_pct=%s (reported, never paged)"
            % (v["family"], v["prev7"], v["cur7"], v["drop_pct"]))
    log("POOLS %s" % json.dumps(metrics["free_metered_1d"], separators=(",", ":"))[:600])
    log("OAUTH_TRIGGER=%s anthropic_calls_30d=%d" % (metrics["oauth_trigger"], metrics["anthropic_calls_30d"]))
    log("ENVELOPE %s · IP_HASH_VERSION=%s" % (("frozen, reference_day=%s flipped_at=%s" % (env_doc.get("reference_day"), env_doc.get("flipped_at")))
                                             if env_doc else env_reason, probe["ip_hash_version"]))
    if should_page(probe["mode"]) and guard_reason is not None:
        log("INDETERMINATE: STEPUP_MODE=live but the activation guard cannot decide — %s" % guard_reason)
        record("INDETERMINATE", 3, metrics)
        return finish("INDETERMINATE", 3)
    pageable = metrics["activation_breaches"] > 0
    if pageable:
        produced_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        envelopes = finding_envelopes(weekly_leg, weekly_rows, early_leg, run_id, started_at, produced_at,
                                      SCHEMA_VERSION)
        gated, refusal = gate_findings(envelopes, run_id)
        metrics["envelopes"] = {"built": len(envelopes), "forwarded": 0 if gated is None else len(gated[0]),
                                "refusal": refusal[:240] if refusal else None}
        if refusal is not None:
            log("INDETERMINATE: %s" % refusal)
            record("INDETERMINATE", 3, metrics)
            return finish("INDETERMINATE", 3)
        log("ENVELOPES forwarded=%d (DETECTOR_ENVELOPE FORWARD/FAIL, change_point %s)" % (len(gated[0]), weekly_leg["flipped_at"]))
    if pageable and should_page(probe["mode"]):
        fire(build_body(gated[0], gated[1]))
        record("FAIL", 0, metrics)
        return finish("FAIL", 0)
    if pageable:
        log("ACTIVATION_BREACH_REPORTED=%d (mode=%s — the guard pages only in live)" % (metrics["activation_breaches"], probe["mode"]))
    clear("no paged activation breach (mode=%s)" % probe["mode"])
    record("PASS", 0, metrics)
    return finish("PASS", 0)


def freeze_envelope(flip_at_iso: str, force: bool = False) -> int:
    """Compute the activation envelope from request_log for the 7 weeks before the flip's UTC day
    and freeze it at ENVELOPE_PATH. Refuses to overwrite a frozen envelope without --force: the
    envelope is the PRE-flip baseline, and recomputing it later would fold post-flip weeks in.
    It records the ip-hash version it was frozen under, so a later rotation is a visible change
    point rather than a silent collapse. The weekly counts are projected from the same daily
    first-activation series the daily run judges — one derivation for both.
    Token: STEPUP_ENVELOPE_VERDICT=WRITTEN|EXISTS|INDETERMINATE (exit 0/0/3)."""
    if os.path.exists(ENVELOPE_PATH) and not force:
        log("ENVELOPE_EXISTS at %s — refusing to overwrite the frozen pre-flip baseline" % ENVELOPE_PATH)
        print("STEPUP_ENVELOPE_VERDICT=EXISTS", flush=True)
        return 0
    try:
        probe = run_probe(ref_iso=flip_at_iso, weeks=ENVELOPE_WEEKS + 1)
        rows = parse_rows(run_sql(probe["sql"]))
        ref = parse_ts(probe["ref"])
        if ref is None:
            raise RuntimeError("probe ref %r is not an ISO-8601 instant" % probe["ref"])
    except Exception as e:  # noqa: BLE001
        log("ENVELOPE_INDETERMINATE: %s" % str(e)[:240])
        print("STEPUP_ENVELOPE_VERDICT=INDETERMINATE", flush=True)
        return 3
    fams = compute_envelope(weekly_from_daily(daily_by_family(rows["actd"]), ref, ENVELOPE_WEEKS + 1))
    if not fams:
        log("ENVELOPE_INDETERMINATE: zero activating families before %s — nothing to freeze" % probe.get("ref"))
        print("STEPUP_ENVELOPE_VERDICT=INDETERMINATE", flush=True)
        return 3
    doc = {
        "flipped_at": flip_at_iso,
        "reference_day": probe["ref"],
        "weeks": ENVELOPE_WEEKS + 1,
        "mode_at_freeze": probe["mode"],
        "ip_hash_version": probe["ip_hash_version"],
        "computed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rule": ("weekly activations = buckets whose first successful free metered call fell in each 7-day "
                 "window before reference_day (weekly[0] most recent); drops_pct[j] = week j against week j+1; "
                 "envelope_pct = the largest defined drop. A live drop pages only if prior >= %d, drop >= %d %% "
                 "and drop > envelope_pct." % (ACT_MIN_PRIOR_WEEK, int(GUARD_DROP * 100))),
        "families": fams,
    }
    tmp = ENVELOPE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, ENVELOPE_PATH)
    for fam, f in sorted(fams.items(), key=lambda kv: -sum(kv[1]["weekly"])):
        log("ENVELOPE family=%s weekly=%s envelope_pct=%s" % (fam, f["weekly"], f["envelope_pct"]))
    print("STEPUP_ENVELOPE_VERDICT=WRITTEN", flush=True)
    return 0


# ── self-test ─────────────────────────────────────────────────────────────────────────────────────


def _selftest_log(check) -> None:
    """log() against a temp LOG: the self-test never appends, a manual run appends once, and a run
    whose stdout IS the log (the cron redirect) leaves one copy, not two."""
    import shutil
    import tempfile
    global LOG
    saved_log, saved_env = LOG, os.environ.get("STEPUP_READOUT_SELFTEST")
    tmpd = tempfile.mkdtemp(prefix="stepup-log-")
    try:
        LOG = os.path.join(tmpd, "a.log")
        log("selftest-line")
        check("log: the self-test never appends to the production log",
              not os.path.exists(LOG) or os.path.getsize(LOG) == 0)
        os.environ["STEPUP_READOUT_SELFTEST"] = "0"
        log("manual-line")
        check("log: a run whose stdout is NOT the log appends exactly once",
              open(LOG, encoding="utf-8").read().count("manual-line") == 1)
        LOG = os.path.join(tmpd, "b.log")
        with open(LOG, "a", encoding="utf-8") as fh:
            real = sys.stdout
            sys.stdout = fh
            try:
                log("cron-line")
            finally:
                sys.stdout = real
        check("log: stdout already IS the log (the cron redirect) → one copy, not two",
              open(LOG, encoding="utf-8").read().count("cron-line") == 1)
    finally:
        LOG = saved_log
        os.environ["STEPUP_READOUT_SELFTEST"] = saved_env if saved_env is not None else "1"
        shutil.rmtree(tmpd, ignore_errors=True)


# The measured world these fixtures stand in for (OPS-STEPUP-ACTIVATION-W1 R1.0, signal-1, aoe_readonly).
_FLIP = "2026-10-12T11:24:01Z"
_R0 = "2026-10-12T00:00:00.000Z"
_NODE_PREV = [1, 6, 7, 7, 3, 9, 3]       # node first activations 2026-09-29 … 10-05 (Σ 36)
_NODE_ALERT = [1, 0, 2, 2, 3, 4, 1]      # node first activations 2026-10-06 … 10-12 (Σ 13, all pre-flip)


def _actd(spec: dict) -> str:
    """{family: {'YYYY-MM-DD': n}} → psql `actd` rows."""
    return "\n".join("actd|%s|%s|%d|" % (fam, day, n) for fam, days in spec.items() for day, n in sorted(days.items()))


def _days(first: str, counts: list) -> dict:
    d0 = date.fromisoformat(first)
    return {(d0 + i * DAY).isoformat(): n for i, n in enumerate(counts) if n}


def _probe(mode: str, ref: str, version: str = "v2") -> dict:
    r = parse_ts(ref)
    return {"mode": mode, "n": 20, "d0": iso(r - DAY), "d1": iso(r), "ref": ref, "weeks": 2,
            "ip_hash_version": version, "series_from": "2026-08-31T00:00:00.000Z", "sql": "-"}


def self_test() -> int:
    os.environ["STEPUP_READOUT_SELFTEST"] = "1"
    fails = []
    ran = 0

    def check(name, fn):
        nonlocal ran
        ran += 1
        try:
            ok = bool(fn() if callable(fn) else fn)
        except Exception as e:  # noqa: BLE001 — an assertion that raises is reported, not crashed
            ok = False
            name = "%s (raised %s)" % (name, e)
        print("  %s %s" % ("PASS" if ok else "FAIL", name))
        if not ok:
            fails.append(name)

    fixture = "\n".join([
        "calls_1d|other|python-requests|300|4",
        "calls_1d|other|node|120|30",
        "calls_1d|anthropic|claude|5|1",
        "anthropic_30d|64|1||",
        "stepup_1d|stepup_would_gate|node|other|3",
        "qhb_1d|other|1200|3|",
        "act|python-requests|900|1500|5",   # volume: −40 % — REPORTED, never paged
        "act|node|700|800|90",
        "actd|node|2026-10-06|1|", "actd|node|2026-10-06|2|",          # same family + day sums
        "actd|node|not-a-day|9|",                                       # unparseable day → ignored
        "garbage line",
        "unknown_label|1|2|3|4",
    ])
    rows = parse_rows(fixture)
    check("parse: every labelled row lands in its bucket",
          len(rows["calls_1d"]) == 3 and rows["anthropic_30d"] == {"calls": 64, "buckets": 1}
          and len(rows["stepup_1d"]) == 1 and len(rows["qhb_1d"]) == 1 and len(rows["act"]) == 2
          and len(rows["actd"]) == 2)
    check("parse: the daily series sums one family's rows per UTC day",
          daily_by_family(rows["actd"]) == {"node": {date(2026, 10, 6): 3}})

    # ── the window primitives ──
    flip = parse_ts(_FLIP)
    p0 = first_midnight_at_or_after(flip)
    check("time: P0 is the first UTC midnight AFTER an intra-day flip", iso(p0) == "2026-10-13T00:00:00Z")
    check("time: a flip exactly at midnight is its own P0",
          first_midnight_at_or_after(parse_ts("2026-10-12T00:00:00Z")) == parse_ts("2026-10-12T00:00:00Z"))
    check("time: parse_ts is strict — a bare date and a naive instant are refused",
          parse_ts("2026-10-12") is None and parse_ts("2026-10-12T11:24:01") is None
          and parse_ts("2026-10-12T13:24:01+02:00") == flip)
    d = lambda s: parse_ts(s + "T00:00:00Z")  # noqa: E731
    check("phase: a window starting at the flip day's next midnight is post",
          window_phase(d("2026-10-13"), d("2026-10-20"), flip) == "post")
    check("phase: a window ending at or before the flip instant is pre",
          window_phase(d("2026-10-05"), d("2026-10-12"), flip) == "pre"
          and window_phase(d("2026-10-05"), flip, flip) == "pre")
    check("phase: the alert's week [10-06, 10-13) straddles the flip",
          window_phase(d("2026-10-06"), d("2026-10-13"), flip) == "straddles")
    check("phase: a window starting exactly at the change instant is post", window_phase(flip, d("2026-10-20"), flip) == "post")

    # ── the envelope, as frozen on 2026-10-12, and its re-derivation from the daily series ──
    env_fams = compute_envelope({
        "node": [15, 35, 26, 10, 23, 33, 61],               # measured pre-flip shape, 2026-10-12
        "python-requests": [1, 2, 8, 4, 0, 0, 0],
        "silent": [0, 0, 0, 0, 0, 0, 0],
    })
    check("envelope: node's largest pre-flip weekly drop is 57.1 %", env_fams["node"]["envelope_pct"] == 57.1)
    check("envelope: weeks with no prior activations are UNDEFINED drops, never zeros",
          env_fams["python-requests"]["drops_pct"][3:] == [None, None, None]
          and env_fams["python-requests"]["envelope_pct"] == 75.0)
    check("envelope: a family that never activated has NO envelope (undefined, not 0 %)",
          env_fams["silent"]["envelope_pct"] is None)
    r0 = parse_ts(_R0)
    one_day_per_week = {"node": {(r0.date() - (7 * j + 1) * DAY): n for j, n in enumerate([15, 35, 26, 10, 23, 33, 61])}}
    check("envelope: weekly counts are a projection of the ONE daily series (A_j = days in [R0-7(j+1), R0-7j))",
          weekly_from_daily(one_day_per_week, r0, 7) == {"node": [15, 35, 26, 10, 23, 33, 61]})
    env_doc = {"flipped_at": _FLIP, "reference_day": _R0, "computed_at": "2026-10-12T11:24:44Z", "families": env_fams}

    # ── the ladder (unchanged) ──
    check("judge: prior exactly 5 is enough (5 → 1, −80 % > 50 %)", judge_week(5, 1, 50.0)[0] == "breach")
    check("judge: prior 4 is not (4 → 0)", judge_week(4, 0, 50.0)[0] == "below_floor")
    check("judge: a drop EQUAL to the envelope is within it — the ruling says LARGER", judge_week(10, 5, 50.0)[0] == "within_envelope")
    check("judge: the 30 % boundary is inclusive (and 30 > a 25 % envelope)", judge_week(10, 7, 25.0)[0] == "breach")
    check("judge: no envelope row is no_envelope — UNDEFINED, never a page", judge_week(9, 1, None)[0] == "no_envelope")
    check("judge: growth is ok", judge_week(6, 12, 10.0)[0] == "ok")

    def world(node_from: str, node_counts: list, extra=None) -> dict:
        spec = {"node": _days("2026-09-29", _NODE_PREV + _NODE_ALERT)}
        spec["node"].update(_days(node_from, node_counts))
        for fam, days in (extra or {}).items():
            spec.setdefault(fam, {}).update(days)
        return daily_by_family(parse_rows(_actd(spec))["actd"])

    # T1 — today's page, reproduced in both directions.
    ref1 = parse_ts("2026-10-13T00:00:00.000Z")
    leg1, rows1 = evaluate_weekly_leg(world("2026-10-13", []), env_doc, ref1, flip)
    node1 = next(j for j in rows1 if j["family"] == "node")
    check("T1: the 2026-10-13 run is not_due — 0 whole post-flip days, the judged week straddles",
          leg1["state"] == "not_due" and leg1["post_days"] == 0 and leg1["phase"] == "straddles" and node1["state"] == "not_due")
    check("T1: the record still shows what moved — node 36 → 13 on the REF-anchored weeks",
          node1["prev_w"] == 36 and node1["cur_w"] == 13 and node1["daily"] == "1,0,2,2,3,4,1")
    check("T1: the SAME inputs through the pre-fix rule page (36 → 13 = −63.9 % > 57.1 %) — the reproduction is proven",
          judge_week(36, 13, 57.1) == ("breach", 63.9))
    check("T1: due_run is the UTC day of the first post-flip week's run", leg1.get("due_run") == "2026-10-20")

    # T2 — REF 2026-10-20: the first judged week; its prior straddles, so the envelope's week 0 stands in.
    ref2 = parse_ts("2026-10-20T00:00:00.000Z")
    leg2, rows2 = evaluate_weekly_leg(world("2026-10-13", [1, 0, 0, 1, 0, 2, 0]), env_doc, ref2, flip)
    node2 = next(j for j in rows2 if j["family"] == "node")
    check("T2: the week [10-13, 10-20) is judged — post by construction, 7 post-flip days",
          leg2["state"] == "judged" and leg2["phase"] == "post" and leg2["post_days"] == 7 and "due_run" not in leg2)
    check("T2: a straddling prior is never judged — envelope_week0 (15) stands in",
          leg2["prior_phase"] == "straddles" and leg2["prior_source"] == "envelope_week0" and node2["prev_w"] == 15)
    check("T2: 15 → 4 = −73.3 % > 57.1 % is a breach", node2["cur_w"] == 4 and node2["drop_pct"] == 73.3 and node2["state"] == "breach")

    # T3 — same week, a fall inside the guard.
    _l3, rows3 = evaluate_weekly_leg(world("2026-10-13", [2, 2, 2, 2, 2, 1, 1]), env_doc, ref2, flip)
    node3 = next(j for j in rows3 if j["family"] == "node")
    check("T3: 15 → 12 = −20 % is ok", node3["cur_w"] == 12 and node3["drop_pct"] == 20.0 and node3["state"] == "ok")

    # T4 — REF 2026-10-27: the prior week is post-flip, so it is MEASURED.
    ref4 = parse_ts("2026-10-27T00:00:00.000Z")
    leg4, rows4 = evaluate_weekly_leg(world("2026-10-13", [2, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1]), env_doc, ref4, flip)
    node4 = next(j for j in rows4 if j["family"] == "node")
    check("T4: a post-flip prior week is measured, not substituted",
          leg4["prior_phase"] == "post" and leg4["prior_source"] == "measured" and node4["prev_w"] == 10 and node4["cur_w"] == 7)

    # The early leg — pooled, post-flip days 2..6, against the worst pre-flip run of the same length.
    def early_world(pre_daily: list, post_daily: list) -> dict:
        pre = _days("2026-08-31", pre_daily)           # [R0 - 42 d, R0) = 2026-08-31 … 10-11
        post = _days("2026-10-13", post_daily)
        return daily_by_family(parse_rows(_actd({"node": {**pre}, "other": post}))["actd"])

    flat3 = [3] * 42
    e5 = evaluate_early_leg(early_world(flat3, [1, 1]), parse_ts("2026-10-15T00:00:00.000Z"), flip, r0)
    check("T5: L = 2, pooled post 2 against pre_min 6 → early_collapse",
          e5["state"] == "early_collapse" and e5["post"] == 2 and e5["pre_min"] == 6 and e5["post_days"] == 2
          and e5["daily"] == "1,1" and e5["phase"] == "post")
    e6 = evaluate_early_leg(early_world(flat3, [2, 1]), parse_ts("2026-10-15T00:00:00.000Z"), flip, r0)
    check("T6: post 3 against pre_min 6 is not a collapse (exactly half is not below half)",
          e6["state"] == "ok" and e6["post"] == 3 and e6["pre_min"] == 6)
    dip = [3] * 42
    dip[20] = 0
    e7 = evaluate_early_leg(early_world(dip, [0, 0]), parse_ts("2026-10-15T00:00:00.000Z"), flip, r0)
    check("T7: a worst pre-flip run of 3 is under the floor — below_floor, never a page, even at post 0",
          e7["state"] == "below_floor" and e7["pre_min"] == 3 and e7["post"] == 0)
    e8 = evaluate_early_leg(early_world(flat3, [0]), parse_ts("2026-10-14T00:00:00.000Z"), flip, r0)
    check("T8: L = 1 is not_due, and still carries post and pre_min",
          e8["state"] == "not_due" and e8["post_days"] == 1 and e8["post"] == 0 and e8["pre_min"] == 3
          and e8.get("due_run") == "2026-10-15")
    e0 = evaluate_early_leg(early_world(flat3, []), ref1, flip, r0)
    check("early: L = 0 (the first run after the flip) is not_due with an empty window",
          e0["state"] == "not_due" and e0["post_days"] == 0 and e0["post"] == 0 and e0["pre_min"] is None and e0["daily"] == "")
    e9 = evaluate_early_leg(early_world(flat3, [0] * 7), ref2, flip, r0)
    check("early: L = 7 is retired — the weekly leg owns it", e9["state"] == "retired")
    check("early: the measured 2026-10-12 population gives pre_min 0 / 3 / 8 at L = 2 / 3 / 4",
          [evaluate_early_leg(early_world([5, 7, 4, 7, 7, 0, 6, 8, 5, 2, 10, 3, 0, 0, 8, 2, 4, 2, 0, 6, 2, 5, 9, 7, 2, 4, 8,
                                           6, 6, 1, 7, 12, 7, 3, 10, 3, 2, 1, 4, 3, 5, 4], [9] * L),
                              parse_ts(iso(p0 + L * DAY)), flip, r0)["pre_min"] for L in (2, 3, 4)] == [0, 3, 8])

    # T9 / T10 — the guard refuses to decide on a changed instrument or a missing change instant.
    check("T9: an ip-hash version that differs from the envelope's (absent ⇒ v2) is undecidable",
          change_point(env_doc, "v3")[0] is None and "re-freeze at the rotation" in change_point(env_doc, "v3")[1]
          and change_point(env_doc, "v2")[0] is not None
          and change_point({**env_doc, "ip_hash_version": "v3"}, "v3")[0] is not None)
    check("T9: the probe filters on the DEPLOYED version tag, never a literal",
          "LIKE ' + q(VER + ':%')" in PROBE_JS and "LIKE 'v2:%'" not in PROBE_JS and "IP_HASH_VERSION } = require" in PROBE_JS)
    no_flip = {k: v for k, v in env_doc.items() if k != "flipped_at"}
    check("T10: an envelope without flipped_at is undecidable", change_point(no_flip, "v2")[0] is None)

    # ── metrics + body ──
    volume = evaluate_volume(rows["act"])
    probe = _probe("shadow", "2026-10-13T00:00:00.000Z")
    early1 = evaluate_early_leg(world("2026-10-13", []), ref1, flip, r0)
    metrics = build_metrics(probe, rows, rows1, volume, env_doc, None, leg1, early1)
    check("metrics: pools aggregate calls and buckets", metrics["free_metered_1d"]["other"]["calls"] == 420
          and metrics["free_metered_1d"]["anthropic"]["buckets"] == 1)
    check("metrics: OAUTH_TRIGGER is NOT_MET below 1,000", metrics["oauth_trigger"] == "NOT_MET")
    check("metrics: OAUTH_TRIGGER is MET at exactly 1,000",
          build_metrics(probe, parse_rows("anthropic_30d|1000|3||"), [])["oauth_trigger"] == "MET")
    check("metrics: each leg carries window, phase, post_days, daily, flipped_at (+ due_run when not_due)",
          all(k in metrics["activation_legs"]["weekly"] for k in ("window_from", "window_to", "phase", "prior_source", "post_days", "flipped_at", "due_run"))
          and all(k in metrics["activation_legs"]["early"] for k in ("window_from", "window_to", "phase", "post_days", "post", "pre_min", "daily", "flipped_at", "due_run")))
    check("metrics: per-family rows carry their daily series", metrics["activation"][0]["daily"] == "1,0,2,2,3,4,1")
    check("metrics: a not_due run counts no breach", metrics["activation_breaches"] == 0)
    check("metrics: the record says which envelope judged it, or why none did",
          metrics["envelope"]["flipped_at"] == _FLIP and metrics["envelope"]["ip_hash_version"] == "v2"
          and build_metrics(probe, rows, [], volume, None, "absent at /x", guard_reason="x")["envelope"] == {"state": "absent at /x"})
    check("metrics: volume rides along, reported", [v["family"] for v in metrics["volume"]] == ["python-requests", "node"])
    check("metrics: fits canary_result_log's 8 KiB line cap", len(json.dumps(metrics, separators=(",", ":"))) < 7000)
    big_daily = {"fam%d" % i: {date(2026, 10, 6 + (i % 7)): i} for i in range(500)}
    big_leg, big_rows = evaluate_weekly_leg(big_daily, env_doc, ref2, flip)
    big = parse_rows("\n".join(["calls_1d|other|fam%d|%d|1" % (i, i) for i in range(500)]))
    check("metrics: 500 families still fit (top-N bound)",
          len(json.dumps(build_metrics(probe, big, big_rows, None, env_doc, None, big_leg, e9), separators=(",", ":"))) < 7000)

    # ── DETECTOR_ENVELOPE (CH2): every page is a contract-checked envelope, rendered from evidence ──
    de = envelope_module()
    de_schema = de.load_schema()
    now_s = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    envs2 = finding_envelopes(leg2, rows2, None, "rid", now_s, now_s, SCHEMA_VERSION)
    check("envelope: one per pageable finding — T2 builds exactly node's breach",
          len(envs2) == 1 and envs2[0]["evidence"]["client_family"] == "node" and envs2[0]["detector"] == DETECTOR)
    check("envelope: the judged window, the frozen flip as change_point, measured scalars + the daily series",
          envs2[0]["observation_window"] == {"from": "2026-10-13T00:00:00Z", "to": "2026-10-20T00:00:00Z"}
          and envs2[0]["change_point"] == {"at": _FLIP, "source": CHANGE_POINT_SOURCE}
          and envs2[0]["evidence"] == {"client_family": "node", "cur": 4, "prior": 15, "prior_source": "envelope_week0",
                                       "drop_pct": 73.3, "envelope_pct": 57.1, "post_days": 7, "daily": "1,0,0,1,0,2,0"})
    check("envelope: T2 conforms and the contract FORWARDs it as FAIL",
          de.validate(envs2[0], de_schema) == [] and gate_findings(envs2, "rid")[1] is None)
    envs5 = finding_envelopes(leg1, rows1, e5, "rid", now_s, now_s, SCHEMA_VERSION)
    check("envelope: an early collapse is ONE pooled envelope over [P0, REF)",
          len(envs5) == 1 and envs5[0]["evidence"]["pooled"] == "all client families"
          and envs5[0]["evidence"]["pre_min"] == 6 and envs5[0]["evidence"]["cur"] == 2
          and envs5[0]["observation_window"]["from"] == "2026-10-13T00:00:00Z" and gate_findings(envs5, "rid")[1] is None)
    straddling = {**leg1, "state": "judged"}
    breach_row = {**rows1[0], "state": "breach"}
    refused, why = gate_findings(finding_envelopes(straddling, [breach_row], None, "rid", now_s, now_s, SCHEMA_VERSION), "rid")
    check("envelope: the 2026-10-13 straddling week, forced through as a breach, is REFUSED by the contract",
          refused is None and "before change_point.at 2026-10-12T11:24:01Z" in (why or ""))
    gated2, _r = gate_findings(envs2, "rid")
    body2 = build_body(gated2[0], gated2[1])
    check("body: names the alert id and the entity noun", ALERT_ID in body2 and "client_family=node" in body2)
    check("body: render_body carries the counts, the envelope, the judged window, its post-flip days and the daily series",
          "cur=4" in body2 and "prior=15" in body2 and "envelope_pct=57.1" in body2 and "drop_pct=73.3" in body2
          and "window=2026-10-13T00:00:00Z..2026-10-20T00:00:00Z" in body2 and "post_days=7" in body2
          and "daily=1,0,0,1,0,2,0" in body2 and "prior_source=envelope_week0" in body2 and "FAIL stepup-activation" in body2)
    check("body: a family that is not in breach is not paged", "python-requests" not in body2)
    gated5, _r = gate_findings(envs5, "rid")
    body5 = build_body(gated5[0], gated5[1])
    check("body: an early collapse renders the pooled window, post vs pre_min and the daily series",
          "pooled=all client families" in body5 and "window=2026-10-13T00:00:00Z..2026-10-15T00:00:00Z" in body5
          and "pre_min=6" in body5 and "cur=2" in body5 and "daily=1,1" in body5 and "client_family" not in body5)
    check("body: carries the rollback line and a templated Action line, never a literal wave number",
          "Rollback lever: STEPUP_MODE=shadow|off" in body2 and "OPS-STEPUP-ACTIVATION-W{NEXT}" in body2)
    # The bypassed artifacts: the probe and the psql invocation are the only code no scenario runs,
    # so their SHAPE is asserted here (a hermetic self-test is blind to exactly what its seam replaces).
    check("probe: derives set A with the app's own hashIp", "require('/app/dist/lib/analytics.js')" in PROBE_JS and "hashIp('160.79.' + i + '.0')" in PROBE_JS)
    check("probe: the metered predicate is the app's billablePredicate()", "billablePredicate()" in PROBE_JS)
    check("probe: mode and N come from the deployed plans module", "plans.resolveStepupMode(process.env)" in PROBE_JS and "FREE_KEYLESS_MONTHLY_CALLS_RULED" in PROBE_JS)
    check("probe: covers addresses .104 through .111 (the /21)", "i <= 111" in PROBE_JS and "i = 104" in PROBE_JS)
    check("probe: ONE first-activation CTE — each bucket's earliest row (DISTINCT ON), counted per family + UTC day",
          PROBE_JS.count("DISTINCT ON (ip_hash)") == 1 and "ORDER BY ip_hash, \"timestamp\")" in PROBE_JS
          and "to_char(first_ts::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')" in PROBE_JS and "'actw'" not in PROBE_JS)
    check("probe: the series ends at REF and starts at the guard's lookback (STEPUP_SERIES_FROM) or REF - WEEKS weeks",
          "process.env.STEPUP_REF_ISO" in PROBE_JS and "process.env.STEPUP_SERIES_FROM" in PROBE_JS
          and "REF.getTime() - WEEKS * 7 * DAY" in PROBE_JS and "ref: RISO" in PROBE_JS and "series_from: FISO" in PROBE_JS)
    check("probe: a version tag that could carry a LIKE wildcard is refused in-container",
          "/^[A-Za-z0-9]+$/.test(VER)" in PROBE_JS)
    check("probe: never prints a hash — only mode, n, bounds, the version tag and the SQL go to stdout",
          PROBE_JS.count("process.stdout.write") == 1 and "JSON.stringify({ mode:" in PROBE_JS)
    check("probe: run_probe demands every key the guard reads", set(PROBE_KEYS) >= {"ip_hash_version", "series_from", "ref"})
    check("series_from: the early leg's lookback is R0 - 42 d", series_from_for(env_doc) == "2026-08-31T00:00:00Z"
          and series_from_for(None) is None)
    check("alert id is a module-level literal (visible to check-alert-registry)", ALERT_ID == "STEPUP_ACTIVATION_DROP")
    check("guard: armed only in live", should_page("live") and not should_page("shadow") and not should_page("off"))
    check("metrics: records whether the guard was armed", metrics["guard_armed"] is False
          and build_metrics({**probe, "mode": "live"}, rows, rows1)["guard_armed"] is True)
    fire(body2)
    check("fire in self-test skips the wrapper and records the body", LAST_FIRE.get(ALERT_ID) == body2)
    clear("ok")
    check("clear in self-test skips the wrapper", LAST_CLEAR.get(ALERT_ID) == "ok")

    import shutil
    import tempfile
    g = globals()
    real_probe, real_sql, real_env_path = g["run_probe"], g["run_sql"], g["ENVELOPE_PATH"]
    tmpd = tempfile.mkdtemp(prefix="stepup-env-")
    try:
        # The ENVELOPE: frozen once from request_log at the flip, refused on overwrite.
        g["ENVELOPE_PATH"] = os.path.join(tmpd, "envelope.json")
        check("envelope file: absent → (None, reason)", load_envelope()[0] is None and "absent" in load_envelope()[1])
        Path(g["ENVELOPE_PATH"]).write_text("{not json", encoding="utf-8")
        check("envelope file: unreadable → (None, reason), never a crash", load_envelope()[0] is None)
        os.remove(g["ENVELOPE_PATH"])
        seen = {}
        env_fixture = _actd(one_day_per_week)

        def fake_probe(ref_iso=None, weeks=None, series_from=None, **_):
            seen["ref"], seen["weeks"] = ref_iso, weeks
            return {**_probe("live", "2026-10-12T00:00:00.000Z"), "weeks": weeks or 2}
        g["run_probe"] = fake_probe
        g["run_sql"] = lambda _sql: env_fixture
        rc_f = freeze_envelope("2026-10-12T13:00:00Z")
        doc, why = load_envelope()
        check("freeze: asks the probe for 7 weeks before the FLIP instant",
              seen.get("ref") == "2026-10-12T13:00:00Z" and seen.get("weeks") == 7)
        check("freeze: writes a readable envelope with node at 57.1 %, from the daily series",
              rc_f == 0 and doc is not None and doc["families"]["node"]["weekly"] == [15, 35, 26, 10, 23, 33, 61]
              and doc["families"]["node"]["envelope_pct"] == 57.1)
        check("freeze: records the ip-hash version it froze under", doc is not None and doc.get("ip_hash_version") == "v2")
        check("freeze: a second freeze REFUSES to overwrite the pre-flip baseline",
              freeze_envelope("2026-10-20T00:00:00Z") == 0 and load_envelope()[0]["flipped_at"] == "2026-10-12T13:00:00Z")
        check("freeze: --force overwrites", freeze_envelope("2026-10-20T00:00:00Z", force=True) == 0
              and load_envelope()[0]["flipped_at"] == "2026-10-20T00:00:00Z")
        g["run_sql"] = lambda _sql: ""
        os.remove(g["ENVELOPE_PATH"])
        check("freeze: zero activating families is INDETERMINATE (exit 3), never an empty envelope",
              freeze_envelope("2026-10-12T13:00:00Z") == 3 and not os.path.exists(g["ENVELOPE_PATH"]))

        # main(), end to end, with the two effects that reach production replaced by fixtures.
        def run_main(mode, ref, actd_spec, envelope=env_doc, version="v2"):
            LAST_FIRE.clear(); LAST_RECORD.clear()
            if envelope is None:
                if os.path.exists(g["ENVELOPE_PATH"]):
                    os.remove(g["ENVELOPE_PATH"])
            else:
                Path(g["ENVELOPE_PATH"]).write_text(json.dumps(envelope), encoding="utf-8")
            asked = {}

            def probe_fn(series_from=None, **_):
                asked["series_from"] = series_from
                return _probe(mode, ref, version)
            g["run_probe"] = probe_fn
            g["run_sql"] = lambda _sql: fixture + "\n" + _actd(actd_spec)
            rc = main()
            return rc, asked

        t1 = {"node": _days("2026-09-29", _NODE_PREV + _NODE_ALERT)}
        rc, asked = run_main("live", "2026-10-13T00:00:00.000Z", t1)
        check("main() T1: the 2026-10-13 run in LIVE is PASS, pages nothing, records node not_due",
              rc == 0 and LAST_RECORD[:1] == ["PASS"] and not LAST_FIRE
              and LAST_RECORD[2]["activation_legs"]["weekly"]["state"] == "not_due"
              and LAST_RECORD[2]["activation"][0]["family"] == "node" and LAST_RECORD[2]["activation"][0]["state"] == "not_due")
        check("main(): asks the probe for the early leg's lookback", asked.get("series_from") == "2026-08-31T00:00:00Z")
        t2 = {"node": {**_days("2026-09-29", _NODE_PREV + _NODE_ALERT), **_days("2026-10-13", [1, 0, 0, 1, 0, 2, 0])}}
        for mode, want in (("shadow", "PASS"), ("off", "PASS"), ("live", "FAIL")):
            rc, _a = run_main(mode, "2026-10-20T00:00:00.000Z", t2)
            check("main() T2: a post-flip breach in %s → %s%s" % (mode, want, " (paged)" if want == "FAIL" else " (reported, not paged)"),
                  LAST_RECORD[:1] == [want] and (ALERT_ID in LAST_FIRE) == (want == "FAIL") and rc == 0)
        check("main() T2: the page is the rendered envelope — the judged window and its daily series",
              "window=2026-10-13T00:00:00Z..2026-10-20T00:00:00Z" in LAST_FIRE.get(ALERT_ID, "")
              and "daily=1,0,0,1,0,2,0" in LAST_FIRE.get(ALERT_ID, "")
              and LAST_RECORD[2].get("envelopes", {}).get("forwarded") == 1)
        # The contract is the backstop: even with the window logic regressed to judge the straddling
        # week, the self-built envelope is refused and the run is INDETERMINATE — never a page.
        real_weekly = g["evaluate_weekly_leg"]

        def regressed(daily, envelope, ref, flip_at):
            leg, rows_ = real_weekly(daily, envelope, ref, flip_at)
            return {**leg, "state": "judged"}, [{**r, "state": "breach" if r["family"] == "node" else r["state"]} for r in rows_]
        g["evaluate_weekly_leg"] = regressed
        try:
            rc, _a = run_main("live", "2026-10-13T00:00:00.000Z", t1)
        finally:
            g["evaluate_weekly_leg"] = real_weekly
        check("main(): a straddling breach that slips past the window logic is REFUSED by DETECTOR_ENVELOPE — INDETERMINATE, exit 3, no page",
              rc == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE
              and "before change_point.at" in (LAST_RECORD[2].get("envelopes", {}).get("refusal") or ""))
        real_mod = g["envelope_module"]
        g["envelope_module"] = lambda: (_ for _ in ()).throw(ImportError("no detector_envelope here"))
        try:
            rc, _a = run_main("live", "2026-10-20T00:00:00.000Z", t2)
        finally:
            g["envelope_module"] = real_mod
        check("main(): a breach with no readable DETECTOR_ENVELOPE contract is INDETERMINATE, exit 3, no page",
              rc == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE)
        t5 = {"node": _days("2026-08-31", flat3), "other": _days("2026-10-13", [1, 1])}
        rc, _a = run_main("live", "2026-10-15T00:00:00.000Z", t5)
        check("main() T5: an early collapse in live pages (FAIL)",
              LAST_RECORD[:1] == ["FAIL"] and ALERT_ID in LAST_FIRE and LAST_RECORD[2]["activation_legs"]["early"]["state"] == "early_collapse")
        rc, _a = run_main("live", "2026-10-13T00:00:00.000Z", t1, version="v3")
        check("main() T9: live with a changed ip-hash version is INDETERMINATE, exit 3, and pages nothing",
              rc == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE
              and "re-freeze at the rotation" in LAST_RECORD[2]["activation_legs"]["reason"])
        rc, _a = run_main("live", "2026-10-13T00:00:00.000Z", t1, envelope=no_flip)
        check("main() T10: live with an envelope lacking flipped_at is INDETERMINATE, exit 3 — never PASS",
              rc == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE)
        rc, _a = run_main("shadow", "2026-10-13T00:00:00.000Z", t1, envelope=no_flip)
        check("main(): in shadow the same undecidable guard is reported and the run is PASS",
              rc == 0 and LAST_RECORD[:1] == ["PASS"] and LAST_RECORD[2]["activation_legs"]["state"] == "undecidable")
        rc, _a = run_main("live", "2026-10-13T00:00:00.000Z", t1, envelope=None)
        check("main(): live with NO frozen envelope is INDETERMINATE, exit 3, and pages nothing",
              rc == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE)
        LAST_FIRE.clear(); LAST_RECORD.clear()
        g["run_probe"] = lambda **_: (_ for _ in ()).throw(RuntimeError("docker exec failed"))
        rc = main()
        check("main(): an unreadable probe is INDETERMINATE, exit 3, and pages nothing",
              rc == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE)
    finally:
        g["run_probe"], g["run_sql"], g["ENVELOPE_PATH"] = real_probe, real_sql, real_env_path
        shutil.rmtree(tmpd, ignore_errors=True)
    _selftest_log(check)
    if ran == 0:
        print("SELF-TEST: FAIL (vacuous — no scenario ran)")
        return 1
    if fails:
        print("SELF-TEST: FAIL (%d of %d)" % (len(fails), ran))
        return 1
    print("SELF-TEST: PASS (%d checks)" % ran)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(self_test())
    if len(sys.argv) > 1 and sys.argv[1] == "--freeze-envelope":
        flip_at = sys.argv[sys.argv.index("--flip-at") + 1] if "--flip-at" in sys.argv else \
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        sys.exit(freeze_envelope(flip_at, force="--force" in sys.argv))
    sys.exit(main())
