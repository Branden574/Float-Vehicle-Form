SET search_path = fleet, pg_catalog;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_approved INTEGER NOT NULL DEFAULT 0 CHECK (staff_approved IN (0,1));
UPDATE users SET staff_approved = 1
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=20261119)
AND (role='admin' OR authorized_driver=1 OR password_hash IS NOT NULL OR invite_hash IS NOT NULL
     OR id IN (SELECT entity_id FROM audit WHERE entity_type='user' AND action IN ('invite_user','renew_invitation'))
     OR id IN (SELECT employee_id FROM trips WHERE status IN ('active','pending_checkout')));
INSERT INTO schema_migrations(version,applied_at) VALUES(20261119,CURRENT_TIMESTAMP::text) ON CONFLICT DO NOTHING;
