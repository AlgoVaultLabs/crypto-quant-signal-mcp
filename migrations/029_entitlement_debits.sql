-- 029 — PRICING-BOT-DELIVERY-METERING-W1 CH2
-- The entitlement debit ledger, which is ALSO the idempotency store. One table, two jobs.
--
-- WHY ONE TABLE. A separate claims table and a separate ledger would need a transaction to stay
-- consistent, and `quota_usage` writes are best-effort with `catch {}` — there is no transaction
-- spanning them. Making the claim row BE the ledger row removes the question: if a debit is
-- recorded, it was claimed; if it was claimed, exactly one caller charged.
--
-- WHY IT MATTERS THAT THIS EXISTS AT ALL. Before it, `trackCallByKey` had NO idempotency key, so a
-- webhook redelivery charged the owner twice. Under this wave's architect ruling R-1 the bot HARD
-- WALLS a paid subscriber at the plan ceiling, which turns a double-charge from an accounting
-- nuisance into a paying customer walled early. Idempotency is load-bearing here, not hygiene.
--
-- WHAT IT IS NOT: this is not a request log. A debit is not a request, and nothing here may write
-- `request_log` — the digest's partition guard (tests/call-class.test.ts) asserts
-- `recognized + raw + paid + TG-bot-row == headline`, and a request_log row for a bot delivery
-- would land that delivery on BOTH sides of the identity and fail the partition by double-count.
--
-- ADDITIVE AND SAFE TO PRE-APPLY: a fresh table with no FK, so it can land ahead of the code that
-- reads it (Build Rule 5 — schema FIRST, then server, then bot).

CREATE TABLE IF NOT EXISTS entitlement_debits (
  -- The caller-supplied idempotency key. NEVER server-minted: a key the server invents defeats the
  -- guard on exactly the retry it exists for. For the bot this is `bot:<chat_id>:<alerts_fired.id>`.
  idem_key    TEXT PRIMARY KEY,
  -- The meter this debit was charged against — the subscriber's API key, not the channel's identity.
  tracker_key TEXT NOT NULL,
  -- Which channel consumed it. This is the per-channel consumption attribution that does not exist
  -- anywhere today: `quota_usage` knows a total and nothing about where it came from.
  channel     TEXT NOT NULL,
  tier        TEXT NOT NULL,
  units       INTEGER NOT NULL,
  charged_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-subscriber consumption over time — the "what did this customer spend it on" query.
CREATE INDEX IF NOT EXISTS idx_entitlement_debits_tracker ON entitlement_debits (tracker_key, charged_at);
-- Per-channel consumption over time — the operator/data-flywheel query.
CREATE INDEX IF NOT EXISTS idx_entitlement_debits_channel ON entitlement_debits (channel, charged_at);
