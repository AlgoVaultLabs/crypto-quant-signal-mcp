-- Down for 039. Dropping these returns the status column to last-event-wins with no ordering,
-- which is the defect the up-migration exists to retire — take it only as a rollback.
ALTER TABLE subscriber_profiles DROP COLUMN IF EXISTS status_updated_at;
ALTER TABLE subscriber_profiles DROP COLUMN IF EXISTS status_subscription_id;
