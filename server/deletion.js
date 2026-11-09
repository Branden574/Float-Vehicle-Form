import { rateLimit } from 'express-rate-limit';
import { rateLimitStore } from './rate-limits.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail, validate } from './validation.js';
import { hash, now } from './store.js';

export const deletionSchema = `CREATE TABLE IF NOT EXISTS deletion_jobs (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT,
  requested_at TEXT NOT NULL, primary_deleted_at TEXT, completed_at TEXT,
  plan_json TEXT, contact_json TEXT, error TEXT
);`;
const erasedActor = '00000000-0000-4000-8000-000000000001';
const emptyActor = { name: 'Deleted account', email: '', charter: '', department: '', manager: '' };

export function installDeletionStatus(app, store) {
  // The receipt is an unguessable secret supplied in the body, never in a URL/log.
  app.post(
    '/api/deletion-status',
    rateLimit({
      store: rateLimitStore(store.db, 'deletion-status'),
      windowMs: 60000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Please wait a minute before checking again.' },
    }),
    async (req, res) => {
      const { receipt } = validate(
        z.object({ receipt: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        req.body,
      );
      const row = await store.db
        .prepare('SELECT primary_deleted_at,completed_at FROM deletion_jobs WHERE token_hash=?')
        .get(hash(receipt));
      if (!row) fail(404, 'Deletion receipt not found.');
      res.json({
        status: row.completed_at
          ? 'complete'
          : row.primary_deleted_at
            ? 'removing_backups'
            : 'processing',
      });
    },
  );
}

export function installDeletion(
  app,
  store,
  {
    deletionEnabled = process.env.ACCOUNT_DELETION_ENABLED === 'true' || store.db.kind === 'sqlite',
  } = {},
) {
  app.post('/api/auth/delete-account', async (req, res) => {
    if (!deletionEnabled)
      fail(503, 'Account deletion is temporarily unavailable. Please try again shortly.');
    const { confirmation } = validate(
      z.object({ confirmation: z.literal('DELETE') }).strict(),
      req.body,
    );
    if (!confirmation) fail(400, 'Confirm account deletion.');
    if (Date.now() - Date.parse(req.session.created_at) > 10 * 60000)
      fail(
        403,
        'For your security, sign out and sign in again, then request deletion within 10 minutes.',
      );
    const receipt = randomBytes(32).toString('hex');
    await store.db.transaction(async () => {
      const user = await store.getUser(req.user.id);
      if (!user?.active) fail(409, 'This account is already inactive.');
      await store.db
        .prepare(
          'INSERT INTO deletion_jobs(id,token_hash,user_id,requested_at,contact_json) VALUES(?,?,?,?,?)',
        )
        .run(randomUUID(), hash(receipt), user.id, now(), store.encodeJSON({ email: user.email }));
      await store.db
        .prepare(
          'UPDATE users SET active=0,password_hash=NULL,invite_hash=NULL,invite_expires_at=NULL WHERE id=?',
        )
        .run(user.id);
      await store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      await store.db
        .prepare('DELETE FROM login_codes WHERE email_lookup=?')
        .run(store.emailLookup(user.email));
    })();
    res.clearCookie('fleet_session', {
      httpOnly: true,
      secure: req.secure || !!process.env.VERCEL,
      sameSite: 'strict',
      path: '/',
    });
    res.status(202).json({
      receipt,
      status: 'processing',
      message:
        'Your account is closed. Associated data and recoverable backups will be removed within 7 days. Save this receipt to check completion. Copies already downloaded or emailed to recipients must be removed by those recipients.',
    });
  });
}

async function ensureErasedActor(store) {
  await store.db
    .prepare(
      "INSERT OR IGNORE INTO users(id,email,name,department,manager,role,authorized_driver,active,created_at,profile_json) VALUES(?,?,'','','','staff',0,0,?,?)",
    )
    .run(erasedActor, 'deleted-system-actor', now(), store.encodeJSON(emptyActor));
}

/** Durable plan is committed before deleting any object; failures retain all retry keys. */
async function prepareDeletion(store, job) {
  const db = store.db;
  return db.transaction(async () => {
    const fresh = await db.prepare('SELECT * FROM deletion_jobs WHERE id=?').get(job.id);
    if (fresh.primary_deleted_at) return { objects: [], tripIDs: [] };
    if (fresh.plan_json) return store.decodeJSON(fresh.plan_json);
    const user = await store.getUser(job.user_id);
    if (!user) throw Error('Deletion account is missing before its plan was committed');
    const trips = await db
      .prepare('SELECT id,vehicle_id,status FROM trips WHERE employee_id=?')
      .all(user.id);
    const tripIDs = new Set(trips.map((t) => t.id));
    const affected = new Set(tripIDs);
    for (const table of ['reviews', 'revisions', 'odometer_replacements']) {
      for (const row of await db
        .prepare(`SELECT trip_id FROM ${table} WHERE user_id=?`)
        .all(user.id))
        affected.add(row.trip_id);
    }
    for (const row of await db
      .prepare('SELECT trip_id FROM revisions WHERE acknowledged_by=?')
      .all(user.id))
      affected.add(row.trip_id);
    const photos = (await db.prepare('SELECT * FROM photos').all()).filter(
      (p) => p.employee_id === user.id || tripIDs.has(p.trip_id),
    );
    const objects = new Set(photos.flatMap((p) => [p.original_path, p.display_path]));
    for (const id of affected)
      for (const key of await store.evidence.list(`reports/${id}-`)) objects.add(key);
    if (db.kind === 'postgres')
      for (const ticket of await db
        .prepare('SELECT object_path FROM upload_tickets WHERE employee_id=?')
        .all(user.id))
        objects.add(ticket.object_path);
    const plan = { objects: [...objects], tripIDs: [...tripIDs] };
    await ensureErasedActor(store);
    for (const trip of trips) {
      if (['active', 'pending_checkout'].includes(trip.status))
        await db
          .prepare("UPDATE vehicles SET status='out_of_service',updated_at=? WHERE id=?")
          .run(now(), trip.vehicle_id);
      for (const table of ['notifications', 'reviews', 'revisions', 'odometer_replacements'])
        await db.prepare(`DELETE FROM ${table} WHERE trip_id=?`).run(trip.id);
      await db.prepare('DELETE FROM audit WHERE entity_id=?').run(trip.id);
    }
    for (const photo of photos) {
      if (db.kind === 'postgres')
        await db.prepare('DELETE FROM upload_tickets WHERE photo_id=?').run(photo.id);
      await db
        .prepare('UPDATE vehicles SET photo_url=? WHERE photo_url=? OR photo_url=?')
        .run('', `/api/photos/${photo.id}`, `/api/photos/${photo.id}/display`);
      await db.prepare('DELETE FROM photos WHERE id=?').run(photo.id);
      await db.prepare('DELETE FROM audit WHERE entity_id=?').run(photo.id);
    }
    for (const id of tripIDs) await db.prepare('DELETE FROM trips WHERE id=?').run(id);
    // Keep others' operational mileage/approval decisions with one shared anonymous actor.
    await db
      .prepare(
        "UPDATE reviews SET user_id=?,initials='',signature='',reason='',user_snapshot_json=? WHERE user_id=?",
      )
      .run(erasedActor, store.encodeJSON(emptyActor), user.id);
    await db
      .prepare("UPDATE revisions SET user_id=?,reason='' WHERE user_id=?")
      .run(erasedActor, user.id);
    await db
      .prepare(
        'UPDATE revisions SET acknowledged_by=?,acknowledgment_signature=NULL WHERE acknowledged_by=?',
      )
      .run(erasedActor, user.id);
    await db
      .prepare("UPDATE odometer_replacements SET user_id=?,reason='' WHERE user_id=?")
      .run(erasedActor, user.id);
    await db.prepare('DELETE FROM audit WHERE actor_id=? OR entity_id=?').run(user.id, user.id);
    // Snapshots can contain a staff profile even when a different admin performed the action.
    for (const row of await db.prepare('SELECT * FROM audit').all()) {
      const content = [row.before_json, row.after_json]
        .filter(Boolean)
        .map((v) => JSON.stringify(store.decodeJSON(v)))
        .join(' ');
      if (
        content.includes(user.id) ||
        (user.email && content.toLowerCase().includes(user.email.toLowerCase()))
      )
        await db.prepare('DELETE FROM audit WHERE id=?').run(row.id);
    }
    for (const row of await db.prepare('SELECT id,recipients_json FROM notifications').all()) {
      const recipients = store.decodeJSON(row.recipients_json);
      const filtered = recipients.filter(
        (email) => email.toLowerCase() !== user.email.toLowerCase(),
      );
      if (filtered.length !== recipients.length)
        await db
          .prepare('UPDATE notifications SET recipients_json=? WHERE id=?')
          .run(store.encodeJSON(filtered), row.id);
    }
    // Request-result caches can embed full trip snapshots belonging to another account.
    for (const row of await db.prepare('SELECT * FROM idempotency').all()) {
      const content = JSON.stringify(store.decodeJSON(row.response_json));
      if (
        row.user_id === user.id ||
        content.includes(user.id) ||
        [...tripIDs].some((id) => content.includes(id))
      )
        await db
          .prepare('DELETE FROM idempotency WHERE user_id=? AND key=?')
          .run(row.user_id, row.key);
    }
    const settings = await store.getSettings();
    for (const key of ['returnReviewerEmails', 'notificationRecipients'])
      settings[key] = settings[key].filter(
        (email) => email.toLowerCase() !== user.email.toLowerCase(),
      );
    await db.prepare('UPDATE settings SET data_json=? WHERE id=1').run(store.encodeJSON(settings));
    await db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    await db
      .prepare('DELETE FROM login_codes WHERE email_lookup=?')
      .run(store.emailLookup(user.email));
    if (db.kind === 'postgres')
      await db.prepare('DELETE FROM upload_tickets WHERE employee_id=?').run(user.id);
    await db.prepare('DELETE FROM users WHERE id=?').run(user.id);
    await db
      .prepare('UPDATE deletion_jobs SET user_id=NULL,plan_json=?,error=NULL WHERE id=?')
      .run(store.encodeJSON(plan), job.id);
    return plan;
  })();
}

export async function processDeletions(store, { time = Date.now() } = {}) {
  // Previously signed upload URLs expire in ten minutes. Let in-flight requests settle.
  const jobs = await store.db
    .prepare(
      'SELECT * FROM deletion_jobs WHERE primary_deleted_at IS NULL AND requested_at<? ORDER BY requested_at LIMIT 5',
    )
    .all(new Date(time - 11 * 60000).toISOString());
  let processed = 0;
  for (const job of jobs) {
    try {
      const plan = await prepareDeletion(store, job);
      for (const object of plan.objects) {
        try {
          await store.evidence.remove(object);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const complete =
        !store.evidence.cloud ||
        (process.env.REVIEW_WORKSPACE === 'true' && process.env.DATABASE_SCHEMA === 'fleet_review');
      await store.db
        .prepare(
          'UPDATE deletion_jobs SET primary_deleted_at=?,completed_at=?,plan_json=NULL,contact_json=NULL,error=NULL WHERE id=? AND primary_deleted_at IS NULL',
        )
        .run(new Date(time).toISOString(), complete ? new Date(time).toISOString() : null, job.id);
      processed++;
    } catch {
      await store.db
        .prepare('UPDATE deletion_jobs SET error=? WHERE id=?')
        .run('Cleanup incomplete; retry required.', job.id);
    }
  }
  return processed;
}
