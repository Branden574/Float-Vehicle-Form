PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 department TEXT NOT NULL DEFAULT '', manager TEXT NOT NULL DEFAULT '', role TEXT NOT NULL CHECK(role IN ('staff','admin')),
 authorized_driver INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
 password_hash TEXT, invite_hash TEXT UNIQUE, invite_expires_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf_token TEXT NOT NULL,
 created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL,
 plate TEXT NOT NULL, vin_last4 TEXT NOT NULL, site TEXT NOT NULL, current_mileage INTEGER NOT NULL CHECK(current_mileage>=0),
 status TEXT NOT NULL CHECK(status IN ('available','checked_out','pending_review','out_of_service')),
 photo_url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
 mileage_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
 id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id), employee_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('pending_checkout','active','returned','cancelled')),
 checkout_at TEXT NOT NULL, projected_return_at TEXT NOT NULL, returned_at TEXT,
 starting_mileage INTEGER NOT NULL CHECK(starting_mileage>=0), ending_mileage INTEGER,
 vehicle_mileage_version INTEGER NOT NULL, return_mileage_version INTEGER,
 checkout_json TEXT NOT NULL, return_json TEXT, flags_json TEXT NOT NULL DEFAULT '[]',
 CHECK(ending_mileage IS NULL OR ending_mileage>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_trip_per_vehicle ON trips(vehicle_id) WHERE status IN ('pending_checkout','active');
CREATE INDEX IF NOT EXISTS trips_employee ON trips(employee_id,checkout_at);
CREATE TABLE IF NOT EXISTS photos (
 id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES users(id), vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
 trip_id TEXT REFERENCES trips(id), draft_id TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('checkout','return','vehicle')),
 view_label TEXT NOT NULL, source TEXT NOT NULL, device_captured_at TEXT, received_at TEXT NOT NULL,
 original_path TEXT NOT NULL, display_path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
 mime_type TEXT NOT NULL, finalized INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS photos_trip ON photos(trip_id,stage);
CREATE TABLE IF NOT EXISTS reviews (
 id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), stage TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 initials TEXT NOT NULL, signature TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 user_snapshot_json TEXT NOT NULL, UNIQUE(trip_id,stage)
);
CREATE TABLE IF NOT EXISTS revisions (
 id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), field TEXT NOT NULL, original_value INTEGER NOT NULL,
 corrected_value INTEGER NOT NULL, reason TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 odometer_replacement INTEGER NOT NULL DEFAULT 0, acknowledged_at TEXT, acknowledged_by TEXT REFERENCES users(id),
 acknowledgment_signature TEXT, affects_current INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS odometer_replacements (
 id TEXT PRIMARY KEY, trip_id TEXT NOT NULL UNIQUE REFERENCES trips(id), old_reading INTEGER NOT NULL,
 new_reading INTEGER NOT NULL, reason TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL,
 entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), stage TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, error TEXT, provider_id TEXT, accepted_at TEXT, delivered_at TEXT,
 recipients_json TEXT NOT NULL, message_id TEXT NOT NULL, UNIQUE(trip_id,stage)
);
CREATE TABLE IF NOT EXISTS idempotency (
 user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, operation TEXT NOT NULL,
 request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,key)
);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
