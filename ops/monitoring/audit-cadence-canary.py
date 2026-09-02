#!/usr/bin/env python3
"""audit-cadence-canary.py — page when a security audit comes DUE, and name the next dispatch.

OPS-AUDIT-CADENCE-CANARY-W1 CH2.

─── WHAT THIS RETIRES ──────────────────────────────────────────────────────────────────────────
`Claude files/rules/deploy-and-infra.md:25` says "monthly during active dev, quarterly
otherwise". That has failed as prose TWICE — 7.5 weeks before SECURITY-AUDIT-FULL-W1, 5 weeks
before SECURITY-AUDIT-MONTHLY-W1. CLAUDE.md: "Prose addressed to whoever happens to read it is
NOT a control. A rule that has once failed as prose must be retired into a gate, or accepted as
ignored and deleted."

─── THE CLOCK, AND THE INSTRUMENT RECORDED BESIDE THE NUMBER ───────────────────────────────────
Age is `now - max(audits[].completed_utc)`, where `now` is THIS HOST's own clock and
`completed_utc` is the PRODUCER's own recorded completion instant.

**NEVER the ledger file's mtime.** mtime is a property of the CONTAINER, not the claim, and
`declaration-sync.sh` rewrites this file hourly (`33 * * * *`) — so an mtime-keyed alarm reads
"fresh" forever and is silently, permanently green. That is this repo's most-recorded alarm
defect ("freshness alarms measure PRODUCERS, never rendered artifacts"), and the self-test pins
it with an explicit mtime-immunity probe.

─── VERDICTS AND EXIT CODES — 0/0/0/3, DELIBERATELY NOT THE SCHEMA GATE'S 0/1/3 ────────────────
    PASS           age < cadence - warn_lead          exit 0   no alert
    DUE            cadence - warn_lead <= age < cadence  exit 0   SECURITY_AUDIT_DUE (warn)
    OVERDUE        age >= cadence                      exit 0   SECURITY_AUDIT_OVERDUE (page)
    INDETERMINATE  absent / unparseable / empty / bad clock / future stamp   exit 3

DUE and OVERDUE exit 0 ON PURPOSE. This is a PAGING canary whose channel is Telegram: a non-zero
exit on a real OVERDUE makes cron mail an operator who already has the page, so the exit code
would be a second, worse notification channel. Its sibling `check-audit-cadence-schema.mjs` is a
BUILD gate and therefore maps FAIL to 1, because a build gate must fail the build. One meaning,
one exit code, chosen LOCALLY — the divergence is a decision. **Do not align them.**

**INDETERMINATE is the whole point of the token.** A missing or unparseable ledger must never
read as "no audit is overdue". Alerting is the channel; callers gate on the TOKEN, never the code.

─── SEVERITY, AND AN HONEST NOTE ABOUT WHAT `DUE` ACTUALLY DELIVERS ────────────────────────────
`send_telegram.sh:526` suppresses every severity other than the single delivering one
(`SUPPRESSED_SEVERITY: severity=$SEVERITY not in TG-fire set`). So:

    OVERDUE        -> CRITICAL_PERSISTENT -> DELIVERED to the operator (24h cooldown applies)
    INDETERMINATE  -> CRITICAL_PERSISTENT -> DELIVERED. A blind cadence guard is exactly the
                                             dark-guard class this wave exists to retire.
    DUE            -> WARN                -> LOGGED, NOT DELIVERED, by design.

    (The `->` before each severity is LOAD-BEARING PUNCTUATION, not styling.
     `scripts/check-alert-registry.mjs` shape 2 reads "the bare token immediately preceding the
     severity literal is an alert id", and it strips `#` comments but NOT Python docstrings —
     a docstring is a string, not a comment. Written as a bare column, `OVERDUE` and
     `INDETERMINATE` here minted PHANTOM alert ids and FAILed that gate. Measured, not theorised.)

**`warn_lead_days` is an INTERNAL STATE BOUNDARY, not a notification window.** Do not "fix" DUE
by escalating its severity to force delivery: at a 24h cooldown that is one page per day for
`warn_lead_days` days while nothing is actually late, and an alert that fires while nothing is
wrong gets muted — after which the OVERDUE page it was meant to precede is muted too. Day
`cadence_days` IS the deadline, not an overrun.

That last line is a real consequence, stated rather than left to be discovered: the operator's
first DELIVERED signal is OVERDUE at day `cadence_days`. DUE is the 7-day forensic heads-up that
lands in the alert log and supersedes itself into OVERDUE or PASS — which is also why its
alert-registry row carries `announce_resolution: false`. Making DUE page would emit one page per
day for `warn_lead_days` days before anything is actually late: chatter, which the recovery law
already forbids.

Usage:
    audit-cadence-canary.py              # evaluate, alert, print the verdict token
    audit-cadence-canary.py --self-test  # hermetic two-way suite, sends nothing
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

# ── seams: env-overridable so the self-test never touches production state ──────────────────
LEDGER = os.environ.get("AC_LEDGER", "/opt/algovault-monitoring/audit-cadence.json")
TG = os.environ.get("AC_TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")

ALERT_DUE = "SECURITY_AUDIT_DUE"
ALERT_OVERDUE = "SECURITY_AUDIT_OVERDUE"
ALERT_INDETERMINATE = "SECURITY_AUDIT_CADENCE_INDETERMINATE"

# The one severity send_telegram.sh delivers (:526). Everything else -> SUPPRESSED_SEVERITY.
SEVERITY_DELIVERED = "CRITICAL_PERSISTENT"
SEVERITY_WARN = "WARN"

EXIT_FOR = {"PASS": 0, "DUE": 0, "OVERDUE": 0, "INDETERMINATE": 3}

ALERT_FOR = {"DUE": ALERT_DUE, "OVERDUE": ALERT_OVERDUE, "INDETERMINATE": ALERT_INDETERMINATE}
SEVERITY_FOR = {"DUE": SEVERITY_WARN, "OVERDUE": SEVERITY_DELIVERED, "INDETERMINATE": SEVERITY_DELIVERED}


# ── pure functions, extracted so the self-test can assert THE ARTIFACTS THE SEAM REPLACES ───
# A hermetic self-test is structurally blind to exactly what its own seam bypasses. The seam here
# is `subprocess.run([...])`; so the argv BUILDER and the body FORMATTER are pure and asserted
# directly, rather than being the only code no scenario ever executes.

def parse_instant(s: str) -> datetime | None:
    """RFC-3339 UTC instant, `Z` only. Returns None rather than raising — a parser that raises
    turns 'proven able to fail' into 'crashes', which is not a verdict."""
    if not isinstance(s, str) or not s.endswith("Z"):
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def latest_audit(doc: dict) -> tuple[dict | None, datetime | None]:
    """The freshness key: max(audits[].completed_utc), by the PRODUCER's own stamp."""
    audits = doc.get("audits")
    if not isinstance(audits, list) or not audits:
        return None, None
    best, best_ts = None, None
    for a in audits:
        if not isinstance(a, dict):
            return None, None
        ts = parse_instant(a.get("completed_utc"))
        if ts is None:
            return None, None
        if best_ts is None or ts > best_ts:
            best, best_ts = a, ts
    return best, best_ts


