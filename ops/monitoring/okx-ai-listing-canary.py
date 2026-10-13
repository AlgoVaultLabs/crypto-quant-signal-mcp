#!/usr/bin/env python3
"""
okx-ai-listing-canary.py — OPS-A2MCP-SERVED-TRUTH-W1 CH2-A (A4).

Weekly host-side canary for the okx.ai A2MCP marketplace listing, plus the paid-demand signal.

WHY. Agent 3417 ("AlgoVault Quant Signal") was delisted by OKX and its /a2mcp/* routes answered
404 for weeks; nothing in this estate looked at okx.ai, so both went unseen. The drift canary's
leg C now watches the ROUTES (declared vs served). This canary watches the two things leg C cannot:
  1. LISTED — GET https://www.okx.ai/agents/<id>, classified on status AND body (measured 2026-10-13):
       listed  = 200 and the page embeds the agent's own record (`"agentId":"<id>"` in its page state)
       review  = 200 and the "This ASP is under review" placeholder (no agent record) — NOT listed
       absent  = 404 (delisted / never listed; 60/60 random unlisted ids measured 404)
       unknown = anything else, including a 200 with neither marker (page shape changed) — fail-open.
     A bare "200 = listed" rule (the first cut) read the review placeholder as LISTED and reset the
     counter on its first live run; a 200 is not a listing until the page carries the agent.
  2. DEMAND — USDT0 `balanceOf(payTo)` on X Layer (eip155:196). The week-over-week delta is the
     paid-demand signal: a LOWER bound, because funds moved out of the payTo hide inbound calls.
     request_log cannot separate a2mcp rows from Base x402 rows, so the chain is the only meter.

ALERT. `OKX_AI_DELISTED` (CRITICAL_PERSISTENT) only after ABSENT_THRESHOLD consecutive NOT-LISTED
runs (absent or under review; default 2) — never on one miss, never on an unknown. An unknown run
neither advances nor resets the counter. Listed → `--clear` (silent; the registry row decides announcement). Severity
gate, 24 h cooldown, DRY_RUN_TG / ALGOVAULT_TG_TEST_INERT and the W{NEXT} template all live in
send_telegram.sh — this file owns only the probes, the counter and fail-open.

RECORD. One line per run via canary_result_log.append_result → canary-results.jsonl; the vault-side
pull (ops/scripts/monitoring-results-sync.sh) makes the balance series a file read.

Verdict: exactly one terminal `OKX_AI_LISTING_VERDICT=PASS|FAIL|INDETERMINATE` (exit 0 / 0 / 3).
PASS = listed · FAIL = absent or under review (paged only at the threshold) · INDETERMINATE = the
listing probe could not decide. The balance probe never changes the verdict (it is a measurement, not a check).

Install (host): /opt/algovault-monitoring/okx-ai-listing-canary.py  (SoT: repo ops/monitoring/)
Cron (weekly, off-:00): 43 7 * * 2  (Tue 07:43 UTC)

    okx-ai-listing-canary.py --self-test   # hermetic: no network, no wrapper, no state, no record

Env:
  OKX_AI_AGENT_ID        default 3417
  OKX_A2MCP_PAYTO        default 0x62366c50e1bb14ed4ff2b6c8c143f6049df075b9 (public in every 402)
  XLAYER_RPC             default https://rpc.xlayer.tech
  ABSENT_THRESHOLD       consecutive not-listed runs before paging (default 2)
  TG_WRAPPER             default /opt/algovault-monitoring/send_telegram.sh
  OKX_AI_LISTING_STATE   default /var/lib/algovault-monitoring/okx-ai-listing-canary-state.json
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CANARY = "okx-ai-listing-canary"
ALERT_ID = "OKX_AI_DELISTED"
SEVERITY = "CRITICAL_PERSISTENT"
RECOMMENDED_WAVE = "OPS-OKX-AI-LISTING-W{NEXT}"

AGENT_ID = os.environ.get("OKX_AI_AGENT_ID", "3417")
PAYTO = os.environ.get("OKX_A2MCP_PAYTO", "0x62366c50e1bb14ed4ff2b6c8c143f6049df075b9")
RPC = os.environ.get("XLAYER_RPC", "https://rpc.xlayer.tech")
# USDT0 on X Layer (EIP-3009, 6 dp) — the same constant src/lib/okx-a2mcp-config.ts settles in.
USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"
USDT0_DECIMALS = 6
THRESHOLD = int(os.environ.get("ABSENT_THRESHOLD", "2"))
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
STATE_PATH = os.environ.get(
    "OKX_AI_LISTING_STATE", "/var/lib/algovault-monitoring/okx-ai-listing-canary-state.json"
)
UA = "algovault-okx-ai-listing-canary/1 (+https://algovault.com)"

LISTED, REVIEW, ABSENT, UNKNOWN = "listed", "review", "absent", "unknown"
NOT_LISTED = (REVIEW, ABSENT)
REVIEW_MARKER = re.compile(r"This ASP is under review", re.I)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"{now_iso()} [{CANARY}] {msg}", flush=True)


# ── pure logic (what --self-test exercises) ──────────────────────────────────────────────────


def classify_listing(status, body: str = "", agent_id: str = AGENT_ID):
    """GET /agents/<id> (status, body) → listed | review | absent | unknown. None = no response.
    A 200 is LISTED only when the page embeds this agent's own record; the review placeholder is
    REVIEW; a 200 with neither marker is UNKNOWN (never a pass on a page we cannot read)."""
    if status == 404:
        return ABSENT
    if status != 200:
        return UNKNOWN
    body = body or ""
    if re.search(r'"agentId"\s*:\s*"?%s"?(?![0-9])' % re.escape(str(agent_id)), body):
        return LISTED
    if REVIEW_MARKER.search(body):
        return REVIEW
    return UNKNOWN


def balance_calldata(owner: str) -> str:
    """ERC-20 balanceOf(owner) calldata. Refuses anything that is not a 20-byte hex address."""
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", owner or ""):
        raise ValueError("payTo is not a 20-byte hex address")
    return "0x70a08231" + "0" * 24 + owner[2:].lower()


def parse_balance_result(result) -> int | None:
    """eth_call result (0x-hex uint256) → atomic units, or None when unreadable."""
    if not isinstance(result, str) or not re.fullmatch(r"0x[0-9a-fA-F]{1,64}", result):
        return None
    return int(result, 16)


def next_state(prev: dict, listing: str, balance_atomic: int | None, at: str) -> dict:
    """The counter rule: not listed (absent or under review) advances, listed resets, unknown
    leaves it alone. Balance is carried forward only when this run read one, so a failed RPC never
    fabricates a delta. Reads the first cut's `consecutive_absent` key once, for continuity."""
    prev = prev or {}
    consecutive = int(prev.get("consecutive_not_listed", prev.get("consecutive_absent", 0)) or 0)
    if listing in NOT_LISTED:
        consecutive += 1
    elif listing == LISTED:
        consecutive = 0
    state = {
        "consecutive_not_listed": consecutive,
        "last_listing": listing if listing != UNKNOWN else prev.get("last_listing"),
        "last_listed_at": at if listing == LISTED else prev.get("last_listed_at"),
        "last_run_at": at,
        "last_balance_atomic": balance_atomic if balance_atomic is not None else prev.get("last_balance_atomic"),
        "last_balance_at": at if balance_atomic is not None else prev.get("last_balance_at"),
    }
    return state


