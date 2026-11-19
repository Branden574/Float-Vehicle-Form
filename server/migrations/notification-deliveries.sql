CREATE TABLE IF NOT EXISTS notification_deliveries (
 id TEXT PRIMARY KEY,
 notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 recipient_key TEXT NOT NULL, recipient_json TEXT NOT NULL, attempt INTEGER NOT NULL,
 status TEXT NOT NULL, provider_id TEXT, event_at TEXT, updated_at TEXT NOT NULL,
 link_expires_at TEXT, code_hash TEXT, code_requested_at TEXT, code_attempts INTEGER NOT NULL DEFAULT 0,
 UNIQUE(notification_id, recipient_key, attempt)
);
CREATE INDEX IF NOT EXISTS notification_delivery_provider ON notification_deliveries(provider_id);