def classify(age_days: float, cadence_days: int, warn_lead_days: int) -> str:
    """The band edges are CLOSED at the lower bound on purpose: `age == cadence - warn_lead` is
    DUE, and `age == cadence` is OVERDUE. Both boundaries are pinned in the self-test, because an
    off-by-one here shifts every page by a full day and nothing else would notice."""
    if age_days >= cadence_days:
        return "OVERDUE"
    if age_days >= cadence_days - warn_lead_days:
        return "DUE"
    return "PASS"


def next_wave_id(last_wave_id: str) -> str:
    """Derived from the ledger, NEVER hardcoded, and emitted in TEMPLATE form.

    CLAUDE.md forbids a literal next-wave number in new code ("Hardcoded `recommended_wave`
    FORBIDDEN. Template `OPS-<CLASS>-W{NEXT}`"). So we take the CLASS from the last entry's
    wave_id and hand back the template — `send_telegram.sh`'s resolver substitutes at send time,
    and on no-match it ships the placeholder verbatim rather than inventing a number."""
    if not isinstance(last_wave_id, str) or not last_wave_id:
        return "SECURITY-AUDIT-MONTHLY-W{NEXT}"
    base = last_wave_id.rsplit("-W", 1)[0] if "-W" in last_wave_id else last_wave_id
    return f"{base}-W{{NEXT}}"


