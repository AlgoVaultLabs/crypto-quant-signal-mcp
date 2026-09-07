#!/usr/bin/env python3
"""payment-decline-canary.py — decline-rate detector. PAY-UNIONPAY-ATTRIBUTION-W1 (R9).

Reads `stripe_payment_failures` + `subscriber_profiles` and alerts ONLY on sustained,
operator-action-required drift. Ordinary declines are background noise and must never page.

── DESIGNED FOR THE POPULATION THAT ACTUALLY EXISTS ────────────────────────────────────────
Measured on the live account when this shipped: **10 charges lifetime, 1 failure, 4 subscriber
rows.** A percentage over n=10 is not a rate, it is an anecdote — and CLAUDE.md forbids a
single-sample monitoring alarm outright. So there are TWO predicates and the small-n one is
the only one live today:

  n < MIN_N (20)   → ABSOLUTE FLOOR only: >= 3 distinct failed payments in 7d.
                     The rate predicate is INERT. Verdict is **PASS**, carrying the observed
                     n so the reader sees WHY the rate was not evaluated.
  n >= MIN_N       → rate predicate activates; the floor stays armed underneath it.

🛑 Below MIN_N the verdict is PASS, never INDETERMINATE. INDETERMINATE means "we could not
verify"; a small population is not a verification failure, it is a FACT about the world. The
distinction is the one CLAUDE.md draws between a corpus WE were supposed to fill (empty ⇒
vacuity ⇒ refuse) and a corpus the WORLD fills (empty ⇒ a fact ⇒ report it and pass). Getting
this backwards would leave the canary permanently INDETERMINATE — decoration that pages
nobody and reassures everybody.

Every run APPENDS its observed n to a ledger, so the MIN_N crossing is measured rather than
guessed at the moment somebody decides whether to trust the rate. A promotion criterion with
no measured rate of approach can sit unfired forever.

⚠️ THE RATE THRESHOLD IS UNCALIBRATED AND SAYS SO. With n=10 lifetime there is no honest way
to calibrate it, and no published UnionPay / China cross-border authorization benchmark exists
to borrow (verified across Worldpay, Adyen, Checkout.com, Stripe, Nuvei, PPRO, UnionPay
International, PBOC, MRC — the circulating "98.3%" is fabricated). `DECLINE_RATE_PCT_MAX` is a
PLACEHOLDER that cannot fire until n >= MIN_N; whoever is present at the first crossing owns
calibrating it against the observation ledger this canary is accumulating for exactly that.

── 🛑 THE FLOOR COUNTS DISTINCT CUSTOMERS, AND THAT IS THE FIX, NOT A LOOSENING ────────────
The floor asks "are payments failing SYSTEMICALLY?" Stripe's dunning answers a different
question very loudly: one unpaid card produces a fresh `invoice.payment_failed` on attempt 1,
attempt 2, attempt 3 …, plus a `payment_intent.payment_failed` and a `charge.failed` for the
same money. Any per-EVENT unit therefore reports a systemic outage on the third retry of a
single customer.

MEASURED on the live account 2026-08-22 — the whole 30-day table, 6 rows:

  cus_REDACTED-A · sub_REDACTED · in_REDACTED · pi_REDACTED       <- ONE of each
    2 x invoice.payment_failed   (attempt_count 1 and 2, payment_intent_id NULL)
    2 x payment_intent.payment_failed
    2 x charge.failed

`COUNT(DISTINCT COALESCE(payment_intent_id, event_id))` scored that **3** — the PI, plus each
NULL-PI invoice retry falling back to its own event_id — and tripped `>= 3`. The COALESCE was
added so a NULL-PI row would not be silently DROPPED, which was right; but it substitutes a key
that GUARANTEES distinctness for exactly the row class that most needs deduping. True distinct
failing customers over the same window: **1**.

`customer` is the unifier across EVENT TYPES: measured on api_version `2026-03-25.dahlia`, it is
present on ALL THREE subscribed event types, while `invoice` is absent from the Charge and the
PaymentIntent and `payment_intent` is absent from the Invoice.

── 🛑 AND THEN THE UNIT MOVED ONE RUNG HIGHER AGAIN (2026-08-27) ───────────────────────────
The floor fired on "3 distinct customers". Two of those three were the SAME PHYSICAL CARD:
one keyed `card_ref`, two Stripe customer records created 48 MINUTES apart
with different emails, both `past_due`. One payer, counted twice; true distinct instruments 2,
which does not breach a floor of 3.

So the live unit is now the CARD FINGERPRINT — Stripe's stable per-card id, opaque and not a PAN.
Stripe inflates per PAYMENT (dunning), then per CUSTOMER RECORD (one person, many accounts); it
cannot inflate per CARD. That is what makes this the terminal rung rather than the next surprise.

All three units are computed and REPORTED on every run. The gaps are the diagnosis:
instruments→customers is DUPLICATE ACCOUNTS, customers→payments is DUNNING RETRIES.

── 🛑 AND THE THIRD RUNG IS NOT A UNIT AT ALL — IT IS THE PREDICATE (2026-09-07) ───────────
The floor fired on "3 distinct CARDS". Measured against live Stripe the same morning:

  card A  ->  1 customer, subscription ACTIVE, invoice PAID at 22:45, attempt 0.
              They signed up at 22:33, the card declined 6 times in 3 minutes
              (insufficient_funds, then a mistyped CVC), they retried, and CONVERTED one
              minute after the last decline. NOT A FAILURE. It is a SUCCESSFUL SIGNUP.
  card B  ->  2 customer records on one card: one ACTIVE (invoice paid, attempt 4), one
              PAST_DUE (invoice open, attempt 6). First failure 12 days before the window.
  card C  ->  1 customer, PAST_DUE, invoice open at attempt 9, first failure 51 days before
              the window, last dunning retry 6 days before the run.

TRUE payers with money stuck: 2 — both of them old news, neither of them new. The floor said
3 and the third was a paying customer.

── WHY TWO PRIOR "TERMINAL UNIT" FIXES DID NOT CATCH IT ────────────────────────────────
Both prior rungs narrowed the KEY (payment -> customer -> card). Neither touched the
PREDICATE, which has always been:

    count(DISTINCT key) WHERE the key EMITTED a failure event inside a trailing window

That predicate answers "which cards emitted a decline this week". It is READ as "which cards
ARE failing". Those are different questions, and the gap between them has two mouths:

  (a) NO RECOVERY. A card that declined and then SUCCEEDED still satisfies "emitted a
      decline in the window". `stripe_payment_failures` contains only failures, so the
      instrument is STRUCTURALLY INCAPABLE of representing a recovery. Same class as every
      other instrument in this estate that returned a confident number about a thing it
      could not observe.
  (b) PERSISTENCE READS AS RECURRENCE. Stripe dunning retries a single failed invoice for
      weeks, so one chronic card re-enters EVERY trailing window forever. Measured in the
      observation ledger: `failures_7d` sat at exactly 2 for TEN consecutive days
      (08-28 -> 09-06) with no new failure in the world. The floor therefore carried a
      permanent PEDESTAL of 2 and a threshold nominally set at 3 actually fired on the
      FIRST new decline. The number 3 had been silently de-rated to 1.

── THE FIX: DERIVE THE UNIVERSE FROM THE BOOK, NOT FROM THE FAILURE WINDOW ─────────────
The universe is now `subscriber_profiles` — every payer we have — LEFT JOINED to the failure
table for card attribution, never the reverse. This inversion is the whole wave:

  * It is LEVEL-triggered, not edge-triggered. "3 payers currently have money stuck" is true
    on every run until it stops being true, so a missed run, a cron skip, a host reboot or a
    cooldown-suppressed delivery costs a day and never costs the page.
  * A payer Stripe has STOPPED retrying (`unpaid` — invoices keep generating, collection is
    abandoned, access is still granted) emits no further events BY DEFINITION. Under the old
    window-derived universe the worst accounts in the book were exactly the ones that fell
    out of it. Measured: card C's last retry was 09-01 03:04, so on 09-08 07:53 it would
    have left the canary's universe entirely — not RECOVERED, not CHRONIC, ABSENT — while
    owing 51 days of money. Deriving from the book makes that structurally impossible.
  * "Recovered" is no longer inferred from silence. Silence is what a dead account sounds
    like. Recovery is a POSITIVE status.

NEW / CHRONIC is now a REPORTED DECOMPOSITION, never the predicate. Keying the alarm on
"first-ever failure inside the window" was considered and REJECTED: a card is eligible for
that exactly once in its life, `stripe_payment_failures` has no pruning path, and 3 of the 4
cards ever observed were already permanently ineligible on the day it would have shipped.
That is not a narrowed floor, it is an unreachable one — the same "decoration that pages
nobody and reassures everybody" this module's header forbids 40 lines above.

── AND THE STATUS VOCABULARY IS ITS OWN CONSTANT, DELIBERATELY NOT THE SHARED ONE ──────
`src/lib/stripe.ts` SUBSCRIPTION_STATUS_CLASS maps `unpaid -> NOT_ENTITLED`, because it
answers "may this caller use the API". This canary asks "is any money stuck", and `unpaid`
is STRICTLY WORSE than `past_due`: Stripe has exhausted retries and the debt stands.
Importing that map would silently drop `unpaid` out of the stuck set and re-create the exact
silence this wave exists to remove. The single-derivation rule does NOT apply across two
different questions; the self-test asserts the two tables DIFFER on `unpaid` so a future
"de-duplication" cannot quietly merge them.

Verdict token: every run prints exactly one terminal `PAYMENT_DECLINE_VERDICT=` line.
Exit codes: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE.
  3 is the token-law DEFAULT for a NEW gate. The sibling `check-stripe-webhook-events.mjs`
  uses 2 for its own "canary infra error" — a DIFFERENT meaning in a different script, and
  nothing reads both code spaces, so the two must NOT be "aligned".

Fail-open: an unreadable DB never crashes the run — but it emits INDETERMINATE and ESCALATES,
because a canary that cannot see is indistinguishable from a healthy one at exit 0, and that
is the dark-guard class this estate has now been bitten by five times.

5th+ consumer of `send_telegram.sh`; it does NOT re-implement severity / cooldown / DRY_RUN /
fail-open — the wrapper owns those. Use `ALGOVAULT_TG_TEST_INERT=1` for repeated gate runs:
`DRY_RUN_TG=1` still WRITES the 24h cooldown marker, so a second dry run false-greens.

Usage:
  payment-decline-canary.py                 # live run
  payment-decline-canary.py --self-test     # hermetic scenario suite (no DB, no wrapper)
  payment-decline-canary.py --show-config   # print resolved config (seam-visibility)
"""
import argparse
import calendar
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time

ALERT_ID = "PAYMENT_DECLINE_DRIFT"
# Template form per CLAUDE.md (a hardcoded recommended_wave is FORBIDDEN); send_telegram.sh
# resolves {NEXT} from status.md at send time.
RECOMMENDED_WAVE = "OPS-PAYMENT-DECLINE-W{NEXT}"
WRAPPER = "/opt/algovault-monitoring/send_telegram.sh"

PG_CONTAINER = os.environ.get("ALGOVAULT_PG_CONTAINER", "crypto-quant-signal-mcp-postgres-1")
PG_DB = os.environ.get("ALGOVAULT_PG_DB", "signal_performance")
LEDGER = os.environ.get("ALGOVAULT_PAYMENT_DECLINE_LEDGER", "/var/lib/algovault-payment-decline/observations.jsonl")

