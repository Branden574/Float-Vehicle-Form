import { createHash } from 'node:crypto';

/** Shared counters across Vercel instances. Keys contain no raw IP or email. */
export function rateLimitStore(db, namespace) {
  if (db.kind !== 'postgres') return undefined;
  return {
    localKeys: false,
    init(options) {
      this.windowMs = options.windowMs;
    },
    key(value) {
      return createHash('sha256')
        .update(namespace + ':' + value)
        .digest('hex');
    },
    async increment(value) {
      const time = Date.now();
      const row = await db
        .prepare(
          `INSERT INTO rate_limits(key,hits,reset_at) VALUES(?,1,?)
        ON CONFLICT(key) DO UPDATE SET
        hits=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.hits+1 END,
        reset_at=CASE WHEN rate_limits.reset_at<=? THEN ? ELSE rate_limits.reset_at END
        RETURNING hits,reset_at`,
        )
        .get(this.key(value), time + this.windowMs, time, time, time + this.windowMs);
      return { totalHits: row.hits, resetTime: new Date(row.reset_at) };
    },
    async decrement(value) {
      await db
        .prepare('UPDATE rate_limits SET hits=GREATEST(0,hits-1) WHERE key=?')
        .run(this.key(value));
    },
    async resetKey(value) {
      await db.prepare('DELETE FROM rate_limits WHERE key=?').run(this.key(value));
    },
  };
}
