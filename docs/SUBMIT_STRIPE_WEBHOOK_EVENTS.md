# Runbook — subscribe the Stripe webhook to `invoice.paid` + `charge.refunded`

**Wave:** REFERRAL-LIGHT-W1 / C3. **When to run:** the server logs
`[referral] webhook events config incomplete (...) — MANUAL_PENDING` on boot, i.e.
the automated `ensureReferralWebhookEvents()` could not subscribe the live endpoint
(no `STRIPE_SECRET_KEY`, endpoint not found by URL, or a verification failure that
rolled back). The referral **accrual + clawback** webhook legs (`invoice.paid`,
`charge.refunded`) are silently never delivered until these events are subscribed —
entitlement + checkout attribution are unaffected (they ride other events).

This is the MANUAL fallback. The automated path (server boot) is the primary; it is
idempotent and self-heals on the next boot once `STRIPE_SECRET_KEY` is present.

> ⚠️ Stripe's webhook-endpoint update **REPLACES the entire `enabled_events` array.**
> NEVER blind-set just the 2 new events — that would drop the entitlement events
> (`customer.subscription.created`/`.deleted`) + the attribution event
> (`checkout.session.completed`). Always **read → union → write → verify**.

## Option A — Stripe Dashboard (4 clicks)
1. Dashboard → **Developers → Webhooks** → the endpoint for
   `https://api.algovault.com/webhooks/stripe`.
2. **Update details** → **Select events**.
3. Add **`invoice.paid`** and **`charge.refunded`** (leave every existing event
   checked — do not uncheck `checkout.session.completed` /
   `customer.subscription.created` / `customer.subscription.deleted`).
4. **Save**. Confirm the event list now shows all 5.

## Option B — CLI (read → union → write → verify → rollback)
```bash
KEY=$STRIPE_SECRET_KEY    # the LIVE sk_live_… from the prod env; never inline it
URL='https://api.algovault.com/webhooks/stripe'

# 1. resolve the endpoint by URL + capture the original (rollback)
EP=$(curl -s https://api.stripe.com/v1/webhook_endpoints -u "$KEY:" -d limit=100 \
  | jq -r --arg u "$URL" '.data[] | select(.url==$u) | .id')
CUR=$(curl -s https://api.stripe.com/v1/webhook_endpoints/$EP -u "$KEY:" | jq -r '.enabled_events[]?' | sort)

# 2. no-op if already a wildcard or already subscribed
grep -qx '*' <<<"$CUR" && { echo "wildcard — no-op"; exit 0; }
grep -qx 'invoice.paid' <<<"$CUR" && grep -qx 'charge.refunded' <<<"$CUR" && { echo "already subscribed"; exit 0; }

# 3. union = current ∪ {invoice.paid, charge.refunded}, then write the FULL set
UNION=$(printf '%s\ninvoice.paid\ncharge.refunded\n' "$CUR" | sort -u | grep -v '^$')
ARGS=(); while IFS= read -r e; do [ -n "$e" ] && ARGS+=(-d "enabled_events[]=$e"); done <<<"$UNION"
curl -s https://api.stripe.com/v1/webhook_endpoints/$EP -u "$KEY:" "${ARGS[@]}" -o /tmp/after.json

# 4. verify the new set ⊇ the 2 new events AND every pre-existing event
NEW=$(jq -r '.enabled_events[]?' /tmp/after.json | sort)
for req in invoice.paid charge.refunded $CUR; do grep -qx "$req" <<<"$NEW" || { echo "HALT: $req missing"; ROLLBACK=1; }; done

# 5. rollback to the captured original on any miss
if [ "${ROLLBACK:-0}" = 1 ]; then
  RB=(); while IFS= read -r e; do [ -n "$e" ] && RB+=(-d "enabled_events[]=$e"); done <<<"$CUR"
  curl -s https://api.stripe.com/v1/webhook_endpoints/$EP -u "$KEY:" "${RB[@]}" >/dev/null
  echo "rolled back"; exit 4
fi
echo "done — invoice.paid + charge.refunded subscribed; pre-existing events retained"
```

## Verify end-to-end
A real referred customer's first payment → a `referral_ledger` row (`status='credited'`
or `'usdc_pending'`). Until live traffic produces one, the config-level re-GET (step 4)
is the proof. The existing monthly drift canary (`scripts/check-stripe-webhook-events.mjs`)
asserts the handler's *original* 3-event set; extending its `EXPECTED` to include these 2
is a tracked follow-up (the boot-time `ensureReferralWebhookEvents` self-heals them).