def balance_delta(prev: dict, balance_atomic: int | None) -> int | None:
    """Week-over-week delta in atomic units; None when either side is missing."""
    p = (prev or {}).get("last_balance_atomic")
    if balance_atomic is None or p is None:
        return None
    return balance_atomic - int(p)


def decide(listing: str, consecutive_not_listed: int, threshold: int) -> tuple[str, int, str]:
    """→ (verdict, exit_code, action) where action is fire | clear | none."""
    if listing == LISTED:
        return "PASS", 0, "clear"
    if listing in NOT_LISTED:
        return "FAIL", 0, ("fire" if consecutive_not_listed >= threshold else "none")
    return "INDETERMINATE", 3, "none"


def usdt0(atomic: int | None) -> str:
    return "n/a" if atomic is None else f"{atomic / 10 ** USDT0_DECIMALS:.6f}".rstrip("0").rstrip(".")


def alert_body(agent_id: str, consecutive: int, last_listed_at, balance_atomic, delta, listing: str = ABSENT) -> str:
    since = last_listed_at or "never recorded by this canary"
    now_state = ("UNDER REVIEW (the page shows the review placeholder, not the agent)" if listing == REVIEW
                 else "ABSENT (https://www.okx.ai/agents/%s → 404)" % agent_id)
    return "\n".join([
        f"🛑 {ALERT_ID}",
        f"okx.ai agent {agent_id} has not been listed for {consecutive} consecutive weekly runs; "
        f"now {now_state}. Last seen listed: {since}.",
        f"payTo USDT0 on X Layer: {usdt0(balance_atomic)} (week-over-week {usdt0(delta) if delta is not None else 'n/a'}).",
        "Relist via the Agent conversation after fixing what the OKX delisting notice names; "
        "/a2mcp/* serving is watched separately by the drift canary's leg C.",
        f"Action: dispatch {RECOMMENDED_WAVE} via Cowork → Claude Code",
    ])


