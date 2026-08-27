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

  cus_UuBrP1otU51OBm · sub_1TuNZs… · in_1U5cMX… · pi_3U5dJU…      <- ONE of each
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
fingerprint `NErSOdf0ZP9j0cJB`, last4 7755, two Stripe customer records created 48 MINUTES apart
with different emails, both `past_due`. One payer, counted twice; true distinct instruments 2,
which does not breach a floor of 3.

So the live unit is now the CARD FINGERPRINT — Stripe's stable per-card id, opaque and not a PAN.
Stripe inflates per PAYMENT (dunning), then per CUSTOMER RECORD (one person, many accounts); it
cannot inflate per CARD. That is what makes this the terminal rung rather than the next surprise.

All three units are computed and REPORTED on every run. The gaps are the diagnosis:
instruments→customers is DUPLICATE ACCOUNTS, customers→payments is DUNNING RETRIES.

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
import json
import os
import subprocess
import sys
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
    fingerprint `NErSOdf0ZP9j0cJB`, last4 7755, two Stripe customer records created 48 minutes
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


def classify(failures_7d, failures_30d, successes_30d, payments_7d=None, payments_30d=None,
             customers_7d=None, customers_30d=None):
    """Pure verdict. Returns (verdict, reasons, facts) — no I/O, no clock.

    `failures_*` are DISTINCT CUSTOMERS; `payments_*` are the prior distinct-payment unit,
    carried for reporting only. Passing them as None keeps every existing caller working and
    renders as `-`, never as 0 — a number we do not have must not print as a measurement.
    """
    n = successes_30d + failures_30d
    facts = {
        "n_30d": n,
        "successes_30d": successes_30d,
        "failures_30d": failures_30d,
        "failures_7d": failures_7d,
        "payments_7d": payments_7d,
        "payments_30d": payments_30d,
        "customers_7d": customers_7d,
        "customers_30d": customers_30d,
        "failure_unit": "distinct payment instruments (keyed card ref)",
        "min_n": MIN_N,
        "rate_predicate": "ACTIVE" if n >= MIN_N else "INERT (n < MIN_N)",
        "decline_rate_pct_30d": (round(failures_30d * 100.0 / n, 1) if n > 0 else None),
    }
    reasons = []

    # Absolute floor — live from n=1. This is the only predicate that can fire today.
    if failures_7d >= FLOOR_FAILURES:
        reasons.append(
            "ABSOLUTE FLOOR breached: %d distinct PAYMENT INSTRUMENTS (cards) failed in the "
            "last %dd (threshold >= %d)" % (failures_7d, FLOOR_WINDOW_DAYS, FLOOR_FAILURES)
        )

    # Rate predicate — structurally inert below MIN_N.
    if n >= MIN_N and facts["decline_rate_pct_30d"] is not None:
        if facts["decline_rate_pct_30d"] > DECLINE_RATE_PCT_MAX:
            reasons.append(
                "DECLINE RATE %.1f%% over Last %dd exceeds %.1f%% (n=%d: %d failing instruments / "
                "%d converted)"
                % (facts["decline_rate_pct_30d"], RATE_WINDOW_DAYS, DECLINE_RATE_PCT_MAX,
                   n, failures_30d, successes_30d)
            )

    return ("FAIL" if reasons else "PASS"), reasons, facts


def _n(v):
    """Render an ABSENT number as '-', never as 0. A count we do not have is not a count of 0."""
    return "-" if v is None else str(v)