def next_rotation_repo(doc: dict) -> str:
    rot = doc.get("rotation")
    slot = doc.get("rotation_slot")
    if not isinstance(rot, list) or not rot or not isinstance(slot, int):
        return "unknown"
    return str(rot[(slot + 1) % len(rot)])


def render_body(verdict: str, age_days: float, doc: dict, last: dict) -> str:
    """The rendered alert body. It NAMES THE NEXT ACTION so the dispatch is not remembered either.

    Every quantity carries its ENTITY NOUN. CLAUDE.md: "An entity ID in an alert body carries its
    entity noun; a bare parenthesised number next to a count is forbidden" — a bare `(new: 6)`
    once cost a real misread, where an operator read six subscriptions when there were two."""
    cadence = doc.get("cadence_days")
    over = int(age_days) - int(cadence) if isinstance(cadence, int) else None
    head = last.get("head_sha", "unknown")
    when = last.get("completed_utc", "unknown")
    wid = last.get("wave_id", "unknown")

    if verdict == "OVERDUE":
        # `over == 0` is the FIRST day of OVERDUE — the audit is due TODAY, not overrun. Rendering
        # that as "0 days overdue" on a first-ever delivered page teaches the operator the channel
        # exaggerates, and this canary's entire value is that its one page is believed. Day
        # `cadence_days` IS the deadline; `warn_lead_days` is an internal state boundary, not a
        # notification window (DUE never delivers — see the module docstring).
        if over == 0:
            lead = (f"Security audit is DUE TODAY — day {int(age_days)} of a {cadence}-day cadence. "
                    f"It is not yet overrun; it becomes overdue tomorrow.")
        else:
            lead = f"Security audit is {over} day(s) PAST DUE — {int(age_days)} days since the last one, cadence is {cadence} days."
    elif verdict == "DUE":
        left = int(cadence) - int(age_days) if isinstance(cadence, int) else "?"
        lead = f"Security audit is DUE in {left} day(s) — {int(age_days)} days since the last one, cadence is {cadence} days."
    else:
        lead = "Security-audit cadence could not be evaluated."

    return "\n".join([
        lead,
        f"Last audit: wave {wid}, completed {when}.",
        f"Next wave: {next_wave_id(wid)}.",
        f"Next BASELINE_SHA: {head} (the last audit's head_sha).",
        f"Rotation repo for the next wave: {next_rotation_repo(doc)}.",
        "That wave's R7 appends its own audits[] entry to ops/monitoring/audit-cadence.json — "
        "which is what keeps this canary's corpus alive. A gate whose corpus is maintained by "
        "prose is the defect the gate exists to retire.",
    ])


def build_argv(verdict: str) -> list[str]:
    """The argv the seam would execute. Pure, so the self-test asserts the BYPASSED artifact."""
    return [TG, ALERT_FOR[verdict], SEVERITY_FOR[verdict], "-"]


def build_clear_argv() -> list[str]:
    """OVERDUE -> PASS. One bounded resolution per DELIVERED page is signal, not chatter; the
    24h cooldown already bounds the fires this answers, so it needs no timer of its own.
    Whether it is actually announced is opt-in DATA on the alert-registry row
    (`announce_resolution`), never a decision made here — an absent row resolves to SILENT."""
    return [TG, "--clear", ALERT_OVERDUE, "a security audit has been completed; cadence is current again"]


# ── the seam ────────────────────────────────────────────────────────────────────────────────
def fire(verdict: str, body: str) -> None:
    try:
        subprocess.run(build_argv(verdict), input=body, text=True, timeout=60, check=False)
    except Exception as exc:  # noqa: BLE001 — an alert path must never take the canary down
        print(f"  ! alert dispatch failed ({exc.__class__.__name__}: {exc}) — verdict still reported below")


def clear() -> None:
    try:
        subprocess.run(build_clear_argv(), text=True, timeout=60, check=False)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! clear dispatch failed ({exc.__class__.__name__}: {exc})")


def load(path: str) -> tuple[dict | None, str]:
    if not os.path.exists(path):
        return None, f"ledger absent at {path}"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except json.JSONDecodeError as exc:
        return None, f"ledger unparseable: {exc}"
    except OSError as exc:
        return None, f"ledger unreadable: {exc}"
    if not isinstance(doc, dict):
        return None, "ledger root is not an object"
    return doc, ""


