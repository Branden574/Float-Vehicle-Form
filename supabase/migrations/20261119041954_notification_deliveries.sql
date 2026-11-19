CREATE TABLE IF NOT EXISTS fleet.notification_deliveries (
 id TEXT PRIMARY KEY,
 notification_id TEXT NOT NULL REFERENCES fleet.notifications(id) ON DELETE CASCADE,
 recipient_key TEXT NOT NULL, recipient_json TEXT NOT NULL, attempt INTEGER NOT NULL,
 status TEXT NOT NULL, provider_id TEXT, event_at TEXT, updated_at TEXT NOT NULL,
 link_expires_at TEXT, code_hash TEXT, code_requested_at TEXT, code_attempts INTEGER NOT NULL DEFAULT 0,
 UNIQUE(notification_id, recipient_key, attempt)
);
CREATE INDEX IF NOT EXISTS notification_delivery_provider ON fleet.notification_deliveries(provider_id);

ALTER TABLE fleet.notification_deliveries ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet.notification_deliveries TO fleet_app;
CREATE POLICY fleet_app_access ON fleet.notification_deliveries TO fleet_app USING (true) WITH CHECK (true);
GRANT SELECT ON fleet.notification_deliveries TO fleet_backup;
CREATE POLICY fleet_backup_read ON fleet.notification_deliveries FOR SELECT TO fleet_backup USING (true);