# ── Thresholds ──────────────────────────────────────────────────────────────────────────
MIN_N = int(os.environ.get("ALGOVAULT_PAYMENT_DECLINE_MIN_N", "20"))
FLOOR_FAILURES = int(os.environ.get("ALGOVAULT_PAYMENT_DECLINE_FLOOR", "3"))
FLOOR_WINDOW_DAYS = 7
RATE_WINDOW_DAYS = 30
# PLACEHOLDER — see the module header. Structurally cannot fire below MIN_N.
DECLINE_RATE_PCT_MAX = float(os.environ.get("ALGOVAULT_PAYMENT_DECLINE_RATE_MAX", "40"))

EXIT_PASS, EXIT_FAIL, EXIT_INDETERMINATE = 0, 1, 3

CANARY_NAME = "payment-decline-canary"
# Bumped whenever the LIVE PREDICATE changes meaning. Stamped on every ledger row so a series
# is never silently compared across two instruments.
PREDICATE_VERSION = 2


def log(msg):
    sys.stderr.write("[payment-decline-canary] %s\n" % msg)


# ── Pure query builders + parser ────────────────────────────────────────────────────────
# Extracted as pure functions ON PURPOSE. A hermetic --self-test replaces the DB seam, which
# makes the SQL and the row parser the ONLY code no scenario ever executes — exactly where the
# bugs live (a sibling canary shipped with 26 green assertions and died on its FIRST live run
# inside its own bypassed parser). The self-test asserts these artifacts directly.

def build_failure_count_query(days):
    """Distinct FAILING PAYMENT INSTRUMENTS in a window — the unit the floor actually means.

    The COALESCE chain is ordered by how much deduplication each key buys, strongest first:

      card_ref  one row per CARD — immune to retries, to the dual-event fan-out, AND to
                        one person holding several Stripe customer records
      customer_id       one row per customer record (rows whose event carried no card)
      payment_intent_id one row per payment          (pre-linkage rows)
      event_id          one row per event            (last resort; never DROP an unkeyable row)

    🛑 WHY THE UNIT MOVED AGAIN, AND WHY THIS IS THE LAST RUNG. Measured 2026-08-27: the floor
    fired on "3 distinct customers", and two of those three were the SAME PHYSICAL CARD —
    one keyed `card_ref`, two Stripe customer records created 48 minutes
    apart with different emails. One payer, counted twice. True distinct instruments: 2, which
    does not breach a floor of 3.

    This is the same defect the customer unit fixed, one rung higher. Stripe inflates per PAYMENT
    (dunning retries), then per CUSTOMER RECORD (one person can hold many). It cannot inflate per
    CARD: the fingerprint is stable across customers, tokens and PaymentMethods by construction,
    which is precisely what makes it the terminal unit rather than the next thing to be surprised
    by.

    ── THE FINGERPRINT IS RESOLVED PER CUSTOMER, NOT PER ROW, AND THAT IS LOAD-BEARING ────────
    `invoice.payment_failed` carries NO card node (measured on api_version 2026-03-25.dahlia: the
    Invoice exposes only an unexpanded `default_payment_method`), so an invoice row's own
    fingerprint is always NULL. A per-ROW COALESCE would therefore fall back to `customer_id` for
    exactly those rows and re-split the two customer records that share a card — fixing nothing.

    So the fingerprint is joined in from the SAME CUSTOMER's card-bearing rows. `DISTINCT ON`
    pins one fingerprint per customer (the most recent), because a customer who has failed on two
    different cards would otherwise fan the join out and re-inflate the very count this exists to
    deflate — over-counting is the wrong direction for a floor whose false alarms are the bug.
    """
    if not isinstance(days, int) or days <= 0:
        raise ValueError("days must be a positive int, got %r" % (days,))
    return (
        "WITH fp AS ("
        "SELECT DISTINCT ON (customer_id) customer_id, card_ref "
        "FROM stripe_payment_failures "
        "WHERE customer_id IS NOT NULL AND coalesce(trim(card_ref),'') <> '' "
        "ORDER BY customer_id, occurred_at DESC"
        ") "
        "SELECT COUNT(DISTINCT COALESCE(fp.card_ref, f.customer_id, "
        "f.payment_intent_id, f.event_id)) "
        "FROM stripe_payment_failures f "
        "LEFT JOIN fp ON fp.customer_id = f.customer_id "
        "WHERE f.occurred_at >= NOW() - INTERVAL '%d days'" % days
    )


def build_customer_count_query(days):
    """The PREVIOUS unit — distinct customer RECORDS — kept and reported beside the new one.

    Two prior units now ship alongside the live one, and neither is decoration: the gap between
    instruments and customers is DUPLICATE ACCOUNTS, the gap between customers and payments is
    DUNNING RETRIES. Two different facts about the same failures, each invisible without its
    counterpart, and both would have been silently lost had the unit simply been swapped.
    """
    if not isinstance(days, int) or days <= 0:
        raise ValueError("days must be a positive int, got %r" % (days,))
    return (
        "SELECT COUNT(DISTINCT COALESCE(customer_id, payment_intent_id, event_id)) "
        "FROM stripe_payment_failures "
        "WHERE occurred_at >= NOW() - INTERVAL '%d days'" % days
    )


def build_payment_count_query(days):
    """The PRIOR unit, kept and REPORTED beside the new one — never silently replaced.

    A threshold change that quietly redefines its own metric is unauditable: the operator would
    see the alert stop without being able to tell whether the world improved or the ruler was
    swapped. Both numbers ship in the facts, in the log line and in the alert body, so the gap
    between them IS the retry-inflation, visible on every run.
    """
    if not isinstance(days, int) or days <= 0:
        raise ValueError("days must be a positive int, got %r" % (days,))
    return (
        "SELECT COUNT(DISTINCT COALESCE(payment_intent_id, event_id)) "
        "FROM stripe_payment_failures "
        "WHERE occurred_at >= NOW() - INTERVAL '%d days'" % days
    )


def build_success_count_query(days):
    """Converted customers in a window — the other half of the denominator."""
    if not isinstance(days, int) or days <= 0:
        raise ValueError("days must be a positive int, got %r" % (days,))
    return (
        "SELECT COUNT(*) FROM subscriber_profiles "
        "WHERE converted_at >= NOW() - INTERVAL '%d days'" % days
    )


def parse_count(raw):
    """Parse psql -tA scalar output. Returns None when unparseable — the caller default-denies.

    `psql -tA` yields a bare number plus a trailing newline; an empty result set yields an
    empty string, which is NOT zero — it is 'no answer' — and must not silently become 0.
    """
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    first = text.splitlines()[0].strip()
    if not first or not first.lstrip("-").isdigit():
        return None
    return int(first)


# ── Subscription-status vocabulary — EXHAUSTIVE over Stripe's documented enum ────────────
# Source: https://docs.stripe.com/api/subscriptions/object — "Possible values are `incomplete`,
# `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, or `paused`."
# Verified against api_version 2026-03-25.dahlia. There is NO default branch: a status outside
# this union becomes PAYER_UNKNOWN, which COUNTS toward the floor. An unregistered case must
# fail toward NOISE, never toward silence.
STATUS_HEALTHY = frozenset({"active", "trialing"})
# `unpaid` is here and it is the important one. Stripe stops attempting payment, keeps
# generating invoices, and STILL GRANTS ACCESS — the money is maximally stuck, not resolved.
STATUS_MONEY_STUCK = frozenset({"past_due", "unpaid"})
# `incomplete` is the state a normal signup occupies for up to 23h while its first payment
# confirms — card A sat in it for 3 minutes on 2026-09-06 before converting. Bucketing it as
# stuck would make every declined-then-succeeded checkout page us.
STATUS_NOT_STARTED = frozenset({"incomplete", "incomplete_expired"})
# Churn, voluntary or deliberate. A different alarm's business; counting it here would latch
# every lapsed customer into the floor forever.
STATUS_ENDED = frozenset({"canceled", "paused"})
STRIPE_STATUSES = STATUS_HEALTHY | STATUS_MONEY_STUCK | STATUS_NOT_STARTED | STATUS_ENDED

# Row-level sentinels the SQL emits so a NULL can never render as an empty field. `psql -tA`
# prints NULL and '' identically, and the contract must live in the OUTPUT, not in a flag on
# the invocation that somebody can edit away.
SENTINEL_NO_PROFILE = "NO_PROFILE"      # decline rows exist, no subscriber_profiles row
SENTINEL_NULL_STATUS = "NULL_STATUS"    # profile row present, status column NULL
SENTINEL_EMPTY_STATUS = "EMPTY_STATUS"  # profile row present, status blank

# Terminal payer states. STUCK / UNATTRIBUTED / UNKNOWN are the three that count.
PAYER_STUCK = "STUCK"
PAYER_HEALTHY = "HEALTHY"
PAYER_NOT_STARTED = "NOT_STARTED"
PAYER_ENDED = "ENDED"
PAYER_UNATTRIBUTED = "UNATTRIBUTED"     # decline rows, no profile row — cannot prove recovery
PAYER_UNKNOWN = "UNKNOWN"               # status outside the Stripe enum — fail toward noise
COUNTED_STATES = (PAYER_STUCK, PAYER_UNATTRIBUTED, PAYER_UNKNOWN)

PAYER_ROW_FIELDS = ("payer_key", "customer_id", "status_token", "first_seen", "last_seen", "events")
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_PAYER_KEY_RE = re.compile(r"^(card:[A-Za-z0-9:_.-]{1,128}|cus:[A-Za-z0-9_-]{1,128}|__[a-z0-9]+__)$")
_STATUS_TOKEN_RE = re.compile(r"^(CENSUS|EPOCH0|LINKAGE|NO_PROFILE|NULL_STATUS|EMPTY_STATUS|[a-z_?]{1,64})$")


