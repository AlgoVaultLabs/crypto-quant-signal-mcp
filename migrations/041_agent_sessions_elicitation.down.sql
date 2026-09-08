-- 041 down — IDENTITY-LIFECYCLE-W3 CH4.
--
-- Safe to drop: these three columns are pure telemetry with no consumer outside the census and
-- the scoreboard row it feeds. Dropping them loses the measurement, not any user-facing state or
-- consent — which is exactly why 040's down migration refuses to drop its suppression list and
-- this one does not need to refuse anything.

ALTER TABLE agent_sessions
  DROP COLUMN IF EXISTS elicitation_capable,
  DROP COLUMN IF EXISTS client_name,
  DROP COLUMN IF EXISTS client_version;