def build_body(reasons, facts):
    lines = ["🛑 %s" % ALERT_ID]
    lines.extend(reasons)
    lines.append(
        "Facts — Last %dd: n=%d (%d converted + %d failing cards) · rate=%s · Last %dd failing cards=%d · rate predicate %s"
        % (RATE_WINDOW_DAYS, facts["n_30d"], facts["successes_30d"], facts["failures_30d"],
           ("%.1f%%" % facts["decline_rate_pct_30d"]) if facts["decline_rate_pct_30d"] is not None else "unmeasured",
           FLOOR_WINDOW_DAYS, facts["failures_7d"], facts["rate_predicate"])
    )
    lines.append(
        "Three units, %dd / %dd — the GAPS are the diagnosis:"
        % (FLOOR_WINDOW_DAYS, RATE_WINDOW_DAYS)
    )
    lines.append("  cards (live unit): %s / %s" % (_n(facts.get("failures_7d")), _n(facts.get("failures_30d"))))
    lines.append("  customer records:  %s / %s   — a gap above means DUPLICATE ACCOUNTS on one card"
                 % (_n(facts.get("customers_7d")), _n(facts.get("customers_30d"))))
    lines.append("  distinct payments: %s / %s   — a gap above means Stripe DUNNING RETRIES"
                 % (_n(facts.get("payments_7d")), _n(facts.get("payments_30d"))))
    lines.append("The floor counts CARDS. One person holding several Stripe customer records, or "
                 "one card dunned for weeks, is ONE failing payer and must not read as several.")
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


def append_observation(facts):
    """Append the observed n so the MIN_N crossing RATE is measured, not guessed later.

    Best-effort: a ledger write must never change the verdict.
    """
    try:
        os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
        row = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "n_30d": facts["n_30d"], "successes_30d": facts["successes_30d"],
               "failures_30d": facts["failures_30d"], "failures_7d": facts["failures_7d"],
               "min_n": MIN_N, "rate_predicate": facts["rate_predicate"]}
        with open(LEDGER, "a") as fh:
            fh.write(json.dumps(row) + "\n")
    except Exception as exc:                                    # noqa: BLE001
        log("ledger append failed (non-fatal): %s" % exc)


_LAST_BODY = {"text": None}


def fire(body):
    _LAST_BODY["text"] = body
    if os.environ.get("ALGOVAULT_CANARY_SELFTEST") == "1":
        log("WOULD_FIRE: (self-test — wrapper skipped)")
        return
    try:
        subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"], input=body,
                       capture_output=True, text=True, timeout=30)
    except Exception as exc:                                    # noqa: BLE001
        log("wrapper invocation failed (fail-open): %s" % exc)


