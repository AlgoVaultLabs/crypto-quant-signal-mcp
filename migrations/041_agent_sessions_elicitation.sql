-- 041 — IDENTITY-LIFECYCLE-W3 CH4 R2. The elicitation census columns.
--
-- ONE question these answer: what share of agent sessions run a client that could receive an MCP
-- elicitation? That number is the go/no-go for MCP-ELICITATION-CLAIM-W{NEXT} — build at >= 30%,
-- drop below — and today nobody knows it.
--
-- 🛑 `elicitation_capable` IS NULLABLE BOOLEAN, AND THAT IS THE WHOLE DESIGN.
--   TRUE / FALSE  a client sent `initialize` and told us
--   NULL          no handshake at all
-- The remote transport is STATELESS and `initialize` is OPTIONAL under Streamable HTTP, so a
-- large share of real traffic legitimately never handshakes. A plain `BOOLEAN NOT NULL DEFAULT
-- FALSE` would silently record every one of those as "not capable" and hand the next wave a
-- denominator that answers a question nobody asked — the census would report a low capability
-- share that is really just a measure of how many clients skip the handshake. There is NO
-- backfill and none is owed: the capabilities that decide the value were never stored, so any
-- backfill would be a guess wearing a measurement's clothes.
--
-- `client_name` / `client_version` come from `clientInfo` and are what makes the number
-- actionable — "30% capable" is a fact, "Claude Code yes, Desktop no" is a decision.
--
-- ADDITIVE AND SAFE TO PRE-APPLY. Nullable columns on an existing table are a metadata-only
-- catalog change on PG 11+ — no rewrite, no long lock. The boot-path twin lives in
-- src/lib/lifecycle/census.ts (`ensureCensusColumns`), because this directory never reaches a
-- fresh database or the SQLite test backend.

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS elicitation_capable BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS client_name         TEXT    NULL,
  ADD COLUMN IF NOT EXISTS client_version      TEXT    NULL;
