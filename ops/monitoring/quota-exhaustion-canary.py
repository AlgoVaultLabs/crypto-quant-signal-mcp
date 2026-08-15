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


def load_fired_set():
    try:
        with open(FIRED_SET_FILE) as fh:
            return set(x for x in fh.read().split() if x.strip())
    except OSError:
        return set()


def state_exists():
    """True once this canary has completed at least one cycle on this host.

    The distinction matters: an EMPTY state file means "nothing is currently exhausted",
    while a MISSING one means "this canary has never run here" — and those must behave
    differently on the very first cycle (see the bootstrap branch in run_cycle).
    """
    return os.path.exists(FIRED_SET_FILE)


def save_fired_set(ids):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(FIRED_SET_FILE, "w") as fh:
            fh.write("\n".join(sorted(ids)))
    except OSError as e:
        log("WARN: could not persist fired set: %s" % e)


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
        "%s used %d/%d (%s) at ~%.0f calls/day"
        % (render_bucket(e["key"]), e["used"], e["cap"], WALL_HORIZON[e["wall"]], e["rate"])
        for e in new_entries
    )
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
        "This is a CONVERSION moment, not a fault. The caller has no account and no email —",
        "the exhaustion notice is the only contact. Check funnel_events quota_hit_block + request_log.",
        "Action: dispatch OPS-QUOTA-EXHAUSTION-CONVERSION-W{NEXT} via Cowork → Claude Code",
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
    """One evaluation. Auto-resolve, dedup, fire. Returns an action dict."""
    high, low, stale, internal = classify(rows, now_s, facts or {}, monthly_cap, daily_cap)
    fired = load_fired_set()
    live_ids = set(dedup_id(e) for e in high)

    # 1) Auto-resolve (SILENT): periods that rolled over, UTC days that rolled over, or
    #    callers who upgraded.
    resolved = fired - live_ids
    if resolved:
        log("RESOLVED: %d bucket-period-wall(s) no longer exhausted (auto-resolve, silent)" % len(resolved))
        fired = fired & live_ids
        save_fired_set(fired)

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

    new_entries = [e for e in high if dedup_id(e) not in fired]
    if not new_entries:
        log("HEALTHY: high=%d low=%d stale=%d internal=%d, no NEW high-volume exhaustion (rows=%d)"
            % (len(high), len(low), len(stale), len(internal), len(rows)))
        return {"action": "silent", "high": len(high), "low": len(low), "internal": len(internal)}

    fire(build_body(new_entries, len(high), monthly_cap, daily_cap))
    save_fired_set(fired | set(dedup_id(e) for e in new_entries))
    return {"action": "fire", "new": len(new_entries), "high": len(high), "low": len(low),
            "internal": len(internal), "walls": sorted(set(e["wall"] for e in new_entries))}


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

    # C) HIGH-volume MONTHLY exhaustion pages once (200 calls in ~1 hour ≈ 2400/day)
    high_row = [row("free:v2:cccc3333dddd4444", 200, NOW - HOUR)]
    r = cycle(high_row, NOW, facts(high_row, 2400))
    check("high-volume monthly exhaustion → fire", r["action"] == "fire" and r["new"] == 1)
    check("it is named as a MONTHLY wall", r.get("walls") == [WALL_MONTHLY])

    # C2) THE CORRECTED CAP. A bucket at the OLD mirrored literal (100) is only HALF WAY to the
    #     real monthly wall and must NOT be selected. This is the wave's defect, asserted.
    save_fired_set(set())
    half_way = [row("free:v2:5555eeee6666ffff", 100, NOW - HOUR)]
    r = cycle(half_way, NOW, facts(half_way, 2400))
    check("a bucket at 100/200 is NOT exhausted (the retired mirror fired here)",
          r["action"] == "silent" and r["high"] == 0)

    # D) same bucket, same period → NO re-fire (dedup)
    save_fired_set(set())
    cycle(high_row, NOW, facts(high_row, 2400))
    check("same bucket+period persists → silent (dedup)",
          cycle(high_row, NOW, facts(high_row, 2400))["action"] == "silent")

    # E) SAME bucket, NEW period → re-arms and fires again
    new_period = [row("free:v2:cccc3333dddd4444", 200, NOW + 31 * DAY_S)]
    r = cycle(new_period, NOW + 31 * DAY_S + HOUR, facts(new_period, 2400))
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
    r = cycle(keyed, NOW)
    body = LAST_FIRE_BODY or ""
    check("keyed bucket fires", r["action"] == "fire")
    check("rendered body does NOT contain the raw API key", "av_free_000000000000000000000000" not in body)
    check("rendered body redacts by structure (key:sha16:)", "key:sha16:" in body)
    check("keyless ids pass through verbatim", render_bucket("free:v2:abcd") == "free:v2:abcd")

    # I) RENDERED-BODY assertions. A-H assert run_cycle's ACTION verdict only, which is exactly
    #    how an operator-misreadable body passed every gate on 2026-08-01.
    save_fired_set(set())
    body_row = [row("free:v2:1111aaaa2222bbbb", 200, NOW - HOUR)]
    cycle(body_row, NOW, facts(body_row, 2400))
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
          "OPS-QUOTA-EXHAUSTION-CONVERSION-W{NEXT}" in body1)

    save_fired_set(set())
    body_rows = [row("free:v2:1111aaaa2222bbbb", 200, NOW - HOUR),
                 row("free:v2:3333cccc4444dddd", 200, NOW - HOUR)]
    cycle(body_rows, NOW, facts(body_rows, 2400))
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
    r = cycle(daily_row, NOW, facts(daily_row, 2400))
    check("a DAILY-wall bucket is selected and fires", r["action"] == "fire")
    check("it is named as a DAILY wall", r.get("walls") == [WALL_DAILY])
    daily_body = LAST_FIRE_BODY or ""
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
    r = cycle(both, NOW, facts(both, 2400))
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
    check("daily wall day 1 → fires", cycle(d1, NOW, facts(d1, 2400))["action"] == "fire")
    check("daily wall day 1, same day again → silent (dedup)",
          cycle(d1, NOW, facts(d1, 2400))["action"] == "silent")
    later = NOW + DAY_S
    d2 = [row(REARM_KEY, 140, NOW - 3 * DAY_S, 100, utc_day_key(later))]
    check("SAME bucket, SAME monthly period, NEW UTC day → re-arms and fires",
          cycle(d2, later, facts(d2, 2400))["action"] == "fire")

    # Q7) THE DENOMINATOR IS THE RESOLVED CAP — asserted against TWO different cap pairs, so a
    #     re-hardcoded number fails at least one of them.
    save_fired_set(set())
    alt = [row("free:v2:a17a17a17a17a17a", 500, NOW - HOUR)]
    cycle(alt, NOW, facts(alt, 2400), m=500, d=250)
    alt_body = LAST_FIRE_BODY or ""
    check("under caps (500,250) the monthly denominator is 500", "used 500/500" in alt_body)
    check("under caps (500,250) the summary reads 500/mo + 250/day",
          "free limits 500/mo + 250/day" in alt_body)
    check("under caps (500,250) the retired literals appear nowhere",
          "/100 " not in alt_body and "200/mo" not in alt_body)
    save_fired_set(set())
    alt_d = [row("free:v2:a17a17a17a17a17b", 300, NOW - 3 * DAY_S, 250, TODAY)]
    cycle(alt_d, NOW, facts(alt_d, 2400), m=500, d=250)
    alt_d_body = LAST_FIRE_BODY or ""
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
    r = cycle(internal_row, NOW, facts(internal_row, 5000, internal=False))
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
    r = cycle(fixture, FIXTURE_WALL, facts(fixture, 2807), m=100, d=100)
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
    r = cycle(keyed_fresh, NOW, {})   # deliberately NO facts row
    check("keyed bucket with no facts row still pages (lifetime fallback)", r["action"] == "fire")
    # ...and a keyed bucket at the DAILY wall pages on its own daily count, which IS a
    # calls/day figure. A windowed rate would be 0 here and would mute every one of them.
    save_fired_set(set())
    keyed_daily = [row("av_free_222222222222222222222222", 120, NOW - 3 * DAY_S, 100, TODAY)]
    r = cycle(keyed_daily, NOW, {})
    check("keyed bucket at the DAILY wall pages on its daily count", r["action"] == "fire")

    # J) VACUITY GUARD — refuse to report a pass over an empty corpus. Without this, a future
    #    change that made every scenario a no-op would still print PASS.
    check("self-test corpus is non-empty (vacuity guard)",
          len(body1) > 0 and len(body2) > 0 and len(fixture_body) > 0
          and len(daily_body) > 0 and len(both_body) > 0 and len(alt_body) > 0)

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
