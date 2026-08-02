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

Test seams (env): QUOTA_CANARY_FORCE_ROWS = `key:count:period_start_epoch,...` overrides the DB.
`--self-test` runs the hermetic scenario suite (no DB, no wrapper, temp state).
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


def query_rows():
    """[(tracker_key, call_count, period_start_epoch)] for CURRENT free-tier periods.

    Only free buckets are considered: a keyless one is `free:...`, a keyed one is an
    `av_free_...` key. Every paid key carries a different prefix, so this is the tier filter
    (`quota_usage` itself stores no tier). `-F '|'` keeps parsing trivial; the SQL literals are
    naturally single-quoted because psql -c is invoked directly, not through `node -e`.
    """
    forced = os.environ.get("QUOTA_CANARY_FORCE_ROWS")
    if forced is not None:
        rows = []
        for chunk in forced.split(","):
            if not chunk.strip():
                continue
            key, count, start = chunk.split(":")[0], chunk.split(":")[1], chunk.split(":")[2]
            rows.append((key, int(count), int(start)))
        return rows
    sql = (
        # `period_start` is a TEXT column (persistTracker writes an ISO-8601 string), NOT a
    # timestamp — so it must be cast before EXTRACT or psql errors out and this canary
    # fail-opens on every single run. Probed live 2026-08-02 before install.
    "SELECT tracker_key, call_count, EXTRACT(EPOCH FROM period_start::timestamptz)::bigint "
        "FROM quota_usage "
        "WHERE (tracker_key LIKE 'free:%' OR tracker_key LIKE 'av_free_%') "
        "AND call_count >= %d" % FREE_LIMIT
    )
    rows = []
    for line in _psql(sql).splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) != 3:
            raise RuntimeError("unexpected quota_usage row: %r" % line)
        rows.append((parts[0], int(parts[1]), int(parts[2])))
    return rows


def classify(rows, now_s):
    """Split the exhausted rows into high-volume (page) and low-volume (silent).

    Burn rate floors elapsed at one day so a bucket that exhausted within the first hour is
    not extrapolated to an absurd rate — the floor can only UNDER-state the rate, so it never
    manufactures a page.
    """
    high, low, stale = [], [], []
    for key, count, start in rows:
        age_s = now_s - start
        if age_s > WINDOW_S:
            stale.append((key, count, start, 0.0))  # period already rolled; not a live wall
            continue
        rate = count / max(1.0, age_s / DAY_S)
        entry = (key, count, start, rate)
        (high if rate >= MIN_CALLS_PER_DAY else low).append(entry)
    return high, low, stale


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


def run_cycle(rows, now_s):
    """One evaluation. Auto-resolve, dedup, fire. Returns an action dict."""
    high, low, stale = classify(rows, now_s)
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
        return {"action": "bootstrap", "seeded": len(seeded), "high": len(high), "low": len(low)}

    new_entries = [e for e in high if "%s@%d" % (e[0], e[2]) not in fired]
    if not new_entries:
        log("HEALTHY: high=%d low=%d stale=%d, no NEW high-volume exhaustion (rows=%d)"
            % (len(high), len(low), len(stale), len(rows)))
        return {"action": "silent", "high": len(high), "low": len(low)}

    fire(build_body(new_entries, len(high)))
    save_fired_set(fired | set("%s@%d" % (e[0], e[2]) for e in new_entries))
    return {"action": "fire", "new": len(new_entries), "high": len(high), "low": len(low)}


