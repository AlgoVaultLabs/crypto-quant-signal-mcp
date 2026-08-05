#!/usr/bin/env python3
"""
x402-claim-liveness-prober.py — prove the paid claim path still WORKS, without a customer.

OPS-ZERO-VS-UNKNOWN-W2 · Ch1. This ships BEFORE the refuse-on-indeterminate behaviour it guards,
and it is the wave's gate: if this cannot be proven to fire, Ch2 does not ship.

── WHY A PROBER AND NOT A COUNTER ────────────────────────────────────────────────────────────
`tryClaimPayment`'s Postgres branch broke and the paid rail served nothing for ~25 hours. Every
gate was green; the fail-safe logged to stderr and returned `false`, indistinguishable from
"already claimed". It was found by an unrelated read-only probe, not by any alarm.

The obvious remedy — count the errors and alert on a rate — is DARK BY CONSTRUCTION here.
REVENUE-TRUTH-W1 measured external settled x402 revenue at $0.00 across four months: no paid
traffic means no failures means no signal. The quota canary already demonstrated this exact
failure from the other side, reading a 2,000/day three-day burst as `~31.6/day` off a lifetime
average and returning SILENT_BY_DESIGN on every pass.

So the detector has to GENERATE ITS OWN TRAFFIC. It executes a real claim, against the real
table, through the real SQL, and asserts the real outcome.

── WHY IT INSERTS AND DELETES FOR REAL ───────────────────────────────────────────────────────
A `BEGIN … ROLLBACK` would never exercise commit-time arbitration — and commit-time arbitration
is precisely what broke: `ON CONFLICT (nonce)` stopped matching the composite primary key, so
Postgres refused every claim. A probe that rolls back would have stayed green through the entire
outage. This one would not.

── HOW IT CANNOT TOUCH A REAL PAYMENT ────────────────────────────────────────────────────────
Measured on prod: every real `payer_wallet` is a 42-char `0x`-prefixed EVM address, or the empty
string (the four back-filled unattributable rows). The sentinel below is neither — it is not
hex, not 42 chars, not empty — so no real payer can produce it and no real row can match it.
Cleanup is keyed on THE SENTINEL PAYER ALONE, so a DELETE cannot reach a real payment even if
every other value were wrong. A stale probe row (crash between insert and delete) is swept at the
START of the next run, so it self-heals instead of accumulating.

Exit: 0 = claim path healthy · 1 = BROKEN (alerted) · 3 = INDETERMINATE (could not determine).
Emits exactly one terminal X402_CLAIM_LIVENESS_VERDICT=PASS|FAIL|INDETERMINATE.

Usage:
  x402-claim-liveness-prober.py            # probe, alert on failure
  x402-claim-liveness-prober.py --self-test  # offline: prove the guards, no DB, no alert
"""
import ast
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

