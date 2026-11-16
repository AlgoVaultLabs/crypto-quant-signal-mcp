-- 057_tg_signin_tokens.sql — TG-SIGNIN-W1-R2 CH2
-- The one-time Telegram sign-in token. A checkout bought from the bot's plan buttons (Session
-- `metadata.utm_source` = `tg_bot`) reveals its key on /welcome once; on that reveal only — tier starter or
-- pro, with an email — the page mints ONE token (`tgl_` + 32 lowercase hex, 16 random bytes) and puts it on
-- the Open Telegram button (`https://t.me/algovaultofficialbot?start=tgl_<token>`). The bot redeems it through
-- `POST /api/bot/signin-token/redeem` and signs in the private chat that opened the link. One row per token:
--
--   token_hash    sha256 hex of the full token — UNIQUE, the redeem's lookup; the token itself is never stored
--   customer_id   the Stripe customer — the redeem reads its CURRENT api key by id (`customers.retrieve`),
--                 never by search; the key itself is never stored here, and neither is a chat id
--   tier          starter | pro — the only tiers a token is minted for
--   email_masked  `maskEmail` of the customer email (`b***@example.com`) for the bot's confirmation (B10)
--   expires_at    created_at + 24 h; an expired token redeems nothing
--   redeemed_at   NULL until the one redeem that wins; set only where it is still NULL
--
-- Producer: mintSigninToken (src/lib/tg-signin-tokens.ts), from revealKeyOnce's CLAIMED arm (src/lib/key-reveal.ts).
-- Consumer: algovault-bot's `/start tgl_<token>` arm (TG-SIGNIN-W1-R2 CH1), through the internal-key redeem route.
--
-- Not pre-applied: the lazy ensure in src/lib/tg-signin-tokens.ts runs these exact statements once per process
-- before its first read or write, under the app's own role. A new table — nothing written by code that predates
-- it reads or writes it, so reverting the code is a complete rollback. The statements are identical (pinned by
-- tests/unit/tg-signin-tokens-pglite.test.ts, which also applies this file up, down and up again).

CREATE TABLE IF NOT EXISTS tg_signin_tokens (
  id           BIGSERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  customer_id  TEXT NOT NULL,
  tier         TEXT NOT NULL,
  email_masked TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  redeemed_at  TIMESTAMPTZ
);
