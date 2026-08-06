#!/usr/bin/env python3
"""
revenue-meter-canary.py — the revenue meters assert their own truth.

REVENUE-METER-TRUTH-W6 · CH7. The terminal chapter of a six-wave arc, and the only one that
outlives it. W1-CH1 through CH6 fixed seven INSTANCES of one class; this fixes the CLASS:

    A REVENUE SIDE-EFFECT THAT FAILS OPEN AND REPORTS TO NOBODY.

Six instruments failed open for up to 57 days each. Every one was found by a human reading a
number that looked wrong, never by an alarm. The arc's own measurement of why:

  - `buildSubscriberProfile` bound a `timestamptz` with `String(<Date>)`, Postgres rejected it
    22007, and because `dbRun` is FIRE-AND-FORGET on PG the rejection reached no `catch` — so it
    logged "profiled cus_…" as SUCCESS for a row that was never written, 3 times out of 3, for
    57 days.
  - `paid_upgrade` counted x402 CLAIMS as paid upgrades with no settlement gate.
  - `stripe_checkout_started` was structurally incapable of ever emitting a non-zero value.
  - The quota canary had fired 3 times ever, twice on our own bots.
  - And the TEST GATE that certified all of the above could print PASS having run zero tests.

── WHY DIVERGENCE AND NOT LIVENESS ───────────────────────────────────────────────────────────
`OPS-FRESHNESS-SOURCE-TRUTH-W1` ratified "freshness alarms measure PRODUCERS" after FIVE
recurrences, and it has never reached the revenue path. But liveness alone is the WRONG
assertion here: a signup webhook is legitimately idle for weeks at four customers, so a canary
that pages on idleness is one the operator mutes within a week. Measured: the newest
`checkout.session.completed` is 2026-07-26, so a liveness check would be red right now and
correct to be ignored.

The assertion is DIVERGENCE BETWEEN A PRODUCER AND ITS UPSTREAM: an upstream fact exists
(Stripe told us a checkout completed) with no corresponding downstream row (`subscriber_profiles`)
after N minutes. That is EXACTLY the 57-day failure, and it fires on the FIRST missed customer
rather than the 57th day.

── WHY THREE METERS AND NOT ONE ──────────────────────────────────────────────────────────────
Meter (b) consumes `reconcileCounts()` — the cross-meter agreement check — and it is
STRUCTURALLY BLIND to the failure meter (a) exists to catch. Measured by replaying the live
data at 2026-08-05 08:50Z, the instant when the W5 backfill had landed 2 of 3 writes and one
paying customer was still missing: `reconcileCounts` computes `divergent: false` (absGap=1,
hi/lo = 4/3 = 1.33, neither the >2 ratio nor the >10 absolute gate trips) while meter (a)
returns exactly 1. At n=4 customers it needs a 3-of-4 loss to flip; it only fired during the
58-day outage because the gap had grown to 4-vs-1.

So: (a) DETECTS, (b) reports AGREEMENT. A green (b) must never suppress (a).

── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────────────
Auto-recovery is deliberately N/A. A mis-firing producer must not be auto-restarted by an
unattended job against production Postgres — Detect → Alert → Escalate only.

Consumer of `send_telegram.sh`; it does NOT re-implement the severity / cooldown / DRY_RUN /
fail-open gates (the wrapper owns those). `ALGOVAULT_TG_TEST_INERT=1` routes through every gate
but skips the POST **and writes no cooldown marker** — use it for repeated smokes.
`DRY_RUN_TG=1` also skips the POST but DOES write the 24h marker, so a second run false-greens
(cooldown-suppressed, not healthy); keep it only for a test whose assertion IS the cooldown.
`recommended_wave` uses the `OPS-REVENUE-METER-<CLASS>-W{NEXT}` template — NO literal Wn; the
wrapper's send-time resolver fills {NEXT}.

Verdict token: every run prints exactly one terminal `REVENUE_METER_VERDICT=` line.
Exit: 0 = evaluated (PASS, or FAIL with an alert sent) · 3 = INDETERMINATE (verified NOTHING).
INDETERMINATE is 3 — the token-law default for a NEW gate. `check_test_baseline.sh` is 2 ONLY
because it had already deployed 2 for that meaning; do not "align" them. A non-zero exit from a
cron line blocks nothing, so 3 is fully compatible with fail-open on tooling breakage.

🆕 AND A DARK RUN STILL ESCALATES. No artifact in ops/monitoring combined a breach streak with a
verdict token before this one: `webhook-delivery-canary.py` owns the only streak but prints no
token, and its fail-open branch touches NEITHER — so a permanently-broken query there is
indistinguishable from a healthy fleet. Here the fail-open path FEEDS the streak and pages once
it sustains, because a canary that is silent because it is broken is not a canary that is silent
because everything is fine. That distinction is the entire arc.

Test seams (env):
  REVENUE_METER_FORCE_A     = int, overrides meter (a)'s breach count
  REVENUE_METER_FORCE_B     = JSON reconciliation object, overrides meter (b)
  REVENUE_METER_FORCE_C     = int, overrides meter (c)'s growth count
  REVENUE_METER_SELFTEST    = 1, short-circuits fire() (set by --self-test)
  --self-test  runs the hermetic scenario suite (no DB, no HTTP, no wrapper, temp state).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ALERT_ID = "REVENUE_METER_DIVERGENCE"
WRAPPER = "/opt/algovault-monitoring/send_telegram.sh"
STATE_DIR = "/opt/algovault-monitoring/.alert-state"
FIRED_SET_FILE = os.path.join(STATE_DIR, "revenue-meter-canary-fired.set")
BREACH_COUNT_FILE = os.path.join(STATE_DIR, "revenue-meter-canary-dark.count")
LOG = "/var/log/algovault-revenue-meter-canary.log"
PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
PG_ROLE = "algovault_autopilot"
PG_DB = "signal_performance"
APP_CONTAINER = "crypto-quant-signal-mcp-mcp-server-1"
SCOREBOARD_URL = "http://127.0.0.1:3000/dashboard/api/funnel-scoreboard"


def _int_env(name, default):
    try:
        v = int(os.environ[name])
        return v if v >= 0 else default
    except (KeyError, ValueError):
        return default


# ── Config. Every default carries the measurement that chose it. ──────────────────────────────

# Meter (a): how long a completed checkout may go unprofiled before it is a breach.
#
# Measured, NOT guessed. The producer is dispatched fire-and-forget inside the SAME webhook
# request that stamps `processed_at`, and a full build including a live Stripe `retrieveSession`
# took 270 ms (two consecutive backfill writes, 08:47:28.685931 → 08:47:28.955966);
# handler→ledger latency is 1.5–2.2 ms. So 15 minutes is ~3,300x headroom — comfortably above a
# container-restart window, which is the one legitimate delay.
#
# ⚠️ Do NOT reach for the 370 / 128 / 126 second figures in the arc's notes. Those are
# `signup_at → converted_at`: how long a HUMAN took at the Stripe checkout page. Using customer
# behaviour as a producer bound is a category error.
#
# There is NO self-healing to wait for: the profiler runs only in the `isNew` branch after the
# idempotency claim, so once the webhook 200s Stripe never redelivers. A breach is PERMANENT.
# Detection speed is the only lever this canary has.
GRACE_MINUTES = _int_env("REVENUE_METER_GRACE_MINUTES", 15)

# Meter (c): claims created after the declared watermark that are still unsettled this long.
# The grace exists because the only promoter is an operator-run script, not a cron.
UNSETTLED_GRACE_DAYS = _int_env("REVENUE_METER_UNSETTLED_GRACE_DAYS", 7)

# Meter (c) baseline. Everything at or below this timestamp is DECLARED DEBT, not a finding.
#
# An age-only threshold here would be a CONSTANT, and this arc has already shipped two dead arms.
# Measured 2026-08-05: `SETTLED` has NEVER existed (0 rows lifetime), and the only writer that
# promotes a claim — `src/scripts/backfill-x402-payer-wallet.ts --classify --execute` — is on no
# cron on either host. So at any age threshold, 15 of 15 rows breach on day one and NOTHING on
# the box can ever clear one: a permanent red light, which is a muted light.
#
# Watermarking makes the meter measure what it can actually detect: NEW unsettled growth. The
# 15-row backlog is declared debt (see the inventory row), unblocked by
# OPS-REVENUE-METER-SETTLEMENT-W{NEXT}.
UNSETTLED_WATERMARK = os.environ.get(
    "REVENUE_METER_UNSETTLED_WATERMARK", "2026-07-29 14:08:47.787216+00")

# Consecutive DARK cycles before a broken canary pages about itself.
SUSTAINED_DARK_CYCLES = max(1, _int_env("REVENUE_METER_SUSTAINED_DARK_CYCLES", 3))

HTTP_TIMEOUT_S = _int_env("REVENUE_METER_HTTP_TIMEOUT_S", 20)


def log(msg):
    line = "%s revenue-meter-canary: %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


# ── State ─────────────────────────────────────────────────────────────────────────────────────

def load_fired_set():
    # splitlines(), NOT split(). The sibling canaries use whitespace-splitting because their ids
    # are whitespace-free by luck (`free:v2:<hex>@<epoch>`); a timestamped id is not, and a
    # whitespace split SHREDS it into fragments that can never match on reload — so every finding
    # re-fires forever while the file looks perfectly reasonable. Caught by this file's own
    # dedup scenarios on their first run.
    try:
        with open(FIRED_SET_FILE) as fh:
            return set(x.strip() for x in fh.read().splitlines() if x.strip())
    except OSError:
        return set()


def state_exists():
    """True once this canary has completed at least one cycle on this host.

    EMPTY means "nothing is diverging"; MISSING means "never run here". Those must behave
    differently on the first cycle — see the bootstrap branch in run_cycle.
    """
    return os.path.exists(FIRED_SET_FILE)


def save_fired_set(ids):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(FIRED_SET_FILE, "w") as fh:
            fh.write("\n".join(sorted(ids)))
    except OSError as e:
        log("WARN: could not persist fired set: %s" % e)


def read_dark_count():
    try:
        with open(BREACH_COUNT_FILE) as fh:
            return int(fh.read().strip() or "0")
    except (OSError, ValueError):
        return 0


def write_dark_count(n):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(BREACH_COUNT_FILE, "w") as fh:
            fh.write(str(n))
    except OSError as e:
        log("WARN: could not persist dark count: %s" % e)


# ── Data access ───────────────────────────────────────────────────────────────────────────────

def _psql(sql, fieldsep="|"):
    args = ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_ROLE, "-d", PG_DB,
            "-tAq", "-F", fieldsep, "-v", "ON_ERROR_STOP=1", "-c", sql]
    out = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % out.stderr.strip()[:300])
    return out.stdout.strip()


def build_divergence_query(grace_minutes):
    """Meter (a). Built by CONCATENATION, never %-formatting — the predicate carries `%s`-free
    JSON operators today but the LIKE/`%` trap has bitten two canaries in this directory already.

    THE JOIN KEY IS `metadata::jsonb->>'client_reference_id'`, and that is not a preference.
    `processed_stripe_events` has SEVEN columns and none of them is a customer id; `session_id`
    (`cs_live_…`) has no counterpart in `subscriber_profiles` and resolves only through a Stripe
    API round trip, which is why W5's backfill had to call `retrieveSession`. This is the only
    pure-SQL key that exists.

    🛑 DIRECTIONAL — events → profiles ONLY. The reverse direction pages forever: one customer
    converted 2026-06-07, before both this ledger's first row (2026-07-18) and the profiler's
    birth commit, so a profile with no event is a legitimate standing orphan.
    """
    return (
        "SELECT e.event_id, e.processed_at, "
        "coalesce(e.metadata::jsonb->>'client_reference_id', '<none>') "
        "FROM processed_stripe_events e "
        "WHERE e.event_type = 'checkout.session.completed' "
        "AND e.processed_at < now() - interval '" + str(int(grace_minutes)) + " minutes' "
        "AND NOT EXISTS (SELECT 1 FROM subscriber_profiles p "
        "WHERE p.client_reference_id = e.metadata::jsonb->>'client_reference_id') "
        "ORDER BY e.processed_at"
    )


def build_unsettled_query(watermark, grace_days):
    """Meter (c). Excludes the four empty-`payer_wallet` rows: they are unattributable ON CHAIN
    by construction (SEC-49 writes '' when no payer can be extracted), so they can never be
    classified and would breach forever. They also inflate COUNT(DISTINCT payer_wallet) to 3 when
    there are 2 real payers.
    """
    return (
        "SELECT count(*) FROM processed_x402_payments "
        "WHERE settlement_state = 'CLAIMED_UNSETTLED' "
        "AND trim(payer_wallet) <> '' "
        "AND created_at > TIMESTAMPTZ '" + watermark + "' "
        "AND created_at < now() - interval '" + str(int(grace_days)) + " days'"
    )


def query_divergence():
    """[(event_id, processed_at, client_reference_id)] — completed checkouts with no profile."""
    forced = os.environ.get("REVENUE_METER_FORCE_A")
    if forced is not None:
        n = int(forced)
        return [("evt_forced_%d" % i, "2026-01-01T00:00:00Z", "forced:%d" % i) for i in range(n)]
    rows = []
    for line in _psql(build_divergence_query(GRACE_MINUTES)).splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) != 3:
            raise RuntimeError("unexpected divergence row: %r" % line)
        rows.append((parts[0], parts[1], parts[2]))
    return rows


def query_unsettled_growth():
    forced = os.environ.get("REVENUE_METER_FORCE_C")
    if forced is not None:
        return int(forced)
    out = _psql(build_unsettled_query(UNSETTLED_WATERMARK, UNSETTLED_GRACE_DAYS))
    return int(out.strip() or "0")


def fetch_reconciliation():
    """Meter (b). CONSUMES `reconcileCounts()` through the dashboard endpoint — never
    re-implements it. Re-deriving a cross-meter check inside the thing that checks it is how two
    independent derivations drift to contradiction (CLAUDE.md single-derivation rule).

    Auth is `Authorization: Bearer` or the session cookie ONLY — `?key=` cannot authorize
    (SEC-10). The key is read from the RUNNING CONTAINER: `~/.config/algovault/admin.env` does
    NOT exist on this host despite being cited, and `stripe-webhook-events-canary.sh` already
    sources it this way.
    """
    forced = os.environ.get("REVENUE_METER_FORCE_B")
    if forced is not None:
        return json.loads(forced)
    key = subprocess.run(["docker", "exec", APP_CONTAINER, "printenv", "ADMIN_API_KEY"],
                         capture_output=True, text=True, timeout=20).stdout.strip()
    if not key:
        raise RuntimeError("could not read ADMIN_API_KEY from the app container")
    req = urllib.request.Request(SCOREBOARD_URL, headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    rec = (payload.get("paying_subscribers") or {}).get("reconciliation")
    if not isinstance(rec, dict):
        raise RuntimeError("scoreboard payload carried no .paying_subscribers.reconciliation")
    return rec


# ── Evaluation ────────────────────────────────────────────────────────────────────────────────

def classify(divergent_rows, reconciliation, unsettled_growth):
    """Returns (findings, notes). A finding pages; a note is reported and never pages."""
    findings, notes = [], []

    # (a) THE DETECTOR.
    for event_id, processed_at, cri in divergent_rows:
        findings.append({
            "meter": "producer_divergence",
            # Dedup identity is the Stripe event id ALONE. It is globally unique and never
            # reissued, so it is both the correct identity AND whitespace-free — the timestamp
            # it used to carry made the id un-round-trippable through the state file.
            "id": event_id,
            "text": "checkout event %s (completed %s, client_reference_id %s) has NO "
                    "subscriber_profiles row after %d minutes"
                    % (event_id, processed_at, cri, GRACE_MINUTES),
        })

    # (b) AGREEMENT, not detection.
    stripe_total = reconciliation.get("stripe_total")
    profiles_total = reconciliation.get("profiles_total")
    if stripe_total is None:
        # A Stripe outage currently makes reconcileCounts return divergent:false — i.e. it reads
        # as AGREEMENT. Refuse to launder that into a pass.
        raise RuntimeError("reconciliation.stripe_total is null — Stripe census unavailable, so "
                           "cross-meter agreement could not be evaluated (it would read as "
                           "`divergent: false`, which is agreement, not silence)")
    if reconciliation.get("divergent"):
        # OPS-STRIPE-SUBSCRIPTION-TRUTH-W3 CH1: reconcileCounts now compares COMPOSITION (tier x
        # billing interval), not only totals, and its `divergent` flag fires on ANY disagreement
        # rather than only on a >2x / >10-absolute gap that could never trip at n=4.
        mismatches = reconciliation.get("composition_mismatches") or []
        # DEDUP IDENTITY MUST INCLUDE THE COMPOSITION. The old id was totals-only
        # ("reconcile@4-4"), and the whole point of this widening is that totals can AGREE while
        # the composition does not — so two genuinely different mismatches would have collapsed
        # to one id and the second would have been suppressed as already-fired.
        shape = ";".join("%s/%s:%s-%s" % (m.get("tier"), m.get("interval"),
                                          m.get("stripe"), m.get("profiles"))
                         for m in mismatches)
        if mismatches:
            # Name the entity, never a bare number beside a count (CLAUDE.md alert-body rule).
            detail = "; ".join(
                "tier %s/%s: Stripe %s vs record %s" % (m.get("tier"), m.get("interval"),
                                                        m.get("stripe"), m.get("profiles"))
                for m in mismatches)
            text = ("reconcileCounts() reports DIVERGENT on COMPOSITION: %s "
                    "(totals stripe_total %s vs profiles_total %s)"
                    % (detail, stripe_total, profiles_total))
        else:
            text = ("reconcileCounts() reports DIVERGENT: stripe_total %s vs profiles_total %s"
                    % (stripe_total, profiles_total))
        findings.append({
            "meter": "cross_meter_disagreement",
            "id": "reconcile@%s-%s%s" % (stripe_total, profiles_total,
                                         ("|" + shape) if shape else ""),
            "text": text,
        })

    # (c) GROWTH above the declared watermark.
    if unsettled_growth > 0:
        noun = "claim" if unsettled_growth == 1 else "claims"
        findings.append({
            "meter": "unsettled_growth",
            "id": "unsettled+%d" % unsettled_growth,
            "text": "%d x402 %s created after the declared watermark are still unsettled after "
                    "%d days" % (unsettled_growth, noun, UNSETTLED_GRACE_DAYS),
        })

    # NOTE CORRECTED 2026-08-06 (OPS-STRIPE-SUBSCRIPTION-TRUTH-W3 CH1). This line used to read
    # "totals only — at this scale it cannot see a single lost customer; meter (a) is the
    # detector". That was TRUE and is now FALSE: reconcileCounts compares composition (tier x
    # billing interval) and its `divergent` flag fires on ANY disagreement, so meter (b) CAN now
    # see a single lost or mis-tiered customer at n=4. Meter (a) remains the producer-liveness
    # DETECTOR — a green (b) must still never suppress it — but (b) is no longer structurally
    # blind. A stale note describing a guard's blindness outlives the blindness and gets read as
    # current fact by the next wave.
    notes.append("meter (b) agreement: stripe_total=%s profiles_total=%s divergent=%s "
                 "composition_compared=%s mismatches=%d"
                 % (stripe_total, profiles_total, reconciliation.get("divergent"),
                    reconciliation.get("composition_compared"),
                    len(reconciliation.get("composition_mismatches") or [])))
    return findings, notes


def build_body(new_findings, total_findings):
    """The operator-facing body.

    Per the alert-body law (OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 D3): an entity ID carries its entity
    NOUN, and a bare parenthesised number never sits beside a count — an operator read `(new: 6)`
    as "six subscriptions" when there were two. IDs and COUNTS live on SEPARATE lines here.
    """
    ids = [f["id"] for f in new_findings]
    noun = "meter finding" if len(ids) == 1 else "meter findings"
    return "\n".join([
        "\U0001F4B8 %s" % ALERT_ID,
        "Newly diverging: %s %s" % (noun, ", ".join(ids)),
        " | ".join(f["text"] for f in new_findings),
        "Newly diverging count: %d | diverging now: %d | grace %d min"
        % (len(ids), total_findings, GRACE_MINUTES),
        "A completed Stripe checkout with no subscriber_profiles row is a PAID CUSTOMER we have",
        "no record of. Stripe never redelivers after a 200, so this does NOT self-heal.",
        "Action: dispatch OPS-REVENUE-METER-DIVERGENCE-W{NEXT} via Cowork → Claude Code",
        "Source log: %s" % LOG,
    ])


def build_dark_body(streak, err):
    """A canary that is silent BECAUSE IT IS BROKEN is not a canary that is silent because
    everything is fine. This is the escalation that no other artifact in ops/monitoring has.
    """
    return "\n".join([
        "\U0001F4B8 %s" % ALERT_ID,
        "Dark run streak: %d consecutive cycle(s) could not evaluate any meter" % streak,
        "Last error: %s" % str(err)[:300],
        "The revenue meters are UNVERIFIED, not healthy. This alert exists because a silent",
        "canary and a silent-because-broken canary look identical in a log.",
        "Action: dispatch OPS-REVENUE-METER-DARK-W{NEXT} via Cowork → Claude Code",
        "Source log: %s" % LOG,
    ])


LAST_FIRE_BODY = None


def fire(body):
    """Hand the body to the wrapper (it owns severity/cooldown/DRY_RUN/fail-open)."""
    global LAST_FIRE_BODY
    LAST_FIRE_BODY = body
    if os.environ.get("REVENUE_METER_SELFTEST") == "1":
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


def run_cycle(divergent_rows, reconciliation, unsettled_growth):
    """One evaluation. Auto-resolve, dedup, fire. Returns an action dict."""
    findings, notes = classify(divergent_rows, reconciliation, unsettled_growth)
    fired = load_fired_set()
    live_ids = set(f["id"] for f in findings)

    resolved = fired - live_ids
    if resolved:
        log("RESOLVED: %d finding(s) no longer diverging (auto-resolve, silent)" % len(resolved))
        fired = fired & live_ids
        save_fired_set(fired)

    # POSITIVE per-meter output, never absence-of-alert. A meter silently skipped by a parse error
    # must not look identical to a meter that was evaluated and passed.
    log("EVAL producer_divergence: %d completed checkout(s) with no profile after %d min "
        "verdict=%s" % (len(divergent_rows), GRACE_MINUTES,
                        "BREACH" if divergent_rows else "OK"))
    for n in notes:
        log("EVAL cross_meter: %s verdict=%s"
            % (n, "BREACH" if reconciliation.get("divergent") else "AGREES"))
    log("EVAL unsettled_growth: %d claim(s) newer than the watermark unsettled > %d days "
        "verdict=%s" % (unsettled_growth, UNSETTLED_GRACE_DAYS,
                        "BREACH" if unsettled_growth else "OK"))

    if not state_exists():
        seeded = set(live_ids)
        save_fired_set(seeded)
        log("BOOTSTRAP: first cycle on this host — seeded %d finding(s) WITHOUT paging "
            "(historical backlog, not new events)" % len(seeded))
        return {"action": "bootstrap", "seeded": len(seeded), "findings": len(findings)}

    new_findings = [f for f in findings if f["id"] not in fired]
    if not new_findings:
        log("HEALTHY: %d finding(s) live, none NEW" % len(findings))
        return {"action": "silent", "findings": len(findings)}

    fire(build_body(new_findings, len(findings)))
    save_fired_set(fired | live_ids)
    return {"action": "fire", "new": len(new_findings), "findings": len(findings)}


def record_dark_cycle(err):
    """🆕 The dark path FEEDS THE STREAK and escalates. Returns the new streak.

    Every other canary in this directory returns from its fail-open branch having recorded
    NOTHING — which is exactly why a permanently-broken one is indistinguishable from a healthy
    one, the class this arc exists to retire.

    ⚠️ This is a SEPARATE FUNCTION so `--self-test` can drive THE SHIPPED PATH rather than a copy
    of it. The first version inlined this in `main()`'s `except` and the self-test re-implemented
    the same arithmetic locally: deleting the real streak write left the self-test fully GREEN.
    That is the same defect shape as the code it guards, in the guard — caught only because AC 7.4
    demands the self-test be PROVEN able to fail, which is why that step is not ceremony.
    """
    streak = read_dark_count() + 1
    write_dark_count(streak)
    log("DARK: cycle could not evaluate any meter — streak %d/%d" % (streak, SUSTAINED_DARK_CYCLES))
    if streak >= SUSTAINED_DARK_CYCLES:
        try:
            fire(build_dark_body(streak, err))
        except Exception as inner:  # noqa: BLE001 — alerting must not mask the finding
            log("FAIL_OPEN: dark escalation also failed: %s" % inner)
    return streak


def main():
    try:
        rows = query_divergence()
        rec = fetch_reconciliation()
        growth = query_unsettled_growth()
        result = run_cycle(rows, rec, growth)
        write_dark_count(0)          # a run that evaluated clears the dark streak
        # FAIL means A METER IS DIVERGING; PASS means evaluated and clean; INDETERMINATE means
        # evaluated NOTHING. All three are reachable on the live path — a token value that can
        # never occur is a dead arm, and this wave removed two of those from the funnel already.
        # The EXIT CODE stays 0 for both PASS and FAIL: the alert is the action, and bouncing a
        # cron line on a real finding would just add noise to a mailbox nobody reads.
        diverging = result.get("findings", 0)
        print("REVENUE_METER_VERDICT=%s" % ("FAIL" if diverging else "PASS"))
        return 0
    except Exception as e:  # noqa: BLE001 — fail-open is the alert contract
        log("FAIL_OPEN: %s: %s" % (type(e).__name__, e))
        record_dark_cycle(e)
        print("REVENUE_METER_VERDICT=INDETERMINATE")
        return 3


# ── Self-test ─────────────────────────────────────────────────────────────────────────────────

def self_test():
    """Hermetic scenarios — no DB, no HTTP, no wrapper, temp state."""
    global STATE_DIR, FIRED_SET_FILE, BREACH_COUNT_FILE, LOG, LAST_FIRE_BODY
    tmp = tempfile.mkdtemp(prefix="revenue-meter-selftest-")
    STATE_DIR = tmp
    FIRED_SET_FILE = os.path.join(tmp, "fired.set")
    BREACH_COUNT_FILE = os.path.join(tmp, "dark.count")
    LOG = os.path.join(tmp, "selftest.log")
    os.environ["REVENUE_METER_SELFTEST"] = "1"
    os.environ["ALGOVAULT_TG_TEST_INERT"] = "1"

    failures = []

    def check(name, cond):
        print("  [%s] %s" % ("PASS" if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    AGREE = {"stripe_total": 4, "profiles_total": 4, "divergent": False,
             "instrumentation_artifact": False, "composition_compared": True,
             "composition_mismatches": []}

    # W3-CH1: totals AGREE (4 vs 4) while the composition does not. This is the exact live
    # defect the arc existed to catch, and the shape the pre-W3 check reported clean.
    COMPOSITION_DRIFT = {
        "stripe_total": 4, "profiles_total": 4, "divergent": True,
        "instrumentation_artifact": False, "composition_compared": True,
        "composition_mismatches": [
            {"tier": "pro", "interval": "month", "stripe": 1, "profiles": 0},
            {"tier": "starter", "interval": "unknown", "stripe": 0, "profiles": 4},
        ],
    }

    # ── THE HISTORICAL CORPUS. All three events are real, with their real timestamps; the single
    #    pre-backfill profile is the one conversion that survived W5's 22007 bind failure because
    #    it had no attribution row (signup_at NULL → a valid bind). This is the 57-day failure.
    E1 = ("evt_1TuNZtKGleoEgU2HOcF2oJcn", "2026-07-18 02:02:10.278181+00", "direct:1784339759464:0iilhe")
    E2 = ("evt_1TxQXtKGleoEgU2HUtoiRfYD", "2026-07-26 11:48:41.997804+00", "tg_bot:1785066392942:3af913")
    E3 = ("evt_1TxRIoKGleoEgU2H6LG4YMSU", "2026-07-26 12:37:11.323471+00", "tg_bot:1785069305022:1zod25")

    # A0) BOOTSTRAP — the first cycle seeds and does NOT page, even with a real backlog.
    r = run_cycle([E1, E2, E3], AGREE, 0)
    check("first cycle with a backlog → bootstrap, NOT a page",
          r["action"] == "bootstrap" and r["seeded"] == 3)
    check("bootstrap wrote NO alert body", LAST_FIRE_BODY is None)
    check("the same backlog on the NEXT cycle stays silent",
          run_cycle([E1, E2, E3], AGREE, 0)["action"] == "silent")

    # A) all meters clean → silent
    save_fired_set(set())
    check("no divergence, agreement, no unsettled growth → silent",
          run_cycle([], AGREE, 0)["action"] == "silent")

    # B) 🎯 THE 57-DAY FAILURE, replayed. Post-backfill the corpus is clean; during the failure
    #    all three events had no profile row.
    save_fired_set(set())
    r = run_cycle([E1, E2, E3], AGREE, 0)
    check("🎯 the 57-day producer failure FIRES", r["action"] == "fire" and r["new"] == 3)
    body_three = LAST_FIRE_BODY or ""

    # C) 🎯 AND IT FIRES ON THE FIRST MISSED CUSTOMER — 8 days before the second. This is the
    #    actual requirement, and it is a SEPARATE assertion: a canary that only fires once three
    #    customers are gone is not the canary this arc needs.
    save_fired_set(set())
    r = run_cycle([E1], AGREE, 0)
    check("🎯 fires on the FIRST missed customer alone", r["action"] == "fire" and r["new"] == 1)
    body_one = LAST_FIRE_BODY or ""

    # D) dedup — same finding, same cycle identity → no re-fire
    check("same finding persists → silent (dedup)",
          run_cycle([E1], AGREE, 0)["action"] == "silent")

    # E) auto-resolve, silently (recovery alerts are noise)
    check("finding clears → silent (auto-resolve)", run_cycle([], AGREE, 0)["action"] == "silent")
    check("fired set emptied after resolve", load_fired_set() == set())

    # F) 🚩 METER (b) IS BLIND WHERE METER (a) SEES. The live 08:50Z instant: one paying customer
    #    genuinely missing, and reconcileCounts says divergent:false. If a green (b) were allowed
    #    to suppress (a), this canary would certify the exact failure it exists to catch.
    save_fired_set(set())
    blind = {"stripe_total": 4, "profiles_total": 3, "divergent": False,
             "instrumentation_artifact": False}
    r = run_cycle([E3], blind, 0)
    check("🚩 meter (a) fires even though meter (b) reports agreement",
          r["action"] == "fire" and r["new"] == 1)

    # G) meter (b) DOES page when it actually diverges
    save_fired_set(set())
    diverged = {"stripe_total": 4, "profiles_total": 1, "divergent": True,
                "instrumentation_artifact": False}
    r = run_cycle([], diverged, 0)
    check("cross-meter disagreement → fire", r["action"] == "fire")

    # G2) W3-CH1 — COMPOSITION drift with IDENTICAL totals. This is the shape the pre-W3 check
    #     reported clean for weeks: 4 subscribers on each side, one of them on the wrong tier.
    save_fired_set(set())
    r = run_cycle([], COMPOSITION_DRIFT, 0)
    check("composition drift at EQUAL totals (4 vs 4) → fire", r["action"] == "fire")
    body = LAST_FIRE_BODY or ""
    # Assert the rendered BODY, not just the action verdict: a canary that fires with a body an
    # operator cannot act on is half a guard, and this repo has shipped exactly that before.
    check("body names the disagreeing tier, not just a total",
          "pro/month" in body and "starter/unknown" in body)
    check("body still carries the totals for context", "4" in body)

    # G3) the dedup identity must include the COMPOSITION, or two different mismatches at the
    #     same totals collapse to one id and the second is suppressed as already-fired.
    save_fired_set(set())
    run_cycle([], COMPOSITION_DRIFT, 0)
    other = dict(COMPOSITION_DRIFT)
    other["composition_mismatches"] = [
        {"tier": "enterprise", "interval": "month", "stripe": 1, "profiles": 0},
        {"tier": "starter", "interval": "month", "stripe": 0, "profiles": 1},
    ]
    r = run_cycle([], other, 0)
    check("a DIFFERENT composition mismatch at the same totals still fires (id is not totals-only)",
          r["action"] == "fire")

    # H) a null Stripe census is INDETERMINATE, never agreement
    save_fired_set(set())
    raised = False
    try:
        run_cycle([], {"stripe_total": None, "profiles_total": 4, "divergent": False}, 0)
    except RuntimeError:
        raised = True
    check("stripe_total=null → refuses to evaluate (not a silent pass)", raised)

    # I) meter (c) watermark: growth pages, backlog does not
    save_fired_set(set())
    check("no growth above the watermark → silent", run_cycle([], AGREE, 0)["action"] == "silent")
    save_fired_set(set())
    r = run_cycle([], AGREE, 2)
    check("NEW unsettled growth → fire", r["action"] == "fire")
    body_unsettled = LAST_FIRE_BODY or ""

    # I2) STATE-FILE ROUND TRIP. The dedup scenarios above only prove ids survive the ids we
    #     happen to use today; this proves the STORE is not the weak link. Its first version split
    #     on whitespace, so any id containing a space came back as fragments and every finding
    #     re-fired forever.
    save_fired_set({"evt_plain", "id with spaces", "trailing "})
    check("the fired-set store round-trips an id containing spaces",
          "id with spaces" in load_fired_set())
    save_fired_set(set())

    # J) RENDERED-BODY assertions. Every check above asserts an ACTION verdict only, which is
    #    exactly how a body a human misreads passed all nine gates on 2026-08-01.
    check("body names the entity with its NOUN (singular)",
          "Newly diverging: meter finding evt_1TuNZtKGleoEgU2HOcF2oJcn" in body_one)
    check("body pluralises the noun from the ID COUNT",
          "Newly diverging: meter findings evt_" in body_three)
    check("counts live on their OWN line, never beside an ID",
          "Newly diverging count: 3" in body_three and "Newly diverging count: 1" in body_one)
    check("the ID line carries NO digits beyond the ids themselves",
          _id_line_has_no_bare_count(body_three, [E1[0], E2[0], E3[0]]))
    check("body states the grace window", "grace 15 min" in body_three)
    check("body says the failure does NOT self-heal", "does NOT self-heal" in body_three)
    check("body carries a templated recommended_wave (no literal Wn)",
          "OPS-REVENUE-METER-DIVERGENCE-W{NEXT}" in body_three)
    check("unsettled body pluralises its own noun from the COUNT",
          "2 x402 claims" in body_unsettled)

    # K) 🆕 THE DARK PATH FEEDS THE STREAK AND ESCALATES.
    # Drives `record_dark_cycle` — THE SHIPPED FUNCTION `main()`'s except branch calls — not a
    # local re-implementation of it. Re-implementing it here is what let a deliberate break of the
    # real streak write pass this suite fully green.
    write_dark_count(0)
    LAST_FIRE_BODY = None
    dark_bodies = []
    for _ in range(SUSTAINED_DARK_CYCLES):
        record_dark_cycle(RuntimeError("psql unreachable"))
        if LAST_FIRE_BODY:
            dark_bodies.append(LAST_FIRE_BODY)
            LAST_FIRE_BODY = None
    check("a dark run INCREMENTS the streak rather than returning silently",
          read_dark_count() == SUSTAINED_DARK_CYCLES)
    check("a dark run BELOW the sustain threshold does NOT page yet",
          len(dark_bodies) == 1)
    check("a sustained dark streak ESCALATES", len(dark_bodies) == 1)
    check("the dark body says UNVERIFIED, not healthy",
          "UNVERIFIED, not healthy" in (dark_bodies[0] if dark_bodies else ""))
    check("the dark body carries its own templated wave",
          "OPS-REVENUE-METER-DARK-W{NEXT}" in (dark_bodies[0] if dark_bodies else ""))

    # L) THE QUERIES THEMSELVES. Every scenario above feeds rows through the FORCE seams, so none
    #    of them touched the SQL — which is precisely how a %-format error in a LIKE clause reached
    #    the host and made a sibling canary's first live run report INDETERMINATE.
    try:
        qa = build_divergence_query(15)
        qc = build_unsettled_query(UNSETTLED_WATERMARK, 7)
        built = True
    except Exception as e:  # noqa: BLE001
        qa, qc, built = "%s: %s" % (type(e).__name__, e), "", False
    check("the SQL builds at all", built)
    check("meter (a) joins on client_reference_id, the ONLY pure-SQL key",
          built and "client_reference_id" in qa)
    check("meter (a) is DIRECTIONAL (events → profiles, never the reverse)",
          built and "NOT EXISTS" in qa and "FROM processed_stripe_events" in qa)
    check("meter (a) carries the grace interval", built and "interval '15 minutes'" in qa)
    check("meter (c) is WATERMARKED, not an age-only threshold",
          built and UNSETTLED_WATERMARK in qc and "created_at >" in qc)
    check("meter (c) excludes the unattributable empty-payer rows",
          built and "trim(payer_wallet) <> ''" in qc)

    # L2) THE TOKEN ITSELF. All three values must be reachable, and the mapping is the contract —
    #     asserting the tokens without the mapping is how re-coding INDETERMINATE to 0 stayed green
    #     in a sibling gate. `run_cycle` returns the count `main()` reads, so this drives the same
    #     decision the shipped path makes.
    save_fired_set(set())
    check("token: a clean evaluation yields PASS",
          run_cycle([], AGREE, 0).get("findings", 0) == 0)
    save_fired_set(set())
    check("token: a diverging meter yields FAIL (not PASS-with-an-alert)",
          run_cycle([E1], AGREE, 0).get("findings", 0) > 0)

    # M) VACUITY GUARD — refuse to report a pass over an empty corpus. Without this, a change that
    #    made every scenario a no-op would still print PASS. Step 0B of this very wave found the
    #    test gate doing exactly that.
    check("self-test corpus is non-empty (vacuity guard)",
          len(body_one) > 0 and len(body_three) > 0 and len(body_unsettled) > 0
          and len(dark_bodies) > 0)

    ok = not failures
    print("SELF-TEST: %s (%d failed)" % ("PASS" if ok else "FAIL", len(failures)))
    print("REVENUE_METER_VERDICT=%s" % ("PASS" if ok else "FAIL"))
    try:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    except Exception:
        pass
    return 0 if ok else 1


def _id_line_has_no_bare_count(body, ids):
    """True iff the ID line exists AND carries no digits once the IDs are removed.

    Written defensively: an assertion that INDEXES into a split is not an assertion, it is a crash
    waiting to be mistaken for a pass. A missing label must report FALSE, never raise.
    """
    marker = "Newly diverging: "
    for line in body.split("\n"):
        if not line.startswith(marker):
            continue
        rest = line[len(marker):]
        for i in ids:
            rest = rest.replace(i, "")
        return not any(ch.isdigit() for ch in rest)
    return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="revenue-meter divergence canary")
    parser.add_argument("--self-test", action="store_true",
                        help="run the hermetic scenario suite and exit")
    a = parser.parse_args()
    if a.self_test:
        sys.exit(self_test())
    sys.exit(main())
