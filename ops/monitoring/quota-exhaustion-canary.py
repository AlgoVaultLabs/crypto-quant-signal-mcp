#!/usr/bin/env python3
"""OPS-QUOTA-EXHAUSTION-NOTICE-W1 R4 — high-volume free-tier exhaustion canary.

Host-side (Hetzner /opt/algovault-monitoring/) detector for the ONE moment in the funnel we
cannot otherwise observe: a heavy, integrated free caller hitting a free-tier wall.

Why it is worth an operator alert at all. The largest external consumer is a bare Node agent
(~2,700 calls/day) with NO account and NO email — only an `ip_hash`. There is no way to contact
them, so the response body is the entire customer relationship at that instant and the operator
never learns whether they churned or converted. This canary is the only signal that the moment
happened. It is deliberately NOT a health check: nothing is broken when it fires.

TWO WALLS, NOT ONE (OPS-QUOTA-CANARY-METER-TRUTH-W1). The free tier refuses on a ROLLING
monthly budget AND on a UTC-CALENDAR-DAY pacing cap, and `license.ts` refuses on them
INDEPENDENTLY. A bucket is therefore exhausted if EITHER wall is live, every row carries which
wall refused it, and the two are never interchangeable to an operator deciding whether to act:
a monthly wall clears at the caller's own rolling reset, a daily wall clears at 00:00 UTC.

RESOLVE, NEVER MIRROR. Both caps are read at run time from the DEPLOYED module inside the
running app container — the value production is actually enforcing, which is strictly stronger
than parsing repo source (repo source can be ahead of the deploy). This file holds NO cap
literal of its own, and `--self-test` parses this file's own AST to prove it. The previous
design kept a hand-followed copy under a comment promising to follow the SoT; the SoT moved and
the copy did not, so the canary selected at HALF the monthly wall, rendered a fabricated
denominator, and could not see the daily wall at all.

REFUSE, NEVER DEFAULT. If cap resolution fails for any reason the run prints
`QUOTA_EXHAUSTION_CANARY_VERDICT=INDETERMINATE` and evaluates NOTHING. A literal fallback here
is precisely what produced the defect this file exists to retire.

THRESHOLDED, not chatty. Ordinary low-volume exhaustion — a hobbyist who took three weeks to
spend the monthly allowance — is SILENT. Only a bucket whose measured burn rate clears
`QUOTA_CANARY_MIN_CALLS_PER_DAY` (default 50/day) pages.

DEDUP is keyed on (tracker_key, period_start, WALL, and — for a daily wall only — the UTC day).
Exhaustion is monotonic inside a metering period, so a bucket that stays exhausted must not
re-fire every hour; but the rolling 30-day window eventually rolls over, and the SAME caller
exhausting a NEW period is a genuinely new event that must page again. The wall belongs in the
identity because a DAILY wall recurs INSIDE one monthly period: keyed on the period alone, the
first daily wall would fire and then silence the next thirty days of them — and would silence
the caller's eventual MONTHLY exhaustion too, which is exactly what happened on 2026-08-14.
When a bucket leaves the exhausted set (period rolled, day rolled, caller upgraded) it
auto-resolves SILENTLY — recovery alerts are noise.

DETECT AT THE MOMENT, PAGE ON THE OUTCOME (OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1). Detection is
unchanged and still happens at the wall. The PAGE is DEFERRED by `QUOTA_OUTCOME_GRACE_H` (24h),
after which the entry resolves to exactly ONE terminal state: SILENT_CONVERTED (a signup was
attributed), SILENT_CTA_CLICKED, SILENT_STILL_ACTIVE (still being refused at volume), or PAGED —
walled, grace elapsed, and then nothing. Only PAGED reaches the operator.

  THE REUSABLE PRIMITIVE is that pending-then-resolve shape, and it generalises to every canary
  that fires on a BUSINESS event rather than a fault — the x402 rail's first refusal, any future
  free-tier surface that walls, every conversion-moment detector. It is the SECOND instance in
  this estate, not a new invention: `decision-gate-orphan-canary.py` already carries
  `DECISION_GATE_GRACE_DAYS` with ORPHAN_SUSPECTED / FIRED_RECENT. What is new is using the
  window to read an OUTCOME rather than to age a suspicion, and coalescing inside it.

  Why this wave existed at all: measured 2026-08-02 → 08-26, this alert DELIVERED 12 pages
  (26 fire decisions, 14 cooldown-suppressed), every one of them closing with a SQL research task
  and a `recommended_wave` that had never been dispatched — the wrapper logged RESOLVER_MISS on
  all 12 because no wave of that class has ever completed. An alert whose recommended action is
  never taken is not an alert, it is a thing the operator learns to swipe away.

  A DAILY WALL ALONE CAN NO LONGER PAGE, and that is deliberate rather than a gap. Its dedup id
  carries the UTC day, so by the time the grace elapses the day has rolled, the caller is being
  served again, and a cap that heals itself in hours is a RECOVERY — silent by the alert
  contract. What a daily wall is still worth is its LEAD: it precedes the same caller's monthly
  wall by a median 15.5h (7 of 7 pairs, 10.4–27.2h, measured 2026-08-26).

  COALESCING. When the monthly wall lands while the daily entry is still PENDING, the pending
  entry is upgraded in place — monthly-first, keeping the ORIGINAL detection instant so the page
  is not delayed — and BOTH dedup ids are claimed so the monthly cannot page separately later.
  The body then states the MONTHLY reset horizon: monthly is the binding wall and does not clear
  at midnight, so rendering the daily horizon would promise a recovery that is not coming.

  STATE FILE FORMAT CHANGED. Legacy lines are bare dedup ids; v2 lines are `<id>#<state>#<epoch>`.
  Both parse, and a legacy line is ALREADY RESOLVED — never re-paged. The host file at cutover
  holds ids the operator has already been paged about, so a migration that re-pages the backlog
  is the bootstrap bug wearing a different hat.

  THE BODY CARRIES THE ANSWER, NOT THE HOMEWORK. Refusals since the wall, whether a signup was
  attributed, CTA state (named DARK when it is), and how many days this bucket had walled before.
  Each degrades to an EXPLICIT `unavailable (...)` string — never a silent zero — and an
  unavailable arm can never silence a page. That is what makes a lost
  `migrations/034_grant_autopilot_funnel_reads.sql` visible instead of dark.

  ⚠️ `request_log` NEVER RECORDS A REFUSED CALL, so "calls after the wall" is a structural zero
  after a monthly wall and "went silent" is a tautology. Measured 2026-08-26 on
  free:v2:37d4ed14c450db39: zero request_log rows after the wall while quota_hit_block was still
  accruing five hours later. The continuation signal is `funnel_events.quota_hit_block`, and
  nothing here may be re-pointed at `request_log` for it.

  SEVERITY IS UNCHANGED at CRITICAL_PERSISTENT. CH1 measured the wall cohort and returned
  QUOTA_CONVERSION_VERDICT=INDETERMINATE (n=26 external walled buckets, ZERO lifetime
  conversions against an expected 0.75 under the never-walled baseline, p=0.525; the CTA arm is
  dark at n=1 all-time). Changing severity on that evidence would be a conditional approval
  shipped unconditionally. Follow-up: OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W2, on the instruments
  becoming readable.

There is no sustain gate. `webhook-delivery-canary.py` needs one because its metrics fluctuate
around a threshold; a quota counter only ever climbs within a period, so a "sustained N cycles"
gate here would add latency and detect nothing extra. Per-bucket dedup is the whole control.

SECRET HYGIENE: a KEYED free bucket's `tracker_key` IS the caller's API key. It is never
rendered raw into a Telegram message or a log line — `render_bucket` redacts by STRUCTURE
(prefix + sha256-16), never by known-vendor prefix. Keyless buckets are already the
pseudonymous `free:v2:<hash>` form and pass through unchanged.

5th+ consumer of `send_telegram.sh`; it does NOT re-implement the severity / cooldown /
DRY_RUN / fail-open gates (the wrapper owns those). `ALGOVAULT_TG_TEST_INERT=1` routes through
every gate but skips the POST **and writes no cooldown marker** — use it for repeated smokes.
`DRY_RUN_TG=1` also skips the POST but DOES write the 24h marker, so a second run false-greens
(cooldown-suppressed, not healthy); keep it only for a test whose assertion IS the cooldown.
`recommended_wave` uses the `OPS-QUOTA-EXHAUSTION-<CLASS>-W{NEXT}` template (NO literal Wn — the
wrapper's send-time resolver fills {NEXT}).

Verdict token: every run prints exactly one terminal `QUOTA_EXHAUSTION_CANARY_VERDICT=` line.
The alert contract requires fail-open (exit 0 on any error), so the EXIT CODE cannot carry that
information — which is precisely the "a dark guard exiting 0 is indistinguishable from a healthy
one" failure this repo has now hit five times. The token can: INDETERMINATE means the canary
verified NOTHING, whatever the exit code says.

WHO it alerts on (REVENUE-METER-TRUTH-W6 CH6): CUSTOMERS, never us. Buckets whose traffic is
`is_bot_internal` are excluded and logged `verdict=SKIPPED_INTERNAL` — measured 2026-08-05,
THIRTEEN of the 19 `free:` buckets that had ever reached the wall are our own, and two of the
three alerts this canary had fired at that point were on that traffic.

Test seams (env), and NONE of them is a production fallback:
  QUOTA_CANARY_FREE_LIMIT + QUOTA_CANARY_FREE_DAILY = stub the resolved cap pair. BOTH OR
    NEITHER — a half-set pair resolves to None rather than silently mixing a stubbed cap with
    a resolved one, because that mixing IS the drift class this wave retired.
  QUOTA_CANARY_FORCE_ROWS = `key:count:epoch[:daily_count:daily_day],...` overrides the DB.
  QUOTA_CANARY_FORCE_FACTS = `key:internal(0|1):window_calls,...` overrides the request_log join.
  QUOTA_CANARY_AS_OF = epoch seconds, replays the evaluation at a past instant (read-only) so a
    historical exhaustion can be proven to fire. It anchors the rate window AND the UTC day.
  QUOTA_CANARY_RATE_WINDOW_HOURS = rate window (default 24).
  `--self-test` runs the hermetic scenario suite (no DB, no wrapper, temp state).
"""
import argparse
import ast
import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time

ALERT_ID = "QUOTA_EXHAUSTION_HIGH_VOLUME"
WRAPPER = "/opt/algovault-monitoring/send_telegram.sh"
STATE_DIR = "/opt/algovault-monitoring/.alert-state"
FIRED_SET_FILE = os.path.join(STATE_DIR, "quota-exhaustion-canary-fired.set")
LOG = "/var/log/algovault-quota-exhaustion-canary.log"
PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
PG_ROLE = "algovault_autopilot"
PG_DB = "signal_performance"

# The app container and the DEPLOYED module the caps are resolved from. Measured 2026-08-15:
# `docker compose ps` service `mcp-server` → container `crypto-quant-signal-mcp-mcp-server-1`,
# and Dockerfile stage 2 does `COPY --from=builder /app/dist/ ./dist/`, so the built module is
# present at runtime while `src/` and `ops/` are deliberately absent from the image.
#
# Hardcoded as a constant, exactly like PG_CONTAINER, and that is deliberate: if the container
# is ever renamed the resolver REFUSES (INDETERMINATE) rather than guessing, which is visible.
# A discovery fallback would be a second way to be silently wrong about the same fact.
APP_CONTAINER = "crypto-quant-signal-mcp-mcp-server-1"
DEPLOYED_PLANS_MODULE = "/app/dist/lib/plans.js"

DAY_S = 86400
# The rolling free window (license.ts MONTH_MS). A row older than this is a stale period.
WINDOW_S = 30 * DAY_S

# ── Deferred-page state grammar (OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1) ────────────────────
# Legacy state lines are BARE dedup ids; v2 lines are `<id>#<state>#<epoch>`. `#` is the
# separator because a dedup id is `<key>@<epoch>` or `<key>@<epoch>|daily@<day>` and neither
# form can contain it, while whitespace would break `load_state`'s `.split()`.
STATE_SEP = "#"
ST_PENDING = "PENDING"                    # detected, grace not yet elapsed — NO page
ST_PAGED = "PAGED"                        # terminal: the operator was paged
ST_CONVERTED = "SILENT_CONVERTED"         # terminal: a signup was attributed — no page
ST_CTA = "SILENT_CTA_CLICKED"             # terminal: they clicked upgrade — no page
ST_ACTIVE = "SILENT_STILL_ACTIVE"         # terminal: still being refused at volume — no page
ST_LEGACY = "RESOLVED_LEGACY"             # a pre-W1 bare id: already known, never re-pages
TERMINAL_STATES = (ST_PAGED, ST_CONVERTED, ST_CTA, ST_ACTIVE, ST_LEGACY)

# Outcome-arm sentinels. An UNAVAILABLE arm is NOT zero and must never be read as one — that
# separation is the entire point. A missing SELECT privilege renders distinguishably from an
# empty result, because a grant that silently vanishes on a reprovision would otherwise send
# these arms dark at a green exit code. Migration 034 exists for the same reason, and THIS is
# what makes its loss detectable rather than silent.
ARM_NA_KEYED = "n/a (keyed bucket — no ip_hash to join on)"
ARM_UNAVAIL_NOPRIV = "unavailable (no SELECT privilege)"
ARM_UNAVAIL_ERROR = "unavailable (query failed)"
ARM_UNAVAILABLE = (ARM_NA_KEYED, ARM_UNAVAIL_NOPRIV, ARM_UNAVAIL_ERROR)

# The two walls. Rendered horizons are NOT interchangeable — a monthly wall does not clear at
# midnight, and telling an operator it does is worse than telling them nothing.
WALL_MONTHLY = "monthly"
WALL_DAILY = "daily"
WALL_HORIZON = {
    WALL_MONTHLY: "MONTHLY wall — clears at the caller's rolling reset",
    WALL_DAILY: "DAILY wall — clears at 00:00 UTC",
}

# `daily_day` is a bare `YYYY-MM-DD` TEXT column (license.ts `utcDayKey()`), NOT the ISO-8601
# instant `period_start` carries. Every day literal is shape-asserted before it is embedded in
# SQL — these are our own derivations, never operator input, but a broken literal must refuse
# rather than emit broken SQL (same defence as the ip_hash quote screen in build_facts_query).
UTC_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _int_env(name, default):
    try:
        v = int(os.environ[name])
        return v if v >= 0 else default
    except (KeyError, ValueError):
        return default