PG_CONTAINER = os.environ.get("X402_PROBE_PG_CONTAINER", "crypto-quant-signal-mcp-postgres-1")
PG_DB = os.environ.get("X402_PROBE_PG_DB", "signal_performance")
WRAPPER = os.environ.get("X402_PROBE_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
ALERT_ID = "X402_CLAIM_PATH_BROKEN"
# Overridable ONLY so the RED proof can reproduce the outage against a scratch table. Production
# runs the default; the override is never set in the crontab.
TABLE = os.environ.get("X402_PROBE_TABLE", "processed_x402_payments")

# The sentinel. NOT 0x-prefixed, NOT 42 chars, NOT empty — outside the space of every real payer.
# Changing this string is a safety-critical edit: it is the ONLY thing separating the prober's
# cleanup from production payment rows.
SENTINEL_PAYER = "probe:claim-liveness"

# CH7(d) — the census contract, as DATA rather than as literals buried in the guard.
#
# Whitespace-tolerant and case-insensitive on purpose: Postgres does not care how a statement is
# spaced or cased, so a guard that does is a guard an author evades by accident. `DELETE\s+FROM`
# with `re.I` catches `delete from`, `DELETE  FROM` and `DELETE\nFROM` alike, and including the
# other destructive verbs is what makes an UPDATE or a TRUNCATE against the production payments
# table a self-test FAILURE instead of something nobody was looking for.
DESTRUCTIVE_VERB_RE = re.compile(r"\b(DELETE\s+FROM|UPDATE|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE)\b", re.IGNORECASE)

# The ONLY predicate a cleanup DELETE in this prober may carry, compared with `==` after whitespace
# normalisation. `in` let anything appended after the match ride along.
EXPECTED_CLEANUP_PREDICATE = "payer_wallet = '%s'"


def _pg_role():
    out = subprocess.run(["docker", "exec", PG_CONTAINER, "printenv", "POSTGRES_USER"],
                         capture_output=True, text=True, timeout=20)
    role = out.stdout.strip()
    if not role:
        raise RuntimeError("could not read POSTGRES_USER from the pg container")
    return role


def _psql(sql, role, fieldsep="|"):
    """One psql -c call. Single quotes are natural here (no node -e / ssh quoting layers)."""
    # -q is load-bearing: without it psql emits the command TAG ("INSERT 0 1", "DELETE 1")
    # on the same stream as the RETURNING rows, so every row count is off by one and the
    # returned nonce arrives with a status line glued to it. The prober's first live run
    # reported a FALSE BROKEN for exactly this reason.
    args = ["docker", "exec", PG_CONTAINER, "psql", "-U", role, "-d", PG_DB,
            "-tAq", "-F", fieldsep, "-v", "ON_ERROR_STOP=1", "-c", sql]
    out = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % out.stderr.strip()[:300])
    return out.stdout.strip()


def sentinel_guard(payer):
    """
    Refuse to run if the sentinel could match a real payer. This is a PRE-CONDITION, not a
    formality: the cleanup DELETE is keyed on it, so a sentinel that looked like an address
    would let this script delete customer payment records.
    """
    if not payer:
        return "sentinel is empty — it would match the back-filled unattributable rows"
    if payer.startswith("0x"):
        return "sentinel starts with 0x — it could collide with a real EVM payer"
    if len(payer) == 42:
        return "sentinel is 42 chars — the length of a real EVM address"
    return None


def probe(role, now_iso):
    """Insert a synthetic claim, assert it was claimed, then remove it. Returns per-check lines."""
    checks = []
    nonce = "probe:%s" % now_iso

    swept = _psql("DELETE FROM %s WHERE payer_wallet = '%s' RETURNING nonce;" % (TABLE, SENTINEL_PAYER), role)
    n_swept = len([x for x in swept.splitlines() if x.strip()])
    checks.append("CHECK sweep_stale:     %d stale probe row(s) removed before insert" % n_swept)

    # THE CLAIM. Same table, same conflict target as production. If ON CONFLICT stops matching the
    # primary key — the actual 25-hour defect — psql raises here and this probe fails.
    got = _psql(
        "INSERT INTO %s (nonce, payer_wallet, tool, amount) "
        "VALUES ('%s', '%s', 'probe', '0') "
        "ON CONFLICT (payer_wallet, nonce) DO NOTHING RETURNING nonce;" % (TABLE, nonce, SENTINEL_PAYER),
        role)
    if got.strip() != nonce:
        raise RuntimeError("claim did not return the inserted nonce (got %r) — the claim path is NOT serving"
                           % got.strip()[:80])
    checks.append("CHECK claim_succeeded: nonce claimed and returned (the ON CONFLICT target resolves)")

    # Replay must still be refused — the property the claim exists for.
    replay = _psql(
        "INSERT INTO %s (nonce, payer_wallet, tool, amount) "
        "VALUES ('%s', '%s', 'probe', '0') "
        "ON CONFLICT (payer_wallet, nonce) DO NOTHING RETURNING nonce;" % (TABLE, nonce, SENTINEL_PAYER),
        role)
    if replay.strip():
        raise RuntimeError("a replay of the same (payer, nonce) was CLAIMED AGAIN — dedup is broken")
    checks.append("CHECK replay_refused:  a second claim of the same (payer,nonce) returned nothing")

    left = _psql("DELETE FROM %s WHERE payer_wallet = '%s' RETURNING nonce;" % (TABLE, SENTINEL_PAYER), role)
    n_left = len([x for x in left.splitlines() if x.strip()])
    if n_left != 1:
        raise RuntimeError("cleanup removed %d rows, expected exactly 1" % n_left)
    checks.append("CHECK cleaned_up:      exactly 1 synthetic row removed; 0 probe rows remain")

    residual = _psql("SELECT count(*) FROM %s WHERE payer_wallet = '%s';" % (TABLE, SENTINEL_PAYER), role)
    if residual.strip() != "0":
        raise RuntimeError("probe rows remain after cleanup: %s" % residual.strip())
    checks.append("CHECK no_residue:      confirmed 0 rows for the sentinel payer")
    return checks


