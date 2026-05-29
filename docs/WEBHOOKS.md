# AlgoVault Webhooks — Trade Call & Regime push

Pause your bot the moment the market regime turns. Instead of polling
`get_trade_call` on a timer, register an HTTPS endpoint and AlgoVault will
**POST you a signed event** the instant a new Trade Call fires or the regime
shifts for an asset you care about.

Built for T2 desks running FreqTrade / Hummingbot / 3Commas / Cryptohopper /
Nautilus. Every delivery is HMAC-signed, idempotent, retried, and self-healing.

> Status: ships behind a server flag (`WEBHOOK_DELIVERY_ENABLED`). Registration
> is open; delivery turns on when AlgoVault enables the flag. You can register
> and `/test` your endpoint now.

---

## Event types

| `event` | Fires when | Key fields |
|---|---|---|
| `trade_call` | a new BUY/SELL Trade Call is recorded for an asset | `call`, `confidence`, `regime`, `price_at_call` |
| `regime_shift` | the regime for `(coin, timeframe, exchange)` changes vs the previous call | `regime`, `prior_regime` |

`call` is one of `BUY`, `SELL`, `HOLD`. `regime` is one of `TRENDING_UP`,
`TRENDING_DOWN`, `RANGING`, `VOLATILE`. A `regime_shift` into `RANGING` /
`VOLATILE` is your "conditions just got hostile — flatten or widen stops" hook.

---

## Quickstart

Registration needs an API key (a free-tier key works). Send it as a Bearer
token. Each **delivered** event draws down your monthly call quota, exactly like
a pull call (Free 100 / Starter 3,000 / Pro 15,000 / Enterprise 100,000).

```bash
# Create a subscription (the signing secret is returned ONCE — store it now)
curl -s -X POST https://api.algovault.com/api/webhooks \
  -H "Authorization: Bearer $ALGOVAULT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourbot.example.com/algovault-hook",
    "events": ["trade_call", "regime_shift"],
    "assets": ["BTC", "ETH", "SOL"],
    "timeframes": ["1h", "4h"],
    "min_confidence": 60
  }'
```

`assets`, `timeframes`, `min_confidence` are optional filters — omit them to
receive everything. The response contains your `subscription.secret`; you will
not see it again.

```bash
# List your subscriptions (secret is never returned here)
curl -s https://api.algovault.com/api/webhooks -H "Authorization: Bearer $ALGOVAULT_API_KEY"

# Send a sample signed event to your endpoint to verify wiring
curl -s -X POST https://api.algovault.com/api/webhooks/<id>/test -H "Authorization: Bearer $ALGOVAULT_API_KEY"

# Delete a subscription
curl -s -X DELETE https://api.algovault.com/api/webhooks/<id> -H "Authorization: Bearer $ALGOVAULT_API_KEY"
```

---

## Payload

```json
{
  "event": "trade_call",
  "delivery_id": "12345",
  "created_at": 1735500000,
  "data": {
    "type": "trade_call",
    "coin": "BTC",
    "timeframe": "1h",
    "exchange": "HL",
    "call": "BUY",
    "confidence": 72,
    "regime": "TRENDING_UP",
    "price_at_call": 95000,
    "signal_hash": "0x4a2c…7f91",
    "verify_url": "https://algovault.com/verify?hash=0x4a2c…7f91"
  },
  "_algovault": {
    "service": "webhook-delivery",
    "version": "1.18.2",
    "docs": "https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/WEBHOOKS.md",
    "disclaimer": "Trade calls are informational, not financial advice. Verify on-chain via verify_url."
  }
}
```

A `regime_shift` payload adds `data.prior_regime` (the regime before the flip).
`signal_hash` is the call's on-chain leaf hash; `verify_url` deep-links to its
Merkle proof. Payloads only ever carry the public, allow-listed fields above —
no internal outcome/return metrics are ever sent.

### Headers

| Header | Meaning |
|---|---|
| `X-AlgoVault-Signature` | `hex(HMAC_SHA256(raw_body, your_secret))` |
| `X-AlgoVault-Event` | `trade_call` or `regime_shift` |
| `X-AlgoVault-Delivery` | unique delivery id |
| `X-AlgoVault-Timestamp` | epoch seconds at send time |

---

## Verify the signature

Always verify `X-AlgoVault-Signature` against the **raw** request body before
acting on a payload.

**Node.js**

```js
import crypto from "node:crypto";

function verify(rawBody, signatureHeader, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // constant-time compare
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

// express: use express.raw({ type: "application/json" }) so req.body is the raw Buffer
app.post("/algovault-hook", express.raw({ type: "application/json" }), (req, res) => {
  if (!verify(req.body, req.get("X-AlgoVault-Signature"), process.env.ALGOVAULT_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  const event = JSON.parse(req.body.toString());
  if (event.event === "regime_shift" && ["RANGING", "VOLATILE"].includes(event.data.regime)) {
    pauseBot(event.data.coin, event.data.timeframe);
  }
  res.status(200).end();
});
```

**Python (Flask)**

```python
import hmac, hashlib

def verify(raw_body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)

@app.post("/algovault-hook")
def hook():
    if not verify(request.get_data(), request.headers.get("X-AlgoVault-Signature", ""), SECRET):
        abort(401)
    event = request.get_json()
    if event["event"] == "regime_shift" and event["data"]["regime"] in ("RANGING", "VOLATILE"):
        pause_bot(event["data"]["coin"], event["data"]["timeframe"])
    return "", 200
```

---

## Delivery semantics

- **Respond 2xx fast.** Return `2xx` within 10s. Non-2xx or a timeout is retried.
- **Retries:** up to 5 attempts with exponential backoff.
- **Idempotency:** each event is delivered at most once per subscription
  (`X-AlgoVault-Delivery` is unique; dedupe on it).
- **Cooldown:** `regime_shift` for a given `(coin, timeframe, exchange)` is
  debounced to at most once per hour, so a flapping regime won't spam you.
- **Auto-disable:** an endpoint that fails 20 deliveries in a row is paused
  automatically. Fix it (it must return `2xx`), then recreate the subscription.
- **Quota:** if your monthly quota is exhausted, deliveries pause and resume on
  the next reset or when you upgrade — no events are lost in between.

---

## Errors

All errors return `{ "ok": false, "code": "<code>", "error": "…", "suggested_action": "…" }`:

| Status | `code` | Meaning |
|---|---|---|
| 401 | `auth_required` | no API key — create one and send it as a Bearer token |
| 400 | `invalid_url` / `invalid_events` / `invalid_min_confidence` / `invalid_id` | bad input |
| 404 | `not_found` | the subscription doesn't exist or isn't yours |