def main():
    try:
        failures_7d = parse_count(_psql(build_failure_count_query(FLOOR_WINDOW_DAYS)))
        failures_30d = parse_count(_psql(build_failure_count_query(RATE_WINDOW_DAYS)))
        successes_30d = parse_count(_psql(build_success_count_query(RATE_WINDOW_DAYS)))
        # Reported, never predicated on. Unparseable here is NOT indeterminate: the verdict does
        # not depend on it, so it degrades to '-' rather than escalating a healthy run.
        payments_7d = parse_count(_psql(build_payment_count_query(FLOOR_WINDOW_DAYS)))
        payments_30d = parse_count(_psql(build_payment_count_query(RATE_WINDOW_DAYS)))
        customers_7d = parse_count(_psql(build_customer_count_query(FLOOR_WINDOW_DAYS)))
        customers_30d = parse_count(_psql(build_customer_count_query(RATE_WINDOW_DAYS)))
    except Exception as exc:                                    # noqa: BLE001
        log("DB unreadable: %s" % exc)
        # Fail-open in the sense that we do not crash — but a blind canary ESCALATES. An
        # exit-0 here would be indistinguishable from a healthy run, which is the dark-guard
        # failure this estate keeps repeating.
        fire("🛑 %s\nCanary could not read the database — decline monitoring is DARK.\n%s\nAction: dispatch %s via Cowork → Claude Code"
             % (ALERT_ID, str(exc)[:200], RECOMMENDED_WAVE))
        print("PAYMENT_DECLINE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE

    if failures_7d is None or failures_30d is None or successes_30d is None:
        # Handed input we could not PARSE ⇒ genuinely indeterminate (distinct from an empty
        # world, which is a fact and passes).
        log("unparseable count(s): 7d=%r 30d=%r succ=%r" % (failures_7d, failures_30d, successes_30d))
        fire("🛑 %s\nCanary read the database but could not parse its counts — monitoring is DARK.\nAction: dispatch %s via Cowork → Claude Code"
             % (ALERT_ID, RECOMMENDED_WAVE))
        print("PAYMENT_DECLINE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE

    verdict, reasons, facts = classify(failures_7d, failures_30d, successes_30d,
                                       payments_7d, payments_30d, customers_7d, customers_30d)
    append_observation(facts)

    # POSITIVE per-check output — never "absence of an alert". A row silently skipped by a
    # load error must not look identical to a row that passed.
    log("Last %dd: n=%d (%d converted + %d failing cards) rate=%s | Last %dd failing cards=%d "
        "(floor >= %d) | customer records: %s/%s | distinct payments: %s/%s | rate predicate %s"
        % (RATE_WINDOW_DAYS, facts["n_30d"], facts["successes_30d"], facts["failures_30d"],
           ("%.1f%%" % facts["decline_rate_pct_30d"]) if facts["decline_rate_pct_30d"] is not None else "unmeasured",
           FLOOR_WINDOW_DAYS, facts["failures_7d"], FLOOR_FAILURES,
           _n(facts["customers_7d"]), _n(facts["customers_30d"]),
           _n(facts["payments_7d"]), _n(facts["payments_30d"]),
           facts["rate_predicate"]))

    if verdict == "FAIL":
        fire(build_body(reasons, facts))
        print("PAYMENT_DECLINE_VERDICT=FAIL")
        return EXIT_FAIL

    print("PAYMENT_DECLINE_VERDICT=PASS")
    return EXIT_PASS


# ── Hermetic self-test ──────────────────────────────────────────────────────────────────

def self_test():
    os.environ["ALGOVAULT_CANARY_SELFTEST"] = "1"
    passed, failed = [], []

    def check(label, cond):
        (passed if cond else failed).append(label)

    # --- classify(): the two predicates -------------------------------------------------
    v, r, f = classify(failures_7d=0, failures_30d=0, successes_30d=0)
    check("empty world ⇒ PASS (a fact, NOT indeterminate)", v == "PASS" and r == [])
    check("empty world reports rate as unmeasured, not 0%", f["decline_rate_pct_30d"] is None)

    v, r, f = classify(failures_7d=1, failures_30d=1, successes_30d=9)
    check("today's live shape (n=10, 1 failure) ⇒ PASS", v == "PASS")
    check("rate predicate INERT below MIN_N", f["rate_predicate"].startswith("INERT"))

    v, r, _ = classify(failures_7d=3, failures_30d=3, successes_30d=1)
    check("absolute floor fires at 3 failures/7d even at tiny n", v == "FAIL" and any("FLOOR" in x for x in r))

    v, r, f = classify(failures_7d=0, failures_30d=1, successes_30d=25)
    check("n >= MIN_N activates the rate predicate", f["rate_predicate"] == "ACTIVE")
    check("healthy rate above MIN_N still PASSes", v == "PASS")

    v, r, f = classify(failures_7d=0, failures_30d=15, successes_30d=10)
    check("rate breach above MIN_N ⇒ FAIL", v == "FAIL" and any("DECLINE RATE" in x for x in r))
    check("rate breach reports n alongside the rate", any("n=25" in x for x in r))

    # A rate that WOULD breach but sits below MIN_N must stay silent — the small-n guarantee.
    v, r, f = classify(failures_7d=2, failures_30d=2, successes_30d=1)
    check("high rate below MIN_N does NOT fire the rate predicate", not any("DECLINE RATE" in x for x in r))
    check("...and below the floor it is PASS", v == "PASS")

    # --- BYPASSED ARTIFACTS: the SQL builders + the parser -------------------------------
    # These are the ONLY functions the hermetic seam replaces, so they get asserted directly.
    q7 = build_failure_count_query(7)
    check("failure query counts DISTINCT payments, not rows", "COUNT(DISTINCT" in q7 and "COUNT(*)" not in q7)
    # FLIPPED, not deleted. The old assertion pinned `COALESCE(payment_intent_id, event_id)` —
    # the exact expression that scored one dunned customer as three failed payments. The unit is
    # now the customer, and the OLD unit is retained under its own builder and asserted there, so
    # the change is visible in the suite rather than silently swapped.
    # FLIPPED again, not deleted. The customer unit fixed dunning inflation; it could not fix
    # ONE CARD held across several customer records, which is what fired the floor on 2026-08-27.
    check("failure query counts distinct CARD REFS first",
          "COALESCE(fp.card_ref, f.customer_id, f.payment_intent_id, f.event_id)" in q7)
    check("...and still never DROPS a row that has none of them (event_id is the last resort)",
          "f.event_id))" in q7 and "COUNT(DISTINCT COALESCE(" in q7)
    check("🛑 the fingerprint is joined PER CUSTOMER, not read per row — an invoice event carries "
          "no card node, so a per-row COALESCE would re-split the very accounts this merges",
          "DISTINCT ON (customer_id)" in q7 and "LEFT JOIN fp ON fp.customer_id = f.customer_id" in q7)
    check("...pinned to ONE fingerprint per customer, so a second card cannot fan the join out",
          "ORDER BY customer_id, occurred_at DESC" in q7)
    check("...and a blank fingerprint never becomes a key",
          "coalesce(trim(card_ref),'') <> ''" in q7)
    check("the CUSTOMER unit is retained as a prior, not deleted",
          "COALESCE(customer_id, payment_intent_id, event_id)" in build_customer_count_query(7)
          and "card_ref" not in build_customer_count_query(7))
    check("the PAYMENT unit is retained too, so all three are comparable on every run",
          "COALESCE(payment_intent_id, event_id)" in build_payment_count_query(7)
          and "customer_id" not in build_payment_count_query(7))
    check("the customer-unit builder carries its own window",
          "INTERVAL '30 days'" in build_customer_count_query(30))
    try:
        build_customer_count_query(0)
        check("customer-unit builder rejects a bad window", False)
    except ValueError:
        check("customer-unit builder rejects a bad window", True)
    for bad in ("7; DROP TABLE x", None, 1.5):
        try:
            build_customer_count_query(bad)
            check("customer-unit builder REFUSES %r rather than crashing" % (bad,), False)
        except ValueError:
            check("customer-unit builder REFUSES %r rather than crashing" % (bad,), True)
        except Exception:
            check("customer-unit builder REFUSES %r rather than crashing" % (bad,), False)
    check("the prior-unit builder carries its own window",
          "INTERVAL '30 days'" in build_payment_count_query(30))
    try:
        build_payment_count_query(0)
        check("prior-unit builder rejects a bad window", False)
    except ValueError:
        check("prior-unit builder rejects a bad window", True)
    check("failure query carries its window", "INTERVAL '7 days'" in q7)
    check("success query targets subscriber_profiles/converted_at",
          "subscriber_profiles" in build_success_count_query(30) and "converted_at" in build_success_count_query(30))
    try:
        build_failure_count_query("7; DROP TABLE stripe_payment_failures")
        check("query builder rejects a non-int window", False)
    except ValueError:
        check("query builder rejects a non-int window", True)

    check("parser reads a plain psql scalar", parse_count("12\n") == 12)
    check("parser reads zero", parse_count("0\n") == 0)
    check("parser returns None for an EMPTY result (not 0)", parse_count("") is None and parse_count("  \n") is None)
    check("parser returns None for garbage", parse_count("ERROR: relation does not exist") is None)
    check("parser returns None for None", parse_count(None) is None)

    # --- token → EXIT CODE mapping (the token alone is not the contract) -----------------
    check("PASS maps to exit 0", EXIT_PASS == 0)
    check("FAIL maps to exit 1", EXIT_FAIL == 1)
    check("INDETERMINATE maps to exit 3 (new-gate default, NOT the sibling's 2)", EXIT_INDETERMINATE == 3)

    # --- rendered alert BODY, not merely the verdict --------------------------------------
    v, r, f = classify(failures_7d=5, failures_30d=5, successes_30d=0)
    body = build_body(r, f)
    check("body names the alert id", ALERT_ID in body)
    check("body carries the templated wave, never a literal W-number", "W{NEXT}" in body)
    check("body states the CARD semantics", "The floor counts CARDS" in body)
    check("body names duplicate accounts as the customer-gap meaning", "DUPLICATE ACCOUNTS" in body)
    check("body carries n alongside every count", "n=5" in body)
    check("body names dunning retries as the reason the two units can differ",
          "DUNNING RETRIES" in body)

    # --- THE REGRESSION, as the live 2026-08-22 numbers -----------------------------------
    # ONE customer / ONE subscription / ONE invoice / ONE PaymentIntent, dunned twice. The old
    # unit scored 3 and paged; the customer unit scores 1 and must not.
    v1, r1, f1 = classify(failures_7d=1, failures_30d=1, successes_30d=4,
                          payments_7d=3, payments_30d=3)
    check("THE REGRESSION: one dunned customer does NOT trip the floor", v1 == "PASS")
    check("...while the prior unit would have (3 >= 3)", f1["payments_7d"] >= FLOOR_FAILURES)
    check("...and both units are carried so the gap is auditable",
          (f1["failures_7d"], f1["payments_7d"]) == (1, 3))
    check("...and the facts name their unit rather than leaving it implied",
          f1["failure_unit"] == "distinct payment instruments (keyed card ref)")

    # --- THE 2026-08-27 REGRESSION, as its live numbers ---------------------------------
    # 3 customer records, 5 distinct payments, but only TWO physical cards (two records shared
    # fingerprint NErSOdf0ZP9j0cJB). The floor must read 2 and stay silent.
    v5, r5, f5 = classify(failures_7d=2, failures_30d=2, successes_30d=2,
                          payments_7d=5, payments_30d=10, customers_7d=3, customers_30d=3)
    check("THE REGRESSION: one card across two customer records does NOT trip the floor", v5 == "PASS")
    check("...while the CUSTOMER unit would have (3 >= 3)", f5["customers_7d"] >= FLOOR_FAILURES)
    check("...and all three units are carried so both gaps are auditable",
          (f5["failures_7d"], f5["customers_7d"], f5["payments_7d"]) == (2, 3, 5))
    b5 = build_body(["x"], f5)
    check("...and the body renders all three, labelled", "cards (live unit): 2" in b5
          and "customer records:  3" in b5 and "distinct payments: 5" in b5)

    # PROVEN able to fail in the other direction: three genuinely distinct customers still page.
    v2, _, _ = classify(failures_7d=3, failures_30d=3, successes_30d=4, payments_7d=3, payments_30d=3)
    check("three DISTINCT customers still trip the floor (the alarm is not disarmed)", v2 == "FAIL")
    v3, _, _ = classify(failures_7d=2, failures_30d=2, successes_30d=4, payments_7d=9, payments_30d=9)
    check("two customers with nine retries between them do NOT trip it", v3 == "PASS")

    # An absent prior-unit count renders as '-', never as 0 — it is reported, never predicated on.
    _, r4, f4 = classify(failures_7d=3, failures_30d=3, successes_30d=0,
                         payments_7d=None, payments_30d=None)
    check("an absent prior-unit count renders as '-', never 0",
          "distinct payments: - / -" in build_body(r4, f4))
    check("_n renders a real zero as 0 and an absent value as '-'", (_n(0), _n(None)) == ("0", "-"))

    # --- vacuity guard --------------------------------------------------------------------
    # WE built this corpus, so empty here means the suite built nothing — a defect in the test.
    check("self-test corpus is non-empty (vacuity guard)", len(passed) + len(failed) >= 55)

    for label in failed:
        sys.stderr.write("  SELF-TEST FAIL: %s\n" % label)
    sys.stderr.write("[payment-decline-canary] self-test: %d passed, %d failed\n" % (len(passed), len(failed)))
    ok = not failed
    print("PAYMENT_DECLINE_VERDICT=%s" % ("PASS" if ok else "FAIL"))
    return EXIT_PASS if ok else EXIT_FAIL


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
        "floor_window_days": FLOOR_WINDOW_DAYS,
        "rate_window_days": RATE_WINDOW_DAYS,
    }
    print(json.dumps(cfg, indent=2))
    return EXIT_PASS


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Payment decline-rate canary (small-n design).")
    parser.add_argument("--self-test", action="store_true", help="run the hermetic scenario suite and exit")
    parser.add_argument("--show-config", action="store_true", help="print resolved config and exit")
    a = parser.parse_args()
    if a.self_test:
        sys.exit(self_test())
    if a.show_config:
        sys.exit(show_config())
    sys.exit(main())
