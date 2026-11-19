CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, counter BIGINT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS passkeys_owner ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL, expires_at TEXT NOT NULL,
  session_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS passkey_challenges_expiry ON passkey_challenges(expires_at);
