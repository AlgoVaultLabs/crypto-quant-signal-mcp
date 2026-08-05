#!/usr/bin/env python3
"""OPS-QUOTA-EXHAUSTION-NOTICE-W1 R4 — high-volume free-tier exhaustion canary.

Host-side (Hetzner /opt/algovault-monitoring/) detector for the ONE moment in the funnel we
cannot otherwise observe: a heavy, integrated free caller hitting the 100/mo wall.

Why it is worth an operator alert at all. The largest external consumer is a bare Node agent
(~2,700 calls/day) with NO account and NO email — only an `ip_hash`. There is no way to contact
them, so the response body is the entire customer relationship at that instant and the operator
never learns whether they churned or converted. This canary is the only signal that the moment
happened. It is deliberately NOT a health check: nothing is broken when it fires.

THRESHOLDED, not chatty. Ordinary low-volume exhaustion — a hobbyist who took three weeks to
spend 100 calls — is SILENT. Only a bucket whose measured burn rate clears
`QUOTA_CANARY_MIN_CALLS_PER_DAY` (default 50/day, i.e. reached the cap in <=2 days) pages.

DEDUP is keyed on (tracker_key, period_start), NOT tracker_key alone. Exhaustion is monotonic
inside a metering period, so a bucket that stays exhausted must not re-fire every hour; but the
rolling 30-day window eventually rolls over, and the SAME caller exhausting a NEW period is a
genuinely new event that must page again. Keying on the period start is what gets both. When a
bucket leaves the exhausted set (period rolled, caller upgraded) it auto-resolves SILENTLY —
recovery alerts are noise.

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
THIRTEEN of the 19 `free:` buckets that have ever reached >=100 are our own, and two of the
three alerts this canary has ever fired were on that traffic.

Test seams (env): QUOTA_CANARY_FORCE_ROWS = `key:count:period_start_epoch,...` overrides the DB.
QUOTA_CANARY_FORCE_FACTS = `key:internal(0|1):window_calls,...` overrides the request_log join.
QUOTA_CANARY_AS_OF = epoch seconds, replays the evaluation at a past instant (read-only) so a
historical exhaustion can be proven to fire. QUOTA_CANARY_RATE_WINDOW_HOURS = rate window
(default 24). `--self-test` runs the hermetic scenario suite (no DB, no wrapper, temp state).
"""
import argparse
import hashlib
import os
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

DAY_S = 86400
# The rolling free window (license.ts MONTH_MS). A row older than this is a stale period.
WINDOW_S = 30 * DAY_S


def _int_env(name, default):
    try:
        v = int(os.environ[name])
        return v if v >= 0 else default
    except (KeyError, ValueError):
        return default


# Config (env-overridable for smokes; defaults are the prod policy).
# FREE_MONTHLY_CALLS — operator-FROZEN at 100 (src/lib/plans.ts). Mirrored, not owned:
# if it ever moves, the SoT is that file and this default follows it.
FREE_LIMIT = _int_env("QUOTA_CANARY_FREE_LIMIT", 100)
# Burn rate above which an exhaustion is worth waking the operator for. 50/day means the
# caller spent the whole free allowance in <=2 days — an integrated, daily-active consumer,
# not a hobbyist. The live heavy caller runs ~2,700/day, so it clears this by ~54x.
MIN_CALLS_PER_DAY = _int_env("QUOTA_CANARY_MIN_CALLS_PER_DAY", 50)

# REVENUE-METER-TRUTH-W6 CH6 — the burn rate is measured over a WINDOW, not over the
# lifetime of the period.
#
# The old rate was `call_count / (now - period_start)`, whose denominator GROWS FOREVER.
# A caller who spent their whole free allowance in a 3-day burst reads as 16/day a week
# later, and as 3/day at the end of the month, so `MIN_CALLS_PER_DAY` was never crossed
# and every hourly pass logged `verdict=SILENT_BY_DESIGN`. Three alerts have ever fired,
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
# meter ticking". `quota_usage.call_count` remains the authority for the CAP itself.
CHARGEABLE_VERDICT_EXCLUDED = "HOLD"


def log(msg):
    line = "%s quota-exhaustion-canary: %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


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


