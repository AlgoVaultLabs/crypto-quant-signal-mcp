-- 052_pre_trade_rule_profiles.sql — DECISION-CALL-V2-W2 CH1
-- Saved pre_trade_check rule profiles: one `rules` object per API key, applied to every check made with that key
-- (Prompt/pre-trade-check-contract-v2.md § v2.1). Layers, key by key: defaults, then this profile, then the call's
-- own `rules`.
--
-- INTERNAL. No raw key, no wallet address, no IP column: the owner is caller_ref, the keyed pseudonym of the API
-- key (callerRef in src/lib/lifecycle/identity.ts — the check log's caller_ref for the same key, so a profile and
-- the checks it shaped share one ref). The store refuses any id that is not that pseudonym.
--
-- Producer: PUT / DELETE /api/pre-trade-rules (API key required).
-- Consumer: the pre_trade_check handler — a keyed call reads its profile once, before rule activation; keyless,
--   x402 and internal calls never read. An unreadable profile adds SAVED_RULES_UNAVAILABLE (adjust).
--
-- Not pre-applied: the lazy ensure in src/lib/pre-trade-rule-profiles.ts creates the table on first use, under the
-- app's own role like every lazily ensured table; IF NOT EXISTS makes this file a no-op after that. The CREATEs
-- are identical (pinned by tests/unit/pre-trade-rule-profiles.test.ts).

CREATE TABLE IF NOT EXISTS pre_trade_rule_profiles (
  caller_ref TEXT        PRIMARY KEY,  -- pc1:<32 hex> pseudonym of the API key; never the key
  rules      JSONB       NOT NULL,     -- the rules object, parsed against PRE_TRADE_RULES (src/lib/pre-trade-rules.ts)
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL      -- the last PUT; served as saved_rules.updated_at
);
