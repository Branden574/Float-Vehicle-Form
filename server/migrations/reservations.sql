CREATE TABLE IF NOT EXISTS reservations (
 id TEXT PRIMARY KEY,
 vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, created_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','picked_up','canceled')),
 trip_id TEXT UNIQUE REFERENCES trips(id) ON DELETE SET NULL,
 canceled_at TEXT, canceled_by TEXT REFERENCES users(id) ON DELETE SET NULL, reason_json TEXT,
 CHECK(starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS reservations_period ON reservations(vehicle_id,status,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS reservations_owner ON reservations(owner_id,ends_at);
CREATE TABLE IF NOT EXISTS reservation_notices (
 id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
 recipient_key TEXT NOT NULL, email_json TEXT NOT NULL, payload_json TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','unknown')),
 attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(reservation_id,recipient_key)
);
CREATE INDEX IF NOT EXISTS reservation_notice_delivery ON reservation_notices(status,updated_at);