def evaluate(doc: dict | None, reason: str, now: datetime) -> tuple[str, dict]:
    """Pure decision. Returns (verdict, facts) and never raises."""
    if doc is None:
        return "INDETERMINATE", {"reason": reason}
    cadence = doc.get("cadence_days")
    warn = doc.get("warn_lead_days")
    if not isinstance(cadence, int) or not isinstance(warn, int) or cadence <= 0 or warn <= 0 or warn >= cadence:
        return "INDETERMINATE", {"reason": f"cadence_days/warn_lead_days unusable (cadence={cadence!r} warn_lead={warn!r})"}
    last, ts = latest_audit(doc)
    if last is None or ts is None:
        # Empty audits[] at CANARY time is a FACT about the world we were handed, so it is
        # INDETERMINATE. At BUILD time it is vacuity and check-audit-cadence-schema.mjs FAILs.
        # Two lifecycle points, two correct verdicts.
        return "INDETERMINATE", {"reason": "audits[] is empty, malformed, or carries an unparseable completed_utc"}
    if ts > now:
        return "INDETERMINATE", {"reason": f"latest completed_utc {last.get('completed_utc')} is in the FUTURE against this host's clock — age would be negative and the alarm could never fire"}
    age = (now - ts).total_seconds() / 86400.0
    return classify(age, cadence, warn), {"age_days": age, "cadence_days": cadence, "warn_lead_days": warn, "last": last}


def check() -> int:
    doc, reason = load(LEDGER)
    now = datetime.now(timezone.utc)
    verdict, facts = evaluate(doc, reason, now)

    # POSITIVE per-check output. A dark guard exiting 0 must not be indistinguishable from a
    # healthy one, so the numbers that produced the verdict are printed every run.
    print(f"audit-cadence-canary: host_clock={now.strftime('%Y-%m-%dT%H:%M:%SZ')} ledger={LEDGER}")
    if verdict == "INDETERMINATE":
        print(f"  ! could not evaluate: {facts.get('reason')}")
    else:
        last = facts["last"]
        print(f"  age_days={int(facts['age_days'])} cadence_days={facts['cadence_days']} "
              f"warn_lead_days={facts['warn_lead_days']} "
              f"due_at_age={facts['cadence_days'] - facts['warn_lead_days']} overdue_at_age={facts['cadence_days']}")
        print(f"  last audit: wave {last.get('wave_id')} completed {last.get('completed_utc')}")
        print(f"  next wave {next_wave_id(last.get('wave_id'))} · next rotation repo {next_rotation_repo(doc)}")

    if verdict in ("DUE", "OVERDUE", "INDETERMINATE"):
        body = render_body(verdict, facts.get("age_days", 0.0), doc or {}, facts.get("last", {})) \
            if verdict != "INDETERMINATE" else \
            f"Security-audit cadence canary could not evaluate: {facts.get('reason')}\nLedger: {LEDGER}\nA missing or unparseable ledger must never read as 'no audit is overdue'."
        print(f"  alert {ALERT_FOR[verdict]} severity {SEVERITY_FOR[verdict]}"
              + ("" if SEVERITY_FOR[verdict] == SEVERITY_DELIVERED else " (logged, not delivered — see the module docstring)"))
        fire(verdict, body)
    elif verdict == "PASS":
        # FIRING -> CLEAR hygiene. Unconditional: send_telegram.sh itself no-ops when no marker
        # exists, so asking it to clear a non-firing alert is free and cannot emit chatter.
        clear()

    print(f"AUDIT_CADENCE_VERDICT={verdict}")
    return EXIT_FOR[verdict]