# Config (env-overridable for smokes; defaults are the prod policy).
#
# NOTE what is NOT here: the free-tier caps. They are RESOLVED per run by resolve_free_caps()
# from the deployed module, never bound to a literal in this file. The two knobs below are
# THRESHOLDS — this canary's own policy, owned here, not mirrored from anywhere — which is why
# they legitimately keep numeric defaults and the caps may never have one.
#
# Burn rate above which an exhaustion is worth waking the operator for. 50/day means the
# caller spent a whole day's pacing allowance in a day, or the monthly allowance in a few — an
# integrated, daily-active consumer, not a hobbyist. The live heavy caller runs ~2,700/day.
MIN_CALLS_PER_DAY = _int_env("QUOTA_CANARY_MIN_CALLS_PER_DAY", 50)

# REVENUE-METER-TRUTH-W6 CH6 — the burn rate is measured over a WINDOW, not over the
# lifetime of the period.
#
# The old rate was `call_count / (now - period_start)`, whose denominator GROWS FOREVER.
# A caller who spent their whole free allowance in a 3-day burst reads as 16/day a week
# later, and as 3/day at the end of the month, so `MIN_CALLS_PER_DAY` was never crossed
# and every hourly pass logged `verdict=SILENT_BY_DESIGN`. Three alerts had ever fired,
# two of them on our own internal traffic, and ZERO on the one real external caller that
# walled itself — which is the whole reason this canary exists.
RATE_WINDOW_H = _int_env("QUOTA_CANARY_RATE_WINDOW_HOURS", 24)

# ⚠️ The rate counts ALL request_log rows in the window, NOT just chargeable ones, and
# that choice is measured rather than assumed. On the historical fixture
# (`free:v2:d552fbc794cd05dc`, the 100th chargeable call at 2026-08-01T17:29:02Z):
#
#     unit                     day 1    day 2    day 3    24h ending at the wall
#     all calls                 2167     2673     2040                      2807
#     chargeable (non-HOLD)       54       36       10                        10
#
# HOLD verdicts are free by design, so the CHARGEABLE rate DECAYS as a caller approaches
# the wall. Gate on it and this canary still cannot detect the one real event in its own
# history (10/day against a 50/day floor) — it would swap a lifetime-averaging bug for a
# unit bug and look fixed. All-calls is also the honest unit for the question actually
# being asked, which is "is a real caller hammering us right now", not "how fast is the
# meter ticking". `quota_usage` remains the authority for the CAPS themselves.
CHARGEABLE_VERDICT_EXCLUDED = "HOLD"

# ── The grace window (OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1) ───────────────────────────────
# DETECT AT THE MOMENT, PAGE ON THE OUTCOME. Detection is unchanged and still happens at the
# wall; the PAGE waits this long and then resolves to exactly one terminal state.
#
# SECOND instance of this shape in the estate, not a new primitive — `decision-gate-orphan-
# canary.py` already carries `DECISION_GATE_GRACE_DAYS` with ORPHAN_SUSPECTED / FIRED_RECENT.
# What is new is that the window is used to read an OUTCOME rather than to age a suspicion,
# and that a pending entry can be COALESCED with a later wall of the same bucket.
#
# 24 is MEASURED and deliberately not widened. The daily wall leads the same caller's monthly
# wall by a median 15.5h (7 of 7 pairs, range 10.4–27.2h, measured 2026-08-26), so 24h captures
# six of seven inside one window. Widening to 28h to capture the seventh would delay EVERY page
# by 4h to catch one pair; the out-of-window pair pages separately, which is the grace window
# working rather than failing. Env-overridable as a DOCUMENTED TEST SEAM only.
OUTCOME_GRACE_H = _int_env("QUOTA_OUTCOME_GRACE_H", 24)


def log(msg):
    line = "%s quota-exhaustion-canary: %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


# ── Cap resolution ────────────────────────────────────────────────────────────────────────

_CAP_PROBE_JS = (
    "const p=require('" + DEPLOYED_PLANS_MODULE + "');"
    "process.stdout.write(JSON.stringify([p.FREE_MONTHLY_CALLS,p.FREE_DAILY_CALLS]));"
)


def _validated_caps(monthly, daily, source):
    """`(monthly, daily)` as positive ints, or None with a logged reason.

    `bool` is rejected explicitly BEFORE the int check: in Python `True` IS an int, so a
    `JSON.stringify([true, 100])` would otherwise resolve to a cap of 1 and look like a
    successful resolution.
    """
    out = []
    for label, raw in (("monthly", monthly), ("daily", daily)):
        if isinstance(raw, bool) or not isinstance(raw, (int, str)):
            log("CAPS_UNRESOLVED: %s cap from %s is not an integer (missing export?): %r"
                % (label, source, raw))
            return None
        try:
            v = int(raw)
        except (TypeError, ValueError):
            log("CAPS_UNRESOLVED: %s cap from %s does not parse as an integer: %r" % (label, source, raw))
            return None
        if v <= 0:
            log("CAPS_UNRESOLVED: %s cap from %s is not positive: %d" % (label, source, v))
            return None
        out.append(v)
    log("CAPS_RESOLVED: monthly=%d daily=%d (source: %s)" % (out[0], out[1], source))
    return (out[0], out[1])


def resolve_free_caps():
    """`(monthly_cap, daily_cap)` as PRODUCTION is enforcing them, or None on ANY failure.

    RESOLVE, NEVER MIRROR — the single-derivation rule applied to a host artifact. The caps are
    read from the module the running container actually loaded, which is strictly stronger than
    parsing repo source: repo source can be ahead of the deploy, and a canary that believes the
    repo would then police a wall production is not enforcing.

    Path α is the established pattern in this file (`docker exec` + argv list, never a shell),
    so none of the ssh/docker/`node -e` quote-mangling traps apply — subprocess passes argv
    verbatim. Measured 2026-08-15: `/app/dist/lib/plans.js` is COMMONJS (`exports.FREE_… = 200`;
    `/app/package.json` declares no `"type"`), so `require()` is the direct read. Dynamic
    `import()` also resolves the named values on Node 24, but it buys nothing and costs a
    promise.

    RETURNS None — never a default — on subprocess failure, timeout, non-zero exit, unparseable
    stdout, a payload that is not a 2-element pair, a missing export, a non-integer, or a
    non-positive integer. Every branch logs WHY, because `main()` turns None into
    INDETERMINATE and an operator reading only the token cannot see the cause.

    `QUOTA_CANARY_FREE_LIMIT` / `QUOTA_CANARY_FREE_DAILY` are DOCUMENTED TEST SEAMS and nothing
    else. They are BOTH-OR-NEITHER: a half-set pair returns None rather than mixing a stubbed
    cap with a resolved one. Neither carries a numeric default, so neither can degrade into the
    hand-followed mirror this wave deleted.
    """
    seam_monthly = os.environ.get("QUOTA_CANARY_FREE_LIMIT")
    seam_daily = os.environ.get("QUOTA_CANARY_FREE_DAILY")
    if seam_monthly is not None or seam_daily is not None:
        if seam_monthly is None or seam_daily is None:
            log("CAPS_UNRESOLVED: the cap seam is HALF-SET (QUOTA_CANARY_FREE_LIMIT=%r "
                "QUOTA_CANARY_FREE_DAILY=%r) — both or neither, never a mixed pair"
                % (seam_monthly, seam_daily))
            return None
        return _validated_caps(seam_monthly, seam_daily, "test seam (QUOTA_CANARY_FREE_*)")

    try:
        proc = subprocess.run(["docker", "exec", APP_CONTAINER, "node", "-e", _CAP_PROBE_JS],
                              capture_output=True, text=True, timeout=30)
    except Exception as e:  # noqa: BLE001 — docker absent, container absent, timeout: all refuse
        log("CAPS_UNRESOLVED: cap probe could not run against %s: %s: %s"
            % (APP_CONTAINER, type(e).__name__, e))
        return None
    if proc.returncode != 0:
        log("CAPS_UNRESOLVED: cap probe exit=%d stderr=%s"
            % (proc.returncode, (proc.stderr or "").strip()[:200]))
        return None
    raw = (proc.stdout or "").strip()
    try:
        parsed = json.loads(raw)
    except ValueError as e:
        log("CAPS_UNRESOLVED: cap probe stdout is not JSON (%s): %r" % (e, raw[:120]))
        return None
    if not isinstance(parsed, list) or len(parsed) != 2:
        log("CAPS_UNRESOLVED: cap probe did not return a 2-element pair: %r" % (parsed,))
        return None
    return _validated_caps(parsed[0], parsed[1],
                           "deployed %s in %s" % (DEPLOYED_PLANS_MODULE, APP_CONTAINER))


def cap_literal_defaults(source_path=None):
    """Every place THIS FILE still binds a free-tier cap to a numeric literal. MUST be empty.

    Parsed with `ast` deliberately, and that is the whole point of the check. Comments and
    docstrings do not exist in an AST, so the historical prose above recording the literal that
    caused this wave can neither trip this check nor satisfy it — the check is a statement about
    CODE. A regex over the raw text can do neither reliably; this is the same anchored-absence
    problem the Dockerfile assertion solved by anchoring on structure rather than on text.

    Exactly two shapes are banned:
      1. any assignment to a `FREE_*` name bound to a numeric literal;
      2. any call reading a `QUOTA_CANARY_FREE*` env name that supplies a numeric default.

    `MIN_CALLS_PER_DAY = _int_env(..., 50)` and `QUOTA_CANARY_RATE_WINDOW_HOURS` are deliberately
    OUT of scope: they are this canary's own thresholds, owned here rather than mirrored from
    anywhere, so a default is correct for them and forbidden for a cap.
    """
    path = source_path or os.path.abspath(__file__)
    with open(path, "r") as fh:
        tree = ast.parse(fh.read(), filename=path)
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.startswith("FREE_") \
                        and _is_numeric_literal(node.value):
                    hits.append("%s = <numeric literal> (line %d)" % (target.id, node.lineno))
        elif isinstance(node, ast.Call) and node.args:
            first = node.args[0]
            name = first.value if isinstance(first, ast.Constant) and isinstance(first.value, str) else None
            if name and name.startswith("QUOTA_CANARY_FREE"):
                defaults = [a for a in node.args[1:] if _is_numeric_literal(a)]
                defaults += [k.value for k in node.keywords if _is_numeric_literal(k.value)]
                if defaults:
                    hits.append("%s read with a numeric default (line %d)" % (name, node.lineno))
    return hits


def _is_numeric_literal(node):
    """True for `100` and for `-100` (which parses as a UnaryOp over a Constant), not for True."""
    if isinstance(node, ast.Constant):
        return isinstance(node.value, (int, float)) and not isinstance(node.value, bool)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        return _is_numeric_literal(node.operand)
    return False


def utc_day_key(now_s):
    """`YYYY-MM-DD` in UTC — the SAME derivation `license.ts` `utcDayKey()` enforces against.

    Derived in Python from the run's anchor rather than in SQL from `now()`, so
    `QUOTA_CANARY_AS_OF` moves the rate window and the day boundary TOGETHER. Anchoring only
    one of them would replay a historical daily wall against today's calendar date and select
    nothing, which is the answer that looks like "it would not have fired".
    """
    return time.strftime("%Y-%m-%d", time.gmtime(now_s))


# ── State ─────────────────────────────────────────────────────────────────────────────────


def parse_state_token(token):
    """One state-file token -> (dedup_id, state, epoch). Total: it never raises.

    Two grammars share this file and BOTH must parse, forever:

      legacy  `free:v2:abc@1787630920`                 (pre-OUTCOME-GATE-W1, bare id)
      v2      `free:v2:abc@1787630920#PENDING#1787...` (id, state, detection instant)

    A legacy line resolves to ST_LEGACY — *already resolved*, never re-paged. That direction is
    not a detail: the file on the host at cutover holds live ids for buckets the operator has
    ALREADY been paged about, so a migration that re-pages the backlog is the bootstrap bug
    wearing a different hat, and this file already carries a bootstrap branch written because of
    exactly that. An unparseable or unknown-state token gets the same treatment for the same
    reason — when in doubt about a bucket we have clearly seen before, stay silent.
    """
    if STATE_SEP not in token:
        return token, ST_LEGACY, 0
    parts = token.split(STATE_SEP)
    if len(parts) != 3:
        return parts[0], ST_LEGACY, 0
    ident, state, stamp = parts
    if state != ST_PENDING and state not in TERMINAL_STATES:
        return ident, ST_LEGACY, 0
    try:
        return ident, state, int(stamp)
    except ValueError:
        return ident, ST_LEGACY, 0


def load_state():
    """`{dedup_id: {"state": str, "since": int}}` — empty dict when the file is absent."""
    try:
        with open(FIRED_SET_FILE) as fh:
            raw = fh.read()
    except OSError:
        return {}
    out = {}
    for token in raw.split():
        if not token.strip():
            continue
        ident, state, stamp = parse_state_token(token)
        out[ident] = {"state": state, "since": stamp}
    return out


def load_fired_set():
    """Every dedup id this canary has already SEEN, whatever state it is in.

    Retained under its original name and original meaning — "do not treat this bucket-period
    as new" — because that is what every dedup call site asks. A PENDING entry is included: it
    has been detected, it simply has not been resolved yet.
    """
    return set(load_state().keys())


def state_exists():
    """True once this canary has completed at least one cycle on this host.

    The distinction matters: an EMPTY state file means "nothing is currently exhausted",
    while a MISSING one means "this canary has never run here" — and those must behave
    differently on the very first cycle (see the bootstrap branch in run_cycle).
    """
    return os.path.exists(FIRED_SET_FILE)