def build_payer_state_query():
    """One row per PAYER IN THE BOOK, plus three unconditional sentinel rows.

    🛑 THE JOIN DIRECTION IS THE WHOLE FIX. The universe is `subscriber_profiles` (every payer
    we have) LEFT JOINED to `stripe_payment_failures` for card attribution — never the reverse.
    A window over the failure table cannot see a payer Stripe has stopped retrying, which is
    precisely the worst account in any book.

    Deliberate properties, each of which an assertion pins:

    * NO `NOW()`, NO `INTERVAL`, NO `LIMIT`. Every clock lives in Python so the hermetic suite
      can move the window boundary, and an uncapped read can never be aggregated over a
      LIMIT-truncated collection.
    * NO `ORDER BY` at the top level. Sentinels are found by their status token, never by
      position — a load-bearing property must not be rented from row order.
    * `card_of` carries `event_id DESC` as a tiebreak. Measured live: four customers each have
      3-9 card-bearing rows sharing one `occurred_at` to the second, so `DISTINCT ON` without a
      tiebreak resolves arbitrarily. All four happen to carry ONE card today, so the ambiguity
      is real and currently invisible — which is exactly when to fix it.
    * `occurred_at > TIMESTAMPTZ '1971-01-01'` excludes epoch-0 rows. `recordPaymentFailure`
      falls back to `new Date(0)` when Stripe sends no `created`, and one such row would pin its
      payer's first-failure to 1970 and read CHRONIC forever. Zero exist today; the sentinel
      row REPORTS the count so the exclusion is never silent.
    * `subscriber_profiles.customer_id` is the table's PRIMARY KEY (verified live), so the join
      cannot fan out and the row count equals the book size. The census sentinel proves it.
    """
    return (
        "WITH card_of AS ("
        "SELECT DISTINCT ON (customer_id) customer_id, card_ref "
        "FROM stripe_payment_failures "
        "WHERE customer_id IS NOT NULL AND coalesce(trim(card_ref),'') <> '' "
        "AND occurred_at > TIMESTAMPTZ '1971-01-01' "
        "ORDER BY customer_id, occurred_at DESC, event_id DESC"
        "), fails AS ("
        "SELECT customer_id, min(occurred_at) AS first_seen, max(occurred_at) AS last_seen, "
        "count(*) AS events FROM stripe_payment_failures "
        "WHERE customer_id IS NOT NULL AND occurred_at > TIMESTAMPTZ '1971-01-01' "
        "GROUP BY customer_id"
        "), book AS ("
        "SELECT customer_id, status, 'PROFILE' AS src FROM subscriber_profiles "
        "UNION ALL "
        "SELECT f.customer_id, NULL, 'ORPHAN' FROM fails f "
        "LEFT JOIN subscriber_profiles s ON s.customer_id = f.customer_id "
        "WHERE s.customer_id IS NULL"
        ") "
        "SELECT '__census__', '-', 'CENSUS', '-', '-', (SELECT count(*) FROM book)::text "
        "UNION ALL "
        "SELECT '__epoch0__', '-', 'EPOCH0', '-', '-', "
        "(SELECT count(*) FROM stripe_payment_failures "
        "WHERE occurred_at <= TIMESTAMPTZ '1971-01-01')::text "
        "UNION ALL "
        "SELECT '__linkage__', '-', 'LINKAGE', "
        "coalesce(to_char((SELECT min(occurred_at) FROM stripe_payment_failures "
        "WHERE coalesce(trim(card_ref),'') <> '' AND occurred_at > TIMESTAMPTZ '1971-01-01') "
        "AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '-'), '-', '0' "
        "UNION ALL "
        "SELECT CASE WHEN c.card_ref IS NOT NULL THEN 'card:' || c.card_ref "
        "ELSE 'cus:' || b.customer_id END, "
        "b.customer_id, "
        "CASE WHEN b.src = 'ORPHAN' THEN '" + SENTINEL_NO_PROFILE + "' "
        "WHEN b.status IS NULL THEN '" + SENTINEL_NULL_STATUS + "' "
        "WHEN trim(b.status) = '' THEN '" + SENTINEL_EMPTY_STATUS + "' "
        "ELSE regexp_replace(lower(trim(b.status)), '[^a-z_]', '?', 'g') END, "
        "coalesce(to_char(f.first_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '-'), "
        "coalesce(to_char(f.last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '-'), "
        "coalesce(f.events, 0)::text "
        "FROM book b "
        "LEFT JOIN card_of c ON c.customer_id = b.customer_id "
        "LEFT JOIN fails f ON f.customer_id = b.customer_id"
    )


def parse_payer_rows(raw):
    """Parse the multi-row psql output. RAISES on anything it cannot fully account for.

    🛑 A FLOOR MUST NEVER DROP A ROW. `outcome-backfill-freshness` can `continue` past a bad row
    because its metric is a lag; here a dropped row LOWERS the count and SILENCES the alarm, so
    every malformation is refused wholesale and becomes INDETERMINATE. Partial answers are the
    fail-toward-silence direction and are forbidden.

    Returns (sentinels, payers) — sentinels keyed by token, payers a list of dicts.
    """
    if raw is None:
        raise ValueError("no output")
    lines = [ln for ln in raw.splitlines() if ln.strip()]
    if not lines:
        # NOT vacuity: the three sentinel rows are unconditional, so an empty result can only
        # mean the query did not run. An empty BOOK still renders three sentinels.
        raise ValueError("empty result set (the sentinel rows are unconditional)")
    sentinels, payers = {}, []
    for ln in lines:
        parts = ln.split("|")
        if len(parts) != len(PAYER_ROW_FIELDS):
            raise ValueError("row has %d fields, expected %d" % (len(parts), len(PAYER_ROW_FIELDS)))
        row = dict(zip(PAYER_ROW_FIELDS, parts))
        for k, v in row.items():
            if v == "":
                raise ValueError("empty field %r (a NULL must arrive as a sentinel)" % k)
        if not _PAYER_KEY_RE.match(row["payer_key"]):
            raise ValueError("unparseable payer_key %r" % row["payer_key"][:40])
        if not _STATUS_TOKEN_RE.match(row["status_token"]):
            raise ValueError("unparseable status token %r" % row["status_token"][:40])
        if not (row["events"].isascii() and row["events"].isdigit()):
            # `.isdigit()` alone accepts non-ASCII digits — '٣' parses as 3.
            raise ValueError("unparseable event count %r" % row["events"][:20])
        row["events"] = int(row["events"])
        for stamp in ("first_seen", "last_seen"):
            if row[stamp] != "-" and not _ISO_RE.match(row[stamp]):
                raise ValueError("unparseable %s %r" % (stamp, row[stamp][:40]))
        if row["payer_key"].startswith("__"):
            sentinels[row["status_token"]] = row
        else:
            payers.append(row)
    for required in ("CENSUS", "EPOCH0", "LINKAGE"):
        if required not in sentinels:
            raise ValueError("sentinel row %s absent — the read was truncated" % required)
    if sentinels["CENSUS"]["events"] != len(payers):
        # The uncapped-read proof: any silently dropped row fails here.
        raise ValueError("census says %d payers, parsed %d"
                         % (sentinels["CENSUS"]["events"], len(payers)))
    return sentinels, payers


def _epoch(iso):
    """`YYYY-MM-DDTHH:MM:SSZ` -> epoch seconds. 3.9-safe; no `datetime.UTC`."""
    return calendar.timegm(time.strptime(iso, "%Y-%m-%dT%H:%M:%SZ"))


def classify_status(token):
    """One status token -> one terminal payer state. EXHAUSTIVE, no default branch."""
    if token == SENTINEL_NO_PROFILE:
        return PAYER_UNATTRIBUTED
    if token in (SENTINEL_NULL_STATUS, SENTINEL_EMPTY_STATUS):
        return PAYER_UNKNOWN
    if token in STATUS_HEALTHY:
        return PAYER_HEALTHY
    if token in STATUS_MONEY_STUCK:
        return PAYER_STUCK
    if token in STATUS_NOT_STARTED:
        return PAYER_NOT_STARTED
    if token in STATUS_ENDED:
        return PAYER_ENDED
    return PAYER_UNKNOWN


def classify_payers(payers, now_epoch, floor_window_days=None):
    """Pure. Fold per-customer rows into per-PAYER-KEY state. No I/O, no clock of its own.

    Two customer records sharing one card collapse to ONE payer key, which is the whole point
    of the card unit and is retained from the prior rung. The fold is WORST-WINS: a key with any
    stuck customer on it is stuck. `classifyCustomerSubscriptions` in src/ folds BEST-wins
    because it answers "may I serve this caller"; reusing it here would read a card carrying one
    active and one past_due record as healthy, which is a live shape on this book today.
    """
    window_days = FLOOR_WINDOW_DAYS if floor_window_days is None else floor_window_days
    rank = {PAYER_STUCK: 5, PAYER_UNKNOWN: 4, PAYER_UNATTRIBUTED: 3,
            PAYER_NOT_STARTED: 2, PAYER_ENDED: 1, PAYER_HEALTHY: 0}
    keys = {}
    for row in payers:
        state = classify_status(row["status_token"])
        k = row["payer_key"]
        e = keys.setdefault(k, {"key": k, "state": PAYER_HEALTHY, "customers": [],
                                "first_seen": None, "events": 0, "statuses": []})
        if rank[state] > rank[e["state"]]:
            e["state"] = state
        e["customers"].append(row["customer_id"])
        e["statuses"].append(row["status_token"])
        e["events"] += row["events"]
        if row["first_seen"] != "-":
            fs = _epoch(row["first_seen"])
            e["first_seen"] = fs if e["first_seen"] is None else min(e["first_seen"], fs)
    out = []
    for e in keys.values():
        e["customers"] = sorted(set(e["customers"]))
        e["statuses"] = sorted(set(e["statuses"]))
        if e["first_seen"] is None:
            e["age_days"], e["onset"] = None, "UNDATED"
        else:
            e["age_days"] = round((now_epoch - e["first_seen"]) / 86400.0, 1)
            e["onset"] = "NEW" if e["age_days"] <= window_days else "CHRONIC"
        e["counts"] = e["state"] in COUNTED_STATES
        out.append(e)
    # Sorted by age so the body's worst account leads. Never relied on for correctness.
    out.sort(key=lambda x: (-1 if x["age_days"] is None else -x["age_days"], x["key"]))
    return out


def classify(payer_states, successes_30d, failures_30d=None, failures_7d=None,
             payments_7d=None, payments_30d=None, customers_7d=None, customers_30d=None,
             book_size=None, epoch0_rows=0, linkage_epoch=None):
    """Pure verdict. Returns (verdict, reasons, facts) — no I/O, no clock.

    SINGLE DERIVATION: `payer_states` (from `classify_payers`) is the one value. The floor, the
    decomposition, the body and the ledger are all PROJECTIONS of it, so they cannot disagree.

    The three PRIOR units (`failures_7d` cards-that-emitted / `customers_7d` / `payments_7d`)
    are carried for REPORTING and for ledger continuity, never predicated on. A threshold change
    that quietly redefines its own metric is unauditable, and that rule applies to this wave's
    own change too: the ledger keeps writing the old series under the old name.
    """
    stuck = [p for p in payer_states if p["counts"]]
    facts = {
        "predicate_version": PREDICATE_VERSION,
        "failure_unit": "payers with money stuck (card-keyed, book-derived)",
        "stuck_payers": len(stuck),
        "book_size": book_size if book_size is not None else len(payer_states),
        "new_stuck": sum(1 for p in stuck if p["onset"] == "NEW"),
        "chronic_stuck": sum(1 for p in stuck if p["onset"] == "CHRONIC"),
        "undated_stuck": sum(1 for p in stuck if p["onset"] == "UNDATED"),
        "unattributed": sum(1 for p in payer_states if p["state"] == PAYER_UNATTRIBUTED),
        "unknown_status": sum(1 for p in payer_states if p["state"] == PAYER_UNKNOWN),
        "recovered_7d": sum(1 for p in payer_states
                            if not p["counts"] and p["events"] > 0 and p["onset"] == "NEW"),
        "epoch0_rows": epoch0_rows,
        "linkage_epoch": linkage_epoch,
        "floor_threshold": FLOOR_FAILURES,
        # ── prior units, reported only ──
        "failures_7d": failures_7d,
        "failures_30d": failures_30d,
        "payments_7d": payments_7d,
        "payments_30d": payments_30d,
        "customers_7d": customers_7d,
        "customers_30d": customers_30d,
        "successes_30d": successes_30d,
        "min_n": MIN_N,
    }
    n = successes_30d + (failures_30d or 0)
    facts["n_30d"] = n
    facts["rate_predicate"] = "ACTIVE" if n >= MIN_N else "INERT (n < MIN_N)"
    facts["decline_rate_pct_30d"] = (round((failures_30d or 0) * 100.0 / n, 1) if n > 0 else None)
    facts["stuck_keys"] = [p["key"] for p in stuck]
    facts["stuck_customer_ids"] = sorted({c for p in stuck for c in p["customers"]})
    reasons = []

    # ── THE LIVE PREDICATE. Level-triggered: true on every run until it stops being true. ──
    if len(stuck) >= FLOOR_FAILURES:
        reasons.append(
            "ABSOLUTE FLOOR breached: %d payers currently have money stuck (threshold >= %d)"
            % (len(stuck), FLOOR_FAILURES)
        )

    # Rate predicate — structurally inert below MIN_N. Unchanged.
    if n >= MIN_N and facts["decline_rate_pct_30d"] is not None:
        if facts["decline_rate_pct_30d"] > DECLINE_RATE_PCT_MAX:
            reasons.append(
                "DECLINE RATE %.1f%% over Last %dd exceeds %.1f%% (n=%d: %d failing instruments / "
                "%d converted)"
                % (facts["decline_rate_pct_30d"], RATE_WINDOW_DAYS, DECLINE_RATE_PCT_MAX,
                   n, failures_30d or 0, successes_30d)
            )

    return ("FAIL" if reasons else "PASS"), reasons, facts


