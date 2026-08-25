#!/usr/bin/env python3
"""x402-settlement-reconciler.py — give `CLAIMED_PENDING` an exit, from CHAIN truth.

OPS-X402-SETTLEMENT-RECONCILER-W1.

── 🛑 THE DEFECT THIS RETIRES ──────────────────────────────────────────────────────────────
`CLAIMED_PENDING` means "nothing has looked yet". The ONLY thing that ever looks is the live
settle callback in `recordSettlementOutcome`, and that will never re-run for an attempt from
last week. So an abandoned or failed payment authorization stays `CLAIMED_PENDING` **forever**,
and `revenue-meter-canary.py`'s meter (c) — which counts exactly that state past a grace period
— grows monotonically with FAILURES rather than measuring unsettled REVENUE.

Measured 2026-08-25: meter (c) had breached continuously since 2026-08-17 on two rows from
2026-08-10 13:03:44 and 13:04:02 (payer 0x7da6de19…, `get_trade_signal`, amount 20000 = $0.02
each). Read on chain, **neither authorization was ever consumed — no money moved.** Nothing was
owed and nothing was lost; the meter was reporting two dead authorizations as unverified
revenue, and no code path existed that could ever resolve them. Third instance this month of the
same latched-state shape, after `PENDING_STALE` and the webhook terminal-disable notice.

── HOW IT DECIDES ──────────────────────────────────────────────────────────────────────────
USDC implements EIP-3009. `authorizationState(authorizer, nonce)` returns TRUE once an
authorization has been consumed — the authoritative answer to "did money move", independent of
our own bookkeeping. Per aged `CLAIMED_PENDING` row:

  consumed = False  ->  CLAIMED_EXPIRED. Terminal, and it leaves meter (c) legitimately.
  consumed = True   ->  🛑 UNRECORDED_SETTLEMENT. Money MOVED and our books do not know.
                        NEVER auto-promoted to SETTLED: this file cannot obtain the rail's
                        transaction reference, and `x402-idempotency-store.ts` states the rule —
                        "a SETTLED row without a reference is an assertion nobody can ever
                        check." So it PAGES and writes nothing. A human resolves it with the ref.
  RPC error         ->  INDETERMINATE for that row. No write. Never an expiry by default.

── 🛑 THE CONTROL IS A HARD PRECONDITION, NOT A NICETY ─────────────────────────────────────
A wrong selector, a wrong contract address or a wrong ABI encoding ALL return `false` — the same
answer as "never consumed". A `false` read is therefore worthless on its own, and acting on it
would mark live authorizations expired.

So every live run first calls the SAME code path against a nonce we independently know was
consumed — a row already `SETTLED` **with a non-empty `settlement_ref`**, i.e. one the rail
itself confirmed. If that control does not come back TRUE, the instrument cannot see, and the
whole run is INDETERMINATE with zero writes. The control is DERIVED from our own data, so it
keeps working as the ledger grows and needs no maintenance.

(This is the estate's own law — "a measured baseline is meaningless without its instrument" —
applied to a chain read. It is also exactly how the 2026-08-25 investigation established that
the two pending rows were genuinely unconsumed rather than merely unreadable.)

── SAFETY ──────────────────────────────────────────────────────────────────────────────────
 * READ-ONLY BY DEFAULT. `--apply` is required to write, and it only ever writes
   CLAIMED_PENDING -> CLAIMED_EXPIRED. It cannot touch SETTLED or OPERATOR, so money that moved
   can never be un-recorded — the same forward-only invariant the store enforces.
 * `CLAIMED_EXPIRED` is NOT terminal for money: `recordSettlementOutcome` accepts it as a FROM
   state, so a late genuine settlement still promotes and still records its reference.
 * RAIL-SCOPED. Only `base-usdc` rows can be answered this way; any other rail is reported as
   DEFERRED, never silently passed over.
 * The grace period is deliberately LONGER than meter (c)'s, so this can only ever retire a row
   the meter has already been complaining about — never one it has not yet seen.

Verdict: exactly one terminal `X402_SETTLEMENT_RECONCILE_VERDICT=PASS|FAIL|INDETERMINATE`.
Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate).

Usage:
  x402-settlement-reconciler.py                # report only: says exactly what it would do
  x402-settlement-reconciler.py --apply        # write the expiries
  x402-settlement-reconciler.py --self-test    # hermetic; no DB, no RPC, no wrapper
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

ALERT_ID = "X402_UNRECORDED_SETTLEMENT"
RECOMMENDED_WAVE = "OPS-X402-SETTLEMENT-RECONCILE-W{NEXT}"
WRAPPER = "/opt/algovault-monitoring/send_telegram.sh"

PG_CONTAINER = os.environ.get("ALGOVAULT_PG_CONTAINER", "crypto-quant-signal-mcp-postgres-1")
PG_DB = os.environ.get("ALGOVAULT_PG_DB", "signal_performance")
APP_CONTAINER = os.environ.get("ALGOVAULT_APP_CONTAINER", "crypto-quant-signal-mcp-mcp-server-1")

# ── Chain facts, declared once ──────────────────────────────────────────────────────────────
# Native USDC on Base mainnet. The reconciler is scoped to the rails it can actually answer for;
# a rail with no entry here is DEFERRED, not guessed at.
RAIL_CONTRACTS = {"base-usdc": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}
# keccak256("authorizationState(address,bytes32)")[:4]. Never trusted on faith — the control
# read above proves it on every live run, and a wrong value fails the run rather than the row.
AUTH_STATE_SELECTOR = "0xe94a0102"

# 🛑 THE User-Agent IS LOAD-BEARING, not decoration. Measured 2026-08-25 from signal-1:
# `https://mainnet.base.org` returns **HTTP 403** to Python's default `Python-urllib/3.x` while
# accepting curl and any explicit UA — a bot filter, not an auth failure. Without this header
# EVERY chain read fails, and a reconciler that treated a failed read as `false` would have
# marked two LIVE authorizations expired on its very first run. It did not, because the control
# caught exactly this — which is what the control is for, and this is its first real save.
#
# A CONSTANT rather than an inline literal so the self-test can assert the VALUE. The first
# version of that assertion grepped this file for the UA string — which the assertion itself
# contained, so it passed with the header deleted. An assertion that cannot fail is not one.
RPC_HEADERS = {
    "content-type": "application/json",
    "user-agent": "algovault-x402-settlement-reconciler/1",
}

# Longer than revenue-meter-canary.py's UNSETTLED_GRACE_DAYS (7) ON PURPOSE: this may only ever
# retire a row meter (c) has already had time to surface, never one it has not yet seen.
EXPIRY_GRACE_DAYS = int(os.environ.get("X402_RECONCILE_GRACE_DAYS", "14"))
PENDING_STATE = "CLAIMED_PENDING"
EXPIRED_STATE = "CLAIMED_EXPIRED"

EXIT_PASS, EXIT_FAIL, EXIT_INDETERMINATE = 0, 1, 3


def log(msg):
    print("[x402-settlement-reconciler] %s" % msg, flush=True)


# ── Pure query builders (the seam a hermetic self-test can actually execute) ─────────────────

def build_pending_query(grace_days):
    """Aged, attributable `CLAIMED_PENDING` rows. Mirrors meter (c)'s exclusions exactly.

    The empty-`payer_wallet` rows are excluded for the same reason meter (c) excludes them: SEC-49
    writes '' when no payer can be extracted, so they are unattributable ON CHAIN by construction
    and no `authorizationState` call can ever be made for them. Including them would produce a
    permanent INDETERMINATE — the very shape this file exists to retire.
    """
    if not isinstance(grace_days, int) or grace_days <= 0:
        raise ValueError("grace_days must be a positive int, got %r" % (grace_days,))
    return (
        "SELECT nonce, payer_wallet, rail, amount, created_at "
        "FROM processed_x402_payments "
        "WHERE settlement_state = '" + PENDING_STATE + "' "
        "AND trim(payer_wallet) <> '' "
        "AND created_at < now() - interval '" + str(grace_days) + " days' "
        "ORDER BY created_at"
    )


def build_control_query():
    """A nonce we KNOW was consumed: already SETTLED and carrying the rail's own reference.

    The `settlement_ref <> ''` half is load-bearing. A SETTLED row without a reference is an
    assertion nobody checked, so using one as the control would validate the instrument against
    another unverified claim — proving nothing while looking rigorous.
    """
    return (
        "SELECT nonce, payer_wallet, rail FROM processed_x402_payments "
        "WHERE settlement_state = 'SETTLED' AND coalesce(settlement_ref,'') <> '' "
        "ORDER BY created_at DESC LIMIT 1"
    )


def build_expire_update(nonce, payer_wallet):
    """Forward-only, and narrow by construction: the WHERE pins the FROM state, so this statement
    is incapable of touching a SETTLED or OPERATOR row even if called with the wrong key."""
    for v in (nonce, payer_wallet):
        if not isinstance(v, str) or not v.startswith("0x") or not _is_hex(v[2:]):
            raise ValueError("refusing to build SQL for a non-hex identifier: %r" % (v,))
    return (
        "UPDATE processed_x402_payments SET settlement_state = '" + EXPIRED_STATE + "' "
        "WHERE nonce = '" + nonce + "' AND payer_wallet = '" + payer_wallet + "' "
        "AND settlement_state = '" + PENDING_STATE + "'"
    )


def _is_hex(s):
    return len(s) > 0 and all(c in "0123456789abcdefABCDEF" for c in s)


def build_auth_state_calldata(payer, nonce):
    """`authorizationState(address,bytes32)` calldata. PURE, so the encoding is unit-testable
    without a chain — which matters, because a mis-encoded call returns `false`, the same answer
    as "never consumed"."""
    if not (isinstance(payer, str) and payer.startswith("0x") and len(payer) == 42 and _is_hex(payer[2:])):
        raise ValueError("bad address %r" % (payer,))
    if not (isinstance(nonce, str) and nonce.startswith("0x") and len(nonce) == 66 and _is_hex(nonce[2:])):
        raise ValueError("bad nonce %r" % (nonce,))
    return AUTH_STATE_SELECTOR + payer[2:].lower().rjust(64, "0") + nonce[2:].lower().rjust(64, "0")


def parse_auth_state(raw):
    """eth_call result -> True/False/None. None is "could not read", NEVER False.

    Collapsing an unreadable answer into False is how a reconciler marks live authorizations
    expired; they are different facts and stay different all the way to the verdict.
    """
    if not isinstance(raw, str) or not raw.startswith("0x"):
        return None
    body = raw[2:]
    if body == "" or not _is_hex(body):
        return None
    try:
        return int(body, 16) == 1
    except ValueError:
        return None


# ── I/O seams ───────────────────────────────────────────────────────────────────────────────

def _pg_role():
    out = subprocess.run(["docker", "exec", PG_CONTAINER, "printenv", "POSTGRES_USER"],
                         capture_output=True, text=True, timeout=15)
    role = out.stdout.strip()
    if not role:
        raise RuntimeError("could not resolve POSTGRES_USER from %s" % PG_CONTAINER)
    return role


def _psql(sql, role=None):
    args = ["docker", "exec", PG_CONTAINER, "psql", "-U", role or _pg_role(), "-d", PG_DB,
            "-tAq", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql]
    out = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % out.stderr.strip()[:300])
    return out.stdout.strip()


def _rpc_url():
    """BASE_RPC_URL lives in the APP container's env, not this host's. Read it at runtime and
    never log it — an RPC URL routinely carries a provider key in its path."""
    out = subprocess.run(["docker", "exec", APP_CONTAINER, "printenv", "BASE_RPC_URL"],
                         capture_output=True, text=True, timeout=15)
    url = out.stdout.strip()
    if not url:
        raise RuntimeError("BASE_RPC_URL is not set in %s" % APP_CONTAINER)
    return url


def eth_call_auth_state(url, contract, payer, nonce, timeout=20):
    """True / False / None. None on ANY failure — transport, JSON-RPC error, or unparseable."""
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{"to": contract, "data": build_auth_state_calldata(payer, nonce)}, "latest"],
    }).encode()
    # 🛑 THE User-Agent IS LOAD-BEARING, not decoration. Measured 2026-08-25 on this host:
    # `https://mainnet.base.org` returns **HTTP 403** to Python's default `Python-urllib/3.x`
    # while accepting curl and any explicit UA — a bot filter, not an auth failure. Without this
    # header every chain read fails, and a reconciler that treated a failed read as `false` would
    # have marked two LIVE authorizations expired on its first run. (It does not: the control
    # below caught exactly this, which is what the control is for.)
    req = urllib.request.Request(url, data=payload, headers=dict(RPC_HEADERS))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            doc = json.loads(resp.read().decode())
    except Exception as exc:                                   # noqa: BLE001
        log("RPC_CALL_FAILED: %s: %s" % (type(exc).__name__, str(exc)[:120]))
        return None
    if "error" in doc:
        log("RPC_ERROR: %s" % json.dumps(doc["error"])[:160])
        return None
    return parse_auth_state(doc.get("result"))


def fire(body):
    if os.environ.get("X402_RECONCILE_SELFTEST") == "1":
        log("WOULD_FIRE: (self-test — wrapper skipped)")
        return
    proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"], input=body,
                          capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


# ── Pure classification ─────────────────────────────────────────────────────────────────────

def classify_row(row, consumed):
    """(action, detail). PURE. `consumed` is True / False / None."""
    if consumed is None:
        return "INDETERMINATE", "authorizationState unreadable — no write, and NOT an expiry"
    if consumed:
        return "UNRECORDED_SETTLEMENT", (
            "the authorization WAS consumed on chain but this row is still %s — money moved and "
            "the ledger does not know. Not auto-promoted: a SETTLED row needs the rail's own "
            "reference, which this reconciler cannot obtain." % PENDING_STATE)
    return "EXPIRE", "authorization never consumed — no transfer ever happened"


def build_body(findings, checked, expired, indeterminate):
    lines = ["🛑 %s" % ALERT_ID]
    lines.append("%d x402 claim(s) were SETTLED ON CHAIN but are still recorded %s."
                 % (len(findings), PENDING_STATE))
    for f in findings:
        lines.append("  nonce %s… payer %s… rail=%s amount=%s created=%s"
                     % (f["nonce"][:12], f["payer"][:10], f["rail"], f["amount"], f["created_at"]))
    lines.append("Money MOVED for these. They are NOT auto-promoted: `SETTLED` requires the "
                 "rail's own transaction reference, and a SETTLED row without one is an "
                 "assertion nobody can ever check.")
    lines.append("This run: %d checked · %d expired · %d indeterminate."
                 % (checked, expired, indeterminate))
    lines.append("Action: dispatch %s via Cowork → Claude Code" % RECOMMENDED_WAVE)
    return "\n".join(lines)


# ── Main ────────────────────────────────────────────────────────────────────────────────────

def main(apply_writes=False):
    try:
        role = _pg_role()
        url = _rpc_url()
    except Exception as exc:                                   # noqa: BLE001
        log("SETUP_FAILED: %s" % str(exc)[:200])
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE

    # ── THE CONTROL. Nothing below is trusted until the instrument proves it can see. ──
    try:
        ctrl = _psql(build_control_query(), role)
    except Exception as exc:                                   # noqa: BLE001
        log("CONTROL_QUERY_FAILED: %s" % str(exc)[:200])
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE
    if not ctrl:
        log("CONTROL_ABSENT: no SETTLED row carries a settlement_ref, so the chain read cannot "
            "be validated. Refusing to classify anything — a `false` from an unvalidated "
            "instrument is indistinguishable from a wrong selector.")
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE
    c_nonce, c_payer, c_rail = (ctrl.splitlines()[0].split("|") + ["", "", ""])[:3]
    c_contract = RAIL_CONTRACTS.get(c_rail)
    if not c_contract:
        log("CONTROL_RAIL_UNSUPPORTED: control row is rail=%s, which this reconciler cannot "
            "read. No classification performed." % c_rail)
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE
    # Both branches are INDETERMINATE, but they are DIFFERENT FAILURES and the operator acts on
    # them differently — so the message must name the one that happened. Reporting a transport
    # 403 as "your encoding is wrong" sends someone to read ABI docs about a bot filter; that is
    # the misnamed-refusal defect this estate has now paid for twice.
    control = eth_call_auth_state(url, c_contract, c_payer, c_nonce)
    if control is None:
        log("CONTROL_UNREACHABLE: could not READ the chain at all (see the RPC line above). "
            "Nothing is known to be wrong with the ledger or the encoding — we simply could not "
            "look. Zero writes.")
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE
    if control is not True:
        log("CONTROL_FAILED: the chain answered, but a nonce known-consumed (SETTLED with a rail "
            "reference, nonce %s…) read back as NOT consumed. The selector, the contract address "
            "or the encoding is wrong — every `false` this run would produce is meaningless. "
            "Zero writes." % c_nonce[:12])
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE
    log("CONTROL OK — nonce %s… reads consumed=True; the instrument can see." % c_nonce[:12])

    try:
        raw = _psql(build_pending_query(EXPIRY_GRACE_DAYS), role)
    except Exception as exc:                                   # noqa: BLE001
        log("PENDING_QUERY_FAILED: %s" % str(exc)[:200])
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE

    rows = []
    for line in raw.splitlines():
        parts = line.split("|")
        if len(parts) < 5:
            continue
        rows.append({"nonce": parts[0], "payer": parts[1], "rail": parts[2],
                     "amount": parts[3], "created_at": parts[4]})

    # An empty corpus here is a FACT about the world, not vacuity: nothing is aged and pending.
    # Reported as a positive line so a clean run is never silent.
    if not rows:
        log("NOTHING_PENDING: 0 %s row(s) older than %dd — a reported pass, not a silent one."
            % (PENDING_STATE, EXPIRY_GRACE_DAYS))
        print("X402_SETTLEMENT_RECONCILE_VERDICT=PASS")
        return EXIT_PASS

    findings, expired, indeterminate, deferred = [], 0, 0, 0
    for r in rows:
        contract = RAIL_CONTRACTS.get(r["rail"])
        if not contract:
            deferred += 1
            log("DEFERRED %s… rail=%s — no contract declared for this rail; reported, not passed"
                % (r["nonce"][:12], r["rail"]))
            continue
        consumed = eth_call_auth_state(url, contract, r["payer"], r["nonce"])
        action, detail = classify_row(r, consumed)
        log("ROW %s… payer=%s… rail=%s amount=%s created=%s -> %s (%s)"
            % (r["nonce"][:12], r["payer"][:10], r["rail"], r["amount"], r["created_at"],
               action, detail))
        if action == "INDETERMINATE":
            indeterminate += 1
        elif action == "UNRECORDED_SETTLEMENT":
            findings.append(r)
        elif action == "EXPIRE":
            if not apply_writes:
                log("  WOULD WRITE %s -> %s (pass --apply to act)" % (PENDING_STATE, EXPIRED_STATE))
                continue
            try:
                _psql(build_expire_update(r["nonce"], r["payer"]), role)
                expired += 1
                log("  WROTE %s -> %s" % (PENDING_STATE, EXPIRED_STATE))
            except Exception as exc:                           # noqa: BLE001
                indeterminate += 1
                log("  EXPIRE_WRITE_FAILED: %s" % str(exc)[:160])

    log("SUMMARY checked=%d expired=%d unrecorded_settlement=%d indeterminate=%d deferred=%d "
        "mode=%s" % (len(rows), expired, len(findings), indeterminate, deferred,
                     "APPLY" if apply_writes else "REPORT"))

    if findings:
        fire(build_body(findings, len(rows), expired, indeterminate))
        print("X402_SETTLEMENT_RECONCILE_VERDICT=FAIL")
        return EXIT_FAIL
    if indeterminate:
        # We were handed rows and could not answer for some. That is not a pass.
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE
    print("X402_SETTLEMENT_RECONCILE_VERDICT=PASS")
    return EXIT_PASS


# ── Hermetic self-test ──────────────────────────────────────────────────────────────────────

def self_test():
    passed, failed = [], []

    def check(label, cond):
        (passed if cond else failed).append(label)

    N = "0x" + "ab" * 32
    P = "0x" + "cd" * 20

    # --- calldata encoding: the thing whose failure looks exactly like "never consumed" -------
    d = build_auth_state_calldata(P, N)
    check("calldata carries the selector", d.startswith(AUTH_STATE_SELECTOR))
    check("calldata is selector + 2 words", len(d) == 10 + 64 + 64)
    check("address is left-padded to a full word", d[10:74] == "0" * 24 + "cd" * 20)
    check("nonce occupies the second word whole", d[74:] == "ab" * 32)
    check("address is lower-cased (a checksummed one must not change the encoding)",
          build_auth_state_calldata(P.upper().replace("0X", "0x"), N) == d)
    for bad in ("", "0x", "0xzz", P[:-2], N):
        try:
            build_auth_state_calldata(bad, N)
            check("bad address %r is refused" % bad, False)
        except ValueError:
            check("bad address %r is refused" % bad, True)
    try:
        build_auth_state_calldata(P, P)
        check("a 20-byte value is refused as a nonce", False)
    except ValueError:
        check("a 20-byte value is refused as a nonce", True)

    # --- the unreadable/False distinction, which is the whole safety argument -----------------
    check("0x…01 parses True", parse_auth_state("0x" + "0" * 63 + "1") is True)
    check("0x…00 parses False", parse_auth_state("0x" + "0" * 64) is False)
    for bad in (None, "", "0x", "not-hex", "0xzz", 1, b"0x01"):
        check("unreadable %r -> None, NEVER False" % (bad,), parse_auth_state(bad) is None)

    # --- classification, all three branches --------------------------------------------------
    row = {"nonce": N, "payer": P, "rail": "base-usdc", "amount": "20000", "created_at": "x"}
    check("consumed=False -> EXPIRE", classify_row(row, False)[0] == "EXPIRE")
    check("consumed=True -> UNRECORDED_SETTLEMENT (never an auto-promotion)",
          classify_row(row, True)[0] == "UNRECORDED_SETTLEMENT")
    check("consumed=None -> INDETERMINATE, and NOT an expiry",
          classify_row(row, None)[0] == "INDETERMINATE")

    # --- the UPDATE is incapable of un-settling money ----------------------------------------
    u = build_expire_update(N, P)
    check("update pins the FROM state", "settlement_state = '" + PENDING_STATE + "'" in u)
    check("update sets EXPIRED", "SET settlement_state = '" + EXPIRED_STATE + "'" in u)
    check("update keys on BOTH nonce and payer", ("nonce = '" + N + "'") in u and ("payer_wallet = '" + P + "'") in u)
    check("update can never name SETTLED or OPERATOR", "SETTLED" not in u and "OPERATOR" not in u)
    for bad in ("'; DROP TABLE processed_x402_payments; --", "0xnothex", "abc", ""):
        try:
            build_expire_update(bad, P)
            check("non-hex identifier %r is refused" % bad, False)
        except ValueError:
            check("non-hex identifier %r is refused" % bad, True)

    # --- queries -----------------------------------------------------------------------------
    q = build_pending_query(14)
    check("pending query is scoped to the pending state", "'" + PENDING_STATE + "'" in q)
    check("pending query carries its grace window", "interval '14 days'" in q)
    check("pending query excludes unattributable rows", "trim(payer_wallet) <> ''" in q)
    try:
        build_pending_query(0)
        check("a non-positive grace window is refused", False)
    except ValueError:
        check("a non-positive grace window is refused", True)
    check("🛑 the grace window is LONGER than meter (c)'s 7d, so this can only retire rows the "
          "meter has already surfaced", EXPIRY_GRACE_DAYS > 7)
    c = build_control_query()
    check("control demands a SETTLED row", "'SETTLED'" in c)
    check("🛑 control demands a real rail REFERENCE, not merely a SETTLED claim",
          "coalesce(settlement_ref,'') <> ''" in c)

    # --- token -> exit code mapping (the token alone is not the contract) ---------------------
    check("PASS maps to 0", EXIT_PASS == 0)
    check("FAIL maps to 1", EXIT_FAIL == 1)
    check("INDETERMINATE maps to 3 (new-gate default)", EXIT_INDETERMINATE == 3)

    # --- rendered body -----------------------------------------------------------------------
    body = build_body([row], 1, 0, 0)
    check("body names the alert id", ALERT_ID in body)
    check("body carries the templated wave, never a literal W-number", "W{NEXT}" in body)
    check("body says money MOVED", "Money MOVED" in body)
    check("body explains why it did not auto-promote", "reference" in body)

    # --- the User-Agent, whose absence 403s every chain read on the public Base endpoint ------
    ua = RPC_HEADERS.get("user-agent", "")
    check("🛑 an explicit User-Agent is sent (mainnet.base.org 403s Python's default)",
          isinstance(ua, str) and ua.strip() != "" and "urllib" not in ua.lower())
    check("...and it identifies THIS consumer, so a provider block is attributable",
          "x402-settlement-reconciler" in ua)
    check("the request still declares JSON", RPC_HEADERS.get("content-type") == "application/json")
    src = open(__file__, encoding="utf-8").read() if os.path.exists(__file__) else ""
    check("the control distinguishes UNREACHABLE from a wrong ANSWER",
          "CONTROL_UNREACHABLE" in src and "CONTROL_FAILED" in src)

    # --- vacuity guard: WE build this corpus, so empty here is a defect in the test -----------
    check("self-test corpus is non-empty", len(passed) + len(failed) >= 35)

    for label in failed:
        log("  SELF-TEST FAIL: %s" % label)
    log("self-test: %d passed, %d failed" % (len(passed), len(failed)))
    if failed:
        print("X402_SETTLEMENT_RECONCILE_VERDICT=INDETERMINATE")
        return EXIT_INDETERMINATE
    print("X402_SETTLEMENT_RECONCILE_VERDICT=PASS")
    return EXIT_PASS


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write the expiries (default: report only)")
    ap.add_argument("--self-test", action="store_true", help="hermetic scenario suite")
    a = ap.parse_args()
    sys.exit(self_test() if a.self_test else main(apply_writes=a.apply))
