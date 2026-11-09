import { processNotification } from './notifications.js';
import { expireRecords } from './retention.js';
import { processDeletions } from './deletion.js';

/** Durable outbox rows survive function shutdown; claims prevent duplicate sends. */
export async function runMaintenance({ store, send }) {
  await expireRecords(store);
  const deletions = await processDeletions(store);
  const time = new Date().toISOString();
  await store.db
    .prepare(
      "UPDATE notifications SET status='unknown',error='Interrupted send. Check the provider before an explicit resend.',updated_at=? WHERE status='processing' AND updated_at<?",
    )
    .run(time, new Date(Date.now() - 15 * 60000).toISOString());
  const rows = await store.db
    .prepare("SELECT id FROM notifications WHERE status='pending' ORDER BY created_at LIMIT 5")
    .all();
  for (const row of rows) await processNotification({ store, notificationId: row.id, send });
  if (store.db.kind === 'postgres') {
    const expired = await store.db
      .prepare('SELECT id,object_path FROM upload_tickets WHERE expires_at<? LIMIT 100')
      .all(time);
    for (const ticket of expired) {
      await store.evidence.remove(ticket.object_path);
      await store.db.prepare('DELETE FROM upload_tickets WHERE id=?').run(ticket.id);
    }
    await store.db.prepare('DELETE FROM rate_limits WHERE reset_at<?').run(Date.now());
    await store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(time);
    await store.db.prepare('DELETE FROM login_codes WHERE expires_at<?').run(time);
  }
  return { processed: rows.length, deletions };
}
