import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { expireRecords } from '../server/retention.js';
import { processDeletions } from '../server/deletion.js';

test('backlogged staging objects remain durably scheduled for erasure through a storage outage', async (t) => {
  const f = await fixture(t),
    db = f.store.db;
  // Exercise the production ticket path locally too; SQLite normally uploads directly.
  const store = db.kind === 'sqlite' ? { ...f.store, db: { ...db, kind: 'postgres' } } : f.store;
  if (db.kind === 'sqlite')
    await db.exec(
      'CREATE TABLE upload_tickets(id TEXT PRIMARY KEY,employee_id TEXT,object_path TEXT,metadata_json TEXT,bytes INTEGER,expires_at TEXT,photo_id TEXT,processing INTEGER)',
    );
  const vehicle = await f.addVehicle(),
    draft = await f.draft(f.s, vehicle);
  const stage = 'staging/test-finalized.jpg';
  const ticket = db.prepare(
    'INSERT INTO upload_tickets(id,employee_id,object_path,metadata_json,bytes,expires_at,photo_id,processing) VALUES(?,?,?,?,?,?,?,0)',
  );
  await db.transaction(async () => {
    for (let i = 0; i < 101; i++)
      await ticket.run(
        'backlog-' + i,
        f.staff.id,
        'staging/backlog-' + i,
        '{}',
        1,
        new Date().toISOString(),
        null,
      );
    await ticket.run(
      'finalized-stage',
      f.staff.id,
      stage,
      '{}',
      1,
      new Date().toISOString(),
      draft.photoIds[0],
    );
  })();
  await f.store.evidence.put(stage, Buffer.from('synthetic staging object'), 'image/jpeg');
  const before = process.env.RETENTION_ENABLED;
  process.env.RETENTION_ENABLED = 'true';
  try {
    await expireRecords(store, { time: Date.now() + 61 * 86400000 });
  } finally {
    if (before == null) delete process.env.RETENTION_ENABLED;
    else process.env.RETENTION_ENABLED = before;
  }
  const job = await db.prepare('SELECT * FROM deletion_jobs').get();
  assert.ok(f.store.decodeJSON(job.plan_json).objects.includes(stage));
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM upload_tickets').get()).count, 101);
  const remove = store.evidence.remove;
  let failOnce = true;
  store.evidence.remove = async (key) => {
    if (key === stage && failOnce) {
      failOnce = false;
      throw Error('Temporary storage failure');
    }
    return remove(key);
  };
  const clock = { time: Date.now() + 61 * 86400000 };
  assert.equal(await processDeletions(store, clock), 0);
  assert.ok(
    (await db.prepare('SELECT plan_json FROM deletion_jobs WHERE id=?').get(job.id)).plan_json,
  );
  assert.equal(await processDeletions(store, clock), 1);
  assert.deepEqual(await store.evidence.list('staging/test-finalized'), []);
});
