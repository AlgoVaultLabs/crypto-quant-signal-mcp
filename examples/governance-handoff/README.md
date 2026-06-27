# Governance handoff: AlgoVault signal → /review → execute or hold

A minimal, runnable example of the two-layer pattern:

1. **AlgoVault** (the brain) — `get_trade_call` returns BUY / SELL / HOLD + confidence + regime
2. **invinoveritas `/review`** (the governance gate) — checks the proposed order for size, leverage, and drawdown before execution; advisory, never blocks

```
AlgoVault get_trade_call
        │
        ▼
 call == HOLD? ──yes──► HOLD
        │ no
        ▼
invinoveritas /review
        │
   ┌────┴────┐
approve   reject
(+concerns)
        │
        ▼
 EXECUTE / EXECUTE_WITH_CAUTION / HOLD
```

The agent owns the final decision. The gate degrades gracefully (timeout, 402) — it never blocks a trade by going unavailable.

## Run it

```bash
pip install requests

# 100 free AlgoVault calls/month — no key needed to start
# invinoveritas key optional: gate skips cleanly on 402 if unfunded

python demo.py BTC 4h
python demo.py ETH 1h --size-usd 500 --leverage 3
ALGOVAULT_API_KEY=your_key INVINOVERITAS_API_KEY=your_bearer python demo.py SOL 15m
```

## Why both layers

AlgoVault is the signal source — it decides *what* the trade should be.
`/review` is the pre-execution sanity check — it looks at *whether* the proposed size and leverage are account-appropriate given current drawdown.

They answer different questions and never overlap:

| Layer | Question |
|---|---|
| AlgoVault `get_trade_call` | Is the market set up for a trade? |
| invinoveritas `/review` | Is this specific order safe to send given my account state? |

## Same payment rail

Both services accept x402 (USDC on Base). An agent already paying AlgoVault per call can pay `/review` with the same wallet — no new infrastructure.

- AlgoVault: `https://api.algovault.com/mcp`
- invinoveritas: `https://api.babyblueviper.com` · [docs](https://api.babyblueviper.com/docs) · [free `/verify-proof`](https://api.babyblueviper.com/verify-proof)

> **Community integration.** This example is maintained by the invinoveritas team.
> AlgoVault lists it as a community example — not a formal endorsement or audit of either service.