# ── self-test ───────────────────────────────────────────────────────────────────────────────
def self_test() -> int:
    import tempfile

    results: list[tuple[str, bool, str]] = []

    def ck(name: str, fn, want) -> None:
        """Every assertion is WRAPPED. An assertion that RAISES is not an assertion — it aborts
        the suite and reads as a crash rather than a FAIL verdict."""
        try:
            got = fn()
        except Exception as exc:  # noqa: BLE001
            results.append((name, False, f"RAISED {exc.__class__.__name__}: {exc}"))
            return
        results.append((name, got == want, f"got {got!r}, want {want!r}"))

    NOW = datetime(2026, 9, 2, 12, 0, 0, tzinfo=timezone.utc)

    def ledger(days_ago: float, cadence: int = 30, warn: int = 7) -> dict:
        ts = (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {
            "schema_version": 1, "cadence_days": cadence, "warn_lead_days": warn,
            "rotation": ["algovault-bot", "autonomous-optimizer", "algovault-editorial", "algovault-skills"],
            "rotation_slot": 0,
            "audits": [{
                "wave_id": "SECURITY-AUDIT-MONTHLY-W1", "completed_utc": ts,
                "baseline_sha": "0" * 40, "head_sha": "c" * 40,
                "scope": ["crypto-quant-signal-mcp"],
            }],
        }

    v = lambda d, n=NOW: evaluate(d, "", n)[0]  # noqa: E731

    # ── all four verdicts ────────────────────────────────────────────────────────────────
    ck("verdict PASS well inside the window", lambda: v(ledger(1)), "PASS")
    ck("verdict DUE inside the warn lead", lambda: v(ledger(25)), "DUE")
    ck("verdict OVERDUE past the cadence", lambda: v(ledger(40)), "OVERDUE")
    ck("verdict INDETERMINATE on a None doc", lambda: evaluate(None, "absent", NOW)[0], "INDETERMINATE")

    # ── BOTH boundaries, closed at the lower edge ────────────────────────────────────────
    ck("boundary age == cadence - warn_lead is DUE (not PASS)", lambda: v(ledger(23)), "DUE")
    ck("boundary one second BEFORE that is still PASS", lambda: v(ledger(23 - 1 / 86400.0)), "PASS")
    ck("boundary age == cadence is OVERDUE (not DUE)", lambda: v(ledger(30)), "OVERDUE")
    ck("boundary one second BEFORE that is still DUE", lambda: v(ledger(30 - 1 / 86400.0)), "DUE")

    # ── the three FAIL-OPEN probes, through the REAL loader ──────────────────────────────
    # Each prints the token, so the CH2 gate can count AUDIT_CADENCE_VERDICT=INDETERMINATE >= 3
    # and cannot be satisfied by a single happy-path run.
    with tempfile.TemporaryDirectory() as tmp:
        missing = os.path.join(tmp, "nope.json")
        corrupt = os.path.join(tmp, "corrupt.json")
        empty = os.path.join(tmp, "empty.json")
        with open(corrupt, "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        with open(empty, "w", encoding="utf-8") as fh:
            json.dump({**ledger(1), "audits": []}, fh)

        def probe(p: str) -> str:
            doc, reason = load(p)
            verdict = evaluate(doc, reason, NOW)[0]
            print(f"AUDIT_CADENCE_VERDICT={verdict}")   # counted by the CH2 gate
            return verdict

        ck("FAIL-OPEN probe 1 — an ABSENT ledger is INDETERMINATE, never PASS", lambda: probe(missing), "INDETERMINATE")
        ck("FAIL-OPEN probe 2 — an UNPARSEABLE ledger is INDETERMINATE, never PASS", lambda: probe(corrupt), "INDETERMINATE")
        ck("FAIL-OPEN probe 3 — an EMPTY audits[] is INDETERMINATE at canary time", lambda: probe(empty), "INDETERMINATE")

        # ── mtime-immunity: the defect that would make this alarm permanently green ───────
        # declaration-sync.sh rewrites the ledger hourly. If age were keyed on mtime, an OVERDUE
        # ledger would read fresh forever.
        stale = os.path.join(tmp, "stale.json")
        with open(stale, "w", encoding="utf-8") as fh:
            json.dump(ledger(40), fh)          # 40 days old BY ITS OWN STAMP, mtime = now
        before = evaluate(load(stale)[0], "", NOW)[0]
        os.utime(stale, None)                   # touch — exactly what declaration-sync.sh does
        after = evaluate(load(stale)[0], "", NOW)[0]
        ck("mtime-immunity — a freshly-touched but 40-day-old ledger is still OVERDUE", lambda: (before, after), ("OVERDUE", "OVERDUE"))

    # ── a FUTURE stamp cannot silence the canary ─────────────────────────────────────────
    ck("a completed_utc in the FUTURE is INDETERMINATE, not PASS", lambda: v(ledger(-5)), "INDETERMINATE")

    # ── unusable config is INDETERMINATE, never PASS ─────────────────────────────────────
    ck("warn_lead >= cadence is INDETERMINATE", lambda: v(ledger(1, cadence=7, warn=7)), "INDETERMINATE")
    ck("a malformed audits[] entry is INDETERMINATE", lambda: v({**ledger(1), "audits": ["nope"]}), "INDETERMINATE")

    # ── THE BYPASSED ARTIFACT: the rendered send_telegram argv and body ──────────────────
    # The seam is subprocess.run. These assert what the seam would have executed.
    doc40 = ledger(40)
    last40 = doc40["audits"][0]
    body = render_body("OVERDUE", 40.0, doc40, last40)
    argv = build_argv("OVERDUE")

    ck("argv[1] is a REGISTERED alert id", lambda: argv[1] in (ALERT_DUE, ALERT_OVERDUE, ALERT_INDETERMINATE), True)
    ck("argv severity for OVERDUE is the only one send_telegram delivers", lambda: argv[2], SEVERITY_DELIVERED)
    ck("argv severity for DUE is the non-delivering warn (logged by design)", lambda: build_argv("DUE")[2], SEVERITY_WARN)
    ck("argv body is stdin ('-'), matching the wrapper's 3-arg contract", lambda: argv[3], "-")
    ck("clear argv targets OVERDUE via --clear", lambda: build_clear_argv()[1:3], ["--clear", ALERT_OVERDUE])

    ck("body carries days-past-due WITH its entity noun", lambda: "10 day(s) PAST DUE" in body, True)

    # ── the two OVERDUE renderings are DISTINCT (architect correction, 2026-09-02) ───────
    # `over == 0` is the first day of OVERDUE: the audit is due TODAY, not overrun. A first-ever
    # delivered page reading "0 days overdue" trains the operator to discount the channel.
    body_today = render_body("OVERDUE", 30.0, ledger(30), ledger(30)["audits"][0])
    ck("age == cadence renders DUE TODAY, never '0 days'", lambda: "DUE TODAY" in body_today, True)
    ck("the due-today body names the day and the cadence", lambda: "day 30 of a 30-day cadence" in body_today, True)
    ck("the due-today body says it is NOT yet overrun", lambda: "not yet overrun" in body_today, True)
    ck("the due-today body never claims a past-due count", lambda: "PAST DUE" in body_today, False)
    ck("age > cadence still renders PAST DUE, not DUE TODAY", lambda: "DUE TODAY" in body, False)
    ck("body carries the last wave_id WITH its entity noun", lambda: "wave SECURITY-AUDIT-MONTHLY-W1" in body, True)
    ck("body carries the next BASELINE_SHA (the last head_sha)", lambda: ("c" * 40) in body, True)
    ck("body carries the rotation repo for the next wave", lambda: "autonomous-optimizer" in body, True)
    ck("body names the R7 append that keeps the corpus alive", lambda: "R7 appends its own audits[] entry" in body, True)
    ck("next wave id is TEMPLATE form, never a literal number", lambda: "SECURITY-AUDIT-MONTHLY-W{NEXT}" in body, True)
    ck("no bare literal next-wave number leaked into the body", lambda: "SECURITY-AUDIT-MONTHLY-W2" in body, False)
    print("ALERT_BODY_ASSERTED")   # the CH2 gate counts this

    # ── the token -> exit-code mapping, ASSERTED not observed ────────────────────────────
    ck("mapping PASS -> 0", lambda: EXIT_FOR["PASS"], 0)
    ck("mapping DUE -> 0 (a page must not also mail cron)", lambda: EXIT_FOR["DUE"], 0)
    ck("mapping OVERDUE -> 0 (same reason)", lambda: EXIT_FOR["OVERDUE"], 0)
    ck("mapping INDETERMINATE -> 3 (token-law default)", lambda: EXIT_FOR["INDETERMINATE"], 3)
    ck("exactly four verdicts, no fifth state", lambda: sorted(EXIT_FOR), ["DUE", "INDETERMINATE", "OVERDUE", "PASS"])

    # ── vacuity guard on the SUITE ITSELF ────────────────────────────────────────────────
    if not results:
        print("SELF-TEST: REFUSING — zero assertions ran")
        print("AUDIT_CADENCE_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  [{detail}]"))
    bad = [r for r in results if not r[1]]
    if bad:
        print(f"SELF-TEST: FAIL ({len(bad)} of {len(results)})")
        print("AUDIT_CADENCE_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]
    print(f"SELF-TEST: PASS ({len(results)})")
    print("AUDIT_CADENCE_VERDICT=PASS")
    return EXIT_FOR["PASS"]


def main(argv: list[str]) -> int:
    return self_test() if "--self-test" in argv else check()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
