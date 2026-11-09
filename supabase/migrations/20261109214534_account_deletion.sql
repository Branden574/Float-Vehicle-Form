CREATE TABLE IF NOT EXISTS fleet.deletion_jobs (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT,
  requested_at TEXT NOT NULL, primary_deleted_at TEXT, completed_at TEXT,
  plan_json TEXT, contact_json TEXT, error TEXT
);
ALTER TABLE fleet.deletion_jobs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet.deletion_jobs TO fleet_app;
CREATE POLICY fleet_app_access ON fleet.deletion_jobs TO fleet_app USING (true) WITH CHECK (true);
GRANT SELECT ON fleet.deletion_jobs TO fleet_backup;
GRANT UPDATE (completed_at) ON fleet.deletion_jobs TO fleet_backup;
CREATE POLICY fleet_backup_read ON fleet.deletion_jobs FOR SELECT TO fleet_backup USING (true);
CREATE POLICY fleet_backup_complete ON fleet.deletion_jobs FOR UPDATE TO fleet_backup USING (primary_deleted_at IS NOT NULL) WITH CHECK (primary_deleted_at IS NOT NULL);