def build_query(free_limit):
    """The exhausted-free-bucket query.

    Built by CONCATENATION, never %-formatting: the WHERE clause contains SQL LIKE wildcards
    (`'free:%'`), and a `%`-format string chokes on them with
    `ValueError: unsupported format character`. That is not hypothetical — it is exactly what
    the first live run on the host reported, caught only because the fail-open branch prints
    INDETERMINATE rather than letting `exit 0` pass for healthy.

    `period_start` is a TEXT column (persistTracker writes an ISO-8601 string), NOT a
    timestamp, so it must be cast before EXTRACT or psql errors and this canary fail-opens on
    every single run. Probed live 2026-08-02 before install.
    """
    return (
        "SELECT tracker_key, call_count, EXTRACT(EPOCH FROM period_start::timestamptz)::bigint "
        "FROM quota_usage "
        "WHERE (tracker_key LIKE 'free:%' OR tracker_key LIKE 'av_free_%') "
        "AND call_count >= " + str(int(free_limit))
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
    """Parse the `key:count:epoch,...` test seam.

    Splits from the RIGHT. Tracker keys contain colons of their own — `free:v2:<hash>` is the
    canonical keyless form — so a left-to-right `split(":")[0:3]` reads the key as `free`, the
    count as `v2`, and dies on `int('v2')`. That is not hypothetical: it made the very first
    fire-proof run on the host report INDETERMINATE, and the scenario suite could not see it
    because every case calls `run_cycle` directly and never touches this seam.
    """
    rows = []
    for chunk in spec.split(","):
        if not chunk.strip():
            continue
        key, count, start = chunk.rsplit(":", 2)
        rows.append((key, int(count), int(start)))
    return rows


def query_rows():
    """[(tracker_key, call_count, period_start_epoch)] for CURRENT free-tier periods.

    Only free buckets are considered: a keyless one is `free:...`, a keyed one is an
    `av_free_...` key. Every paid key carries a different prefix, so this is the tier filter
    (`quota_usage` itself stores no tier). `-F '|'` keeps parsing trivial; the SQL literals are
    naturally single-quoted because psql -c is invoked directly, not through `node -e`.
    """
    forced = os.environ.get("QUOTA_CANARY_FORCE_ROWS")
    if forced is not None:
        return parse_forced_rows(forced)
    sql = build_query(FREE_LIMIT)
    rows = []
    for line in _psql(sql).splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) != 3:
            raise RuntimeError("unexpected quota_usage row: %r" % line)
        rows.append((parts[0], int(parts[1]), int(parts[2])))
    return rows


