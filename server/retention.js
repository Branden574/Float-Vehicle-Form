import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from './store.js';
import { recordStagingObjects } from './deletion.js';
import { preserveVehicleInspection } from './vehicle-inspections.js';

/** Expired closed trips use the same durable erasure queue as account deletion. */
export async function expireRecords(store, { time = Date.now() } = {}) {
  if (process.env.RETENTION_ENABLED !== 'true') return 0;
  const cutoff = new Date(time - 60 * 86400000).toISOString();
  return store.db.transaction(async () => {
    const db = store.db;
    const trips = await db
      .prepare(
        "SELECT id FROM trips WHERE status IN ('returned','cancelled') AND COALESCE(returned_at,checkout_at)<?",
      )
      .all(cutoff);
    const tripIDs = new Set(trips.map((t) => t.id));
    const photos = (await db.prepare('SELECT * FROM photos').all()).filter(
      (p) => tripIDs.has(p.trip_id) || (!p.trip_id && p.received_at < cutoff),
    );
    const expiredBookings = await db
      .prepare('DELETE FROM reservations WHERE COALESCE(canceled_at,ends_at)<?')
      .run(cutoff);
    if (!trips.length && !photos.length && !expiredBookings.changes) return 0;
    const objects = new Set(photos.flatMap((p) => [p.original_path, p.display_path]));
    for (const id of tripIDs)
      for (const key of await store.evidence.list(`reports/${id}-`)) objects.add(key);
    await recordStagingObjects(db, photos, objects);
    for (const id of tripIDs) await preserveVehicleInspection(store, id, true);
    const plan = { objects: [...objects], tripIDs: [...tripIDs] };
    await db
      .prepare('INSERT INTO deletion_jobs(id,token_hash,requested_at,plan_json) VALUES(?,?,?,?)')
      .run(
        randomUUID(),
        hash(randomBytes(32)),
        new Date(time - 12 * 60000).toISOString(),
        store.encodeJSON(plan),
      );
    for (const photo of photos) {
      await db
        .prepare('UPDATE vehicles SET photo_url=? WHERE photo_url=? OR photo_url=?')
        .run('', `/api/photos/${photo.id}`, `/api/photos/${photo.id}/display`);
      await db.prepare('DELETE FROM photos WHERE id=?').run(photo.id);
      await db.prepare('DELETE FROM audit WHERE entity_id=?').run(photo.id);
    }
    for (const id of tripIDs) {
      for (const table of ['notifications', 'reviews', 'revisions', 'odometer_replacements'])
        await db.prepare(`DELETE FROM ${table} WHERE trip_id=?`).run(id);
      await db.prepare('DELETE FROM audit WHERE entity_id=?').run(id);
      await db.prepare('DELETE FROM trips WHERE id=?').run(id);
    }
    for (const row of await db.prepare('SELECT * FROM idempotency').all()) {
      const content = JSON.stringify(store.decodeJSON(row.response_json));
      if ([...tripIDs].some((id) => content.includes(id)) || row.created_at < cutoff)
        await db
          .prepare('DELETE FROM idempotency WHERE user_id=? AND key=?')
          .run(row.user_id, row.key);
    }
    await db.prepare('DELETE FROM audit WHERE created_at<?').run(cutoff);
    return tripIDs.size;
  })();
}
