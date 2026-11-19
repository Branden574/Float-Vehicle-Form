CREATE TABLE IF NOT EXISTS fleet.trip_reminders (
 trip_id TEXT NOT NULL REFERENCES fleet.trips(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, recipient_key TEXT NOT NULL, status TEXT NOT NULL,
 attempts INTEGER NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(trip_id,kind,recipient_key)
);
ALTER TABLE fleet.trip_reminders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet.trip_reminders TO fleet_app;
CREATE POLICY fleet_app_reminders ON fleet.trip_reminders TO fleet_app USING (true) WITH CHECK (true);
GRANT SELECT ON fleet.trip_reminders TO fleet_backup;
CREATE POLICY fleet_backup_reminders ON fleet.trip_reminders FOR SELECT TO fleet_backup USING (true);