def save_state(state):
    """Persist `{dedup_id: {"state", "since"}}` in the v2 grammar, one token per line."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        lines = ["%s%s%s%s%d" % (i, STATE_SEP, state[i]["state"], STATE_SEP, state[i]["since"])
                 for i in sorted(state)]
        with open(FIRED_SET_FILE, "w") as fh:
            fh.write("\n".join(lines))
    except OSError as e:
        log("WARN: could not persist state: %s" % e)


def save_fired_set(ids, now_s=None, state=ST_LEGACY):
    """Compatibility shim: persist a bare id set, defaulting every entry to already-resolved.

    Used by the bootstrap branch and by auto-resolve pruning, both of which mean "record that
    these are known, and never page them" — which is exactly ST_LEGACY's contract.
    """
    stamp = int(now_s or time.time())
    save_state({i: {"state": state, "since": stamp} for i in ids})


def render_bucket(tracker_key):
    """Operator-readable bucket id that NEVER leaks an API key.

    A keyless free bucket is `free:v2:<hash>` — already pseudonymous, shown verbatim so the
    operator can correlate it with `request_log`. A KEYED free bucket's tracker_key IS the
    caller's `av_free_...` secret, so it is redacted by STRUCTURE (fixed prefix + sha256-16),
    never by matching a known vendor prefix — key formats drift, structure does not.
    """
    if tracker_key.startswith("free:"):
        return tracker_key
    digest = hashlib.sha256(tracker_key.encode("utf-8")).hexdigest()[:16]
    return "key:sha16:%s" % digest


def _psql(sql, fieldsep="|"):
    args = ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_ROLE, "-d", PG_DB, "-tA", "-F", fieldsep, "-c", sql]
    out = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % out.stderr.strip()[:200])
    return out.stdout


def build_query(monthly_cap, daily_cap, utc_day):
    """The exhausted-free-bucket query — BOTH walls, in one pass.

    Built by CONCATENATION, never %-formatting: the WHERE clause contains SQL LIKE wildcards
    (`'free:%'`), and a `%`-format string chokes on them with
    `ValueError: unsupported format character`. That is not hypothetical — it is exactly what
    the first live run on the host reported, caught only because the fail-open branch prints
    INDETERMINATE rather than letting `exit 0` pass for healthy.

    THE TWO TEXT COLUMNS NEED DIFFERENT TREATMENT, and conflating them is a live trap:

      `period_start` is a full ISO-8601 INSTANT (`2026-08-13T11:28:58.790Z`, written by
      persistTracker), so it MUST be cast — `::timestamptz` — before EXTRACT, or psql errors and
      this canary fail-opens on every single run. Probed live 2026-08-02 before install.

      `daily_day` is a bare CALENDAR DAY (`2026-08-14`, written by persistDailyTracker from
      `utcDayKey()`), and it is compared by TEXT EQUALITY to a day literal derived on the Python
      side. It is deliberately NOT cast: `'2026-08-14'::timestamptz` resolves against the SERVER
      timezone, which would make this canary's correctness a function of a postgres setting
      nothing in this repo asserts. Measured 2026-08-15 the server is UTC, so the cast would
      work today — which is precisely the kind of accidental correctness worth refusing.
      Measured the same day: 671 of 684 rows carry `''` and NONE carry NULL, so the equality
      excludes every never-metered row without a coalesce.

    A row selected here is not yet EXHAUSTED — `classify` decides that, because the monthly leg
    also has to be inside its rolling window.
    """
    if not UTC_DAY_RE.match(utc_day or ""):
        raise ValueError("refusing to embed a malformed UTC day literal: %r" % (utc_day,))
    return (
        "SELECT tracker_key, call_count, EXTRACT(EPOCH FROM period_start::timestamptz)::bigint, "
        "daily_count, daily_day "
        "FROM quota_usage "
        "WHERE (tracker_key LIKE 'free:%' OR tracker_key LIKE 'av_free_%') "
        "AND (call_count >= " + str(int(monthly_cap)) +
        " OR (daily_count >= " + str(int(daily_cap)) + " AND daily_day = '" + utc_day + "'))"
    )


def bucket_ip_hash(tracker_key):
    """The `request_log.ip_hash` a keyless bucket maps to, or None for a keyed one.

    A keyless free bucket is `free:<ip_hash>`, and `ip_hash` itself may carry the `v2:`
    generation tag (`free:v2:<hex>`) — so strip ONLY the leading `free:` and keep the rest
    verbatim. A keyed bucket (`av_free_…`) has no ip_hash and therefore no join: it is a
    caller who registered, which is exactly the population this canary must NEVER suppress.
    """
    if tracker_key.startswith("free:"):
        return tracker_key[len("free:"):]
    return None


def build_facts_query(keys, as_of_s=None):
    """Per-bucket `is_bot_internal` + windowed call count, for the given keyless buckets.

    Concatenated, never %-formatted — same reason as build_query: a `%` in a LIKE pattern
    or a timestamp format string kills a %-format call. Literals are single-quoted because
    psql -c is invoked directly.

    `timestamp` is a TEXT column (ISO-8601 strings), so it is cast before comparison —
    the identical trap `period_start` already carries above.

    `as_of_s` anchors the window END. It must be threaded all the way into the SQL, not just
    into the staleness check: anchoring only the Python side would replay a historical
    exhaustion against TODAY's traffic, which is a windowed rate of ~0 for any past event —
    the replay would report "would not have fired" for a burst that provably happened, and
    that answer is worse than no replay at all.
    """
    hashes = [bucket_ip_hash(k) for k in keys]
    hashes = [h for h in hashes if h]
    if not hashes:
        return None
    # Defensive: these are our own hex/`v2:`-tagged hashes, never operator input, but a
    # quote would still break the statement, so refuse rather than emit broken SQL.
    safe = [h for h in hashes if "'" not in h and "\\" not in h]
    in_list = ", ".join("'" + h + "'" for h in safe)
    anchor = "now()" if as_of_s is None else ("to_timestamp(" + str(int(as_of_s)) + ")")
    return (
        "SELECT ip_hash, "
        "bool_or(coalesce(is_bot_internal,false)) AS internal, "
        "count(*) FILTER (WHERE timestamp::timestamptz >  " + anchor + " - interval '" + str(int(RATE_WINDOW_H)) + " hours' "
        "AND timestamp::timestamptz <= " + anchor + ") AS window_calls "
        "FROM request_log WHERE ip_hash IN (" + in_list + ") GROUP BY ip_hash"
    )


def query_bucket_facts(keys, as_of_s=None):
    """{tracker_key: {"internal": bool, "window_calls": int}} — empty dict when unavailable.

    The test seam mirrors parse_forced_rows: `key:internal:window_calls`, rsplit from the
    RIGHT because tracker keys contain colons of their own.
    """
    forced = os.environ.get("QUOTA_CANARY_FORCE_FACTS")
    if forced is not None:
        facts = {}
        for chunk in forced.split(","):
            if not chunk.strip():
                continue
            key, internal, wcalls = chunk.rsplit(":", 2)
            facts[key] = {"internal": internal == "1", "window_calls": int(wcalls)}
        return facts
    sql = build_facts_query(keys, as_of_s)
    if not sql:
        return {}
    by_hash = {}
    for line in _psql(sql).splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) != 3:
            raise RuntimeError("unexpected request_log facts row: %r" % line)
        by_hash[parts[0]] = {"internal": parts[1].strip() == "t", "window_calls": int(parts[2])}
    facts = {}
    for k in keys:
        h = bucket_ip_hash(k)
        if h and h in by_hash:
            facts[k] = by_hash[h]
    return facts


def _arm_unavailable_reason(exc):
    """Map a psql failure to the RIGHT sentinel. No-privilege is not query-failure.

    Separating them is required, not cosmetic: `migrations/034_grant_autopilot_funnel_reads.sql`
    grants this role its reads, and a reprovision that loses those grants must be visible in the
    alert body as a PRIVILEGE problem — not as an empty result and not as a generic error.
    """
    text = str(exc).lower()
    if "permission denied" in text or "must be owner" in text:
        return ARM_UNAVAIL_NOPRIV
    return ARM_UNAVAIL_ERROR


def build_outcome_query(kind, ip_hash, since_s, until_s):
    """The outcome statement for one arm-group, or None when there is nothing to join on.

    Concatenated rather than %-formatted for the same reason as every other query here: a `%`
    in a LIKE pattern or a timestamp format string kills a %-format call, and this file has
    already shipped dark once on exactly that.

    TWO STATEMENTS, NOT ONE, and the split is load-bearing: `funnel_events` and
    `signup_attribution` are separate GRANTs, so folding them into a single statement would let
    one missing privilege darken BOTH arms and misreport which one is actually unreadable.

    ⚠️ `funnel_events` is `meta_json` (TEXT) and `ts` (timestamptz) — NOT `meta` and not
    `timestamp`. Probed live 2026-08-26; the spec that commissioned this join named both wrong.
    """
    if not ip_hash or "'" in ip_hash or "\\" in ip_hash:
        return None
    lo = "to_timestamp(" + str(int(since_s)) + ")"
    hi = "to_timestamp(" + str(int(until_s)) + ")"
    q = "'" + ip_hash + "'"
    if kind == "funnel":
        # Arms 1, 3 and 4 all live in one table and therefore behind one privilege.
        #   refusals   — did they KEEP TRYING. This is the continuation signal, and it is the
        #                only one there is: `request_log` never records a refused call, so a
        #                walled caller's row count stops dead at the cap and "calls after the
        #                wall" is a structural zero. Measured 2026-08-26 on
        #                free:v2:37d4ed14c450db39 — 0 request_log rows after the wall while
        #                quota_hit_block was still accruing five hours later.
        #   cta        — did they click upgrade. Measured DARK: n=1 all-time (2026-06-18).
        #   prior_days — how many earlier UTC days this bucket was already walling on.
        return (
            "SELECT "
            "count(*) FILTER (WHERE event_type='quota_hit_block' AND ts > " + lo + " AND ts <= " + hi + "), "
            "count(*) FILTER (WHERE event_type='upgrade_cta_clicked' AND ts > " + lo + " AND ts <= " + hi + "), "
            "count(DISTINCT (ts AT TIME ZONE 'UTC')::date) FILTER (WHERE event_type='quota_hit_block' AND ts <= " + lo + ") "
            "FROM funnel_events WHERE session_id = " + q
        )
    if kind == "signup":
        # Arm 2 — the first-party bridge. `signup_attribution.ip_hash` is NOT caller-settable,
        # unlike funnel_events.session_id (`trackToken ?? ipHash ?? randomUUID()`). Measured
        # 2026-08-26, the shape hazard is 0.00% on quota_hit_block rows but 100% on
        # landing_cta_clicked, so the bridge is preferred wherever both would answer.
        return ("SELECT count(*) FILTER (WHERE created_at > " + lo + " AND created_at <= " + hi + "), "
                "count(*) FROM signup_attribution WHERE ip_hash = " + q)
    raise ValueError("unknown outcome arm-group: %r" % kind)


def query_outcome(tracker_key, since_s, until_s):
    """Every outcome arm for one bucket. Each arm is an int OR an ARM_UNAVAILABLE sentinel.

    NEVER returns a zero it did not measure. A keyed bucket has no ip_hash, a table may be
    unreadable, a query may fail — three different facts, three different renderings, and none
    of them is `0`. A body that silently drops a fact it could not measure is indistinguishable
    from one where the fact was absent, which is the failure this file's own per-bucket
    positive-output rule exists to stop.
    """
    forced = os.environ.get("QUOTA_CANARY_FORCE_OUTCOME")
    if forced is not None:
        # Seam: `key:refusals:cta:signups:prior_days,...` — rsplit from the RIGHT because a
        # tracker key carries colons of its own (`free:v2:<hash>`). Same shape as FORCE_FACTS.
        # A field may be a sentinel word: `noprivilege` / `error` / `keyed`.
        def _v(tok):
            return {"noprivilege": ARM_UNAVAIL_NOPRIV, "error": ARM_UNAVAIL_ERROR,
                    "keyed": ARM_NA_KEYED}.get(tok, None) if not tok.lstrip("-").isdigit() else int(tok)
        for chunk in forced.split(","):
            if not chunk.strip():
                continue
            key, r, c, s, p = chunk.rsplit(":", 4)
            if key == tracker_key:
                return {"refusals": _v(r), "cta": _v(c), "signups": _v(s), "prior_days": _v(p)}
        return {"refusals": 0, "cta": 0, "signups": 0, "prior_days": 0}

    iph = bucket_ip_hash(tracker_key)
    if iph is None:
        # KEYED bucket. Not a failure and not a zero — there is genuinely no ip_hash to join.
        return {"refusals": ARM_NA_KEYED, "cta": ARM_NA_KEYED,
                "signups": ARM_NA_KEYED, "prior_days": ARM_NA_KEYED}

    out = {}
    try:
        sql = build_outcome_query("funnel", iph, since_s, until_s)
        parts = _psql(sql).strip().split("|")
        if len(parts) != 3:
            raise RuntimeError("unexpected funnel_events outcome row: %r" % parts)
        out["refusals"], out["cta"], out["prior_days"] = int(parts[0]), int(parts[1]), int(parts[2])
    except Exception as e:  # noqa: BLE001 — an unreadable arm degrades, it never kills the run
        reason = _arm_unavailable_reason(e)
        log("OUTCOME_ARM_INDETERMINATE: funnel_events for %s — %s (%s)"
            % (render_bucket(tracker_key), reason, type(e).__name__))
        out["refusals"] = out["cta"] = out["prior_days"] = reason
    try:
        sql = build_outcome_query("signup", iph, since_s, until_s)
        parts = _psql(sql).strip().split("|")
        if len(parts) != 2:
            raise RuntimeError("unexpected signup_attribution outcome row: %r" % parts)
        out["signups"] = int(parts[0])
    except Exception as e:  # noqa: BLE001
        reason = _arm_unavailable_reason(e)
        log("OUTCOME_ARM_INDETERMINATE: signup_attribution for %s — %s (%s)"
            % (render_bucket(tracker_key), reason, type(e).__name__))
        out["signups"] = reason
    return out


def resolve_outcome(outcome):
    """The pending entry's terminal state, from its measured outcome. One derivation.

    Order is deliberate — strongest evidence of a GOOD outcome first:
      signup   -> SILENT_CONVERTED     the funnel worked; a working funnel is not a page
      cta      -> SILENT_CTA_CLICKED   they engaged with the upsell
      refusals -> SILENT_STILL_ACTIVE  still hammering the wall; nothing has been lost yet
      else     -> PAGED                walled, grace elapsed, and then silence — the churn case

    AN UNAVAILABLE ARM CAN NEVER SILENCE A PAGE. `x > 0` is False for a sentinel string, so an
    arm we could not read falls through to PAGED rather than being read as zero. That direction
    is the safe one *and* the loud one: it preserves the pre-wave behaviour exactly when the
    instruments fail, and it is what makes a lost migration-034 grant show up in an operator's
    hands instead of vanishing into a silent resolve.
    """
    def positive(v):
        return isinstance(v, int) and v > 0
    if positive(outcome.get("signups")):
        return ST_CONVERTED
    if positive(outcome.get("cta")):
        return ST_CTA
    if positive(outcome.get("refusals")):
        return ST_ACTIVE
    return ST_PAGED


def render_arm(value, unit):
    """One outcome fact, rendered. A sentinel prints itself; an int gets its noun."""
    if value in ARM_UNAVAILABLE:
        return value
    return "%d %s" % (value, unit)


def parse_forced_rows(spec):
    """Parse the `key:count:epoch[:daily_count:daily_day]` test seam.

    Splits from the RIGHT. Tracker keys contain colons of their own — `free:v2:<hash>` is the
    canonical keyless form — so a left-to-right `split(":")[0:3]` reads the key as `free`, the
    count as `v2`, and dies on `int('v2')`. That is not hypothetical: it made the very first
    fire-proof run on the host report INDETERMINATE, and the scenario suite could not see it
    because every case calls `run_cycle` directly and never touches this seam.

    WIDENED for the daily meter, keeping the 3-field form working. The discriminator is
    STRUCTURAL, never positional-by-hope: the 5-field reading is taken only when the last field
    is a `YYYY-MM-DD` day (or empty, the never-metered shape). Without that guard
    `free:v2:aaaa:100:1785000000` — a legitimate 3-field chunk whose key contains two colons —
    would rsplit into five parts and be misread as a daily row with an epoch for a day.
    """
    rows = []
    for chunk in spec.split(","):
        if not chunk.strip():
            continue
        parts = chunk.rsplit(":", 4)
        if len(parts) == 5 and (UTC_DAY_RE.match(parts[4]) or parts[4] == ""):
            key, count, start, daily_count, daily_day = parts
            rows.append((key, int(count), int(start), int(daily_count), daily_day))
            continue
        key, count, start = chunk.rsplit(":", 2)
        rows.append((key, int(count), int(start), 0, ""))
    return rows


def query_rows(monthly_cap, daily_cap, utc_day):
    """[(tracker_key, call_count, period_start_epoch, daily_count, daily_day)] for free buckets.

    Only free buckets are considered: a keyless one is `free:...`, a keyed one is an
    `av_free_...` key. Every paid key carries a different prefix, so this is the tier filter
    (`quota_usage` itself stores no tier). `-F '|'` keeps parsing trivial; the SQL literals are
    naturally single-quoted because psql -c is invoked directly, not through `node -e`.
    """
    forced = os.environ.get("QUOTA_CANARY_FORCE_ROWS")
    if forced is not None:
        return parse_forced_rows(forced)
    sql = build_query(monthly_cap, daily_cap, utc_day)
    rows = []
    for line in _psql(sql).splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) != 5:
            raise RuntimeError("unexpected quota_usage row: %r" % line)
        rows.append((parts[0], int(parts[1]), int(parts[2]), int(parts[3] or 0), parts[4]))
    return rows


def _entry(key, used, start, rate, wall, cap, day):
    """One classified bucket. `used`/`cap` are ALWAYS the pair for THIS row's wall.

    Carrying the denominator on the entry rather than reaching for a module global is the
    single-derivation rule made structural: the resolved cap is chosen once, in classify, and
    every consumer — log line, alert body, dedup id — projects from that one value. A renderer
    that cannot reach a cap cannot render a stale one.
    """
    return {"key": key, "used": used, "start": start, "rate": rate,
            "wall": wall, "cap": cap, "day": day}


def dedup_id(entry):
    """Dedup identity = (bucket, period, wall, and the UTC day for a DAILY wall only).

    The monthly form is BYTE-IDENTICAL to the pre-W1 `key@epoch` id, deliberately: monthly is
    the default namespace, the semantic identity is unchanged, and keeping the string stable
    means the fired-set survives this install instead of re-paging every already-known monthly
    bucket at cutover.

    The daily form carries its UTC day because a daily wall RECURS inside one monthly period.
    Keyed on the period alone, the first daily wall of a month would fire and the next thirty
    would be silent — and so would the caller's eventual monthly exhaustion, which is exactly
    what happened to `free:v2:4df1578c249959b8`: the daily wall on 2026-08-13 claimed the id,
    and the genuine monthly wall at 2026-08-14T06:02Z never paged.
    """
    if entry["wall"] == WALL_DAILY:
        return "%s@%d|daily@%s" % (entry["key"], entry["start"], entry["day"])
    return "%s@%d" % (entry["key"], entry["start"])


def classify(rows, now_s, facts, monthly_cap, daily_cap):
    """Split the selected rows into internal (skip), high-volume (page), low-volume, stale.

    NAMES THE WALL (OPS-QUOTA-CANARY-METER-TRUTH-W1). `license.ts` refuses on the rolling
    monthly budget and on the UTC-day pacing cap INDEPENDENTLY, so a row can be live on either
    or both. A bucket on BOTH is reported ONCE, MONTHLY-FIRST: the monthly wall is the more
    severe of the two because it does not clear at 00:00 UTC.

    Monthly liveness still requires the period to be inside the rolling window; daily liveness
    is already pinned to today by the query, so a daily row is never "period rolled" — reading
    a fresh daily wall as a stale monthly period is how the more severe classification would
    silently swallow the less severe one.

    REVENUE-METER-TRUTH-W6 CH6 — two behaviours that survive unchanged:

    1. INTERNAL BUCKETS ARE EXCLUDED, on either wall. This canary exists to catch a CUSTOMER at
       the wall; our own bots hitting it is not a conversion moment. Measured 2026-08-05: of the
       19 `free:` buckets that had ever reached the wall, THIRTEEN are `is_bot_internal`.

    2. THE RATE IS WINDOWED, not lifetime-averaged. See RATE_WINDOW_H above for why the old
       `count / period_age` denominator made the floor structurally unreachable.

    A bucket with NO facts row has no request_log traffic in the window, so its windowed
    rate is 0 and it is low-volume — the correct reading of "walled a while ago and is
    quiet now", which is precisely not a page. Note this is deliberately NOT default-deny:
    the failure mode being avoided is a NOISY canary, and the fail-open direction for a
    pager is silence, not a page on absent evidence.
    """
    high, low, stale, internal = [], [], [], []
    window_days = max(RATE_WINDOW_H / 24.0, 1.0 / 24.0)
    today = utc_day_key(now_s)
    for key, count, start, daily_count, daily_day in rows:
        f = facts.get(key) or {}
        monthly_live = count >= monthly_cap and (now_s - start) <= WINDOW_S
        daily_live = daily_count >= daily_cap and daily_day == today

        if monthly_live:
            wall, used, cap = WALL_MONTHLY, count, monthly_cap
        elif daily_live:
            wall, used, cap = WALL_DAILY, daily_count, daily_cap
        else:
            # Selected by the query but live on neither wall now — the monthly period rolled,
            # and any daily row belongs to an earlier UTC day. Rendered in monthly terms
            # because that is the leg that selected it.
            wall, used, cap = WALL_MONTHLY, count, monthly_cap

        if f.get("internal"):
            internal.append(_entry(key, used, start, 0.0, wall, cap, today))
            continue
        if not (monthly_live or daily_live):
            stale.append(_entry(key, used, start, 0.0, wall, cap, today))
            continue

        if bucket_ip_hash(key) is None:
            # KEYED bucket (`av_free_…`). `request_log` records an ip_hash, never an API key,
            # so there is nothing to window on.
            if wall == WALL_DAILY:
                # It spent `daily_count` calls INSIDE one UTC day, so that number already IS a
                # calls/day figure — an exact lower bound rather than an estimate. Better than
                # the monthly lifetime average here, and far better than 0, which would mute
                # every keyed daily wall there will ever be.
                rate = float(daily_count)
            else:
                # The lifetime estimate is the only signal available. Keeping it is strictly
                # better than the alternative: a windowed rate would be 0 for EVERY keyed
                # bucket, which would silently mute the most valuable case this canary has —
                # a caller who actually registered, and then hit the wall.
                rate = count / max(1.0, (now_s - start) / DAY_S)
        else:
            rate = float(f.get("window_calls") or 0) / window_days

        entry = _entry(key, used, start, rate, wall, cap, today)
        (high if rate >= MIN_CALLS_PER_DAY else low).append(entry)
    return high, low, stale, internal


def build_body(new_entries, total_high, monthly_cap, daily_cap):
    """The operator-facing body.

    Per the alert-body law (OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 D3): an entity ID carries its
    entity NOUN, and a bare parenthesised number never sits next to a count — a real operator
    read `(new: 6)` as "six subscriptions" on 2026-08-01 when there were two. Here the ids are
    opaque strings rather than integers, but the same rule applies: they are introduced as
    "bucket <id>" / "buckets <id>, <id>", pluralised from the ID COUNT.

    EVERY DENOMINATOR IS A RESOLVED CAP, and every entry names its wall and that wall's reset
    horizon. The two are not interchangeable to an operator deciding whether to act: a daily
    wall clears at 00:00 UTC and the caller returns on their own, a monthly wall does not.
    Before OPS-QUOTA-CANARY-METER-TRUTH-W1 this line rendered a hand-mirrored literal, so a
    DAILY exhaustion was reported as `used 100/100 … free limit 100/mo` — every number on it
    either fabricated or attributed to the wrong meter.
    """
    ids = [render_bucket(e["key"]) for e in new_entries]
    noun = "bucket" if len(ids) == 1 else "buckets"
    detail = " | ".join(
        "%s used %d/%d (%s) at ~%.0f calls/day%s"
        % (render_bucket(e["key"]), e["used"], e["cap"], WALL_HORIZON[e["wall"]], e["rate"],
           ("" if not e.get("also_wall") else
            " [also hit the %s wall earlier in this episode — coalesced into this one page]"
            % e["also_wall"].upper()))
        for e in new_entries
    )
    # THE OUTCOME, not a research task. Every fact is measured over the grace window and every
    # one of them degrades to an EXPLICIT string — never a silent zero, never a dropped line.
    outcome_lines = [
        "  %s — %s since the wall | signup: %s | upgrade CTA: %s | prior walled days: %s"
        % (render_bucket(e["key"]),
           render_arm(e["outcome"]["refusals"], "refusals"),
           render_arm(e["outcome"]["signups"], "attributed"),
           (e["outcome"]["cta"] if e["outcome"]["cta"] in ARM_UNAVAILABLE
            else ("%d" % e["outcome"]["cta"] if e["outcome"]["cta"]
                  else "0 — ARM IS DARK (1 click estate-wide, all-time)")),
           render_arm(e["outcome"]["prior_days"], "days"))
        for e in new_entries
    ]
    # SINGLE DERIVATION of the contact channel, from the bucket's own keyed/keyless
    # discriminator — the same value `render_bucket` and `bucket_ip_hash` already branch on.
    # Before OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1 this sentence asserted "no account and no
    # email" UNCONDITIONALLY, including on `key:sha16:…` buckets, whose whole definition is a
    # caller who registered. It shipped that way to the operator at least twice on 2026-08-16
    # (`av_free_30…` and `av_free_c8…`, both walled 100/100 that day).
    keyed = [e for e in new_entries if bucket_ip_hash(e["key"]) is None]
    keyless = [e for e in new_entries if bucket_ip_hash(e["key"]) is not None]
    contact = []
    if keyed:
        contact.append("REGISTERED caller%s %s — a free API key was issued, so an account and a "
                       "direct contact path EXIST."
                       % ("" if len(keyed) == 1 else "s",
                          ", ".join(render_bucket(e["key"]) for e in keyed)))
    if keyless:
        contact.append("Keyless caller%s %s — no account and no email; the exhaustion notice was "
                       "the only contact."
                       % ("" if len(keyless) == 1 else "s",
                          ", ".join(render_bucket(e["key"]) for e in keyless)))
    # The action clause PROJECTS from the same measured outcome the body just rendered, once.
    # An unconditional "the caller went quiet" would assert as fact the exact thing an
    # UNAVAILABLE arm means we could not establish — which is the shape of falsehood R3 exists
    # to retire, reappearing one line lower down.
    unread = [e for e in new_entries
              if any(e["outcome"][k] in ARM_UNAVAILABLE for k in ("refusals", "signups", "cta"))]
    if unread:
        action_clause = ("the outcome could NOT be measured for %d of %d bucket(s) — treat the "
                         "page as unresolved and fix the reader first (see the unavailable arm "
                         "above; migrations/034_grant_autopilot_funnel_reads.sql grants it)."
                         % (len(unread), len(new_entries)))
    else:
        action_clause = ("the caller(s) above went quiet after the wall — decide win-back vs "
                         "let-go from the outcome line.")
    return "\n".join([
        "\U0001F4B0 %s" % ALERT_ID,
        # IDs and COUNTS live on SEPARATE lines. Mixing them is what produced the 2026-08-01
        # misread; keeping every count away from the ID list removes the ambiguity structurally
        # rather than relying on punctuation to disambiguate it.
        "Newly exhausted: %s %s" % (noun, ", ".join(ids)),
        detail,
        "Newly exhausted count: %d | high-volume exhausted now: %d | threshold >= %d calls/day "
        "| free limits %d/mo + %d/day"
        % (len(ids), total_high, MIN_CALLS_PER_DAY, monthly_cap, daily_cap),
        "This is a CONVERSION moment, not a fault. Outcome measured over the %dh since detection:"
        % OUTCOME_GRACE_H,
    ] + outcome_lines + [
        "Contact: %s" % " ".join(contact),
        # R5 — the retired `OPS-QUOTA-EXHAUSTION-CONVERSION-W{NEXT}` was recommended on all 12
        # delivered pages and dispatched zero times; the wrapper logged RESOLVER_MISS every time
        # because no wave of that class has ever completed. The action line now names THIS
        # bucket and its measured outcome, and any wave reference keeps the {NEXT} template form
        # (a literal Wn is forbidden) pointing at a class that actually has a completed wave.
        "Action: %s Free-tier policy follow-up: OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W{NEXT}."
        % action_clause,
        "Source log: %s" % LOG,
    ])


def _id_line_has_no_count(body, ids):
    """True iff the ID line exists AND carries no digits once the IDs are removed.

    Written defensively on purpose: an assertion that INDEXES into a split is not an assertion,
    it is a crash waiting to be mistaken for a pass. If the "Newly exhausted:" label is gone the
    check must report FALSE (→ SELF-TEST: FAIL), never raise.
    """
    marker = "Newly exhausted: "
    for line in body.split("\n"):
        if not line.startswith(marker):
            continue
        rest = line[len(marker):]
        for i in ids:
            rest = rest.replace(i, "")
        return not any(ch.isdigit() for ch in rest)
    return False


# Last body handed to fire(). The --self-test asserts the RENDERED TEXT against this, not just
# run_cycle's action verdict — asserting the verdict alone is exactly how a body a human
# misreads passed every gate on 2026-08-01.
LAST_FIRE_BODY = None


def fire(body):
    """Hand the body to the wrapper (it owns severity/cooldown/DRY_RUN/fail-open)."""
    global LAST_FIRE_BODY
    LAST_FIRE_BODY = body
    if os.environ.get("QUOTA_CANARY_SELFTEST") == "1":
        log("WOULD_FIRE: (self-test — wrapper skipped)")
        return
    proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"], input=body,
                          capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))
    if os.environ.get("ALGOVAULT_TG_TEST_INERT") == "1":
        log("WOULD_FIRE: alert_id=%s severity=CRITICAL_PERSISTENT verdict=SUPPRESSED_TEST_INERT "
            "(no POST, no cooldown marker)" % ALERT_ID)
    elif os.environ.get("DRY_RUN_TG") == "1":
        log("WOULD_FIRE: alert_id=%s severity=CRITICAL_PERSISTENT verdict=DRY_RUN (no POST; 24h "
            "COOLDOWN MARKER WRITTEN — prefer ALGOVAULT_TG_TEST_INERT=1)" % ALERT_ID)


def run_cycle(rows, now_s, facts, monthly_cap, daily_cap):
    """One evaluation. Auto-resolve, detect-to-PENDING, resolve-on-outcome, fire.

    DETECT AT THE MOMENT, PAGE ON THE OUTCOME (OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1). A newly
    exhausted high-volume external bucket is recorded PENDING and pages NOTHING. On the first
    cycle at or after `OUTCOME_GRACE_H` the entry is resolved against its measured outcome to
    exactly one terminal state, and only the PAGED branch reaches the operator.

    COALESCING. A caller's daily wall leads their monthly wall by a median 15.5h, so the monthly
    wall usually arrives while the daily entry is still PENDING. When it does, the pending entry
    is UPGRADED in place — monthly-first, keeping the ORIGINAL detection instant so the page is
    not delayed — and BOTH dedup ids are marked, so the monthly can never page separately later.
    The page then states the MONTHLY reset horizon: monthly is the binding wall and does NOT
    clear at 00:00 UTC, so rendering the daily horizon would tell the operator to expect a
    recovery in hours that is not coming. Same monthly-first precedence `classify` already
    applies to the same-cycle case.
    """
    high, low, stale, internal = classify(rows, now_s, facts or {}, monthly_cap, daily_cap)
    state = load_state()
    live_ids = set(dedup_id(e) for e in high)

    # 1) Auto-resolve (SILENT): periods that rolled over, UTC days that rolled over, or
    #    callers who upgraded. A PENDING entry that disappears before its grace elapses is
    #    resolved here and never pages — the wall cleared on its own, which is the funnel
    #    working, and this is the recovery-is-silent default the alert contract mandates.
    #
    # ⚠️ A PENDING ENTRY IS NEVER PRUNED HERE, and that exception is load-bearing in two ways.
    # (a) A DAILY dedup id carries its UTC day, so it leaves the live set at 00:00 UTC — every
    #     single time, by construction. Pruning pending entries would therefore destroy every
    #     daily detection before its 24h grace elapsed, and with it the coalescing window that
    #     the monthly wall (median 15.5h later, i.e. usually across that boundary) depends on.
    # (b) A pending entry is a COMMITMENT to evaluate an outcome at a stated instant. Dropping
    #     it early does not make the alert quieter, it makes it forgetful.
    # Pending entries whose row is gone at resolution time are handled there, silently, as the
    # recovery they are.
    # A bucket that still has a PENDING entry keeps its whole state, terminal siblings included:
    # the coalesce record IS a closed sibling, and pruning it would erase the evidence that the
    # page about to be rendered absorbed an earlier wall. It self-cleans on the first cycle
    # after that pending entry resolves.
    keys_pending = set(i.split("@")[0] for i, v in state.items() if v["state"] == ST_PENDING)
    resolved = set(i for i, v in state.items()
                   if i not in live_ids and v["state"] != ST_PENDING
                   and i.split("@")[0] not in keys_pending)
    if resolved:
        log("RESOLVED: %d bucket-period-wall(s) no longer exhausted (auto-resolve, silent)"
            % len(resolved))
        state = {i: v for i, v in state.items() if i not in resolved}
        save_state(state)
    fired = set(state)

    # POSITIVE per-check output — never absence-of-alert. A row silently dropped by a parse
    # error must not look identical to a row that was evaluated and passed. Every line carries
    # the WALL and the RESOLVED denominator, so a stale cap is visible in the log and not only
    # in an alert nobody may receive.
    for e in high:
        log("EVAL high-volume: bucket %s used %d/%d wall=%s rate ~%.0f/day (>= %d) verdict=PAGE_CANDIDATE"
            % (render_bucket(e["key"]), e["used"], e["cap"], e["wall"].upper(), e["rate"], MIN_CALLS_PER_DAY))
    for e in low:
        log("EVAL low-volume: bucket %s used %d/%d wall=%s rate ~%.1f/day (< %d) verdict=SILENT_BY_DESIGN"
            % (render_bucket(e["key"]), e["used"], e["cap"], e["wall"].upper(), e["rate"], MIN_CALLS_PER_DAY))
    for e in stale:
        log("EVAL stale-period: bucket %s used %d/%d verdict=SKIPPED_PERIOD_ROLLED"
            % (render_bucket(e["key"]), e["used"], e["cap"]))
    # Internal buckets get a POSITIVE line of their own rather than vanishing. A bucket
    # dropped silently by the exclusion is indistinguishable from one that was never
    # queried, which is the failure this canary's own per-bucket output rule exists to stop.
    for e in internal:
        log("EVAL internal: bucket %s used %d/%d wall=%s verdict=SKIPPED_INTERNAL (is_bot_internal — "
            "our own traffic, not a customer at the wall)"
            % (render_bucket(e["key"]), e["used"], e["cap"], e["wall"].upper()))

    # BOOTSTRAP — report, do not page. On the FIRST cycle on a host every currently-exhausted
    # bucket looks "new", so a naive first run pages the entire accumulated backlog as though it
    # had just happened. Live measurement before install: 19 exhausted buckets, 5 of them above
    # the volume threshold — an opening alert naming five historical exhaustions, none of which
    # was a fresh conversion moment. Seed the state instead and page only on what happens NEXT.
    # (Same shape as the "bootstrap report-not-page for never-attempted keys" rule.)
    if not state_exists():
        seeded = live_ids
        save_fired_set(seeded)
        log("BOOTSTRAP: first cycle on this host — seeded %d high-volume bucket-period-wall(s) WITHOUT "
            "paging (historical backlog, not new events). high=%d low=%d stale=%d"
            % (len(seeded), len(high), len(low), len(stale)))
        return {"action": "bootstrap", "seeded": len(seeded), "high": len(high), "low": len(low),
                "internal": len(internal)}

    # 2) DETECT — a bucket-period-wall we have not seen becomes PENDING. No page.
    #    Coalescing runs first so a monthly wall arriving on top of a still-PENDING daily one
    #    is absorbed rather than opening a second pending entry.
    by_key_pending = {}
    for ident, v in state.items():
        if v["state"] == ST_PENDING:
            by_key_pending.setdefault(ident.split("@")[0], []).append(ident)
    entry_by_id = {dedup_id(e): e for e in high}
    coalesced = {}
    newly_pending = []
    for e in high:
        ident = dedup_id(e)
        if ident in state:
            continue
        siblings = [i for i in by_key_pending.get(e["key"], []) if i != ident]
        if siblings and e["wall"] == WALL_MONTHLY:
            # Monthly wall landed while the daily one is still PENDING → one page, not two.
            older = min(siblings, key=lambda i: state[i]["since"])
            lag_h = max(0.0, (now_s - state[older]["since"]) / 3600.0)
            state[ident] = {"state": ST_PENDING, "since": state[older]["since"]}
            state[older] = {"state": ST_ACTIVE, "since": state[older]["since"]}
            coalesced[ident] = {"from_wall": WALL_DAILY, "lag_h": lag_h}
            log("COALESCE: bucket %s hit the MONTHLY wall %.1fh after a still-PENDING DAILY wall "
                "— merged into ONE pending page, monthly-first; both dedup ids are now claimed "
                "so the monthly cannot page separately later"
                % (render_bucket(e["key"]), lag_h))
            continue
        state[ident] = {"state": ST_PENDING, "since": now_s}
        newly_pending.append(e)
        log("EVAL deferred: bucket %s used %d/%d wall=%s verdict=PENDING_OUTCOME (page held %dh; "
            "resolves at ~%s)"
            % (render_bucket(e["key"]), e["used"], e["cap"], e["wall"].upper(), OUTCOME_GRACE_H,
               time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_s + OUTCOME_GRACE_H * 3600))))

    # 3) RESOLVE — every PENDING entry whose grace has elapsed gets exactly one terminal state.
    due, page_entries = [], []
    for ident, v in sorted(state.items()):
        if v["state"] != ST_PENDING:
            continue
        if now_s - v["since"] < OUTCOME_GRACE_H * 3600:
            log("EVAL pending: %s verdict=PENDING_OUTCOME (%.1fh of %dh elapsed — no page)"
                % (ident, max(0.0, (now_s - v["since"]) / 3600.0), OUTCOME_GRACE_H))
            continue
        e = entry_by_id.get(ident)
        if e is None:
            # The wall CLEARED on its own before the grace elapsed — the daily cap rolling over
            # at 00:00 UTC is the overwhelming case, and a caller who is served again tomorrow
            # is the funnel working, not a conversion moment lost. Recovery is silent by the
            # alert contract; the measured outcome still goes to the log as forensics so a
            # silently-closed entry is never indistinguishable from one that was skipped.
            key = ident.split("@")[0]
            oc = query_outcome(key, v["since"], now_s)
            state[ident] = {"state": ST_ACTIVE, "since": v["since"]}
            log("EVAL resolve: bucket %s verdict=SILENT_STILL_ACTIVE (wall cleared before the "
                "%dh grace elapsed — no live row this cycle; refusals=%s signups=%s cta=%s)"
                % (render_bucket(key), OUTCOME_GRACE_H, oc["refusals"], oc["signups"], oc["cta"]))
            continue
        outcome = query_outcome(e["key"], v["since"], now_s)
        terminal = resolve_outcome(outcome)
        state[ident] = {"state": terminal, "since": v["since"]}
        due.append(ident)
        log("EVAL resolve: bucket %s wall=%s grace=%dh refusals=%s signups=%s cta=%s "
            "prior_days=%s verdict=%s"
            % (render_bucket(e["key"]), e["wall"].upper(), OUTCOME_GRACE_H,
               outcome["refusals"], outcome["signups"], outcome["cta"], outcome["prior_days"],
               terminal))
        if terminal == ST_PAGED:
            e = dict(e)
            e["outcome"] = outcome
            # Was this entry COALESCED from an earlier wall of the same bucket? Derived from the
            # state itself rather than from a per-invocation variable, because detection and
            # resolution are DIFFERENT RUNS an entire grace window apart — anything held only in
            # memory is gone by the time the body is rendered. The signature is exact: a sibling
            # id on the same bucket, closed at coalesce time, carrying the SAME detection
            # instant this entry inherited. A sibling that merely resolved on its own carries
            # its own `since` and does not match.
            sibs = [i for i, sv in state.items()
                    if i != ident and i.split("@")[0] == e["key"]
                    and sv["state"] == ST_ACTIVE and sv["since"] == v["since"]]
            if sibs:
                e["also_wall"] = WALL_DAILY if any("|daily@" in i for i in sibs) else WALL_MONTHLY
            page_entries.append(e)

    save_state(state)

    if not page_entries:
        log("HEALTHY: high=%d low=%d stale=%d internal=%d pending=%d resolved_this_cycle=%d, "
            "no page (rows=%d)"
            % (len(high), len(low), len(stale), len(internal),
               sum(1 for v in state.values() if v["state"] == ST_PENDING), len(due), len(rows)))
        return {"action": "silent", "high": len(high), "low": len(low), "internal": len(internal),
                "pending": len(newly_pending), "resolved": len(due)}

    fire(build_body(page_entries, len(high), monthly_cap, daily_cap))
    return {"action": "fire", "new": len(page_entries), "high": len(high), "low": len(low),
            "internal": len(internal), "pending": len(newly_pending), "resolved": len(due),
            "walls": sorted(set(e["wall"] for e in page_entries))}


def main():
    try:
        # RESOLVE FIRST, and evaluate NOTHING if it fails. The caps are the unit every
        # downstream decision is expressed in — which rows are selected, which are exhausted,
        # what denominator the operator reads — so a run that cannot resolve them has not
        # "mostly worked", it has verified nothing.
        caps = resolve_free_caps()
        if caps is None:
            log("INDETERMINATE: free caps unresolved — this cycle evaluated NOTHING. No query "
                "was run and no bucket was classified. A literal fallback here is exactly what "
                "produced OPS-QUOTA-CANARY-METER-TRUTH-W1, so there is not one.")
            print("QUOTA_EXHAUSTION_CANARY_VERDICT=INDETERMINATE")
            return 0
        monthly_cap, daily_cap = caps

        # `QUOTA_CANARY_AS_OF` (epoch seconds) replays the evaluation at a past instant so a
        # historical exhaustion can be proven to FIRE. Read-only: it moves the rate window, the
        # staleness horizon and the UTC day together, and nothing else.
        as_of = os.environ.get("QUOTA_CANARY_AS_OF")
        now_s = int(as_of or time.time())
        rows = query_rows(monthly_cap, daily_cap, utc_day_key(now_s))
        facts = query_bucket_facts([r[0] for r in rows], int(as_of) if as_of else None)
        run_cycle(rows, now_s, facts, monthly_cap, daily_cap)
        print("QUOTA_EXHAUSTION_CANARY_VERDICT=PASS")
        return 0
    except Exception as e:  # noqa: BLE001 — fail-open is the alert contract
        log("FAIL_OPEN: %s: %s" % (type(e).__name__, e))
        # The exit code stays 0 (alert contract), so the TOKEN is the only thing that can say
        # this run verified nothing. Never launder it into a PASS.
        print("QUOTA_EXHAUSTION_CANARY_VERDICT=INDETERMINATE")
        return 0


def self_test():
    """Hermetic scenarios — no DB, no wrapper, temp state."""
    global STATE_DIR, FIRED_SET_FILE, LOG, APP_CONTAINER, query_rows
    tmp = tempfile.mkdtemp(prefix="quota-canary-selftest-")
    STATE_DIR = tmp
    FIRED_SET_FILE = os.path.join(tmp, "fired.set")
    LOG = os.path.join(tmp, "selftest.log")
    os.environ["QUOTA_CANARY_SELFTEST"] = "1"
    os.environ["ALGOVAULT_TG_TEST_INERT"] = "1"  # inert: routes the gates, writes no marker

    failures = []

    def check(name, cond):
        print("  [%s] %s" % ("PASS" if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    NOW = 1_785_000_000
    HOUR = 3600
    TODAY = utc_day_key(NOW)
    # The live ladder as production enforces it, used by every scenario that is not
    # specifically about a DIFFERENT cap pair. Passed in explicitly — there is no module
    # global to fall back on, which is the point.
    CAP_M, CAP_D = 200, 100

    def row(key, count, start, daily_count=0, daily_day=""):
        return (key, count, start, daily_count, daily_day)

    def facts(rows, window_calls, internal=False):
        """Facts for every keyless bucket in `rows`.

        REVENUE-METER-TRUTH-W6 CH6 made the burn rate a function of request_log traffic in
        a window, so every scenario below must now SAY what that traffic was. Passing it
        explicitly is the point: before this, the rate was derivable from the row alone and
        the scenarios could not distinguish a lifetime average from a windowed one.
        """
        return {r[0]: {"internal": internal, "window_calls": window_calls} for r in rows}

    def cycle(rows, now_s, f=None, m=CAP_M, d=CAP_D):
        return run_cycle(rows, now_s, f if f is not None else {}, m, d)

    GRACE_S = OUTCOME_GRACE_H * 3600

    def outcome_seam(rows, refusals=0, cta=0, signups=0, prior=0):
        """Force every bucket in `rows` to a known outcome. `None` clears the seam.

        The hermetic suite has no database, so WITHOUT this every outcome arm would resolve to
        `unavailable (query failed)` and — because an unavailable arm can never silence a page —
        every scenario would page for the wrong reason and still look green. That is precisely
        the "a hermetic --self-test is blind to what its own seam replaces" trap, so the seam is
        explicit per scenario and one scenario below asserts the unavailable path on purpose.
        """
        if rows is None:
            os.environ.pop("QUOTA_CANARY_FORCE_OUTCOME", None)
            return
        os.environ["QUOTA_CANARY_FORCE_OUTCOME"] = ",".join(
            "%s:%d:%d:%d:%d" % (r[0], refusals, cta, signups, prior) for r in rows)

    def page(rows, now_s, f=None, m=CAP_M, d=CAP_D, **oc):
        """Detect, then resolve one grace window later. Returns the RESOLVING cycle's action.

        Two cycles, because that is now the real contract: nothing pages at detection. Callers
        that only want the detection half use `cycle` directly.
        """
        outcome_seam(rows, **oc)
        cycle(rows, now_s, f, m, d)
        return cycle(rows, now_s + GRACE_S + 60, f, m, d)

    # A0) BOOTSTRAP — the first cycle seeds and does NOT page, even with high-volume backlog.
    backlog = [row("free:v2:9999aaaa8888bbbb", 900, NOW - 2 * DAY_S),
               row("free:v2:7777cccc6666dddd", 400, NOW - 2 * DAY_S)]
    r = cycle(backlog, NOW, facts(backlog, 2400))
    check("first cycle with a backlog → bootstrap, NOT a page",
          r["action"] == "bootstrap" and r["seeded"] == 2)
    check("bootstrap seeded the state (so the backlog never pages later)", len(load_fired_set()) == 2)
    check("bootstrap wrote NO alert body", LAST_FIRE_BODY is None)
    check("the same backlog on the NEXT cycle stays silent",
          cycle(backlog, NOW, facts(backlog, 2400))["action"] == "silent")

    # A) nothing exhausted → silent
    check("no exhausted buckets → silent", cycle([], NOW)["action"] == "silent")

    # B) LOW-volume exhaustion is silent BY DESIGN (took 25 days to spend the allowance)
    low_row = [row("free:v2:aaaa1111bbbb2222", 200, NOW - 25 * DAY_S)]
    r = cycle(low_row, NOW, facts(low_row, 12))
    check("low-volume exhaustion → silent by design", r["action"] == "silent" and r["low"] == 1)

    # C) HIGH-volume MONTHLY exhaustion — DETECTED now, PAGED one grace window later.
    high_row = [row("free:v2:cccc3333dddd4444", 200, NOW - HOUR)]
    outcome_seam(high_row)                       # churn branch: no refusals, no cta, no signup
    r0 = cycle(high_row, NOW, facts(high_row, 2400))
    check("detection alone does NOT page (deferred)", r0["action"] == "silent" and r0["pending"] == 1)
    check("detection wrote a PENDING entry", load_state()[dedup_id(
        _entry("free:v2:cccc3333dddd4444", 200, NOW - HOUR, 0, WALL_MONTHLY, 200, TODAY)
    )]["state"] == ST_PENDING)
    check("detection wrote NO alert body", LAST_FIRE_BODY is None)
    r_mid = cycle(high_row, NOW + GRACE_S - 2 * HOUR, facts(high_row, 2400))
    check("grace NOT elapsed → still no page, state persists",
          r_mid["action"] == "silent" and LAST_FIRE_BODY is None)
    r = cycle(high_row, NOW + GRACE_S + 60, facts(high_row, 2400))
    check("grace elapsed on the churn branch → fires", r["action"] == "fire" and r["new"] == 1)
    check("it is named as a MONTHLY wall", r.get("walls") == [WALL_MONTHLY])
    check("the resolved entry is terminal PAGED", ST_PAGED in
          [v["state"] for v in load_state().values()])

    # C2) THE CORRECTED CAP. A bucket at the OLD mirrored literal (100) is only HALF WAY to the
    #     real monthly wall and must NOT be selected. This is the wave's defect, asserted.
    save_fired_set(set())
    half_way = [row("free:v2:5555eeee6666ffff", 100, NOW - HOUR)]
    r = cycle(half_way, NOW, facts(half_way, 2400))
    check("a bucket at 100/200 is NOT exhausted (the retired mirror fired here)",
          r["action"] == "silent" and r["high"] == 0)

    # D) same bucket, same period → NO re-fire (dedup), and a PAGED entry never re-pages
    check("same bucket+period persists after paging → silent (dedup)",
          cycle(high_row, NOW + GRACE_S + 2 * HOUR, facts(high_row, 2400))["action"] == "silent")

    # E) SAME bucket, NEW period → re-arms and pages again after its own grace
    save_fired_set(set())
    new_period = [row("free:v2:cccc3333dddd4444", 200, NOW + 31 * DAY_S)]
    r = page(new_period, NOW + 31 * DAY_S + HOUR, facts(new_period, 2400))
    check("same bucket, NEW period → fires again (re-armed)", r["action"] == "fire")

    # F) bucket leaves the exhausted set → auto-resolve, silent, state emptied
    check("bucket clears → silent (auto-resolve)", cycle([], NOW + 32 * DAY_S)["action"] == "silent")
    check("fired set emptied after resolve", load_fired_set() == set())

    # G) a stale period (older than the rolling window) is skipped, never paged
    stale_row = [row("free:v2:eeee5555ffff6666", 5000, NOW - 60 * DAY_S)]
    check("stale period → silent (skipped)",
          cycle(stale_row, NOW, facts(stale_row, 2400))["action"] == "silent")

    # H) SECRET HYGIENE — a keyed bucket's API key never appears anywhere
    save_fired_set(set())
    keyed = [row("av_free_000000000000000000000000", 200, NOW - HOUR)]
    r = page(keyed, NOW)
    body = LAST_FIRE_BODY or ""
    check("keyed bucket fires", r["action"] == "fire")
    check("rendered body does NOT contain the raw API key", "av_free_000000000000000000000000" not in body)
    check("rendered body redacts by structure (key:sha16:)", "key:sha16:" in body)
    check("keyless ids pass through verbatim", render_bucket("free:v2:abcd") == "free:v2:abcd")

    # I) RENDERED-BODY assertions. A-H assert run_cycle's ACTION verdict only, which is exactly
    #    how an operator-misreadable body passed every gate on 2026-08-01.
    save_fired_set(set())
    body_row = [row("free:v2:1111aaaa2222bbbb", 200, NOW - HOUR)]
    page(body_row, NOW, facts(body_row, 2400))
    body1 = LAST_FIRE_BODY or ""
    check("singular labels the ID ('Newly exhausted: bucket <id>')",
          "Newly exhausted: bucket free:v2:1111aaaa2222bbbb" in body1)
    check("singular count is on its own labelled line", "Newly exhausted count: 1" in body1)
    check("body states usage as N/<resolved monthly cap>", "used 200/200" in body1)
    check("body names the MONTHLY wall and its reset horizon",
          "(MONTHLY wall — clears at the caller's rolling reset)" in body1)
    check("body states the burn rate", "calls/day" in body1)
    check("summary states BOTH resolved limits", "free limits 200/mo + 100/day" in body1)
    check("the retired single-limit phrasing is gone", "free limit " not in body1)
    check("body carries a templated recommended_wave (no literal Wn)",
          "OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W{NEXT}" in body1)
    check("no literal Wn anywhere in the body",
          not re.search(r"-W\d+\b", body1))

    # ── OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1 R2/R5 — the body carries the ANSWER, not homework.
    check("R2: body carries the refusal-continuation fact", "refusals since the wall" in body1)
    check("R2: body carries the signup fact", "signup: " in body1)
    check("R2: body carries the CTA fact", "upgrade CTA: " in body1)
    check("R2: body carries the prior-walled-days fact", "prior walled days: " in body1)
    check("R2: body names the grace window it measured over",
          "since detection" in body1 and str(OUTCOME_GRACE_H) in body1)
    # STRUCTURAL absence, asserted on the RENDERED body — and deliberately not satisfiable by a
    # comment recording the retired string, because a comment is not in the body at all.
    check("R5: the retired research line is structurally ABSENT",
          "Check funnel_events" not in body1)
    check("R5: the never-dispatched wave name is structurally ABSENT",
          "OPS-QUOTA-EXHAUSTION-CONVERSION" not in body1)

    save_fired_set(set())
    body_rows = [row("free:v2:1111aaaa2222bbbb", 200, NOW - HOUR),
                 row("free:v2:3333cccc4444dddd", 200, NOW - HOUR)]
    page(body_rows, NOW, facts(body_rows, 2400))
    body2 = LAST_FIRE_BODY or ""
    check("plural renders 'buckets <id>, <id>'",
          "Newly exhausted: buckets free:v2:1111aaaa2222bbbb, free:v2:3333cccc4444dddd" in body2)
    check("plural does NOT render the singular noun before the list",
          "Newly exhausted: bucket free:v2:1111aaaa2222bbbb," not in body2)
    check("the ID line carries NO count (counts live on their own line)",
          _id_line_has_no_count(body2, ["free:v2:1111aaaa2222bbbb", "free:v2:3333cccc4444dddd"]))
    check("counts are rendered on a separate, labelled line",
          "Newly exhausted count: 2" in body2)

    # ── OPS-QUOTA-CANARY-METER-TRUTH-W1 ───────────────────────────────────────────────
    #
    # Q1) NO CAP LITERAL SURVIVES IN THIS FILE. Asserted against this file's own AST, so the
    #     historical comments recording the literal that caused the wave can neither trip the
    #     check nor satisfy it. RED-verified by re-adding `FREE_LIMIT = 100`.
    try:
        cap_hits = cap_literal_defaults()
        scanned = True
    except Exception as e:  # noqa: BLE001 — an assertion that raises is not an assertion
        log("cap-literal scan raised: %s: %s" % (type(e).__name__, e))
        cap_hits, scanned = ["<scan raised>"], False
    check("the cap-literal scan ran at all", scanned)
    check("this file binds NO free-tier cap to a numeric literal (found: %s)" % (cap_hits or "none"),
          scanned and cap_hits == [])
    # The scan must be able to SEE one — otherwise `[] == []` proves nothing about the predicate.
    probe_src = os.path.join(tmp, "cap_literal_probe.py")
    with open(probe_src, "w") as fh:
        fh.write("FREE_LIMIT = 100\n"
                 "MIN_CALLS_PER_DAY = _int_env('QUOTA_CANARY_MIN_CALLS_PER_DAY', 50)\n"
                 "X = _int_env('QUOTA_CANARY_FREE_DAILY', 100)\n")
    probe_hits = cap_literal_defaults(probe_src)
    check("the scan DETECTS a re-added `FREE_LIMIT = 100`",
          any("FREE_LIMIT" in h for h in probe_hits))
    check("the scan DETECTS a numeric default on a QUOTA_CANARY_FREE* env read",
          any("QUOTA_CANARY_FREE_DAILY" in h for h in probe_hits))
    check("the scan does NOT flag the MIN_CALLS_PER_DAY threshold default",
          not any("MIN_CALLS" in h for h in probe_hits))

    # Q2) THE RESOLVER. Its seam is documented and both-or-neither; its failure is None.
    #
    # The container is pointed at a name that CANNOT exist for the whole block, so every
    # assertion here is deterministic wherever the suite runs — laptop, host, CI. Leaving the
    # real container in place would make the half-set assertions pass on a laptop (no docker)
    # and fail on the host (caps resolvable), which is a suite that lies depending on where it
    # is run.
    saved_container = APP_CONTAINER
    APP_CONTAINER = "algovault-quota-canary-selftest-no-such-container"
    check("an unreachable app container resolves to None (refuse, never default)",
          resolve_free_caps() is None)
    os.environ["QUOTA_CANARY_FREE_LIMIT"] = "500"
    os.environ["QUOTA_CANARY_FREE_DAILY"] = "250"
    check("resolver honours the documented seam pair", resolve_free_caps() == (500, 250))
    # A half-set seam must resolve to None AND SAY WHY. Asserting only the None would be
    # satisfied by two different code paths — the explicit both-or-neither guard, and
    # `_validated_caps` rejecting the None downstream — so deleting the guard would be
    # invisible to this suite (measured: RED-verify break B14 produced zero failures until
    # the diagnosis was asserted). The guard's product IS the diagnosis: an operator reading
    # only `INDETERMINATE` cannot tell a misconfigured smoke from a broken container.
    mark = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    os.environ.pop("QUOTA_CANARY_FREE_DAILY", None)
    check("a HALF-SET seam resolves to None, never a mixed pair", resolve_free_caps() is None)
    try:
        with open(LOG) as fh:
            half_set_log = fh.read()[mark:]
    except OSError:
        half_set_log = ""
    check("...and it is DIAGNOSED as a half-set seam, not as a bad cap value",
          "HALF-SET" in half_set_log)
    os.environ["QUOTA_CANARY_FREE_DAILY"] = "0"
    check("a non-positive cap resolves to None", resolve_free_caps() is None)
    os.environ["QUOTA_CANARY_FREE_DAILY"] = "not-a-number"
    check("an unparseable cap resolves to None", resolve_free_caps() is None)
    os.environ.pop("QUOTA_CANARY_FREE_LIMIT", None)
    os.environ.pop("QUOTA_CANARY_FREE_DAILY", None)

    # Q3) UNRESOLVED CAPS ⇒ INDETERMINATE, and the run evaluates ZERO rows. Asserted through
    #     main() rather than by inspection, and the query is replaced by a tripwire so
    #     "evaluated nothing" is measured rather than assumed.
    real_query_rows = query_rows
    queried = []

    def _tripwire(*a, **k):
        queried.append(a)
        return []

    query_rows = _tripwire
    os.environ["QUOTA_CANARY_FORCE_FACTS"] = ""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc_bad = main()
    out_bad = buf.getvalue()
    check("unresolved caps → QUOTA_EXHAUSTION_CANARY_VERDICT=INDETERMINATE",
          "QUOTA_EXHAUSTION_CANARY_VERDICT=INDETERMINATE" in out_bad)
    check("unresolved caps → never laundered into PASS",
          "QUOTA_EXHAUSTION_CANARY_VERDICT=PASS" not in out_bad)
    check("unresolved caps → ZERO rows queried", queried == [])
    check("unresolved caps → exit code stays 0 (alert contract)", rc_bad == 0)
    # Positive control: the SAME main() with caps resolvable DOES query and DOES report PASS,
    # so the assertions above cannot be satisfied by main() being broken outright.
    os.environ["QUOTA_CANARY_FREE_LIMIT"] = "200"
    os.environ["QUOTA_CANARY_FREE_DAILY"] = "100"
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc_ok = main()
    out_ok = buf.getvalue()
    check("resolvable caps → PASS and the query IS reached (positive control)",
          "QUOTA_EXHAUSTION_CANARY_VERDICT=PASS" in out_ok and len(queried) == 1 and rc_ok == 0)
    query_rows = real_query_rows
    APP_CONTAINER = saved_container
    os.environ.pop("QUOTA_CANARY_FREE_LIMIT", None)
    os.environ.pop("QUOTA_CANARY_FREE_DAILY", None)
    os.environ.pop("QUOTA_CANARY_FORCE_FACTS", None)

    # Q4) THE DAILY WALL — selected, classified, and rendered with the DAILY denominator and
    #     the 00:00 UTC horizon. The monthly count is deliberately well under the monthly cap,
    #     so nothing but the daily leg can select this row.
    save_fired_set(set())
    daily_row = [row("free:v2:d0d0d0d0d0d0d0d0", 120, NOW - 3 * DAY_S, 100, TODAY)]
    outcome_seam(daily_row)
    r = cycle(daily_row, NOW, facts(daily_row, 2400))
    check("a DAILY-wall bucket is selected and DETECTED", r["action"] == "silent" and r["pending"] == 1)
    # A DAILY wall alone can now NEVER page, and that is a deliberate consequence rather than a
    # gap: its dedup id carries the UTC day, so by the time the 24h grace elapses the day has
    # rolled, the row is no longer live, and the caller is being served again. A cap that heals
    # itself in hours is a recovery, and recovery is silent by the alert contract. What a daily
    # wall IS good for is the coalescing lead — see Q8.
    r = cycle(daily_row, NOW + GRACE_S + 60, facts(daily_row, 2400))
    check("a DAILY wall alone resolves SILENTLY once its UTC day has rolled",
          r["action"] == "silent")
    check("...and its terminal state is SILENT_STILL_ACTIVE, not PAGED",
          ST_PAGED not in [v["state"] for v in load_state().values()])
    # The DAILY rendering is still gated, at unit level, because the deferred path can no longer
    # reach it and METER-TRUTH-W1 bought these assertions with a real incident: a DAILY
    # exhaustion once rendered as `used 100/100 … free limit 100/mo`.
    daily_entry = dict(_entry("free:v2:d1d1d1d1d1d1d1d1", 100, NOW - 3 * DAY_S, 2400.0,
                              WALL_DAILY, 100, TODAY))
    daily_entry["outcome"] = {"refusals": 0, "cta": 0, "signups": 0, "prior_days": 0}
    daily_body = build_body([daily_entry], 1, CAP_M, CAP_D)
    check("the daily body renders the DAILY denominator, not the monthly one",
          "used 100/100" in daily_body and "used 120/200" not in daily_body)
    check("the daily body names the 00:00 UTC reset horizon",
          "(DAILY wall — clears at 00:00 UTC)" in daily_body)
    check("the daily body still states BOTH resolved limits",
          "free limits 200/mo + 100/day" in daily_body)

    # Q4b) YESTERDAY's daily wall is not today's. The daily leg is pinned to the run's UTC day.
    save_fired_set(set())
    yesterday = [row("free:v2:d0d0d0d0d0d0d0d0", 120, NOW - 3 * DAY_S, 100, utc_day_key(NOW - DAY_S))]
    r = cycle(yesterday, NOW, facts(yesterday, 2400))
    check("a daily wall from a PREVIOUS UTC day is not live today", r["action"] == "silent")

    # Q5) BOTH WALLS AT ONCE → reported ONCE, MONTHLY-FIRST (monthly is the more severe: it
    #     does not clear at midnight).
    save_fired_set(set())
    both = [row("free:v2:b0thb0thb0thb0th", 200, NOW - HOUR, 100, TODAY)]
    r = page(both, NOW, facts(both, 2400))
    check("a bucket on BOTH walls fires exactly once", r["action"] == "fire" and r["new"] == 1)
    check("...and it is reported MONTHLY-first", r.get("walls") == [WALL_MONTHLY])
    both_body = LAST_FIRE_BODY or ""
    check("...rendered against the MONTHLY denominator",
          "used 200/200" in both_body and "(MONTHLY wall" in both_body)
    check("...and NOT also as a daily line", "(DAILY wall" not in both_body)

    # Q6) DAILY DEDUP. Same bucket, same MONTHLY period, a NEW UTC day → re-arms and fires.
    #     Under the pre-W1 `(key, period_start)` identity this second wall was silent for the
    #     rest of the month — and so was the caller's eventual monthly exhaustion.
    save_fired_set(set())
    REARM_KEY = "free:v2:dede1111dede2222"
    d1 = [row(REARM_KEY, 120, NOW - 3 * DAY_S, 100, TODAY)]
    outcome_seam(d1)
    r1 = cycle(d1, NOW, facts(d1, 2400))
    check("daily wall day 1 → DETECTED (pending)", r1["pending"] == 1)
    check("daily wall day 1, same day again → no second pending entry (dedup)",
          cycle(d1, NOW, facts(d1, 2400))["pending"] == 0)
    later = NOW + DAY_S
    d2 = [row(REARM_KEY, 140, NOW - 3 * DAY_S, 100, utc_day_key(later))]
    outcome_seam(d2)
    r2 = cycle(d2, later, facts(d2, 2400))
    check("SAME bucket, SAME monthly period, NEW UTC day → re-arms as a NEW pending entry",
          r2["pending"] == 1)
    check("...and the two daily walls carry DISTINCT dedup ids (the METER-TRUTH-W1 identity)",
          len([i for i in load_state() if "|daily@" in i]) == 2)

    # Q7) THE DENOMINATOR IS THE RESOLVED CAP — asserted against TWO different cap pairs, so a
    #     re-hardcoded number fails at least one of them.
    save_fired_set(set())
    alt = [row("free:v2:a17a17a17a17a17a", 500, NOW - HOUR)]
    page(alt, NOW, facts(alt, 2400), m=500, d=250)
    alt_body = LAST_FIRE_BODY or ""
    check("under caps (500,250) the monthly denominator is 500", "used 500/500" in alt_body)
    check("under caps (500,250) the summary reads 500/mo + 250/day",
          "free limits 500/mo + 250/day" in alt_body)
    check("under caps (500,250) the retired literals appear nowhere",
          "/100 " not in alt_body and "200/mo" not in alt_body)
    alt_d_entry = dict(_entry("free:v2:a17a17a17a17a17b", 250, NOW - 3 * DAY_S, 2400.0,
                              WALL_DAILY, 250, TODAY))
    alt_d_entry["outcome"] = {"refusals": 0, "cta": 0, "signups": 0, "prior_days": 0}
    alt_d_body = build_body([alt_d_entry], 1, 500, 250)
    check("under caps (500,250) the DAILY denominator is 250", "used 250/250" in alt_d_body)

    # I2) THE QUERY ITSELF. Every scenario above feeds rows in through the FORCE_ROWS seam, so
    #     none of them ever touched `build_query` — which is precisely how a %-format error in
    #     the SQL reached the host and made the FIRST live run report INDETERMINATE.
    try:
        q = build_query(200, 100, TODAY)
        built = True
    except Exception as e:  # noqa: BLE001
        q, built = "%s: %s" % (type(e).__name__, e), False
    check("the SQL builds at all (no %-format error on the LIKE wildcards)", built)
    check("the SQL keeps its LIKE wildcards intact", built and "LIKE 'free:%'" in q and "LIKE 'av_free_%'" in q)
    check("the SQL casts the TEXT period_start before EXTRACT", built and "period_start::timestamptz" in q)
    check("the SQL selects BOTH daily columns", built and "daily_count" in q and "daily_day" in q)
    check("the SQL carries the monthly leg at the resolved cap", built and "call_count >= 200" in q)
    check("the SQL carries the daily leg at the resolved cap, pinned to the run's UTC day",
          built and ("daily_count >= 100 AND daily_day = '" + TODAY + "'") in q)
    check("the SQL compares daily_day as TEXT (no timezone-dependent cast)",
          built and "daily_day::" not in q)
    bad_day = None
    try:
        build_query(200, 100, "2026/08/15")
    except ValueError as e:
        bad_day = str(e)
    check("a malformed UTC day literal REFUSES rather than emitting SQL", bad_day is not None)

    # I3) THE TEST SEAM ITSELF — every scenario above calls run_cycle directly, so the parser
    #     that the host-side fire-proof depends on was never exercised. A colon-bearing key
    #     (`free:v2:<hash>`, the canonical keyless form) is the case that broke it.
    #     Wrapped defensively: a parser that RAISES must report FAIL, not abort the suite —
    #     an assertion that crashes is not an assertion.
    try:
        parsed = parse_forced_rows("free:v2:aaaa1111bbbb2222:100:1785000000,av_free_x:250:1785000001")
    except Exception as e:  # noqa: BLE001
        log("seam parse raised: %s: %s" % (type(e).__name__, e))
        parsed = []
    check("seam parses a COLON-BEARING key (rsplit, not split)",
          len(parsed) == 2 and parsed[0] == ("free:v2:aaaa1111bbbb2222", 100, 1785000000, 0, ""))
    check("seam parses a colon-free key too",
          len(parsed) == 2 and parsed[1] == ("av_free_x", 250, 1785000001, 0, ""))
    try:
        parsed5 = parse_forced_rows("free:v2:aaaa1111bbbb2222:120:1785000000:100:2026-08-13")
    except Exception as e:  # noqa: BLE001
        log("widened seam parse raised: %s: %s" % (type(e).__name__, e))
        parsed5 = []
    check("seam parses the WIDENED 5-field daily form",
          len(parsed5) == 1
          and parsed5[0] == ("free:v2:aaaa1111bbbb2222", 120, 1785000000, 100, "2026-08-13"))

    # ── REVENUE-METER-TRUTH-W6 CH6 ────────────────────────────────────────────────────
    #
    # K) INTERNAL EXCLUSION. Two of the three alerts this canary had fired by 2026-08-05 were
    #    on our own bots; 13 of the 19 walled `free:` buckets were `is_bot_internal`.
    save_fired_set(set())
    internal_row = [row("free:v2:beefbeefbeefbeef", 200, NOW - HOUR)]
    r = cycle(internal_row, NOW, facts(internal_row, 5000, internal=True))
    check("internal bucket at the wall → NOT a page", r["action"] == "silent")
    check("internal bucket is COUNTED as internal, not silently dropped", r.get("internal") == 1)
    check("internal bucket is not miscounted as high-volume", r["high"] == 0)
    # The exclusion must be about the FLAG, not about the volume — same bucket, same rate,
    # external, must page. Without this pair, `internal: True` for everything would pass.
    save_fired_set(set())
    r = page(internal_row, NOW, facts(internal_row, 5000, internal=False))
    check("the SAME bucket at the SAME rate, external → pages", r["action"] == "fire")
    # ...and the exclusion covers the DAILY wall too, not only the monthly one.
    save_fired_set(set())
    internal_daily = [row("free:v2:beefbeefbeefbeef", 120, NOW - 3 * DAY_S, 100, TODAY)]
    r = cycle(internal_daily, NOW, facts(internal_daily, 5000, internal=True))
    check("internal bucket at the DAILY wall → NOT a page", r["action"] == "silent" and r["internal"] == 1)

    # L) 🎯 THE HISTORICAL CASE. `free:v2:d552fbc794cd05dc` — the one real external caller
    #    that walled itself before REVENUE-METER-TRUTH-W6, and the event this canary was built
    #    for and MISSED. Period opened 2026-07-30T04:41:53Z; 100th chargeable call
    #    2026-08-01T17:29:02Z; 2,807 request_log calls in the 24h ending at that instant. All
    #    four numbers are measured from prod, not invented. The cap was 100/mo at that time,
    #    which is why this scenario passes its own (m, d) pair rather than the live one —
    #    replaying a historical event against today's ladder would be a different experiment.
    FIXTURE_START = 1_785_386_513   # 2026-07-30T04:41:53Z
    FIXTURE_WALL = 1_785_605_342    # 2026-08-01T17:29:02Z
    fixture = [row("free:v2:d552fbc794cd05dc", 100, FIXTURE_START)]

    # First, pin what the OLD logic did, computed here rather than asserted from memory:
    # 100 calls / 2.53 days = 39.5/day, under the 50/day floor. THAT is why it stayed
    # silent — not a threshold that was too high, but a denominator that grows forever.
    old_rate = 100 / ((FIXTURE_WALL - FIXTURE_START) / DAY_S)
    check("the OLD lifetime rate really was below the floor (39.5 < 50)",
          old_rate < MIN_CALLS_PER_DAY and 39.0 < old_rate < 40.0)

    save_fired_set(set())
    r = page(fixture, FIXTURE_WALL, facts(fixture, 2807), m=100, d=100)
    check("🎯 the historical exhaustion FIRES under the windowed rate", r["action"] == "fire")
    fixture_body = LAST_FIRE_BODY or ""
    check("the fired body names the real bucket", "free:v2:d552fbc794cd05dc" in fixture_body)
    check("the fired body reports the WINDOWED rate, not the lifetime one",
          "~2807 calls/day" in fixture_body and "~39 calls/day" not in fixture_body)

    # M) The window is a WINDOW. A caller who is quiet NOW must not page on old volume —
    #    otherwise the fix would just page forever instead of never.
    save_fired_set(set())
    r = cycle(fixture, FIXTURE_WALL, facts(fixture, 0), m=100, d=100)
    check("exhausted but no traffic in the window → silent (not a live burst)",
          r["action"] == "silent")

    # N) KEYED buckets have no ip_hash, so there is nothing to window on. They must keep
    #    firing on the lifetime estimate rather than being silently muted by a rate that
    #    is structurally 0 for every one of them.
    save_fired_set(set())
    keyed_fresh = [row("av_free_111111111111111111111111", 200, NOW - HOUR)]
    r = page(keyed_fresh, NOW, {})   # deliberately NO facts row
    check("keyed bucket with no facts row still pages (lifetime fallback)", r["action"] == "fire")
    # ...and a keyed bucket at the DAILY wall pages on its own daily count, which IS a
    # calls/day figure. A windowed rate would be 0 here and would mute every one of them.
    save_fired_set(set())
    keyed_daily = [row("av_free_222222222222222222222222", 120, NOW - 3 * DAY_S, 100, TODAY)]
    r = cycle(keyed_daily, NOW, {})
    check("keyed bucket at the DAILY wall is DETECTED on its daily count", r["pending"] == 1)

    # ── OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1 R6 ───────────────────────────────────────
    #
    # W1a) THE THREE SILENT BRANCHES. Each is the SAME wall, the SAME rate, the SAME grace —
    #      only the measured outcome differs. Asserting them as a set is the point: it proves
    #      the branch is chosen by the OUTCOME and by nothing else about the bucket.
    silent_row = [row("free:v2:5111e17511e17511", 200, NOW - HOUR)]
    for label, kwargs, want in (
        ("a signup was attributed → SILENT_CONVERTED", {"signups": 1}, ST_CONVERTED),
        ("they clicked upgrade → SILENT_CTA_CLICKED", {"cta": 1}, ST_CTA),
        ("still refused at volume → SILENT_STILL_ACTIVE", {"refusals": 340}, ST_ACTIVE),
    ):
        save_fired_set(set())
        globals()["LAST_FIRE_BODY"] = None
        r = page(silent_row, NOW, facts(silent_row, 2400), **kwargs)
        check("R6: %s → NO page" % label, r["action"] == "silent")
        check("R6: %s → terminal state is %s" % (label, want),
              want in [v["state"] for v in load_state().values()])
        check("R6: %s → wrote NO alert body" % label, LAST_FIRE_BODY is None)

    # W1b) PRECEDENCE, asserted rather than assumed: money beats engagement beats presence.
    check("R6: signup outranks CTA and refusals",
          resolve_outcome({"signups": 1, "cta": 9, "refusals": 999}) == ST_CONVERTED)
    check("R6: CTA outranks refusals",
          resolve_outcome({"signups": 0, "cta": 1, "refusals": 999}) == ST_CTA)
    check("R6: nothing at all → PAGED (the churn branch)",
          resolve_outcome({"signups": 0, "cta": 0, "refusals": 0}) == ST_PAGED)

    # W1c) AN UNAVAILABLE ARM CAN NEVER SILENCE A PAGE. This is the property that makes a lost
    #      migration-034 grant DETECTABLE rather than silent, so it is asserted per sentinel.
    for sentinel in ARM_UNAVAILABLE:
        check("R6: refusals=%r cannot silence the page" % sentinel,
              resolve_outcome({"signups": 0, "cta": 0, "refusals": sentinel}) == ST_PAGED)
        check("R6: signups=%r cannot silence the page" % sentinel,
              resolve_outcome({"signups": sentinel, "cta": 0, "refusals": 0}) == ST_PAGED)

    # W1d) NO-PRIVILEGE vs QUERY-FAILURE vs ZERO — three facts, three renderings (Q1-ADD-2).
    check("R6: a permission-denied maps to the NO-PRIVILEGE sentinel",
          _arm_unavailable_reason(RuntimeError("psql failed: ERROR:  permission denied for "
                                               "table funnel_events")) == ARM_UNAVAIL_NOPRIV)
    check("R6: any other failure maps to the QUERY-FAILED sentinel",
          _arm_unavailable_reason(RuntimeError("psql failed: could not connect"))
          == ARM_UNAVAIL_ERROR)
    check("R6: the sentinels are distinguishable from each other and from zero",
          ARM_UNAVAIL_NOPRIV != ARM_UNAVAIL_ERROR
          and render_arm(0, "refusals") == "0 refusals"
          and render_arm(ARM_UNAVAIL_NOPRIV, "refusals") == ARM_UNAVAIL_NOPRIV)
    save_fired_set(set())
    unavail_row = [row("free:v2:c0ffeec0ffeec0ff", 200, NOW - HOUR)]
    os.environ["QUOTA_CANARY_FORCE_OUTCOME"] = \
        "free:v2:c0ffeec0ffeec0ff:noprivilege:noprivilege:noprivilege:noprivilege"
    cycle(unavail_row, NOW, facts(unavail_row, 2400))
    r = cycle(unavail_row, NOW + GRACE_S + 60, facts(unavail_row, 2400))
    unavail_body = LAST_FIRE_BODY or ""
    check("R6: an unreadable outcome still PAGES (never a silent zero)", r["action"] == "fire")
    check("R6: the body says the arm is unavailable, in words",
          ARM_UNAVAIL_NOPRIV in unavail_body)
    check("R6: the body does NOT render an unmeasured zero", "0 refusals" not in unavail_body)
    check("R6: the ACTION clause does not claim the caller went quiet when we could not look",
          "went quiet" not in unavail_body and "could NOT be measured" in unavail_body)
    check("R6: a MEASURED churn page does say the caller went quiet",
          "went quiet" in body1 and "could NOT be measured" not in body1)

    # W1e) A REAL raising query — the seam above forces a sentinel, this forces the exception
    #      path itself, because a hermetic suite is blind to exactly what its own seam replaces.
    outcome_seam(None)
    _saved_psql = globals()["_psql"]

    def _boom(*a, **k):
        raise RuntimeError("psql failed: ERROR:  permission denied for table signup_attribution")
    globals()["_psql"] = _boom
    try:
        raised = query_outcome("free:v2:c0ffeec0ffeec0ff", NOW, NOW + 3600)
    finally:
        globals()["_psql"] = _saved_psql
    check("R6: a RAISING outcome query degrades instead of killing the run",
          raised["signups"] == ARM_UNAVAIL_NOPRIV and raised["refusals"] == ARM_UNAVAIL_NOPRIV)
    check("R6: a KEYED bucket's arms are n/a — not unavailable, and not zero",
          query_outcome("av_free_999999999999999999999999", NOW, NOW + 1)["refusals"]
          == ARM_NA_KEYED)

    # W1f) LEGACY STATE LINES. The host file at cutover holds bare ids for buckets the operator
    #      has ALREADY been paged about; re-paging that backlog is the bootstrap bug in a new
    #      coat, so a bare id is `already resolved`, full stop.
    save_fired_set(set())
    legacy_row = [row("free:v2:1e6ac71e6ac71e6a", 200, NOW - HOUR)]
    legacy_id = dedup_id(_entry("free:v2:1e6ac71e6ac71e6a", 200, NOW - HOUR, 0,
                                WALL_MONTHLY, 200, TODAY))
    with open(FIRED_SET_FILE, "w") as fh:
        fh.write(legacy_id + "\n")                       # BARE id, pre-W1 grammar
    check("R6: a legacy bare id parses as already-resolved",
          parse_state_token(legacy_id) == (legacy_id, ST_LEGACY, 0))
    globals()["LAST_FIRE_BODY"] = None
    outcome_seam(legacy_row)
    r = cycle(legacy_row, NOW, facts(legacy_row, 2400))
    check("R6: a legacy entry opens NO pending entry", r["pending"] == 0)
    r = cycle(legacy_row, NOW + GRACE_S + 60, facts(legacy_row, 2400))
    check("R6: a legacy entry NEVER re-pages, even past the grace window",
          r["action"] == "silent" and LAST_FIRE_BODY is None)
    check("R6: an unparseable token is also treated as resolved, never as new",
          parse_state_token("garbage#NOT_A_STATE#x")[1] == ST_LEGACY
          and parse_state_token("a#b#c#d")[1] == ST_LEGACY)

    # W1g) THE KEYED/KEYLESS TRUTH FIX (R3). The retired sentence asserted "no account and no
    #      email" UNCONDITIONALLY, including for `key:sha16:…` buckets — whose whole definition
    #      is a caller who registered. It shipped to the operator that way on 2026-08-16.
    save_fired_set(set())
    keyed_body_rows = [row("av_free_333333333333333333333333", 200, NOW - HOUR)]
    page(keyed_body_rows, NOW, {})
    keyed_body = LAST_FIRE_BODY or ""
    check("R3: a KEYED bucket's body does NOT claim the caller has no account",
          "no account and no email" not in keyed_body)
    check("R3: a KEYED bucket's body says a contact path EXISTS",
          "REGISTERED caller" in keyed_body and "direct contact path EXIST" in keyed_body)
    check("R3: a KEYLESS bucket's body DOES say there is no account",
          "no account and no email" in body1)
    check("R3: a KEYLESS bucket's body does NOT claim a registered caller",
          "REGISTERED caller" not in body1)

    # W1h) COALESCING (Q4). The monthly wall lands while the daily one is still PENDING → ONE
    #      page, monthly-first, both dedup ids claimed so the monthly cannot page separately.
    save_fired_set(set())
    COAL_KEY = "free:v2:c0a1e5cec0a1e5ce"
    coal_daily = [row(COAL_KEY, 150, NOW - 3 * DAY_S, 100, TODAY)]
    outcome_seam(coal_daily)
    cycle(coal_daily, NOW, facts(coal_daily, 2400))
    st0 = load_state()
    check("R6/Q4: the daily wall is PENDING before the monthly arrives",
          len(st0) == 1 and list(st0.values())[0]["state"] == ST_PENDING)
    LAG = int(15.5 * HOUR)                              # the measured median lead
    coal_monthly = [row(COAL_KEY, 200, NOW - 3 * DAY_S, 100, utc_day_key(NOW + LAG))]
    outcome_seam(coal_monthly)
    r = cycle(coal_monthly, NOW + LAG, facts(coal_monthly, 2400))
    st = load_state()
    check("R6/Q4: the monthly wall COALESCES into the pending daily entry (no page yet)",
          r["action"] == "silent")
    check("R6/Q4: BOTH dedup ids are claimed, so the monthly cannot page separately",
          len(st) == 2 and sum(1 for v in st.values() if v["state"] == ST_PENDING) == 1)
    check("R6/Q4: the coalesced entry keeps the ORIGINAL detection instant (page is not delayed)",
          [v["since"] for v in st.values() if v["state"] == ST_PENDING] == [NOW])
    globals()["LAST_FIRE_BODY"] = None
    r = cycle(coal_monthly, NOW + GRACE_S + 60, facts(coal_monthly, 2400))
    coal_body = LAST_FIRE_BODY or ""
    check("R6/Q4: the coalesced pair produces exactly ONE page",
          r["action"] == "fire" and r["new"] == 1)
    check("R6/Q4-RULE-1: it states the MONTHLY reset horizon, not the daily one",
          "(MONTHLY wall — clears at the caller's rolling reset)" in coal_body
          and "clears at 00:00 UTC" not in coal_body)
    check("R6/Q4-RULE-1: it NAMES the daily wall it absorbed",
          "also hit the DAILY wall" in coal_body and "coalesced into this one page" in coal_body)
    check("R6/Q4: a NON-coalesced page carries no absorbed-wall clause (the derivation is not "
          "just 'any sibling')", "also hit the" not in body1)

    # W1i) THE GRACE CONSTANT. Q4-RULE-2 refused a widening to 28h; pin the default so a future
    #      edit has to argue with this line rather than slip past it.
    check("R6/Q4-RULE-2: the grace default is 24h (not widened for the 27.2h outlier)",
          OUTCOME_GRACE_H == 24)

    # J) VACUITY GUARD — refuse to report a pass over an empty corpus. Without this, a future
    #    change that made every scenario a no-op would still print PASS.
    check("self-test corpus is non-empty (vacuity guard)",
          len(body1) > 0 and len(body2) > 0 and len(fixture_body) > 0
          and len(daily_body) > 0 and len(both_body) > 0 and len(alt_body) > 0
          and len(keyed_body) > 0 and len(coal_body) > 0 and len(unavail_body) > 0)

    ok = not failures
    print("SELF-TEST: %s (%d failed)" % ("PASS" if ok else "FAIL", len(failures)))
    print("QUOTA_EXHAUSTION_CANARY_VERDICT=%s" % ("PASS" if ok else "FAIL"))
    try:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    except Exception:
        pass
    return 0 if ok else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="high-volume free-tier quota-exhaustion canary")
    parser.add_argument("--self-test", action="store_true", help="run the hermetic scenario suite and exit")
    a = parser.parse_args()
    if a.self_test:
        sys.exit(self_test())
    sys.exit(main())