def alert(body):
    """Route through the canonical wrapper — never re-implement its severity/cooldown gates."""
    try:
        proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"],
                              input=body, text=True, capture_output=True, timeout=60)
        return proc.returncode
    except Exception as exc:  # an alerting failure must not mask the finding
        print("FAIL_OPEN wrapper error: %s" % exc, file=sys.stderr)
        return -1


# REVENUE-METER-TRUTH-W6 CH7(d) — the SELF-GUARD, rebuilt as a DESTRUCTIVE-VERB CENSUS.
#
# The two properties this guard asserts were always the right ones — the sentinel sits outside the
# real payer space, and every cleanup DELETE is keyed on it. The METHOD was the hole. It read its
# own source, split on the literal "DELETE FROM", and inspected the first 160 characters after each
# fragment. Measured at 885c90d, that had three genuine false-NEGATIVE classes and one
# false-POSITIVE hazard:
#
#   (a) `in`, not `==`. Nothing AFTER the matched substring was inspected, so
#       `WHERE payer_wallet = '%s' OR 1=1` PASSED and deletes every row in the table.
#   (b) A str.split corpus is lexical. `delete from`, `DELETE  FROM`, `DELETE\n FROM`,
#       `"DELETE " + "FROM "`, or an f-string yield ZERO fragments — INVISIBLE, not merely
#       unchecked. Postgres is case- and whitespace-indifferent; this guard was not.
#   (c) Only DELETE was in the corpus at all. `UPDATE`, `TRUNCATE`, `DROP TABLE` and `INSERT`
#       were never inspected — a TRUNCATE would have destroyed the whole production payments
#       table with the self-test still green.
#
#   (+) And the 160-char window fails CLOSED, not open: a correctly-keyed DELETE whose predicate is
#       pushed past offset 160 FAILS the guard (measured: fragment length 243, pattern at 173).
#       So the window was never the evasion route the spec described — it was a false-alarm hazard
#       on a safe long statement. Slicing to the statement terminator retires both readings.
#
# The corpus also self-polluted: `src.split("DELETE FROM")` yielded THREE fragments, and the third
# was this function's OWN split literal, which passed only because the comparison literal on the
# next line happened to land at offset 47 inside the window. Two behaviour-PRESERVING refactors —
# hoisting the pattern to a constant, or inserting a three-line comment — each flipped it to a
# FALSE FAILURE pointing at the guard's own body, where the obvious "fix" is to weaken the check.
# Scanning only the region ABOVE this function removes that trap by construction.
def self_test():
    fails = []
    # (5) The LIVE sentinel, not a frozen literal. This line read
    # `sentinel_guard("probe:claim-liveness")` — so changing SENTINEL_PAYER left the guard happily
    # asserting the OLD value, i.e. the one assertion that must track the constant did not.
    if sentinel_guard(SENTINEL_PAYER) is not None:
        fails.append("the real sentinel was rejected by its own guard")
    for bad, why in [("", "empty"), ("0xabc", "0x-prefixed"), ("0x" + "a" * 40, "42-char address")]:
        if sentinel_guard(bad) is None:
            fails.append("sentinel_guard accepted a %s value — cleanup could hit a real payer" % why)
    # the sentinel must be outside the real payer space, checked against the MEASURED shapes
    if SENTINEL_PAYER.startswith("0x") or len(SENTINEL_PAYER) == 42 or SENTINEL_PAYER == "":
        fails.append("SENTINEL_PAYER is inside the real payer space")

    # Read our own source. Unreadable OR unparseable ⇒ INDETERMINATE, never a FAIL: "could not
    # verify" is not "verified and broken", and conflating them is the class this arc exists to
    # retire.
    try:
        src = open(__file__).read()
        tree = ast.parse(src)
    except (OSError, SyntaxError) as exc:
        return None, ["could not read/parse own source for the DML census: %s" % exc]

    # ── THE CORPUS IS WHAT IS EXECUTED, NOT WHAT IS WRITTEN. ──────────────────────────────────
    # Every statement this prober sends to Postgres goes through `_psql()`. So the corpus is the
    # SQL argument of each `_psql` call site — nothing else in the file is SQL, whatever it says.
    #
    # This took three attempts and the failures are the lesson. Scanning raw source text put the
    # guard's own PROSE in its corpus, every time:
    #   1. the ORIGINAL `src.split("DELETE FROM")` matched its own split literal, and passed only
    #      because a comparison literal happened to land inside a 160-char window;
    #   2. rewriting it as a text census matched the comment above, which documents `OR 1=1`,
    #      `TRUNCATE` and `DROP TABLE` as hazards — demanding the deletion of the most useful
    #      paragraph in the file;
    #   3. narrowing to string literals STILL matched `main()`'s own success message, which says
    #      "all DELETE FROM keyed EXACTLY on the sentinel".
    # A guard whose corpus includes its own description can always be silenced by rewording, and
    # will always punish the author for explaining the hazard. CLAUDE.md records the weak form of
    # this ("strip comments before grepping source for a banned construct"); binding the corpus to
    # the CALL SITE is the strong form, because prose cannot reach a database.
    #
    # It also closes evasion class (b) properly rather than incidentally: a statement assembled
    # dynamically — an f-string, a `+` concat, a variable — is not a literal, so it cannot be
    # censused, and THAT is reported as a finding instead of silently yielding zero matches.
    def _sql_literal(node):
        """The statement text of a `_psql` first argument, or None if it is not a literal."""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        # The `"... %s ..." % (...)` form every call site here uses.
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
            return _sql_literal(node.left)
        return None

    call_sites = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_psql" and n.args
    ]

    # (4) VACUITY FLOOR. Here the corpus is OURS to construct, so an empty one is a defect in the
    # TEST, not a fact about the world — REFUSE. (Contrast the runtime path below, where an empty
    # result set is a FACT and PASS is the honest verdict. Empty-input is only vacuity when you
    # were the one supposed to fill it.)
    if not call_sites:
        fails.append("VACUITY: found ZERO _psql call sites to census — the guard is scanning "
                     "nothing, which is indistinguishable from scanning something clean")

    destructive = 0
    for call in call_sites:
        stmt_raw = _sql_literal(call.args[0])
        if stmt_raw is None:
            fails.append("a _psql statement at line %d is not a literal — it cannot be censused, "
                         "so a destructive statement could be assembled past this guard" % call.lineno)
            continue
        stmt = " ".join(stmt_raw.split())
        for m in DESTRUCTIVE_VERB_RE.finditer(stmt):
            destructive += 1
            verb = " ".join(m.group(1).upper().split())
            if verb != "DELETE FROM":
                # (c) A verb outside the cleanup contract. This prober only ever removes its own
                # sentinel rows; anything else against a production payments table is unaccounted
                # for — and a TRUNCATE here would have destroyed the whole table, green.
                fails.append("non-DELETE destructive verb %s at line %d — outside the cleanup "
                             "contract" % (verb, call.lineno))
                continue
            # (2) Slice to the statement TERMINATOR, not a magic character count. The old 160-char
            # window failed CLOSED on a safe long statement while catching none of the real classes.
            tail = stmt[m.end():]
            cut = tail.find(";")
            body = tail[:cut] if cut != -1 else tail
            mw = re.search(r"(?is)\bWHERE\b(.*?)(?:\bRETURNING\b|$)", body)
            pred = " ".join((mw.group(1) if mw else "").split())
            # (3) EQUALS, not `in`: an appended `OR 1=1` no longer rides along behind a match.
            if pred != EXPECTED_CLEANUP_PREDICATE:
                fails.append("a DELETE predicate at line %d is not EXACTLY the sentinel key "
                             "(got %r)" % (call.lineno, pred[:80]))

    if call_sites and destructive == 0:
        fails.append("VACUITY: %d _psql call site(s) censused but ZERO destructive statements "
                     "found — this prober deletes its own rows, so finding none means the census "
                     "is not reading them" % len(call_sites))
    return destructive, fails


