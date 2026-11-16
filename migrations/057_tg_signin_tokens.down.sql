-- 057_tg_signin_tokens.down.sql — rollback of 057 (TG-SIGNIN-W1-R2 CH2).
-- ⚠ DESTRUCTIVE: this DROPS every sign-in token. An unredeemed row is a paid Telegram checkout whose buyer has not
-- tapped Open Telegram yet; dropping it turns that tap into the bot's paste-your-key prompt (the buyer can still
-- paste the key from the page or the welcome email). Data Integrity LAW: never run it against production without
-- explicit authorization. Take `pg_dump -t tg_signin_tokens` first. The lazy ensure in src/lib/tg-signin-tokens.ts
-- re-creates the (empty) table on the next reveal or redeem unless the code is reverted first.
DROP TABLE IF EXISTS tg_signin_tokens;