def metrics_for(listing, status, state, balance_atomic, delta, action) -> dict:
    return {
        "agent_id": AGENT_ID,
        "listing": listing,
        "http_status": status,
        "consecutive_not_listed": state["consecutive_not_listed"],
        "threshold": THRESHOLD,
        "balance_usdt0_atomic": balance_atomic,
        "balance_delta_atomic": delta,
        "action": action,
    }


# ── I/O ──────────────────────────────────────────────────────────────────────────────────────


def probe_listing(agent_id: str):
    """→ (status, body). Body capped at 2 MB; a read failure leaves it empty (→ unknown on a 200)."""
    url = f"https://www.okx.ai/agents/{agent_id}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read(2_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001 — network errors are UNKNOWN, never ABSENT
        log(f"listing probe failed (unknown): {str(e)[:160]}")
        return None, ""


def probe_balance(owner: str):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": USDT0, "data": balance_calldata(owner)}, "latest"]}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return parse_balance_result(json.loads(r.read().decode()).get("result"))
    except Exception as e:  # noqa: BLE001 — a balance read failure is recorded, never a verdict
        log(f"balance probe failed: {str(e)[:160]}")
        return None


def load_state() -> dict:
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:  # noqa: BLE001
        log(f"state unreadable, starting fresh: {str(e)[:120]}")
        return {}


def save_state(state: dict) -> None:
    d = os.path.dirname(STATE_PATH) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".okx-ai-listing.")
    with os.fdopen(fd, "w") as f:
        json.dump(state, f, sort_keys=True)
    os.replace(tmp, STATE_PATH)