def main():
    if "--self-test" in sys.argv:
        # CH7(d): this path printed NO verdict token, contradicting the docstring above, which has
        # promised "exactly one terminal X402_CLAIM_LIVENESS_VERDICT=" since the file was written.
        # Under the token law a caller must gate on the TOKEN, never on an exit code — which was
        # impossible here. `census` is None only when the source could not be read.
        census, f = self_test()
        if census is None:
            print("? self-test INDETERMINATE — could not verify:")
            for x in f:
                print("   - " + x)
            print("X402_CLAIM_LIVENESS_VERDICT=INDETERMINATE")
            return 3
        if f:
            print("x self-test FAILED:")
            for x in f:
                print("   - " + x)
            print("X402_CLAIM_LIVENESS_VERDICT=FAIL")
            return 1
        # POSITIVE, COUNTED output. "every DELETE is keyed on it" is only meaningful alongside how
        # many statements were actually inspected — the old message asserted the property over a
        # corpus it never reported, so a census of zero read exactly like a clean bill of health.
        print("+ x402-claim-liveness self-test passed: %d destructive statement(s) censused, all "
              "DELETE FROM keyed EXACTLY on the sentinel; sentinel is outside the real payer space; "
              "the guard rejects address-shaped sentinels" % census)
        print("X402_CLAIM_LIVENESS_VERDICT=PASS")
        return 0

    now_iso = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    bad = sentinel_guard(SENTINEL_PAYER)
    if bad:
        print("REFUSING TO RUN: %s" % bad, file=sys.stderr)
        print("X402_CLAIM_LIVENESS_VERDICT=INDETERMINATE")
        return 3

    try:
        role = _pg_role()
    except Exception as exc:
        # An unreachable database is INDETERMINATE, never a pass — that distinction is the wave.
        print("could not reach the database: %s" % exc, file=sys.stderr)
        print("X402_CLAIM_LIVENESS_VERDICT=INDETERMINATE")
        return 3

    try:
        checks = probe(role, now_iso)
    except Exception as exc:
        detail = str(exc)[:400]
        print("CLAIM PATH BROKEN: %s" % detail, file=sys.stderr)
        body = ("The x402 paid claim path FAILED a synthetic liveness probe.\n\n"
                "%s\n\n"
                "A real customer paying right now would be refused and served nothing. This is the "
                "shape of the 2026-08-03 outage, which lasted ~25 hours because no alarm could see "
                "it (there is effectively no paid traffic, so no rate metric can fire).\n\n"
                "Action: dispatch OPS-<CLASS>-W{NEXT} after checking the claim SQL's ON CONFLICT "
                "target against the table's PRIMARY KEY." % detail)
        alert(body)
        print("X402_CLAIM_LIVENESS_VERDICT=FAIL")
        return 1

    # POSITIVE per-check output — never absence-of-alert. A prober silently skipped by a load
    # error looks identical to a healthy one unless it says what it verified.
    for line in checks:
        print("  " + line)
    print("  probe nonce: probe:%s (sentinel payer %s)" % (now_iso, SENTINEL_PAYER))
    print("X402_CLAIM_LIVENESS_VERDICT=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