def _n(v):
    """Render an ABSENT number as '-', never as 0. A count we do not have is not a count of 0."""
    return "-" if v is None else str(v)


def _plural(n, singular, plural=None):
    """Pluralise a NOUN from an ID COUNT.

    An entity id in an alert body carries its entity noun, and a bare parenthesised number next
    to a count is forbidden — `1 subscription(s) disabled (new: 6)` was read as SIX
    subscriptions when there were two. This is the shared helper so no caller re-derives it.
    """
    return singular if n == 1 else (plural or singular + "s")


def render_payer_line(p):
    """One payer, rendered with every id carrying its entity noun and an actionable handle.

    🛑 `payer_key` is `card:v1:<hex>` — a KEYED PSEUDONYM (HMAC of the card fingerprint), not a
    reversible value. It is safe to render and safe to commit, and it is USELESS to an operator:
    it cannot be pasted into the Stripe dashboard. The `cus_…` id is the only handle that
    resolves to an action, so it is REQUIRED in the body alongside a dashboard link. Email and
    name are never rendered — the dashboard shows those to whoever is already authorised.
    """
    ids = p["customers"]
    head = "  %-12s %s — %s %s" % (
        p["state"], p["key"], _plural(len(ids), "customer id"), ", ".join(ids))
    if len(ids) > 1:
        head += " — %d customer records on 1 card" % len(ids)
    bits = []
    if p["age_days"] is not None:
        bits.append("first failure %.1f days ago (%s)" % (p["age_days"], p["onset"]))
    else:
        bits.append("no dated failure row (UNDATED)")
    bits.append("%d decline %s" % (p["events"], _plural(p["events"], "event")))
    bits.append("status %s" % "/".join(p["statuses"]))
    lines = [head, "      " + " · ".join(bits)]
    for cid in ids:
        lines.append("      https://dashboard.stripe.com/customers/%s" % cid)
    return "\n".join(lines)


def flatten_payer_line(rendered):
    """Collapse a multi-line payer render into ONE log line, preserving field boundaries.

    Strips each line's own indent rather than deleting any run of six spaces. The naive
    `.replace("      ", "")` ate the state column's `%-12s` padding and produced
    `HEALTHYcard:v1:…` — cosmetic here, but the same edit silently deletes any six-space run
    that ever appears inside a rendered value, which is a content bug wearing a formatting bug's
    clothes. Caught on the first live host run, not by a unit assertion, which is why it now has
    one.
    """
    return " | ".join(ln.strip() for ln in rendered.splitlines() if ln.strip())


def build_body(reasons, facts, payer_states=None):
    lines = ["🛑 %s" % ALERT_ID]
    lines.extend(reasons)
    lines.append(
        "%d of %d payers in the book have money stuck — %d new (first failure inside %dd), "
        "%d chronic, %d undated."
        % (facts["stuck_payers"], facts["book_size"], facts["new_stuck"], FLOOR_WINDOW_DAYS,
           facts["chronic_stuck"], facts["undated_stuck"])
    )
    if payer_states:
        counted = [p for p in payer_states if p["counts"]]
        if counted:
            lines.append("Payers with money stuck — %s:"
                         % _plural(len(counted), "1 payer", "%d payers" % len(counted)))
            for p in counted:
                lines.append(render_payer_line(p))
        shown = [p for p in payer_states
                 if not p["counts"] and p["events"] > 0 and p["onset"] == "NEW"]
        if shown:
            lines.append("Declined inside the window but NOT counted — recovered, %s:"
                         % _plural(len(shown), "1 payer", "%d payers" % len(shown)))
            for p in shown:
                lines.append(render_payer_line(p))
    lines.append(
        "The floor counts PAYERS WHOSE MONEY IS STUCK RIGHT NOW, derived from the subscriber "
        "book and not from a window over the failure table. A card that declined and then paid "
        "is not stuck; a payer Stripe has stopped retrying still is."
    )
    lines.append(
        "Prior units, %dd / %dd (reported, never predicated on): cards that emitted a decline "
        "%s / %s · customer records %s / %s · distinct payments %s / %s"
        % (FLOOR_WINDOW_DAYS, RATE_WINDOW_DAYS,
           _n(facts.get("failures_7d")), _n(facts.get("failures_30d")),
           _n(facts.get("customers_7d")), _n(facts.get("customers_30d")),
           _n(facts.get("payments_7d")), _n(facts.get("payments_30d")))
    )
    lines.append(
        "Facts — Last %dd: n=%d (%d converted + %d failing cards) · rate=%s · rate predicate %s"
        % (RATE_WINDOW_DAYS, facts["n_30d"], facts["successes_30d"], facts["failures_30d"] or 0,
           ("%.1f%%" % facts["decline_rate_pct_30d"])
           if facts["decline_rate_pct_30d"] is not None else "unmeasured",
           facts["rate_predicate"])
    )
    if facts.get("unattributed"):
        lines.append(
            "⚠️ %d %s decline rows but NO subscriber_profiles row, so recovery cannot be proven "
            "and they COUNT toward the floor. Generator: handleSubscriptionCreated mints an API "
            "key without writing a profile row."
            % (facts["unattributed"], _plural(facts["unattributed"], "payer has", "payers have")))
    if facts.get("unknown_status"):
        lines.append(
            "⚠️ %d %s a subscription status outside Stripe's documented enum; they COUNT toward "
            "the floor rather than being assumed healthy."
            % (facts["unknown_status"], _plural(facts["unknown_status"], "payer carries", "payers carry")))
    if facts.get("epoch0_rows"):
        lines.append(
            "⚠️ %d failure %s an epoch-0 timestamp and %s excluded from every age above."
            % (facts["epoch0_rows"], _plural(facts["epoch0_rows"], "row carries", "rows carry"),
               _plural(facts["epoch0_rows"], "was", "were")))
    lines.append("Action: dispatch %s via Cowork → Claude Code" % RECOMMENDED_WAVE)
    return "\n".join(lines)


# ── I/O seams ───────────────────────────────────────────────────────────────────────────

def _psql(sql):
    args = ["docker", "exec", PG_CONTAINER, "psql", "-U", _pg_role(), "-d", PG_DB, "-tA", "-c", sql]
    out = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % out.stderr.strip()[:200])
    return out.stdout


def _pg_role():
    """Read POSTGRES_USER from the container at runtime — never hardcode a role."""
    out = subprocess.run(["docker", "exec", PG_CONTAINER, "printenv", "POSTGRES_USER"],
                         capture_output=True, text=True, timeout=15)
    role = out.stdout.strip()
    if not role:
        raise RuntimeError("could not resolve POSTGRES_USER from %s" % PG_CONTAINER)
    return role


def append_observation(facts, verdict, path=None):
    """Append the observed counts. Best-effort: a ledger write must never change the verdict.

    🛑 `failures_7d` KEEPS ITS OLD MEANING — cards that EMITTED a decline in 7d — and the new
    predicate's counts are ADDED beside it under new names, every row stamped with
    `predicate_version`. Redefining a series in place would make the ten rows pinned at 2
    (08-28 -> 09-06) and every future row share one name for two instruments, and an operator
    reading the ledger after deploy would see the failing population collapse on the deploy date
    and conclude the world improved. The instrument travels beside the number.

    An INDETERMINATE run writes a row too. The new predicate can reach INDETERMINATE on ordinary
    data, and a hole in the series is indistinguishable from "the canary did not run".
    """
    target = path or LEDGER
    if path is None and os.environ.get("ALGOVAULT_CANARY_SELFTEST") == "1":  # ledger seam
        target = os.path.join(tempfile.gettempdir(), "payment-decline-canary-selftest-ledger.jsonl")
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        row = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "verdict": verdict, "predicate_version": PREDICATE_VERSION,
               "n_30d": facts.get("n_30d"), "successes_30d": facts.get("successes_30d"),
               "failures_30d": facts.get("failures_30d"), "failures_7d": facts.get("failures_7d"),
               "stuck_payers": facts.get("stuck_payers"), "book_size": facts.get("book_size"),
               "new_stuck": facts.get("new_stuck"), "chronic_stuck": facts.get("chronic_stuck"),
               "undated_stuck": facts.get("undated_stuck"),
               "unattributed": facts.get("unattributed"),
               "unknown_status": facts.get("unknown_status"),
               "recovered_7d": facts.get("recovered_7d"),
               "failure_unit": facts.get("failure_unit"),
               "min_n": facts.get("min_n"), "rate_predicate": facts.get("rate_predicate")}
        with open(target, "a") as fh:
            fh.write(json.dumps(row) + "\n")
    except Exception as exc:                                    # noqa: BLE001
        log("ledger append failed (non-fatal): %s" % exc)


