-- 015_referral_tables.sql — REFERRAL-LIGHT-W1 / C1
-- Referral program substrate: codes (auto per-account 'user' + admin 'partner'),
-- attributions (one grant per human), the commission ledger (idempotent accrual
-- + clawback), and the referee bonus-calls meter.
--
-- Pre-applied to prod signal_performance via SSH psql BEFORE the code commit
-- lands (CLAUDE.md "pre-apply schema via SSH then deploy code with IF NOT EXISTS
-- idempotency"); the in-code ensureReferralSchema() (src/lib/referral-store.ts)
-- mirrors this with IF NOT EXISTS so the committed code is a no-op against the
-- prepared DB. Additive only — no existing table/query touched; Data-Integrity safe.
--
-- e2-cents convention: *_usd_e2 columns store USD × 100 as INT (no float drift).
-- This file is the PG (prod) DDL; the SQLite test backend gets the equivalent
-- portable subset from referral-store.ts (regex CHECK is PG-only).

CREATE TABLE IF NOT EXISTS referral_codes (
  code        TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{6,16}$'),
  kind        TEXT NOT NULL CHECK (kind IN ('user', 'partner')),
  owner_key   TEXT,          -- api key (av_live_/av_free_) for user codes; NULL for partner
  owner_email TEXT,          -- referrer email (lookup / partner contact)
  owner_label TEXT,          -- human label for partner codes (e.g. 'listicle:cryptopanic')
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_attributions (
  id                 BIGSERIAL PRIMARY KEY,
  code               TEXT NOT NULL,
  referee_email      TEXT UNIQUE,            -- one grant per human (fraud floor)
  referee_key        TEXT,                   -- minted av_free_ / av_live_ key
  channel            TEXT NOT NULL CHECK (channel IN ('paid_checkout', 'free_signup')),
  stripe_customer_id TEXT,
  window_ends_at     TIMESTAMPTZ,            -- commission window end (paid path)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_attr_code ON referral_attributions (code);
CREATE INDEX IF NOT EXISTS idx_referral_attr_customer ON referral_attributions (stripe_customer_id);

CREATE TABLE IF NOT EXISTS referral_ledger (
  id                BIGSERIAL PRIMARY KEY,
  code              TEXT NOT NULL,
  attribution_id    BIGINT,
  stripe_event_id   TEXT UNIQUE,             -- accrual idempotency anchor (one row per Stripe event)
  invoice_id        TEXT,
  gross_usd_e2      INTEGER NOT NULL DEFAULT 0,   -- referred invoice amount, USD × 100
  commission_usd_e2 INTEGER NOT NULL DEFAULT 0,   -- COMMISSION_RATE × gross, USD × 100
  status            TEXT NOT NULL CHECK (status IN ('credited', 'usdc_pending', 'usdc_paid', 'clawed_back')),
  tx_ref            TEXT,                    -- Stripe balance-txn id / USDC tx hash
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_ledger_code ON referral_ledger (code);
CREATE INDEX IF NOT EXISTS idx_referral_ledger_status ON referral_ledger (status);

CREATE TABLE IF NOT EXISTS referral_bonus (
  tracker_key     TEXT PRIMARY KEY,          -- the av_free_/av_live_ key (= quota tracker key)
  bonus_remaining INTEGER NOT NULL DEFAULT 0 CHECK (bonus_remaining >= 0),
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_code     TEXT
);
