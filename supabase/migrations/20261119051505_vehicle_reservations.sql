CREATE TABLE IF NOT EXISTS fleet.reservations (
 id TEXT PRIMARY KEY,
 vehicle_id TEXT NOT NULL REFERENCES fleet.vehicles(id),
 owner_id TEXT NOT NULL REFERENCES fleet.users(id) ON DELETE CASCADE,
 starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, created_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','picked_up','canceled')),
 trip_id TEXT UNIQUE REFERENCES fleet.trips(id) ON DELETE SET NULL,
 canceled_at TEXT, canceled_by TEXT REFERENCES fleet.users(id) ON DELETE SET NULL, reason_json TEXT,
 CHECK(starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS reservations_period ON fleet.reservations(vehicle_id,status,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS reservations_owner ON fleet.reservations(owner_id,ends_at);
CREATE TABLE IF NOT EXISTS fleet.reservation_notices (
 id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES fleet.reservations(id) ON DELETE CASCADE,
 recipient_key TEXT NOT NULL, email_json TEXT NOT NULL, payload_json TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','unknown')),
 attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(reservation_id,recipient_key)
);
CREATE INDEX IF NOT EXISTS reservation_notice_delivery ON fleet.reservation_notices(status,updated_at);
ALTER TABLE fleet.reservations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet.reservations TO fleet_app;
CREATE POLICY fleet_app_access ON fleet.reservations TO fleet_app USING (true) WITH CHECK (true);
GRANT SELECT ON fleet.reservations TO fleet_backup;
CREATE POLICY fleet_backup_read ON fleet.reservations FOR SELECT TO fleet_backup USING (true);
ALTER TABLE fleet.reservation_notices ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet.reservation_notices TO fleet_app;
CREATE POLICY fleet_app_access ON fleet.reservation_notices TO fleet_app USING (true) WITH CHECK (true);
GRANT SELECT ON fleet.reservation_notices TO fleet_backup;
CREATE POLICY fleet_backup_read ON fleet.reservation_notices FOR SELECT TO fleet_backup USING (true);
