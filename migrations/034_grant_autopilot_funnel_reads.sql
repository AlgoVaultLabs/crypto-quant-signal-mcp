-- 034 — OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1
-- Read-only grants so the host quota-exhaustion canary can resolve a walled caller's OUTCOME.
--
-- WHY THIS IS A MIGRATION AND NOT AN SSH ONE-LINER. `quota-exhaustion-canary.py` connects as
-- `algovault_autopilot` and, from this wave on, joins `funnel_events` (did the caller keep being
-- refused, did they click the upgrade CTA) and `signup_attribution` (did they register) before it
-- decides whether to page. Measured 2026-08-26, that role had SELECT on `quota_usage`,
-- `request_log` and `subscriber_profiles` and NO privilege at all on the other two — so the join
-- would have rendered "unavailable" on every hourly cycle, forever, at a green exit code. A grant
-- applied by hand over SSH is invisible to any future reprovision and would send those arms dark
-- again just as silently, which is the "installed is not working" class this wave exists to
-- retire. Prose in status.md is not a control; a numbered idempotent migration is.
--
-- SENSITIVITY. This is not a privilege expansion of consequence: the role ALREADY holds SELECT on
-- `subscriber_profiles`, which carries `email`, `name` and card metadata. `funnel_events` holds
-- event types and a session id; `signup_attribution` holds a hashed IP and UTM fields. Both are
-- strictly less sensitive than what the role already reads. SELECT only — no INSERT, UPDATE,
-- DELETE, and no ownership change.
--
-- WHY THE `ALTER DEFAULT PRIVILEGES` LINES ARE HERE (the generator-level half). This is the FOURTH
-- monitoring consumer to be bitten by the same cause: `GRANT SELECT ON ALL TABLES IN SCHEMA public`
-- is a one-shot over the tables that exist AT THAT MOMENT — it does not cover tables created
-- afterwards. Every table added since the autopilot role was provisioned has therefore been
-- invisible to it by default, and each occurrence has been fixed one table at a time. Default
-- privileges close the class instead.
--
-- The owning role was MEASURED, not assumed — a re-own wave has moved objects in this database
-- before, so the creating role is not assumable:
--
--   public relations by owner (2026-08-26):  algovault_app 66 · algovault 4 · algovault_autopilot 1
--   funnel_events, signup_attribution, subscriber_profiles, quota_usage, request_log → algovault_app
--
-- BOTH owning roles are covered because `pg_default_acl` already carries exactly that pair for
-- `aoe_readonly` (`algovault=r/algovault` and `algovault_app=r/algovault_app`) — an in-database
-- precedent for the shape, not an extrapolation. Covering only `algovault_app` would leave the
-- four `algovault`-owned relations to recur as a fifth instance.
--
-- Default privileges are NOT retroactive, which is why the two explicit grants above them are
-- required and are not redundant with them.
--
-- IDEMPOTENT AND ADDITIVE: re-running GRANT on an already-granted privilege is a no-op, and
-- re-running ALTER DEFAULT PRIVILEGES with the same target is a no-op. No table is rewritten,
-- no row is touched, nothing is revoked.

-- ── The two tables this wave's outcome join needs, explicitly (default privileges below are not
--    retroactive and cannot supply these).
GRANT SELECT ON funnel_events       TO algovault_autopilot;
GRANT SELECT ON signup_attribution  TO algovault_autopilot;

-- ── The generator fix: every FUTURE table created by either owning role is readable by the
--    monitoring role without a fifth one-table migration.
ALTER DEFAULT PRIVILEGES FOR ROLE algovault_app IN SCHEMA public
  GRANT SELECT ON TABLES TO algovault_autopilot;

ALTER DEFAULT PRIVILEGES FOR ROLE algovault     IN SCHEMA public
  GRANT SELECT ON TABLES TO algovault_autopilot;
