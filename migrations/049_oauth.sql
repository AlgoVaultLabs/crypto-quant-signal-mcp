-- 049_oauth.sql — GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 (R2.13, endpoint-truth §Proposals (e)).
-- The OAuth authorization server's store: registered (DCR) clients, the CIMD document cache,
-- pending authorizations, single-use codes, access + refresh tokens (SHA-256 only) and email codes.
--
-- Producer + consumer: src/lib/oauth/* (mounted only when MCP_OAUTH is optin|wall). Every timestamp
-- is ISO-8601 TEXT computed in JS. Nothing here holds a token, a code or a key in clear EXCEPT
-- identity_value, which for a bare-key identity (no email on file) is that key — the identity, R2.9.
--
-- NOT pre-applied: the identical lazy ensure in src/lib/oauth/store.ts creates these tables on the
-- first non-`off` boot (CH4), as the app role (has_schema_privilege(algovault_app, public, CREATE)
-- = t, measured 2026-10-27). Parity with the ensure is pinned by tests/unit/oauth-store-ddl.test.ts.
-- Retention (purgeExpired, hourly): pending, codes, OTPs after 24 h; revoked/expired tokens after
-- 30 d; DCR clients unused for 30 d.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id          TEXT NOT NULL,
  client_name        TEXT,
  redirect_uris_json TEXT NOT NULL,
  metadata_json      TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  last_used_at       TEXT NOT NULL,
  PRIMARY KEY (client_id)
);

CREATE TABLE IF NOT EXISTS oauth_cimd_cache (
  client_id     TEXT NOT NULL,
  document_json TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL,
  PRIMARY KEY (client_id)
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  id                    TEXT NOT NULL,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  redirect_uri_explicit INTEGER NOT NULL,
  code_challenge        TEXT NOT NULL,
  state                 TEXT,
  scopes                TEXT NOT NULL,
  resource              TEXT NOT NULL,
  csrf_token            TEXT NOT NULL,
  identity_kind         TEXT,
  identity_value        TEXT,
  via                   TEXT,
  plan                  TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  consumed_at           TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash             TEXT NOT NULL,
  pending_id            TEXT NOT NULL,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  redirect_uri_explicit INTEGER NOT NULL,
  code_challenge        TEXT NOT NULL,
  resource              TEXT NOT NULL,
  scopes                TEXT NOT NULL,
  identity_kind         TEXT NOT NULL,
  identity_value        TEXT NOT NULL,
  via                   TEXT NOT NULL,
  plan                  TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  used_at               TEXT,
  PRIMARY KEY (code_hash)
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  family_id      TEXT NOT NULL,
  code_hash      TEXT,
  client_id      TEXT NOT NULL,
  resource       TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  identity_kind  TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  parent_hash    TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  rotated_at     TEXT,
  revoked_at     TEXT,
  PRIMARY KEY (token_hash)
);

CREATE TABLE IF NOT EXISTS email_otps (
  id          TEXT NOT NULL,
  pending_id  TEXT NOT NULL,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_code ON oauth_tokens (code_hash);
CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps (email, created_at);
CREATE INDEX IF NOT EXISTS idx_email_otps_pending ON email_otps (pending_id);