def classify(rows, now_s, facts):
    """Split the exhausted rows into internal (skip), high-volume (page), low-volume, stale.

    REVENUE-METER-TRUTH-W6 CH6 — two changes, both measured against live data:

    1. INTERNAL BUCKETS ARE EXCLUDED. This canary exists to catch a CUSTOMER at the wall;
       our own bots hitting it is not a conversion moment. Measured 2026-08-05: of the 19
       `free:` buckets that have ever reached >=100, THIRTEEN are `is_bot_internal`. Two of
       the three alerts this canary has ever fired were on that traffic, and an alert that
       is usually about us is one the operator mutes within a week.

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
    for key, count, start in rows:
        f = facts.get(key) or {}
        if f.get("internal"):
            internal.append((key, count, start, 0.0))
            continue
        age_s = now_s - start
        if age_s > WINDOW_S:
            stale.append((key, count, start, 0.0))  # period already rolled; not a live wall
            continue
        if bucket_ip_hash(key) is None:
            # KEYED bucket (`av_free_…`). `request_log` records an ip_hash, never an API
            # key, so there is nothing to window on and the lifetime estimate is the only
            # signal available. Keeping it is strictly better than the alternative: a
            # windowed rate would be 0 for EVERY keyed bucket, which would silently mute
            # the most valuable case this canary has — a caller who actually registered,
            # and then hit the wall.
            rate = count / max(1.0, (now_s - start) / DAY_S)
        else:
            rate = float(f.get("window_calls") or 0) / window_days
        entry = (key, count, start, rate)
        (high if rate >= MIN_CALLS_PER_DAY else low).append(entry)
    return high, low, stale, internal


def build_body(new_entries, total_high):
    """The operator-facing body.

    Per the alert-body law (OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 D3): an entity ID carries its
    entity NOUN, and a bare parenthesised number never sits next to a count — a real operator
    read `(new: 6)` as "six subscriptions" on 2026-08-01 when there were two. Here the ids are
    opaque strings rather than integers, but the same rule applies: they are introduced as
    "bucket <id>" / "buckets <id>, <id>", pluralised from the ID COUNT.
    """
    ids = [render_bucket(k) for k, _c, _s, _r in new_entries]
    noun = "bucket" if len(ids) == 1 else "buckets"
    detail = " | ".join(
        "%s used %d/%d at ~%.0f calls/day" % (render_bucket(k), c, FREE_LIMIT, r)
        for k, c, _s, r in new_entries
    )
    return "\n".join([
        "\U0001F4B0 %s" % ALERT_ID,
        # IDs and COUNTS live on SEPARATE lines. Mixing them is what produced the 2026-08-01
        # misread; keeping every count away from the ID list removes the ambiguity structurally
        # rather than relying on punctuation to disambiguate it.
        "Newly exhausted: %s %s" % (noun, ", ".join(ids)),
        detail,
        "Newly exhausted count: %d | high-volume exhausted now: %d | threshold >= %d calls/day | free limit %d/mo"
        % (len(ids), total_high, MIN_CALLS_PER_DAY, FREE_LIMIT),
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


def run_cycle(rows, now_s, facts=None):
    """One evaluation. Auto-resolve, dedup, fire. Returns an action dict."""
    high, low, stale, internal = classify(rows, now_s, facts or {})
    fired = load_fired_set()
    # Dedup identity = (bucket, period). A new period for the SAME caller re-arms the alert.
    live_ids = set("%s@%d" % (k, s) for k, _c, s, _r in high)

    # 1) Auto-resolve (SILENT): periods that rolled over or callers who upgraded.
    resolved = fired - live_ids
    if resolved:
        log("RESOLVED: %d bucket-period(s) no longer exhausted (auto-resolve, silent)" % len(resolved))
        fired = fired & live_ids
        save_fired_set(fired)

    # POSITIVE per-check output — never absence-of-alert. A row silently dropped by a parse
    # error must not look identical to a row that was evaluated and passed.
    for key, count, _s, rate in high:
        log("EVAL high-volume: bucket %s used %d/%d rate ~%.0f/day (>= %d) verdict=PAGE_CANDIDATE"
            % (render_bucket(key), count, FREE_LIMIT, rate, MIN_CALLS_PER_DAY))
    for key, count, _s, rate in low:
        log("EVAL low-volume: bucket %s used %d/%d rate ~%.1f/day (< %d) verdict=SILENT_BY_DESIGN"
            % (render_bucket(key), count, FREE_LIMIT, rate, MIN_CALLS_PER_DAY))
    for key, count, _s, _r in stale:
        log("EVAL stale-period: bucket %s used %d/%d verdict=SKIPPED_PERIOD_ROLLED"
            % (render_bucket(key), count, FREE_LIMIT))
    # Internal buckets get a POSITIVE line of their own rather than vanishing. A bucket
    # dropped silently by the exclusion is indistinguishable from one that was never
    # queried, which is the failure this canary's own per-bucket output rule exists to stop.
    for key, count, _s, _r in internal:
        log("EVAL internal: bucket %s used %d/%d verdict=SKIPPED_INTERNAL (is_bot_internal — "
            "our own traffic, not a customer at the wall)" % (render_bucket(key), count, FREE_LIMIT))

    # BOOTSTRAP — report, do not page. On the FIRST cycle on a host every currently-exhausted
    # bucket looks "new", so a naive first run pages the entire accumulated backlog as though it
    # had just happened. Live measurement before install: 19 exhausted buckets, 5 of them above
    # the volume threshold — an opening alert naming five historical exhaustions, none of which
    # was a fresh conversion moment. Seed the state instead and page only on what happens NEXT.
    # (Same shape as the "bootstrap report-not-page for never-attempted keys" rule.)
    if not state_exists():
        seeded = set("%s@%d" % (k, st) for k, _c, st, _r in high)
        save_fired_set(seeded)
        log("BOOTSTRAP: first cycle on this host — seeded %d high-volume bucket-period(s) WITHOUT "
            "paging (historical backlog, not new events). high=%d low=%d stale=%d"
            % (len(seeded), len(high), len(low), len(stale)))
        return {"action": "bootstrap", "seeded": len(seeded), "high": len(high), "low": len(low),
                "internal": len(internal)}

    new_entries = [e for e in high if "%s@%d" % (e[0], e[2]) not in fired]
    if not new_entries:
        log("HEALTHY: high=%d low=%d stale=%d internal=%d, no NEW high-volume exhaustion (rows=%d)"
            % (len(high), len(low), len(stale), len(internal), len(rows)))
        return {"action": "silent", "high": len(high), "low": len(low), "internal": len(internal)}

    fire(build_body(new_entries, len(high)))
    save_fired_set(fired | set("%s@%d" % (e[0], e[2]) for e in new_entries))
    return {"action": "fire", "new": len(new_entries), "high": len(high), "low": len(low),
            "internal": len(internal)}


def main():
    try:
        rows = query_rows()
        # `QUOTA_CANARY_AS_OF` (epoch seconds) replays the evaluation at a past instant so a
        # historical exhaustion can be proven to FIRE. Read-only: it changes which rows are
        # stale and nothing else.
        now_s = int(os.environ.get("QUOTA_CANARY_AS_OF") or time.time())
        as_of = os.environ.get("QUOTA_CANARY_AS_OF")
        facts = query_bucket_facts([k for k, _c, _s in rows], int(as_of) if as_of else None)
        run_cycle(rows, now_s, facts)
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
    global STATE_DIR, FIRED_SET_FILE, LOG
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

    def facts(rows, window_calls, internal=False):
        """Facts for every keyless bucket in `rows`.

        REVENUE-METER-TRUTH-W6 CH6 made the burn rate a function of request_log traffic in
        a window, so every scenario below must now SAY what that traffic was. Passing it
        explicitly is the point: before this, the rate was derivable from the row alone and
        the scenarios could not distinguish a lifetime average from a windowed one.
        """
        return {k: {"internal": internal, "window_calls": window_calls} for k, _c, _s in rows}

    # A0) BOOTSTRAP — the first cycle seeds and does NOT page, even with high-volume backlog.
    backlog = [("free:v2:9999aaaa8888bbbb", 900, NOW - 2 * DAY_S),
               ("free:v2:7777cccc6666dddd", 400, NOW - 2 * DAY_S)]
    r = run_cycle(backlog, NOW, facts(backlog, 2400))
    check("first cycle with a backlog → bootstrap, NOT a page",
          r["action"] == "bootstrap" and r["seeded"] == 2)
    check("bootstrap seeded the state (so the backlog never pages later)", len(load_fired_set()) == 2)
    check("bootstrap wrote NO alert body", LAST_FIRE_BODY is None)
    check("the same backlog on the NEXT cycle stays silent",
          run_cycle(backlog, NOW, facts(backlog, 2400))["action"] == "silent")

    # A) nothing exhausted → silent
    check("no exhausted buckets → silent", run_cycle([], NOW)["action"] == "silent")

    # B) LOW-volume exhaustion is silent BY DESIGN (took 25 days to spend 100)
    low_row = [("free:v2:aaaa1111bbbb2222", 100, NOW - 25 * DAY_S)]
    r = run_cycle(low_row, NOW, facts(low_row, 12))
    check("low-volume exhaustion → silent by design", r["action"] == "silent" and r["low"] == 1)

    # C) HIGH-volume exhaustion pages once (100 calls in ~1 hour ≈ 2400/day)
    high_row = [("free:v2:cccc3333dddd4444", 100, NOW - HOUR)]
    r = run_cycle(high_row, NOW, facts(high_row, 2400))
    check("high-volume exhaustion → fire", r["action"] == "fire" and r["new"] == 1)

    # D) same bucket, same period → NO re-fire (dedup)
    check("same bucket+period persists → silent (dedup)",
          run_cycle(high_row, NOW, facts(high_row, 2400))["action"] == "silent")

    # E) SAME bucket, NEW period → re-arms and fires again
    new_period = [("free:v2:cccc3333dddd4444", 100, NOW + 31 * DAY_S)]
    r = run_cycle(new_period, NOW + 31 * DAY_S + HOUR, facts(new_period, 2400))
    check("same bucket, NEW period → fires again (re-armed)", r["action"] == "fire")

    # F) bucket leaves the exhausted set → auto-resolve, silent, state emptied
    check("bucket clears → silent (auto-resolve)", run_cycle([], NOW + 32 * DAY_S)["action"] == "silent")
    check("fired set emptied after resolve", load_fired_set() == set())

    # G) a stale period (older than the rolling window) is skipped, never paged
    stale_row = [("free:v2:eeee5555ffff6666", 5000, NOW - 60 * DAY_S)]
    check("stale period → silent (skipped)",
          run_cycle(stale_row, NOW, facts(stale_row, 2400))["action"] == "silent")

    # H) SECRET HYGIENE — a keyed bucket's API key never appears anywhere
    save_fired_set(set())
    keyed = [("av_free_000000000000000000000000", 100, NOW - HOUR)]
    r = run_cycle(keyed, NOW)
    body = LAST_FIRE_BODY or ""
    check("keyed bucket fires", r["action"] == "fire")
    check("rendered body does NOT contain the raw API key", "av_free_000000000000000000000000" not in body)
    check("rendered body redacts by structure (key:sha16:)", "key:sha16:" in body)
    check("keyless ids pass through verbatim", render_bucket("free:v2:abcd") == "free:v2:abcd")

    # I) RENDERED-BODY assertions. A-H assert run_cycle's ACTION verdict only, which is exactly
    #    how an operator-misreadable body passed every gate on 2026-08-01.
    save_fired_set(set())
    body_row = [("free:v2:1111aaaa2222bbbb", 100, NOW - HOUR)]
    run_cycle(body_row, NOW, facts(body_row, 2400))
    body1 = LAST_FIRE_BODY or ""
    check("singular labels the ID ('Newly exhausted: bucket <id>')",
          "Newly exhausted: bucket free:v2:1111aaaa2222bbbb" in body1)
    check("singular count is on its own labelled line", "Newly exhausted count: 1" in body1)
    check("body states usage as N/limit", "used 100/100" in body1)
    check("body states the burn rate", "calls/day" in body1)
    check("body carries a templated recommended_wave (no literal Wn)",
          "OPS-QUOTA-EXHAUSTION-CONVERSION-W{NEXT}" in body1)

    save_fired_set(set())
    body_rows = [("free:v2:1111aaaa2222bbbb", 100, NOW - HOUR),
                 ("free:v2:3333cccc4444dddd", 100, NOW - HOUR)]
    run_cycle(body_rows, NOW, facts(body_rows, 2400))
    body2 = LAST_FIRE_BODY or ""
    check("plural renders 'buckets <id>, <id>'",
          "Newly exhausted: buckets free:v2:1111aaaa2222bbbb, free:v2:3333cccc4444dddd" in body2)
    check("plural does NOT render the singular noun before the list",
          "Newly exhausted: bucket free:v2:1111aaaa2222bbbb," not in body2)
    check("the ID line carries NO count (counts live on their own line)",
          _id_line_has_no_count(body2, ["free:v2:1111aaaa2222bbbb", "free:v2:3333cccc4444dddd"]))
    check("counts are rendered on a separate, labelled line",
          "Newly exhausted count: 2" in body2)

    # I2) THE QUERY ITSELF. Every scenario above feeds rows in through the FORCE_ROWS seam, so
    #     none of them ever touched `build_query` — which is precisely how a %-format error in
    #     the SQL reached the host and made the FIRST live run report INDETERMINATE.
    try:
        q = build_query(FREE_LIMIT)
        built = True
    except Exception as e:  # noqa: BLE001
        q, built = "%s: %s" % (type(e).__name__, e), False
    check("the SQL builds at all (no %-format error on the LIKE wildcards)", built)
    check("the SQL keeps its LIKE wildcards intact", built and "LIKE 'free:%'" in q and "LIKE 'av_free_%'" in q)
    check("the SQL casts the TEXT period_start before EXTRACT", built and "period_start::timestamptz" in q)
    check("the SQL carries the free limit", built and q.rstrip().endswith(str(FREE_LIMIT)))

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
          len(parsed) == 2 and parsed[0] == ("free:v2:aaaa1111bbbb2222", 100, 1785000000))
    check("seam parses a colon-free key too",
          len(parsed) == 2 and parsed[1] == ("av_free_x", 250, 1785000001))

    # ── REVENUE-METER-TRUTH-W6 CH6 ────────────────────────────────────────────────────
    #
    # K) INTERNAL EXCLUSION. Two of the three alerts this canary has ever fired were on our
    #    own bots. Measured 2026-08-05: 13 of the 19 `free:` buckets that have ever reached
    #    >=100 are `is_bot_internal`.
    save_fired_set(set())
    internal_row = [("free:v2:beefbeefbeefbeef", 100, NOW - HOUR)]
    r = run_cycle(internal_row, NOW, facts(internal_row, 5000, internal=True))
    check("internal bucket at the wall → NOT a page", r["action"] == "silent")
    check("internal bucket is COUNTED as internal, not silently dropped", r.get("internal") == 1)
    check("internal bucket is not miscounted as high-volume", r["high"] == 0)
    # The exclusion must be about the FLAG, not about the volume — same bucket, same rate,
    # external, must page. Without this pair, `internal: True` for everything would pass.
    save_fired_set(set())
    r = run_cycle(internal_row, NOW, facts(internal_row, 5000, internal=False))
    check("the SAME bucket at the SAME rate, external → pages", r["action"] == "fire")

    # L) 🎯 THE HISTORICAL CASE. `free:v2:d552fbc794cd05dc` — the one real external caller
    #    that ever walled itself, and the event this canary was built for and MISSED.
    #    Period opened 2026-07-30T04:41:53Z; 100th chargeable call 2026-08-01T17:29:02Z;
    #    2,807 request_log calls in the 24h ending at that instant. All four numbers are
    #    measured from prod, not invented.
    FIXTURE_START = 1_785_386_513   # 2026-07-30T04:41:53Z
    FIXTURE_WALL = 1_785_605_342    # 2026-08-01T17:29:02Z
    fixture = [("free:v2:d552fbc794cd05dc", 100, FIXTURE_START)]

    # First, pin what the OLD logic did, computed here rather than asserted from memory:
    # 100 calls / 2.53 days = 39.5/day, under the 50/day floor. THAT is why it stayed
    # silent — not a threshold that was too high, but a denominator that grows forever.
    old_rate = 100 / ((FIXTURE_WALL - FIXTURE_START) / DAY_S)
    check("the OLD lifetime rate really was below the floor (39.5 < 50)",
          old_rate < MIN_CALLS_PER_DAY and 39.0 < old_rate < 40.0)

    save_fired_set(set())
    r = run_cycle(fixture, FIXTURE_WALL, facts(fixture, 2807))
    check("🎯 the historical exhaustion FIRES under the windowed rate", r["action"] == "fire")
    fixture_body = LAST_FIRE_BODY or ""
    check("the fired body names the real bucket", "free:v2:d552fbc794cd05dc" in fixture_body)
    check("the fired body reports the WINDOWED rate, not the lifetime one",
          "~2807 calls/day" in fixture_body and "~39 calls/day" not in fixture_body)

    # M) The window is a WINDOW. A caller who is quiet NOW must not page on old volume —
    #    otherwise the fix would just page forever instead of never.
    save_fired_set(set())
    r = run_cycle(fixture, FIXTURE_WALL, facts(fixture, 0))
    check("exhausted but no traffic in the window → silent (not a live burst)",
          r["action"] == "silent")

    # N) KEYED buckets have no ip_hash, so there is nothing to window on. They must keep
    #    firing on the lifetime estimate rather than being silently muted by a rate that
    #    is structurally 0 for every one of them.
    save_fired_set(set())
    keyed_fresh = [("av_free_111111111111111111111111", 100, NOW - HOUR)]
    r = run_cycle(keyed_fresh, NOW, {})   # deliberately NO facts row
    check("keyed bucket with no facts row still pages (lifetime fallback)", r["action"] == "fire")

    # J) VACUITY GUARD — refuse to report a pass over an empty corpus. Without this, a future
    #    change that made every scenario a no-op would still print PASS.
    check("self-test corpus is non-empty (vacuity guard)",
          len(body1) > 0 and len(body2) > 0 and len(fixture_body) > 0)

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
