CREATE TABLE fleet.vehicle_inspections (
  id text PRIMARY KEY,
  vehicle_id text NOT NULL UNIQUE REFERENCES fleet.vehicles(id) ON DELETE CASCADE
);
CREATE TABLE fleet.inspection_exclusions (
  lookup text PRIMARY KEY,
  user_id text NOT NULL REFERENCES fleet.users(id) ON DELETE CASCADE
);
ALTER TABLE fleet.vehicle_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet.inspection_exclusions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON fleet.vehicle_inspections, fleet.inspection_exclusions TO fleet_app;
CREATE POLICY fleet_app_access ON fleet.vehicle_inspections TO fleet_app USING (true) WITH CHECK (true);
CREATE POLICY fleet_app_access ON fleet.inspection_exclusions TO fleet_app USING (true) WITH CHECK (true);
GRANT SELECT ON fleet.vehicle_inspections, fleet.inspection_exclusions TO fleet_backup;
CREATE POLICY fleet_backup_read ON fleet.vehicle_inspections FOR SELECT TO fleet_backup USING (true);
CREATE POLICY fleet_backup_read ON fleet.inspection_exclusions FOR SELECT TO fleet_backup USING (true);