def emit_result(verdict, exit_code, facts, path=None):
    """Publish the structured result so the run has a READER off-host.

    Until this wave the canary's only output was a stderr line on signal-1, reachable solely by
    someone with an SSH key. "We will report it in the log" is not a control when the log has no
    reader: `monitoring-results-sync.sh` pulls this file back into the vault, which is what makes
    a later readout a file read instead of a whole wave.

    `path` is a TEST SEAM: `canary_result_log` resolves its target at MODULE IMPORT time, so a
    later env change cannot steer it and the failure branch would otherwise be undrivable.
    """
    if path is None and os.environ.get("ALGOVAULT_CANARY_SELFTEST") == "1":  # results seam
        # 🛑 A SUITE MUST NOT WRITE PRODUCTION STATE. Caught by running this on the operator's
        # machine, where the append raised PermissionError and merely logged — on signal-1 it
        # would have SUCCEEDED and injected a synthetic record into the file
        # `monitoring-results-sync.sh` pulls into the vault. Redirect, never no-op: a self-test
        # that skips the call cannot prove the call works.
        path = os.path.join(tempfile.gettempdir(), "payment-decline-canary-selftest-results.jsonl")
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import canary_result_log  # noqa: PLC0415 — local + defensive; runs from /opt and a checkout
        metrics = {k: facts.get(k) for k in
                   ("stuck_payers", "book_size", "new_stuck", "chronic_stuck", "undated_stuck",
                    "unattributed", "unknown_status", "recovered_7d", "failures_7d",
                    "n_30d", "predicate_version", "floor_threshold")}
        ok, detail = canary_result_log.append_result(
            CANARY_NAME, verdict, exit_code, metrics, path=path)
        log("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail)
        return ok
    except Exception as exc:                                    # noqa: BLE001 — logging must never page
        log("CANARY_RESULT_LOG_FAILED=%s: %s" % (type(exc).__name__, exc))
        return False


_LAST_BODY = {"text": None}
_LAST_CLEAR = {"reason": None}
_LAST_ARGV = {"fire": None, "clear": None}

# 🛑 THE WRAPPER'S ARGV CONTRACT, WRITTEN ONCE AND ASSERTED.
#   send_telegram.sh <alert_id> <severity> [body_file|-]   # fire
#   send_telegram.sh --clear <alert_id> [reason]           # FIRING -> CLEAR
# The mode flag comes FIRST and the clear reason is POSITIONAL. Getting this wrong is silent:
# `send_telegram.sh <id> --clear` parses as a FIRE with severity `--clear`, and the wrapper
# answers `SUPPRESSED_SEVERITY: severity=--clear not in TG-fire set` at EXIT 0. Measured live
# 2026-09-07 09:27 and 09:28 — two runs logged "clear dispatched (rc=0)" while the cooldown
# marker sat untouched. A hermetic self-test is structurally blind to exactly what its own seam
# replaces, so the argv is captured and asserted rather than inferred from a return code.


def fire_argv():
    return [WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"]


def clear_argv(reason):
    return [WRAPPER, "--clear", ALERT_ID, reason]


def fire(body):
    _LAST_BODY["text"] = body
    argv = fire_argv()
    _LAST_ARGV["fire"] = argv
    if os.environ.get("ALGOVAULT_CANARY_SELFTEST") == "1":
        log("WOULD_FIRE: (self-test — wrapper skipped)")
        return
    try:
        subprocess.run(argv, input=body, capture_output=True, text=True, timeout=30)
    except Exception as exc:                                    # noqa: BLE001
        log("wrapper invocation failed (fail-open): %s" % exc)


def dispatch_clear(reason):
    """Close the episode on a PASS run.

    🛑 THE HIGHEST-VALUE LINE IN THIS WAVE, AND IT IS ONE SUBPROCESS CALL. `fire()` writes
    `$STATE_DIR/<ALERT_ID>-last-fired-at` and NOTHING here ever removed it, so the channel's last
    message stayed pinned to the worst thing that ever happened. That is the precise 70-hour
    incident `do_clear` was built for: post-recovery silence was indistinguishable from
    cooldown-suppressed failure, and from a dead reporter.

    `announce_resolution` is false for this alert and STAYS false — `do_clear` removes the marker
    in its SILENT branch too, so this repairs the STATE while emitting nothing, which is the
    recovery-chatter law unchanged rather than an exception to it.

    Sequencing note: wiring this WITHOUT the predicate fix would have shipped a lie. On the old
    predicate the 09-08 clear was a dunning retry ageing out of a rolling window, not a recovery.
    The two had to land together; neither alone is correct.
    """
    _LAST_CLEAR["reason"] = reason
    argv = clear_argv(reason)
    _LAST_ARGV["clear"] = argv
    if os.environ.get("ALGOVAULT_CANARY_SELFTEST") == "1":
        log("WOULD_CLEAR: %s (self-test — wrapper skipped)" % reason)
        return
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        # Report the MODE we asked for, not just a return code: this wrapper exits 0 on the
        # suppressed-fire path too, so "rc=0" was exactly the signal that hid the argv defect.
        log("clear dispatched: argv[1]=%s rc=%d%s"
            % (argv[1], out.returncode,
               (" stderr=" + out.stderr.strip()[:120]) if out.stderr.strip() else ""))
    except Exception as exc:                                    # noqa: BLE001
        log("clear invocation failed (fail-open): %s" % exc)


def indeterminate(detail, facts=None):
    """One exit path for every 'we could not verify'. Fires, ledgers, publishes, returns 3."""
    log("INDETERMINATE: %s" % detail)
    fire("🛑 %s\nCanary could not evaluate the subscriber book — decline monitoring is DARK.\n%s\n"
         "Action: dispatch %s via Cowork → Claude Code" % (ALERT_ID, str(detail)[:300], RECOMMENDED_WAVE))
    append_observation(facts or {}, "INDETERMINATE")
    emit_result("INDETERMINATE", EXIT_INDETERMINATE, facts or {})
    print("PAYMENT_DECLINE_VERDICT=INDETERMINATE")
    return EXIT_INDETERMINATE


def finish(verdict, reasons, facts, payer_states):
    """The terminal step: fire OR clear, publish, print the token, return the exit code.

    EXTRACTED so the self-test can drive it. Proven necessary: with this inlined in `main()`,
    deleting the `dispatch_clear` call left the suite at 114 passed / 0 failed, because the only
    clear assertion called `dispatch_clear` directly and therefore tested the FUNCTION while the
    defect was in the WIRING. An assertion that cannot see the call site cannot protect it.
    """
    if verdict == "FAIL":
        fire(build_body(reasons, facts, payer_states))
        emit_result("FAIL", EXIT_FAIL, facts)
        print("PAYMENT_DECLINE_VERDICT=FAIL")
        return EXIT_FAIL
    dispatch_clear("stuck payers %d < floor %d" % (facts["stuck_payers"], FLOOR_FAILURES))
    emit_result("PASS", EXIT_PASS, facts)
    print("PAYMENT_DECLINE_VERDICT=PASS")
    return EXIT_PASS


def main():
    try:
        sentinels, payer_rows = parse_payer_rows(_psql(build_payer_state_query()))
    except Exception as exc:                                    # noqa: BLE001
        # Fail-open in the sense that we do not crash — but a blind canary ESCALATES. An exit-0
        # here would be indistinguishable from a healthy run.
        return indeterminate("payer-state read failed: %s: %s" % (type(exc).__name__, exc))

    # Prior units: REPORTED, never predicated on, so an unparseable one degrades to '-' rather
    # than escalating a run whose verdict does not depend on it.
    prior = {}
    for name, sql in (("failures_7d", build_failure_count_query(FLOOR_WINDOW_DAYS)),
                      ("failures_30d", build_failure_count_query(RATE_WINDOW_DAYS)),
                      ("payments_7d", build_payment_count_query(FLOOR_WINDOW_DAYS)),
                      ("payments_30d", build_payment_count_query(RATE_WINDOW_DAYS)),
                      ("customers_7d", build_customer_count_query(FLOOR_WINDOW_DAYS)),
                      ("customers_30d", build_customer_count_query(RATE_WINDOW_DAYS))):
        try:
            prior[name] = parse_count(_psql(sql))
        except Exception as exc:                                # noqa: BLE001
            log("prior unit %s unreadable (reported as '-'): %s" % (name, exc))
            prior[name] = None

    try:
        successes_30d = parse_count(_psql(build_success_count_query(RATE_WINDOW_DAYS)))
    except Exception as exc:                                    # noqa: BLE001
        return indeterminate("conversion denominator unreadable: %s" % exc)
    if successes_30d is None:
        return indeterminate("conversion denominator unparseable (empty is NOT zero)")

    payer_states = classify_payers(payer_rows, time.time())
    verdict, reasons, facts = classify(
        payer_states, successes_30d,
        failures_30d=prior["failures_30d"], failures_7d=prior["failures_7d"],
        payments_7d=prior["payments_7d"], payments_30d=prior["payments_30d"],
        customers_7d=prior["customers_7d"], customers_30d=prior["customers_30d"],
        book_size=sentinels["CENSUS"]["events"],
        epoch0_rows=sentinels["EPOCH0"]["events"],
        linkage_epoch=sentinels["LINKAGE"]["first_seen"])
    append_observation(facts, verdict)

    # POSITIVE per-check output — never "absence of an alert". Every payer that counts is named,
    # so a row silently dropped by a load error cannot look identical to a row that passed.
    log("stuck payers=%d/%d (floor >= %d) | new=%d chronic=%d undated=%d | recovered in %dd=%d | "
        "unattributed=%d unknown-status=%d | prior units: emitting cards %s/%s, customer records "
        "%s/%s, payments %s/%s | n=%d rate=%s %s | linkage epoch %s | epoch0 rows %d"
        % (facts["stuck_payers"], facts["book_size"], FLOOR_FAILURES, facts["new_stuck"],
           facts["chronic_stuck"], facts["undated_stuck"], FLOOR_WINDOW_DAYS, facts["recovered_7d"],
           facts["unattributed"], facts["unknown_status"],
           _n(prior["failures_7d"]), _n(prior["failures_30d"]),
           _n(prior["customers_7d"]), _n(prior["customers_30d"]),
           _n(prior["payments_7d"]), _n(prior["payments_30d"]),
           facts["n_30d"],
           ("%.1f%%" % facts["decline_rate_pct_30d"])
           if facts["decline_rate_pct_30d"] is not None else "unmeasured",
           facts["rate_predicate"], facts["linkage_epoch"], facts["epoch0_rows"]))
    for p in payer_states:
        if p["counts"] or (p["events"] > 0 and p["onset"] == "NEW"):
            log("  %s" % flatten_payer_line(render_payer_line(p)))

    return finish(verdict, reasons, facts, payer_states)


# ── Hermetic self-test ──────────────────────────────────────────────────────────────────
# 🛑 EVERY FIXTURE BELOW IS SYNTHETIC. Earlier rungs of this file pasted live Stripe customer
# ids and a raw cross-merchant card fingerprint into prose that ships in a PUBLIC repo; this
# wave redacted them. Use `cus_TEST…` / `card:v1:aaaa…` and never a real handle.
SELF_TEST_MIN_CHECKS = 139


def _read_last_json(path):
    """Read back the last JSON line a seam wrote. Returns {} rather than raising.

    🛑 A self-test readback must FAIL A CHECK, never abort the suite. Measured: an unguarded
    `open()` here turned a deliberate mutation into a traceback with NO verdict token — which is
    strictly worse than a red check, because every caller in this estate gates on the token.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        return json.loads(lines[-1]) if lines else {}
    except Exception:                                           # noqa: BLE001
        return {}



def _capture_status_vocabulary():
    """Run the real `--status-vocabulary` printer and capture what it emitted.

    Capturing the PRINTER rather than re-reading the constants is the point: a test that
    re-listed the frozensets would pass with the printer deleted, which is the assertion-that-
    cannot-fail shape this file has already paid for twice.
    """
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        status_vocabulary()
    return buf.getvalue()


def _pr(key, cust, status, first="-", last="-", events=1):
    """Build one parsed payer row — the shape `parse_payer_rows` emits."""
    return {"payer_key": key, "customer_id": cust, "status_token": status,
            "first_seen": first, "last_seen": last, "events": events}


def self_test():
    os.environ["ALGOVAULT_CANARY_SELFTEST"] = "1"
    passed, failed = [], []

    def check(label, cond):
        (passed if cond else failed).append(label)

    NOW = calendar.timegm(time.strptime("2026-09-07T09:00:00Z", "%Y-%m-%dT%H:%M:%SZ"))
    KEY_A = "card:v1:aaaaaaaaaaaaaaaa"   # declined at signup, then PAID
    KEY_B = "card:v1:bbbbbbbbbbbbbbbb"   # one card, two customer records, one of them past_due
    KEY_C = "card:v1:cccccccccccccccc"   # past_due for 51 days, Stripe still dunning
    T_A, T_B, T_C = "2026-09-06T22:41:52Z", "2026-08-26T11:49:00Z", "2026-07-18T01:57:00Z"

    # ── the status vocabulary is EXHAUSTIVE and PARTITIONS Stripe's documented enum ───────
    documented = {"incomplete", "incomplete_expired", "trialing", "active",
                  "past_due", "canceled", "unpaid", "paused"}
    check("the four status buckets cover Stripe's documented enum exactly",
          STRIPE_STATUSES == documented)
    check("...and they PARTITION it — no status is in two buckets",
          sum(len(b) for b in (STATUS_HEALTHY, STATUS_MONEY_STUCK,
                               STATUS_NOT_STARTED, STATUS_ENDED)) == len(documented))
    check("every documented status classifies to a NON-unknown state",
          all(classify_status(s) != PAYER_UNKNOWN for s in documented))
    check("a status OUTSIDE the enum is UNKNOWN, never assumed healthy",
          classify_status("some_future_stripe_state") == PAYER_UNKNOWN)
    check("...and UNKNOWN counts toward the floor (fail toward NOISE, never silence)",
          PAYER_UNKNOWN in COUNTED_STATES)
    check("a missing profile row is UNATTRIBUTED and also counts",
          classify_status(SENTINEL_NO_PROFILE) == PAYER_UNATTRIBUTED
          and PAYER_UNATTRIBUTED in COUNTED_STATES)
    check("a NULL / blank status is UNKNOWN, not healthy",
          classify_status(SENTINEL_NULL_STATUS) == PAYER_UNKNOWN
          and classify_status(SENTINEL_EMPTY_STATUS) == PAYER_UNKNOWN)
    check("`unpaid` is MONEY STUCK — Stripe stopped retrying, the debt stands",
          classify_status("unpaid") == PAYER_STUCK)
    check("`past_due` is MONEY STUCK", classify_status("past_due") == PAYER_STUCK)
    check("🛑 `incomplete` is NOT stuck — it is the 3-minute state a normal signup occupies "
          "while its first payment confirms", classify_status("incomplete") == PAYER_NOT_STARTED)
    check("`canceled` / `paused` are ENDED, excluded — churn is a different alarm",
          classify_status("canceled") == PAYER_ENDED and classify_status("paused") == PAYER_ENDED)
    check("`trialing` is healthy", classify_status("trialing") == PAYER_HEALTHY)
    # Transcribed from src/lib/stripe.ts SUBSCRIPTION_STATUS_CLASS. The assertion is that the two
    # tables DIFFER, so a future "single-derivation" cleanup cannot silently merge them.
    src_entitlement = {"active": "ENTITLED", "trialing": "ENTITLED", "past_due": "DUNNING",
                       "unpaid": "NOT_ENTITLED", "canceled": "NOT_ENTITLED",
                       "incomplete": "NOT_ENTITLED", "incomplete_expired": "NOT_ENTITLED",
                       "paused": "NOT_ENTITLED"}
    vocab = json.loads(_capture_status_vocabulary())
    check("the --status-vocabulary seam emits all four buckets",
          sorted(vocab.keys()) == ["ENDED", "HEALTHY", "MONEY_STUCK", "NOT_STARTED"])
    check("...and its contents ARE the live constants, not a hand-typed copy",
          vocab["MONEY_STUCK"] == sorted(STATUS_MONEY_STUCK)
          and vocab["HEALTHY"] == sorted(STATUS_HEALTHY)
          and vocab["NOT_STARTED"] == sorted(STATUS_NOT_STARTED)
          and vocab["ENDED"] == sorted(STATUS_ENDED))
    check("...and it partitions Stripe's enum with nothing missing and nothing spare",
          sorted(v for b in vocab.values() for v in b) == sorted(documented))
    check("🛑 the stuck set DIFFERS from src/'s entitlement map, and `unpaid` is the difference",
          STATUS_MONEY_STUCK != {k for k, v in src_entitlement.items() if v == "DUNNING"}
          and "unpaid" in STATUS_MONEY_STUCK and src_entitlement["unpaid"] == "NOT_ENTITLED")

    # ── THE 2026-09-07 REGRESSION, as its live shape ─────────────────────────────────────
    live = [_pr(KEY_A, "cus_TESTAAA", "active", T_A, T_A, 6),
            _pr(KEY_B, "cus_TESTBB1", "active", T_B, "2026-08-31T06:49:00Z", 9),
            _pr(KEY_B, "cus_TESTBB2", "past_due", T_B, "2026-09-06T14:39:00Z", 18),
            _pr(KEY_C, "cus_TESTCCC", "past_due", T_C, "2026-09-01T03:04:00Z", 28)]
    st = classify_payers(live, NOW)
    by = {p["key"]: p for p in st}
    check("THE REGRESSION: the card that declined at signup and then PAID does not count",
          by[KEY_A]["state"] == PAYER_HEALTHY and by[KEY_A]["counts"] is False)
    check("...and it is still SEEN — classified, not dropped", by[KEY_A]["events"] == 6)
    check("...the two chronic cards do count", by[KEY_B]["counts"] and by[KEY_C]["counts"])
    v, r, f = classify(st, successes_30d=3, failures_30d=3, failures_7d=3,
                       payments_7d=3, payments_30d=22, customers_7d=3, customers_30d=4,
                       book_size=7)
    check("🛑 THE REGRESSION: 3 emitting cards but only 2 stuck payers ⇒ PASS, no page",
          v == "PASS" and f["stuck_payers"] == 2)
    check("...while the PRIOR unit would have breached (3 >= 3), and is carried so the gap "
          "is auditable", f["failures_7d"] >= FLOOR_FAILURES)
    check("...the recovered card is reported, not silently dropped", f["recovered_7d"] == 1)
    check("...and both stuck payers are CHRONIC, so the decomposition names the pedestal",
          (f["new_stuck"], f["chronic_stuck"]) == (0, 2))
    check("...facts name the live unit rather than leaving it implied",
          f["failure_unit"] == "payers with money stuck (card-keyed, book-derived)")
    check("...and the book size travels with the count",
          f["book_size"] == 7 and f["floor_threshold"] == FLOOR_FAILURES)

    # ── PROVEN ABLE TO FAIL: three genuinely stuck payers still page ──────────────────────
    three = [_pr(KEY_A, "cus_TESTAAA", "past_due", T_A, T_A, 2),
             _pr(KEY_B, "cus_TESTBB2", "unpaid", T_B, T_B, 3),
             _pr(KEY_C, "cus_TESTCCC", "past_due", T_C, T_C, 4)]
    v3, r3, f3 = classify(classify_payers(three, NOW), successes_30d=4, failures_30d=3)
    check("three genuinely stuck payers DO page — the alarm is not disarmed",
          v3 == "FAIL" and f3["stuck_payers"] == 3 and any("FLOOR" in x for x in r3))

    # ── THE F3 FIX: a payer Stripe has STOPPED retrying stays visible ─────────────────────
    # This is the assertion that fails under the rejected window-derived design. Card C's last
    # decline is 200 days old — no window over the failure table can see it — and it is STILL
    # stuck because the universe is the BOOK.
    silent = [_pr(KEY_C, "cus_TESTCCC", "unpaid", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", 9)]
    sst = classify_payers(silent, NOW)
    check("🛑 a payer Stripe stopped retrying 200 days ago is STILL counted (level-triggered)",
          sst[0]["counts"] and sst[0]["state"] == PAYER_STUCK)
    check("...and is reported CHRONIC, not NEW", sst[0]["onset"] == "CHRONIC")
    # ...and a stuck payer with NO failure rows at all is still counted, keyed by customer.
    nofail = classify_payers([_pr("cus:cus_TESTDDD", "cus_TESTDDD", "past_due")], NOW)
    check("a stuck payer with zero failure rows is counted and keyed by customer",
          nofail[0]["counts"] and nofail[0]["onset"] == "UNDATED" and nofail[0]["age_days"] is None)

    # ── worst-wins fold: one card, one active + one past_due record ───────────────────────
    check("🛑 the card fold is WORST-wins: one active + one past_due record ⇒ STUCK",
          by[KEY_B]["state"] == PAYER_STUCK)
    flipped = classify_payers([_pr(KEY_B, "cus_TESTBB2", "past_due", T_B, T_B, 1),
                               _pr(KEY_B, "cus_TESTBB1", "active", T_B, T_B, 1)], NOW)
    check("...and it is order-independent — the reversed input folds identically",
          flipped[0]["state"] == PAYER_STUCK and len(flipped) == 1)
    check("...both customer ids survive the fold so the body can render them",
          by[KEY_B]["customers"] == ["cus_TESTBB1", "cus_TESTBB2"])
    check("two records on one card count as ONE payer, not two",
          len([p for p in st if p["counts"]]) == 2)

    # ── the NEW / CHRONIC decomposition is REPORTED, never the predicate ──────────────────
    newly = [_pr(KEY_A, "cus_TESTAAA", "past_due", T_A, T_A, 1)]
    nst = classify_payers(newly, NOW)
    check("a first-ever failure inside the window reports NEW", nst[0]["onset"] == "NEW")
    check("...and one outside it reports CHRONIC", by[KEY_C]["onset"] == "CHRONIC")
    check("...the window boundary is applied in PYTHON, so the suite can move it",
          classify_payers(newly, NOW, floor_window_days=0)[0]["onset"] == "CHRONIC")
    _, _, f_new = classify(nst, successes_30d=1, failures_30d=1)
    check("...but ONE new stuck payer does not page — onset is not the predicate",
          f_new["stuck_payers"] == 1 and f_new["new_stuck"] == 1)
    check("age is reported in days against the injected clock, not a wall clock",
          abs(by[KEY_C]["age_days"] - 51.3) < 0.2)

    # ── UNATTRIBUTED / UNKNOWN both count and are both NAMED ─────────────────────────────
    odd = [_pr("cus:cus_TESTEEE", "cus_TESTEEE", SENTINEL_NO_PROFILE, T_A, T_A, 2),
           _pr("cus:cus_TESTFFF", "cus_TESTFFF", "some_future_state", T_A, T_A, 1)]
    vo, ro, fo = classify(classify_payers(odd, NOW), successes_30d=0, failures_30d=2)
    check("an unattributed payer counts", fo["unattributed"] == 1)
    check("an unknown-status payer counts", fo["unknown_status"] == 1)
    check("...and neither silently poisons the whole run to INDETERMINATE",
          vo == "PASS" and fo["stuck_payers"] == 2)
    bo = build_body(["x"], fo, classify_payers(odd, NOW))
    check("...the body NAMES the unattributed class and its generator",
          "NO subscriber_profiles row" in bo and "handleSubscriptionCreated" in bo)
    check("...and names the unknown-status class",
          "outside Stripe's documented enum" in bo)

    # ── BYPASSED ARTIFACT: the payer-state SQL. Positive AND its negative twin. ───────────
    q = build_payer_state_query()
    # 🛑 EQUALITY, not `in`. A substring assertion is satisfied by appending a WHERE clause —
    # measured: `... FROM subscriber_profiles WHERE customer_id IN (SELECT customer_id FROM
    # fails)` reverts the universe to the failure window and left this check GREEN.
    def _between(text, a, b):
        """Slice between two markers, returning '' when either is absent — never raising.
        Measured: an `index()` here turned a deliberate mutation into a traceback with no
        verdict token, which is worse than a red check."""
        try:
            i = text.index(a) + len(a)
            return text[i:text.index(b, i)]
        except ValueError:
            return ""
    book_cte = _between(q, "), book AS (", ") SELECT '__census__'")
    check("🛑 the payer query's universe is the WHOLE subscriber book — the profile leg is "
          "unfiltered (pinned by equality, not by substring)",
          book_cte.split("UNION ALL")[0].strip()
          == "SELECT customer_id, status, 'PROFILE' AS src FROM subscriber_profiles")
    check("🛑 ...and joins the failure table INWARD, never the reverse",
          "FROM book b " in q and "LEFT JOIN card_of c ON c.customer_id = b.customer_id" in q
          and "LEFT JOIN fails f ON f.customer_id = b.customer_id" in q)
    check("...the OLD window-derived predicate is GONE from it (negative twin)",
          "COUNT(DISTINCT COALESCE(fp.card_ref" not in q)
    check("🛑 the query carries NO clock — every window is applied in Python",
          "NOW()" not in q.upper() and "INTERVAL" not in q.upper())
    check("🛑 ...and NO LIMIT, so nothing is aggregated over a capped collection",
          "LIMIT" not in q.upper())
    check("...and no top-level ORDER BY — sentinels are found by token, never by position",
          q.rstrip().upper().endswith("B.CUSTOMER_ID"))
    check("DISTINCT ON carries an event_id tiebreak — row order is never rented",
          "ORDER BY customer_id, occurred_at DESC, event_id DESC" in q)
    # 🛑 EXACT count, and each CTE pinned separately. `>= 2` was satisfied with one of the three
    # filters deleted — measured, the `fails` aggregate lost its guard and the suite stayed green.
    check("every aggregate excludes epoch-0 rows — all three filters present, none spare",
          q.count("occurred_at > TIMESTAMPTZ '1971-01-01'") == 3)
    check("...the card_of CTE carries one",
          "occurred_at > TIMESTAMPTZ '1971-01-01' " in _between(q, "WITH card_of AS (", "), fails AS ("))
    check("...and the fails aggregate carries one",
          "occurred_at > TIMESTAMPTZ '1971-01-01' " in _between(q, "), fails AS (", "), book AS ("))
    check("...and their count is REPORTED, so the exclusion is never silent",
          "'__epoch0__'" in q and "occurred_at <= TIMESTAMPTZ '1971-01-01'" in q)
    check("the linkage epoch ships beside every age it censors", "'__linkage__'" in q)
    check("the census sentinel is unconditional, so an empty read is never mistaken for an "
          "empty book", "'__census__'" in q and "(SELECT count(*) FROM book)::text" in q)
    # 🛑 `'ORPHAN'` also appears in the CASE arm below, so a bare substring test is satisfied
    # while the UNION leg is broken — measured: retagging the leg 'PROFILE' left this green.
    check("orphan failing customers are UNIONed into the book (the UNION LEG is pinned, not "
          "merely the token, which also appears in the CASE arm)",
          "UNION ALL SELECT f.customer_id, NULL, 'ORPHAN' FROM fails f "
          "LEFT JOIN subscriber_profiles s ON s.customer_id = f.customer_id "
          "WHERE s.customer_id IS NULL" in " ".join(book_cte.split()))
    check("...and they are graded UNATTRIBUTED, which COUNTS",
          "WHEN b.src = 'ORPHAN' THEN '" + SENTINEL_NO_PROFILE + "'" in q)
    check("every NULL leaves SQL as an explicit sentinel, never as an empty field",
          all(("'%s'" % t) in q for t in
              (SENTINEL_NO_PROFILE, SENTINEL_NULL_STATUS, SENTINEL_EMPTY_STATUS)))
    check("the status token is sanitised in SQL so it can never carry the field delimiter",
          "regexp_replace(lower(trim(b.status)), '[^a-z_]', '?', 'g')" in q)

    # ── BYPASSED ARTIFACT: the row parser. Every malformation is INDETERMINATE. ───────────
    good = ("__census__|-|CENSUS|-|-|2\n"
            "__epoch0__|-|EPOCH0|-|-|0\n"
            "__linkage__|-|LINKAGE|2026-08-18T03:03:00Z|-|0\n"
            "card:v1:aaaaaaaaaaaaaaaa|cus_TESTAAA|active|%s|%s|6\n"
            "card:v1:cccccccccccccccc|cus_TESTCCC|past_due|%s|%s|28\n" % (T_A, T_A, T_C, T_C))
    sen, rows = parse_payer_rows(good)
    check("parser reads the sentinels and the payer rows", len(rows) == 2 and sen["CENSUS"]["events"] == 2)
    check("...and pins the columns POSITIONALLY — psql -tA returns values, not names",
          rows[0]["customer_id"] == "cus_TESTAAA" and rows[0]["first_seen"] == T_A
          and rows[0]["events"] == 6)
    check("...carrying the linkage epoch through", sen["LINKAGE"]["first_seen"] == "2026-08-18T03:03:00Z")

    def refuses(label, raw):
        try:
            parse_payer_rows(raw)
            check(label, False)
        except ValueError:
            check(label, True)
        except Exception:
            check(label, False)

    refuses("parser REFUSES an empty result (the sentinels are unconditional)", "")
    refuses("parser REFUSES None", None)
    refuses("parser REFUSES a short row rather than dropping it",
            good.replace("|cus_TESTAAA|active|", "|active|"))
    refuses("parser REFUSES an extra delimiter", good.replace("|active|", "|act|ive|"))
    refuses("parser REFUSES an empty field — a NULL must arrive as a sentinel",
            good.replace("|cus_TESTAAA|", "||"))
    refuses("parser REFUSES a census that disagrees with the rows it parsed",
            good.replace("CENSUS|-|-|2", "CENSUS|-|-|5"))
    refuses("parser REFUSES a truncated read that lost a sentinel",
            "\n".join(good.splitlines()[1:]))
    # 🛑 ISOLATION MATTERS. With the census left consistent, ONLY the width check can catch a
    # malformed row — and with a mutually-consistent census the earlier short-row assertion is
    # satisfied by the census check instead, which is how a deleted width check stayed green.
    # 🛑 The census must still AGREE **after** the bad row is dropped, or the census check
    # answers first and the width check can be deleted while this stays green — measured.
    refuses("parser REFUSES a short row even when dropping it would leave the census CONSISTENT "
            "(the width check is isolated, not masked by the census)",
            "__census__|-|CENSUS|-|-|1\n__epoch0__|-|EPOCH0|-|-|0\n"
            "__linkage__|-|LINKAGE|2026-08-18T03:03:00Z|-|0\n"
            "card:v1:aaaaaaaaaaaaaaaa|cus_TESTAAA|active|%s|%s|6\n"
            "card:v1:cccccccccccccccc|cus_TESTCCC|past_due|%s|9\n" % (T_A, T_A, T_C))
    refuses("parser REFUSES an over-wide row with a consistent census",
            "__census__|-|CENSUS|-|-|1\n__epoch0__|-|EPOCH0|-|-|0\n"
            "__linkage__|-|LINKAGE|2026-08-18T03:03:00Z|-|0\n"
            "card:v1:aaaaaaaaaaaaaaaa|cus_TESTAAA|active|%s|%s|6|extra\n" % (T_A, T_A))
    refuses("parser REFUSES a non-ASCII digit count", good.replace("|6\n", "|٣\n"))
    refuses("parser REFUSES a malformed timestamp", good.replace(T_A, "2026-09-06 22:41"))
    refuses("parser REFUSES an unparseable payer key",
            good.replace("card:v1:aaaaaaaaaaaaaaaa|cus_TESTAAA", ";DROP TABLE x|cus_TESTAAA"))
    refuses("parser REFUSES an unparseable status token", good.replace("|active|", "|AcTiVe!!|"))
    check("🛑 a partial parse is never a partial ANSWER — every refusal above raises rather "
          "than returning the rows it managed to read", True)

    # ── prior-unit builders: UNCHANGED and still asserted ────────────────────────────────
    q7 = build_failure_count_query(7)
    check("the prior CARD unit is retained as a reported prior, not deleted",
          "COALESCE(fp.card_ref, f.customer_id, f.payment_intent_id, f.event_id)" in q7)
    check("the CUSTOMER unit is retained too",
          "COALESCE(customer_id, payment_intent_id, event_id)" in build_customer_count_query(7)
          and "card_ref" not in build_customer_count_query(7))
    check("the PAYMENT unit is retained too",
          "COALESCE(payment_intent_id, event_id)" in build_payment_count_query(7)
          and "customer_id" not in build_payment_count_query(7))
    check("prior-unit builders still carry their own window",
          "INTERVAL '30 days'" in build_customer_count_query(30)
          and "INTERVAL '30 days'" in build_payment_count_query(30)
          and "INTERVAL '7 days'" in q7)
    for bad in ("7; DROP TABLE x", None, 1.5, 0):
        for builder in (build_failure_count_query, build_customer_count_query,
                        build_payment_count_query):
            try:
                builder(bad)
                check("%s REFUSES %r" % (builder.__name__, bad), False)
            except ValueError:
                check("%s REFUSES %r" % (builder.__name__, bad), True)
            except Exception:
                check("%s REFUSES %r" % (builder.__name__, bad), False)
    check("success query targets subscriber_profiles/converted_at",
          "subscriber_profiles" in build_success_count_query(30)
          and "converted_at" in build_success_count_query(30))
    check("parser reads a plain psql scalar and a real zero",
          parse_count("12\n") == 12 and parse_count("0\n") == 0)
    check("scalar parser returns None for EMPTY / garbage / None (empty is NOT zero)",
          parse_count("") is None and parse_count("ERROR: nope") is None and parse_count(None) is None)

    # ── rate predicate: unchanged, and still structurally inert below MIN_N ──────────────
    _, r_lo, f_lo = classify(classify_payers([_pr(KEY_A, "cus_TESTAAA", "past_due", T_A, T_A)], NOW),
                             successes_30d=1, failures_30d=2)
    check("rate predicate INERT below MIN_N", f_lo["rate_predicate"].startswith("INERT"))
    check("...and a high rate below MIN_N does NOT fire it",
          not any("DECLINE RATE" in x for x in r_lo))
    v_hi, r_hi, f_hi = classify([], successes_30d=10, failures_30d=15)
    check("n >= MIN_N activates the rate predicate", f_hi["rate_predicate"] == "ACTIVE")
    check("...and a rate breach above MIN_N ⇒ FAIL",
          v_hi == "FAIL" and any("DECLINE RATE" in x for x in r_hi))
    v_e, r_e, f_e = classify([], successes_30d=0, failures_30d=0)
    check("empty world ⇒ PASS (a fact about the world, NOT indeterminate)",
          v_e == "PASS" and r_e == [])
    check("empty world reports rate as unmeasured, not 0%", f_e["decline_rate_pct_30d"] is None)

    # ── token → EXIT CODE mapping ───────────────────────────────────────────────────────
    check("PASS/FAIL/INDETERMINATE map to 0/1/3 (3 is the new-gate default, NOT the sibling's 2)",
          (EXIT_PASS, EXIT_FAIL, EXIT_INDETERMINATE) == (0, 1, 3))

    # ── the rendered BODY, asserted as a SET, not as a substring of itself ───────────────
    vB, rB, fB = classify(classify_payers(three, NOW), successes_30d=4, failures_30d=3)
    body = build_body(rB, fB, classify_payers(three, NOW))
    rendered = set(re.findall(r"cus_[A-Za-z0-9]+", body))
    check("🛑 the body renders EXACTLY the stuck customer ids — set equality, so a missing id "
          "AND an extra id both fail",
          rendered == {"cus_TESTAAA", "cus_TESTBB2", "cus_TESTCCC"})
    check("...and no recovered payer's id leaks into a FAIL body",
          "cus_TESTBB1" not in build_body(rB, fB, classify_payers(three, NOW)))
    check("every rendered customer id carries a dashboard link that resolves to an action",
          all(("https://dashboard.stripe.com/customers/%s" % c) in body for c in rendered))
    check("body names the alert id and the templated wave, never a literal W-number",
          ALERT_ID in body and "W{NEXT}" in body and not re.search(r"-W\d+\b", body))
    check("body states the live unit in words",
          "PAYERS WHOSE MONEY IS STUCK RIGHT NOW" in body)
    check("body carries the prior units so the instrument swap is auditable",
          "cards that emitted a decline" in body)
    check("body states the stuck count against the BOOK, not as a bare number",
          re.search(r"\d+ of \d+ payers in the book", body) is not None)
    # The entity-noun law: a bare parenthesised number beside a count is forbidden.
    check("🛑 body contains no bare parenthesised number next to a count",
          re.search(r"\(\s*(new|now)?\s*:?\s*\d+\s*\)", body) is None)
    multi = classify_payers([_pr(KEY_B, "cus_TESTBB1", "past_due", T_B, T_B),
                             _pr(KEY_B, "cus_TESTBB2", "past_due", T_B, T_B)], NOW)
    lineB = render_payer_line(multi[0])
    check("a card holding two records states the fan-out IN WORDS, never as '(2)'",
          "2 customer records on 1 card" in lineB and "(2)" not in lineB)
    check("...and pluralises the noun from the ID count", "customer ids" in lineB)
    flat = flatten_payer_line(render_payer_line(by[KEY_A]))
    check("🛑 the log flattener preserves the state column instead of eating its padding",
          flat.startswith("HEALTHY ") and "HEALTHYcard" not in flat)
    check("...and joins the render's lines with an explicit separator, losing nothing",
          flat.count(" | ") == len(render_payer_line(by[KEY_A]).splitlines()) - 1
          and "cus_TESTAAA" in flat and "dashboard.stripe.com" in flat)
    check("...and a six-space run inside a VALUE survives the flatten",
          "a      b" in flatten_payer_line("  x\n      a      b"))
    check("a single-id line uses the singular noun",
          "customer id " in render_payer_line(nst[0])
          and "customer ids" not in render_payer_line(nst[0]))
    check("_plural pluralises from the count, not from a hardcoded '(s)'",
          (_plural(1, "card"), _plural(2, "card")) == ("card", "cards"))
    check("_n renders a real zero as 0 and an absent value as '-'", (_n(0), _n(None)) == ("0", "-"))
    check("an absent prior unit renders as '-', never 0",
          "distinct payments - / -" in build_body(rB, fB))
    check("🛑 no email or name is ever rendered into a body",
          "@" not in body.replace("W{NEXT}", "") and "email" not in body.lower())

    # ── the CLEAR path — asserted at the CALL SITE, not on the function ──────────────────
    # 🛑 Driving `dispatch_clear` directly proved worthless: deleting the call from the verdict
    # path left the whole suite green. `finish()` exists so this assertion sees the wiring.
    # stdout is CAPTURED, not suppressed: the module contract is exactly ONE terminal
    # PAYMENT_DECLINE_VERDICT line per run, and a suite that let `finish()` print would emit
    # three and break the very contract every caller gates on. Capturing also makes the
    # token↔exit-code pairing assertable end to end rather than by inspection.
    def drive(verdict, reasons, facts_, states):
        _LAST_CLEAR["reason"], _LAST_BODY["text"] = None, None
        _LAST_ARGV["fire"] = _LAST_ARGV["clear"] = None
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = finish(verdict, reasons, facts_, states)
        # Snapshot PER CALL. Reading the module globals after both drives sees only the LAST
        # one, so the PASS drive's argv would be unobservable — the assertion would then be
        # about the FAIL drive while claiming to be about the PASS path.
        return rc, buf.getvalue().strip(), dict(_LAST_ARGV)

    rc_pass, tok_pass, argv_pass = drive("PASS", [], f, st)
    check("🛑 a PASS verdict DISPATCHES --clear, so the episode closes instead of the channel "
          "staying pinned to the worst thing that ever happened",
          _LAST_CLEAR["reason"] is not None and "stuck payers" in _LAST_CLEAR["reason"])
    check("...and a PASS fires nothing, prints exactly one PASS token, and exits 0",
          _LAST_BODY["text"] is None and rc_pass == EXIT_PASS
          and tok_pass == "PAYMENT_DECLINE_VERDICT=PASS")
    rc_fail, tok_fail, argv_fail = drive("FAIL", rB, fB, classify_payers(three, NOW))
    check("...while a FAIL verdict FIRES and never clears — a clear on a firing condition "
          "would erase the episode",
          _LAST_BODY["text"] is not None and _LAST_CLEAR["reason"] is None)
    check("...and pairs exactly one FAIL token with exit 1",
          rc_fail == EXIT_FAIL and tok_fail == "PAYMENT_DECLINE_VERDICT=FAIL")
    check("...and the FAIL body is the one built from the same facts (no second derivation)",
          _LAST_BODY["text"] == build_body(rB, fB, classify_payers(three, NOW)))
    # ── BYPASSED ARTIFACT: the wrapper ARGV. The seam replaces the subprocess, so the one
    # thing the suite can never observe by running is the command line it would have run.
    ca = clear_argv("because")
    ca = ca + [None] * (4 - len(ca)) if len(ca) < 4 else ca   # short argv fails a check, never raises
    check("🛑 the clear argv puts --clear FIRST — `<id> --clear` parses as a FIRE with severity "
          "'--clear' and is answered SUPPRESSED_SEVERITY at exit 0 (measured live 2026-09-07)",
          ca[1] == "--clear" and ca[2] == ALERT_ID)
    check("...and passes the reason POSITIONALLY, as the wrapper reads it (never via env)",
          ca[3] == "because" and len(clear_argv("because")) == 4)
    check("...while the FIRE argv keeps <id> <severity> <body> and a severity the wrapper "
          "actually accepts", fire_argv()[1:] == [ALERT_ID, "CRITICAL_PERSISTENT", "-"])
    check("...the two argv shapes are DIFFERENT — a clear is not a fire with a flag bolted on",
          fire_argv()[1] != clear_argv("x")[1])
    check("...and the PASS path actually invoked the CLEAR argv and never the fire argv",
          argv_pass["clear"] is not None and argv_pass["clear"][1] == "--clear"
          and argv_pass["fire"] is None)
    check("...while the FAIL path invoked the FIRE argv and never the clear argv",
          argv_fail["fire"] is not None and argv_fail["clear"] is None)
    selftest_results = os.path.join(tempfile.gettempdir(),
                                    "payment-decline-canary-selftest-results.jsonl")
    # 🛑 UNLINK FIRST. Asserting only that the temp file exists is satisfied by a STALE file
    # from any earlier run — measured: removing the redirect left this green because yesterday's
    # file was still on disk. The file must be re-created by THIS run.
    if os.path.exists(selftest_results):
        os.unlink(selftest_results)
    drive("PASS", [], f, st)
    check("🛑 the suite publishes to a TEMP results path, never to the production file the "
          "vault sync pulls from", os.path.exists(selftest_results))
    _rec = _read_last_json(selftest_results)
    check("...and the published record carries the canary name, verdict and the live counts",
          _rec.get("canary") == CANARY_NAME and _rec.get("verdict") in ("PASS", "FAIL")
          and _rec.get("metrics", {}).get("predicate_version") == PREDICATE_VERSION
          and "stuck_payers" in _rec.get("metrics", {}))

    # ── the ledger keeps the OLD series under the OLD name ───────────────────────────────
    ledger_path = os.path.join(tempfile.gettempdir(), "payment-decline-canary-selftest-ledger.jsonl")
    if os.path.exists(ledger_path):
        os.unlink(ledger_path)
    append_observation(f, "PASS")
    check("the ledger writes to a TEMP path under the self-test seam", os.path.exists(ledger_path))
    led = _read_last_json(ledger_path)
    # 🛑 READ BACK WHAT WAS WRITTEN. Asserting on `facts` instead would test the dict, not the
    # ledger — measured: repointing the ledger's failures_7d at stuck_payers left the suite green.
    check("🛑 the ledger row still carries failures_7d meaning 'cards that EMITTED a decline', "
          "so the pre-wave series stays comparable across the predicate change",
          led.get("failures_7d") == 3 and led.get("failures_7d") != led.get("stuck_payers"))
    check("...and carries the NEW counts under NEW names beside it",
          (led.get("stuck_payers"), led.get("new_stuck"), led.get("chronic_stuck")) == (2, 0, 2))
    check("...stamped with the predicate version and the unit it was measured with",
          led.get("predicate_version") == PREDICATE_VERSION
          and led.get("failure_unit") == f["failure_unit"] and led.get("verdict") == "PASS")
    check("...and stamps predicate_version so the two instruments are never silently compared",
          f["predicate_version"] == PREDICATE_VERSION and PREDICATE_VERSION == 2)

    # ── vacuity guard — computed OUTSIDE the list it guards, and printed ─────────────────
    total = len(passed) + len(failed)
    if total < SELF_TEST_MIN_CHECKS:
        failed.append("VACUITY: ran %d checks, floor is %d — the suite collapsed"
                      % (total, SELF_TEST_MIN_CHECKS))
    if SELF_TEST_MIN_CHECKS < 139:
        failed.append("VACUITY: SELF_TEST_MIN_CHECKS was lowered below its committed value")

    for label in failed:
        sys.stderr.write("  SELF-TEST FAIL: %s\n" % label)
    sys.stderr.write("[payment-decline-canary] self-test: %d passed, %d failed (floor %d)\n"
                     % (len(passed), len(failed), SELF_TEST_MIN_CHECKS))
    ok = not failed
    print("PAYMENT_DECLINE_VERDICT=%s" % ("PASS" if ok else "FAIL"))
    return EXIT_PASS if ok else EXIT_FAIL


def status_vocabulary():
    """Print the 4-bucket status partition as JSON, for the CROSS-LANGUAGE PARITY test.

    🛑 THIS EXISTS BECAUSE THE SECOND IMPLEMENTATION CANNOT IMPORT THE FIRST. `src/lib/
    subscriber-status.ts` owns this vocabulary for every TypeScript consumer; this file owns it
    for the host canary, and a JS test cannot import a Python module. Two independent
    re-derivations of one classification drift to contradiction — that is the defect class the
    single-derivation rule exists to retire — so `tests/unit/subscriber-status-parity.test.ts`
    feeds ONE corpus to both sides and demands identical output.

    It prints the map rather than answering one query, so the test compares the WHOLE partition:
    a per-value probe would pass while a bucket the test forgot to ask about had drifted.
    """
    print(json.dumps({
        "HEALTHY": sorted(STATUS_HEALTHY),
        "MONEY_STUCK": sorted(STATUS_MONEY_STUCK),
        "NOT_STARTED": sorted(STATUS_NOT_STARTED),
        "ENDED": sorted(STATUS_ENDED),
    }, sort_keys=True))
    return EXIT_PASS


def show_config():
    """Print the RESOLVED config, in the producer's own variable names.

    A guard that reads a knob nothing writes resolves silently to its own default and looks
    healthy forever; a hermetic suite that sets module globals directly cannot see that.
    """
    cfg = {
        "ALGOVAULT_PG_CONTAINER": PG_CONTAINER,
        "ALGOVAULT_PG_DB": PG_DB,
        "ALGOVAULT_PAYMENT_DECLINE_MIN_N": MIN_N,
        "ALGOVAULT_PAYMENT_DECLINE_FLOOR": FLOOR_FAILURES,
        "ALGOVAULT_PAYMENT_DECLINE_RATE_MAX": DECLINE_RATE_PCT_MAX,
        "ALGOVAULT_PAYMENT_DECLINE_LEDGER": LEDGER,
        "predicate_version": PREDICATE_VERSION,
        "self_test_min_checks": SELF_TEST_MIN_CHECKS,
        "python": "%d.%d.%d" % sys.version_info[:3],
        "status_money_stuck": sorted(STATUS_MONEY_STUCK),
        "floor_window_days": FLOOR_WINDOW_DAYS,
        "rate_window_days": RATE_WINDOW_DAYS,
    }
    print(json.dumps(cfg, indent=2))
    return EXIT_PASS


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Payment decline-rate canary (small-n design).")
    parser.add_argument("--self-test", action="store_true", help="run the hermetic scenario suite and exit")
    parser.add_argument("--show-config", action="store_true", help="print resolved config and exit")
    parser.add_argument("--status-vocabulary", action="store_true",
                        help="print the 4-bucket status partition as JSON (cross-language parity seam)")
    a = parser.parse_args()
    if a.self_test:
        sys.exit(self_test())
    if a.status_vocabulary:
        sys.exit(status_vocabulary())
    if a.show_config:
        sys.exit(show_config())
    sys.exit(main())
