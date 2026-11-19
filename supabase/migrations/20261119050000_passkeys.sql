CREATE TABLE IF NOT EXISTS fleet.passkeys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES fleet.users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, counter BIGINT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS passkeys_owner ON fleet.passkeys(user_id);
CREATE TABLE IF NOT EXISTS fleet.passkey_challenges (
  challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL, expires_at TEXT NOT NULL,
  session_hash TEXT REFERENCES fleet.sessions(token_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS passkey_challenges_expiry ON fleet.passkey_challenges(expires_at);
ALTER TABLE fleet.passkeys ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet.passkeys TO fleet_app;
CREATE POLICY fleet_app_access ON fleet.passkeys TO fleet_app USING (true) WITH CHECK (true);
GRANT SELECT ON fleet.passkeys TO fleet_backup;
CREATE POLICY fleet_backup_read ON fleet.passkeys FOR SELECT TO fleet_backup USING (true);
ALTER TABLE fleet.passkey_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet.passkey_challenges TO fleet_app;
CREATE POLICY fleet_app_access ON fleet.passkey_challenges TO fleet_app USING (true) WITH CHECK (true);
-- Backup enumerates all tables. With no SELECT policy it sees zero transient challenges.
GRANT SELECT ON fleet.passkey_challenges TO fleet_backup;
