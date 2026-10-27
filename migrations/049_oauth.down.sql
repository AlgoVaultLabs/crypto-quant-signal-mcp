-- 049_oauth.down.sql — rollback of 049 (GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2).
-- ⚠ DESTRUCTIVE: drops every OAuth grant — each connected client must sign in again. Never run it
-- while MCP_OAUTH is optin|wall (the lazy ensure in src/lib/oauth/store.ts recreates the tables on
-- the next boot), and never without explicit authorization. Set MCP_OAUTH off first — that alone
-- is the rollback lever; this file only removes the storage.
DROP INDEX IF EXISTS idx_email_otps_pending;
DROP INDEX IF EXISTS idx_email_otps_email;
DROP INDEX IF EXISTS idx_oauth_tokens_code;
DROP INDEX IF EXISTS idx_oauth_tokens_family;
DROP TABLE IF EXISTS email_otps;
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_codes;
DROP TABLE IF EXISTS oauth_pending;
DROP TABLE IF EXISTS oauth_cimd_cache;
DROP TABLE IF EXISTS oauth_clients;
