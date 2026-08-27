-- 034 down — OPS-QUOTA-EXHAUSTION-OUTCOME-GATE-W1
-- Reverts exactly what 034 granted, and nothing else.
--
-- WHAT REVERTING COSTS, stated so it is a decision and not a surprise: with these grants gone the
-- quota-exhaustion canary's outcome arms render `unavailable (no SELECT privilege)` and the run
-- labels those arms INDETERMINATE. That is the DESIGNED degradation — the canary distinguishes
-- "no privilege" from "no rows" precisely so this state is visible rather than silent — but the
-- alert stops carrying the outcome and reverts to paging on detection alone.
--
-- The ALTER DEFAULT PRIVILEGES reversal is the exact inverse statement, not a REVOKE: default
-- privileges are removed by re-issuing the ALTER with REVOKE, which deletes the pg_default_acl
-- entry. It does NOT revoke privileges already materialised on tables created while it was in
-- force — those are ordinary grants now and are left alone deliberately, since dropping them
-- would silently break consumers this migration never added.

ALTER DEFAULT PRIVILEGES FOR ROLE algovault_app IN SCHEMA public
  REVOKE SELECT ON TABLES FROM algovault_autopilot;

ALTER DEFAULT PRIVILEGES FOR ROLE algovault     IN SCHEMA public
  REVOKE SELECT ON TABLES FROM algovault_autopilot;

REVOKE SELECT ON funnel_events      FROM algovault_autopilot;
REVOKE SELECT ON signup_attribution FROM algovault_autopilot;