def main():
    try:
        rows = query_rows()
        run_cycle(rows, int(time.time()))
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

    # A0) BOOTSTRAP — the first cycle seeds and does NOT page, even with high-volume backlog.
    backlog = [("free:v2:9999aaaa8888bbbb", 900, NOW - 2 * DAY_S),
               ("free:v2:7777cccc6666dddd", 400, NOW - 2 * DAY_S)]
    r = run_cycle(backlog, NOW)
    check("first cycle with a backlog → bootstrap, NOT a page",
          r["action"] == "bootstrap" and r["seeded"] == 2)
    check("bootstrap seeded the state (so the backlog never pages later)", len(load_fired_set()) == 2)
    check("bootstrap wrote NO alert body", LAST_FIRE_BODY is None)
    check("the same backlog on the NEXT cycle stays silent", run_cycle(backlog, NOW)["action"] == "silent")

    # A) nothing exhausted → silent
    check("no exhausted buckets → silent", run_cycle([], NOW)["action"] == "silent")

    # B) LOW-volume exhaustion is silent BY DESIGN (took 25 days to spend 100)
    low_row = [("free:v2:aaaa1111bbbb2222", 100, NOW - 25 * DAY_S)]
    r = run_cycle(low_row, NOW)
    check("low-volume exhaustion → silent by design", r["action"] == "silent" and r["low"] == 1)

    # C) HIGH-volume exhaustion pages once (100 calls in ~1 hour ≈ 2400/day)
    high_row = [("free:v2:cccc3333dddd4444", 100, NOW - HOUR)]
    r = run_cycle(high_row, NOW)
    check("high-volume exhaustion → fire", r["action"] == "fire" and r["new"] == 1)

    # D) same bucket, same period → NO re-fire (dedup)
    check("same bucket+period persists → silent (dedup)", run_cycle(high_row, NOW)["action"] == "silent")

    # E) SAME bucket, NEW period → re-arms and fires again
    new_period = [("free:v2:cccc3333dddd4444", 100, NOW + 31 * DAY_S)]
    r = run_cycle(new_period, NOW + 31 * DAY_S + HOUR)
    check("same bucket, NEW period → fires again (re-armed)", r["action"] == "fire")

    # F) bucket leaves the exhausted set → auto-resolve, silent, state emptied
    check("bucket clears → silent (auto-resolve)", run_cycle([], NOW + 32 * DAY_S)["action"] == "silent")
    check("fired set emptied after resolve", load_fired_set() == set())

    # G) a stale period (older than the rolling window) is skipped, never paged
    stale_row = [("free:v2:eeee5555ffff6666", 5000, NOW - 60 * DAY_S)]
    check("stale period → silent (skipped)", run_cycle(stale_row, NOW)["action"] == "silent")

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
    run_cycle([("free:v2:1111aaaa2222bbbb", 100, NOW - HOUR)], NOW)
    body1 = LAST_FIRE_BODY or ""
    check("singular labels the ID ('Newly exhausted: bucket <id>')",
          "Newly exhausted: bucket free:v2:1111aaaa2222bbbb" in body1)
    check("singular count is on its own labelled line", "Newly exhausted count: 1" in body1)
    check("body states usage as N/limit", "used 100/100" in body1)
    check("body states the burn rate", "calls/day" in body1)
    check("body carries a templated recommended_wave (no literal Wn)",
          "OPS-QUOTA-EXHAUSTION-CONVERSION-W{NEXT}" in body1)

    save_fired_set(set())
    run_cycle([("free:v2:1111aaaa2222bbbb", 100, NOW - HOUR),
               ("free:v2:3333cccc4444dddd", 100, NOW - HOUR)], NOW)
    body2 = LAST_FIRE_BODY or ""
    check("plural renders 'buckets <id>, <id>'",
          "Newly exhausted: buckets free:v2:1111aaaa2222bbbb, free:v2:3333cccc4444dddd" in body2)
    check("plural does NOT render the singular noun before the list",
          "Newly exhausted: bucket free:v2:1111aaaa2222bbbb," not in body2)
    check("the ID line carries NO count (counts live on their own line)",
          _id_line_has_no_count(body2, ["free:v2:1111aaaa2222bbbb", "free:v2:3333cccc4444dddd"]))
    check("counts are rendered on a separate, labelled line",
          "Newly exhausted count: 2" in body2)

    # J) VACUITY GUARD — refuse to report a pass over an empty corpus. Without this, a future
    #    change that made every scenario a no-op would still print PASS.
    check("self-test corpus is non-empty (vacuity guard)", len(body1) > 0 and len(body2) > 0)

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
