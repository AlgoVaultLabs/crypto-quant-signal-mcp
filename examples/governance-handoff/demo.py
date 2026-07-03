"""
Governance handoff: AlgoVault signal -> /review gate -> execute or hold.

AlgoVault is the brain (BUY/SELL/HOLD + confidence + regime).
invinoveritas /review is the pre-execution governance check (size, leverage,
drawdown — advisory, never blocks). The agent owns the final decision.

Usage:
    python demo.py BTC 4h [--size-usd 1000] [--leverage 5]

Requirements:
    pip install requests
    ALGOVAULT_API_KEY=<your key>   (100 free calls/month, no key needed for free tier)
    INVINOVERITAS_API_KEY=<bearer> (optional; calls without a funded key return 402
                                    — the gate degrades gracefully to SKIP on payment error)

Both services share the same payment rail (x402 / USDC on Base), so an agent
already paying AlgoVault per call can pay /review with the same wallet.
"""

import argparse
import json
import os
import sys

import requests

ALGOVAULT_MCP = "https://api.algovault.com/mcp"
INVINOVERITAS_REVIEW = "https://api.babyblueviper.com/review"
REVIEW_TIMEOUT_S = 8  # advisory gate — never block the trade on a slow response


def get_trade_call(coin: str, timeframe: str, api_key: str | None) -> dict:
    """Call AlgoVault get_trade_call via MCP JSON-RPC.

    AlgoVault's /mcp is stateless streamable-HTTP: it requires the
    ``Accept: application/json, text/event-stream`` header (otherwise 406) and
    replies with an SSE frame (``event: message`` / ``data: {…}``), so the JSON
    lives on the ``data:`` line rather than in ``r.json()``. A bare ``tools/call``
    works with no initialize handshake.
    """
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",  # required by streamable-HTTP MCP
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "get_trade_call",
            "arguments": {"coin": coin, "timeframe": timeframe},
        },
    }
    r = requests.post(ALGOVAULT_MCP, json=payload, headers=headers, timeout=15)
    r.raise_for_status()
    if "text/event-stream" in r.headers.get("content-type", ""):
        # SSE frame: take the JSON envelope off the `data:` line.
        line = next(ln[5:] for ln in r.text.splitlines() if ln.startswith("data:"))
        envelope = json.loads(line.strip())
    else:
        envelope = r.json()
    # MCP result is nested: result.content[0].text -> JSON string
    content = envelope.get("result", {}).get("content", [{}])[0].get("text", "{}")
    return json.loads(content)


def review_trade(signal: dict, coin: str, size_usd: float, leverage: float,
                 bearer: str | None) -> dict | None:
    """
    POST the proposed order to /review. Returns the verdict dict or None if
    the gate is unavailable (network error, 402 without a funded key, etc.).
    The caller treats None as SKIP — the gate is advisory only.
    """
    # /review takes `artifact` as a STRING (per the published schema), so the
    # proposed order is rendered as a concise human-readable line. Note AlgoVault
    # confidence is 0–100 (e.g. 37), so it's labelled `/100` here — /review must
    # not read it as a 0–1 probability.
    artifact = (
        f"Proposed {signal.get('call', 'UNKNOWN')} {coin}: "
        f"size ${size_usd:,.0f} at {leverage}x leverage, entry {signal.get('price')}. "
        f"AlgoVault signal confidence {signal.get('confidence')}/100, "
        f"regime {signal.get('regime')}. Reasoning: {signal.get('reasoning', '')}".strip()
    )
    headers = {"Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    try:
        r = requests.post(
            INVINOVERITAS_REVIEW,
            json={
                "artifact_type": "trade",
                "artifact": artifact,
                "severity_threshold": "all",
                "sign": True,
            },
            headers=headers,
            timeout=REVIEW_TIMEOUT_S,
        )
        if r.status_code == 402:
            print("  [/review] no funded key — gate skipped (advisory only)")
            return None
        r.raise_for_status()
        return r.json()
    except requests.exceptions.Timeout:
        print("  [/review] timeout — gate skipped (advisory only)")
        return None
    except Exception as e:
        print(f"  [/review] unavailable ({e}) — gate skipped (advisory only)")
        return None


def decide(signal: dict, review: dict | None) -> str:
    """
    Agent-side decision: combine AlgoVault signal with /review verdict.
    Returns 'EXECUTE', 'EXECUTE_WITH_CAUTION', or 'HOLD'.
    """
    call = signal.get("call", "HOLD")
    if call == "HOLD":
        return "HOLD"
    if review is None:
        # Gate unavailable — proceed on signal alone (advisory gate never blocks)
        return "EXECUTE"
    verdict = review.get("verdict", "")
    if verdict == "approve":
        return "EXECUTE"
    if verdict == "approve_with_concerns":
        return "EXECUTE_WITH_CAUTION"
    if verdict == "reject":
        return "HOLD"
    return "EXECUTE"  # unknown verdict shape — don't block


def main():
    ap = argparse.ArgumentParser(description="AlgoVault signal -> /review -> execute or hold")
    ap.add_argument("coin", help="e.g. BTC, ETH, SOL")
    ap.add_argument("timeframe", nargs="?", default="4h", help="e.g. 1h, 4h, 1d")
    ap.add_argument("--size-usd", type=float, default=1000, help="proposed position size in USD")
    ap.add_argument("--leverage", type=float, default=5, help="proposed leverage")
    args = ap.parse_args()

    av_key = os.getenv("ALGOVAULT_API_KEY")
    iv_key = os.getenv("INVINOVERITAS_API_KEY")

    # Step 1: get AlgoVault signal
    print(f"\n[1] AlgoVault: get_trade_call({args.coin}, {args.timeframe})")
    try:
        signal = get_trade_call(args.coin, args.timeframe, av_key)
    except Exception as e:
        print(f"  ERROR: {e}")
        sys.exit(1)
    print(f"  call={signal.get('call')}  confidence={signal.get('confidence')}  "
          f"regime={signal.get('regime')}  price={signal.get('price')}")

    if signal.get("call") == "HOLD":
        print("\n[2] /review: skipped (signal is HOLD — nothing to review)")
        print("\n=> HOLD (AlgoVault signal)")
        return

    # Step 2: governance check
    print(f"\n[2] /review: checking proposed {signal['call']} "
          f"${args.size_usd} x{args.leverage} {args.coin}")
    review = review_trade(signal, args.coin, args.size_usd, args.leverage, iv_key)
    if review:
        print(f"  verdict={review.get('verdict')}  confidence={review.get('confidence')}")
        if review.get("summary"):
            print(f"  summary: {review['summary'][:120]}")
        for issue in (review.get("issues") or [])[:3]:
            print(f"  issue: {issue}")
        if review.get("proof", {}).get("id"):
            print(f"  proof: {review['proof']['id']} (recheck: GET /verify-proof?id={review['proof']['id']})")

    # Step 3: agent decision
    decision = decide(signal, review)
    print(f"\n=> {decision}")
    if decision == "EXECUTE_WITH_CAUTION":
        print("   (proceed, but review flagged concerns above)")
    elif decision == "HOLD":
        print("   (/review rejected — holding, re-check next cycle)")


if __name__ == "__main__":
    main()