def fire(body: str) -> None:
    proc = subprocess.run([WRAPPER, ALERT_ID, SEVERITY, "-"], input=body,
                          capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def clear(reason: str) -> None:
    with open(os.devnull, "rb") as devnull:
        proc = subprocess.run([WRAPPER, "--clear", ALERT_ID, reason], stdin=devnull,
                              capture_output=True, text=True, timeout=30)
    log("wrapper --clear exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def record(verdict: str, exit_code: int, metrics: dict) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import canary_result_log  # noqa: E402 — lives beside this file on the host
        ok, detail = canary_result_log.append_result(CANARY, verdict, exit_code, metrics)
    except Exception as e:  # noqa: BLE001 — a recorder failure must never change the verdict
        ok, detail = False, "import/append raised: %s" % str(e)[:160]
    print("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail, flush=True)


def main() -> int:
    at = now_iso()
    prev = load_state()
    status, page = probe_listing(AGENT_ID)
    listing = classify_listing(status, page, AGENT_ID)
    balance = probe_balance(PAYTO)
    delta = balance_delta(prev, balance)
    state = next_state(prev, listing, balance, at)
    verdict, code, action = decide(listing, state["consecutive_not_listed"], THRESHOLD)
    log(f"agent={AGENT_ID} http={status} listing={listing} consecutive_not_listed={state['consecutive_not_listed']}/"
        f"{THRESHOLD} balance_usdt0={usdt0(balance)} delta_usdt0={usdt0(delta) if delta is not None else 'n/a'} "
        f"action={action}")
    try:
        save_state(state)
    except Exception as e:  # noqa: BLE001 — fail-open: a state write failure is logged, not paged
        log(f"state write failed: {str(e)[:160]}")
    try:
        if action == "fire":
            fire(alert_body(AGENT_ID, state["consecutive_not_listed"], state.get("last_listed_at"), balance, delta, listing))
        elif action == "clear":
            clear(f"okx.ai agent {AGENT_ID} listed (http 200, agent record on the page)")
    except Exception as e:  # noqa: BLE001 — fail-open: the wrapper is the alert path, never the verdict
        log(f"wrapper invoke failed (fail-open): {str(e)[:160]}")
    record(verdict, code, metrics_for(listing, status, state, balance, delta, action))
    print(f"OKX_AI_LISTING_VERDICT={verdict}", flush=True)
    return code


# ── self-test ────────────────────────────────────────────────────────────────────────────────


def self_test() -> int:
    fails: list[str] = []
    ran = 0

    def check(name: str, cond) -> None:
        nonlocal ran
        ran += 1
        try:
            ok = bool(cond() if callable(cond) else cond)
        except Exception as e:  # noqa: BLE001 — a raising assertion is a FAIL, never a crash
            ok = False
            name = f"{name} (raised {type(e).__name__}: {e})"
        print(("  ok   " if ok else "  FAIL ") + name, flush=True)
        if not ok:
            fails.append(name)

    # classify — fixtures shaped like the measured pages (2026-10-13)
    LISTED_PAGE = '<script>window.__INIT_STATE__={"agentDetail":{"agentId":"3417","onlineStatus":1}}</script>'
    REVIEW_PAGE = '<img alt="Agent image"/>This ASP is under reviewThis Agent Service Provider is currently being reviewed'
    OTHER_AGENT = '<script>window.__INIT_STATE__={"agentDetail":{"agentId":"34170","onlineStatus":1}}</script>'
    check("200 + this agent's record → listed", classify_listing(200, LISTED_PAGE, "3417") == LISTED)
    check("200 + review placeholder → review (NOT listed)", classify_listing(200, REVIEW_PAGE, "3417") == REVIEW)
    check("200 + neither marker → unknown (never a pass on an unreadable page)", classify_listing(200, "<html>ok</html>", "3417") == UNKNOWN)
    check("200 + a DIFFERENT agent's record (id prefix) → not listed", classify_listing(200, OTHER_AGENT, "3417") == UNKNOWN)
    check("200 + empty body → unknown", classify_listing(200, "", "3417") == UNKNOWN)
    check("404 → absent", classify_listing(404, "", "3417") == ABSENT)
    for s in (None, 301, 403, 429, 500, 503):
        check(f"{s} → unknown (never absent)", classify_listing(s, LISTED_PAGE, "3417") == UNKNOWN)

    # calldata + parse
    cd = balance_calldata("0x62366c50e1bb14ed4ff2b6c8c143f6049df075b9")
    check("balanceOf calldata is selector + 32-byte padded owner",
          cd == "0x70a08231" + "0" * 24 + "62366c50e1bb14ed4ff2b6c8c143f6049df075b9" and len(cd) == 74)
    check("calldata refuses a non-address", lambda: _raises(lambda: balance_calldata("0x1234")))
    check("parse 0x5f370 → 390000 atomic (0.39 USDT0)", parse_balance_result("0x" + "0" * 59 + "5f370") == 390000)
    check("parse refuses junk", parse_balance_result("nope") is None and parse_balance_result(None) is None)
    check("usdt0 renders 390000 as 0.39", usdt0(390000) == "0.39")

    # the counter rule
    s1 = next_state({}, ABSENT, 390000, "T1")
    check("first absent → counter 1", s1["consecutive_not_listed"] == 1)
    s2 = next_state(s1, UNKNOWN, None, "T2")
    check("unknown neither advances nor resets", s2["consecutive_not_listed"] == 1)
    check("unknown keeps the last balance (no fabricated delta)", s2["last_balance_atomic"] == 390000)
    s3 = next_state(s2, REVIEW, 400000, "T3")
    check("under review counts as NOT listed → counter 2", s3["consecutive_not_listed"] == 2)
    check("under review never stamps last_listed_at", s3["last_listed_at"] is None)
    s4 = next_state(s3, LISTED, 410000, "T4")
    check("listed resets the counter and stamps last_listed_at", s4["consecutive_not_listed"] == 0 and s4["last_listed_at"] == "T4")
    check("reads the first cut's consecutive_absent key once (continuity)",
          next_state({"consecutive_absent": 1}, ABSENT, None, "T5")["consecutive_not_listed"] == 2)

    # decide
    check("listed → PASS/0/clear", decide(LISTED, 0, 2) == ("PASS", 0, "clear"))
    check("1st absent → FAIL/0/none (never pages on one miss)", decide(ABSENT, 1, 2) == ("FAIL", 0, "none"))
    check("2nd absent → FAIL/0/fire", decide(ABSENT, 2, 2) == ("FAIL", 0, "fire"))
    check("1st review → FAIL/0/none", decide(REVIEW, 1, 2) == ("FAIL", 0, "none"))
    check("2nd consecutive not-listed (review) → FAIL/0/fire", decide(REVIEW, 2, 2) == ("FAIL", 0, "fire"))
    check("unknown → INDETERMINATE/3/none", decide(UNKNOWN, 5, 2) == ("INDETERMINATE", 3, "none"))

    # delta
    check("delta = this week − last week", balance_delta({"last_balance_atomic": 390000}, 410000) == 20000)
    check("delta is None when either side is missing",
          balance_delta({}, 410000) is None and balance_delta({"last_balance_atomic": 1}, None) is None)

    # alert body: names the entity with its noun, the count, the URL, the action template
    body = alert_body("3417", 2, None, 390000, None, ABSENT)
    check("body names the alert id, the agent, the count and the URL",
          ALERT_ID in body and "agent 3417" in body and "2 consecutive" in body and "/agents/3417" in body)
    check("a review-state body says UNDER REVIEW, not 404",
          "UNDER REVIEW" in alert_body("3417", 2, None, 390000, None, REVIEW) and "404" not in alert_body("3417", 2, None, 390000, None, REVIEW))
    check("body carries the W{NEXT} template, never a literal wave number",
          "OPS-OKX-AI-LISTING-W{NEXT}" in body and not re.search(r"OPS-OKX-AI-LISTING-W\d", body))

    # metrics fit the recorder's line cap
    m = metrics_for(ABSENT, 404, s3, 400000, 10000, "fire")
    check("metrics serialise under canary_result_log's 8 KiB cap", len(json.dumps(m)) < 8192)

    if ran == 0:
        print("SELF-TEST: FAIL (vacuous — no checks ran)")
        return 1
    if fails:
        print(f"SELF-TEST: FAIL ({len(fails)} of {ran})")
        return 1
    print(f"SELF-TEST: PASS ({ran} checks)")
    return 0


def _raises(fn) -> bool:
    try:
        fn()
    except Exception:  # noqa: BLE001
        return True
    return False


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(self_test())
    sys.exit(main())
