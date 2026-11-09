import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, signature } from './helpers.js';
import { processDeletions } from '../server/deletion.js';
import { createReport } from '../server/reports.js';

test('deletion revokes access, erases evidence and account, holds active vehicles, and confirms by private receipt', async (t) => {
  const f = await fixture(t);
  const vehicle = await f.addVehicle();
  const trip = (await f.checkout(f.s, vehicle)).data.trip;
  await createReport({ store: f.store, tripId: trip.id, stage: 'checkout' });
  const photos = await f.store.db
    .prepare('SELECT * FROM photos WHERE employee_id=?')
    .all(f.staff.id);
  const reports = await f.store.evidence.list(`reports/${trip.id}-`);
  assert.ok(reports.length);
  const denied = await f.s.request('/auth/delete-account', {
    method: 'POST',
    body: { confirmation: 'no' },
  });
  assert.equal(denied.status, 400);
  const deletion = await f.s.request('/auth/delete-account', {
    method: 'POST',
    body: { confirmation: 'DELETE' },
  });
  assert.equal(deletion.status, 202, JSON.stringify(deletion.data));
  assert.equal((await f.s.request('/auth/me')).status, 401);
  assert.equal((await f.o.request('/auth/me')).status, 200);
  assert.equal(
    await processDeletions(f.store),
    0,
    'signed uploads must expire before object cleanup',
  );
  assert.equal(await processDeletions(f.store, { time: Date.now() + 12 * 60000 }), 1);
  assert.equal(await f.store.getUser(f.staff.id), null);
  assert.equal(await f.store.getTrip(trip.id), null);
  assert.equal((await f.store.getVehicle(vehicle.id)).status, 'out_of_service');
  for (const key of [...reports, ...photos.flatMap((p) => [p.original_path, p.display_path])])
    await assert.rejects(f.store.evidence.read(key), { code: 'ENOENT' });
  const status = await fetch(f.url + '/api/deletion-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt: deletion.data.receipt }),
  });
  assert.deepEqual(await status.json(), { status: 'complete' });
  assert.equal(
    (await f.store.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE actor_id=?').get(f.staff.id))
      .n,
    0,
  );
  assert.equal(
    (
      await f.store.db
        .prepare('SELECT COUNT(*) AS n FROM idempotency WHERE user_id=?')
        .get(f.staff.id)
    ).n,
    0,
  );
  const job = await f.store.db.prepare('SELECT * FROM deletion_jobs').get();
  assert.equal(job.user_id, null);
  assert.equal(job.plan_json, null);
  assert.equal(job.contact_json, null);
});

test('cleanup failures retain retry keys and never report completion', async (t) => {
  const f = await fixture(t);
  const v = await f.addVehicle();
  await f.checkout(f.s, v);
  await f.s.request('/auth/delete-account', { method: 'POST', body: { confirmation: 'DELETE' } });
  const remove = f.store.evidence.remove;
  f.store.evidence.remove = async () => {
    throw Error('storage offline');
  };
  assert.equal(await processDeletions(f.store, { time: Date.now() + 12 * 60000 }), 0);
  let job = await f.store.db.prepare('SELECT * FROM deletion_jobs').get();
  assert.ok(job.plan_json);
  assert.equal(job.completed_at, null);
  f.store.evidence.remove = remove;
  assert.equal(await processDeletions(f.store, { time: Date.now() + 12 * 60000 }), 1);
  job = await f.store.db.prepare('SELECT * FROM deletion_jobs').get();
  assert.ok(job.completed_at);
  assert.equal(job.error, null);
});

test('all accounts can delete, but stale sessions require reauthentication', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.a.request('/auth/delete-account', {
        method: 'POST',
        body: { confirmation: 'DELETE' },
      })
    ).status,
    202,
  );
  await f.store.db
    .prepare('UPDATE sessions SET created_at=? WHERE user_id=?')
    .run(new Date(Date.now() - 11 * 60000).toISOString(), f.staff.id);
  assert.equal(
    (
      await f.s.request('/auth/delete-account', {
        method: 'POST',
        body: { confirmation: 'DELETE' },
      })
    ).status,
    403,
  );
  assert.equal((await f.store.getUser(f.staff.id)).active, true);
});

test('deleting a reviewer anonymizes their signature while preserving another driver trip', async (t) => {
  const f = await fixture(t);
  const v = await f.addVehicle();
  const trip = (await f.checkout(f.s, v)).data.trip;
  const { randomUUID } = await import('node:crypto');
  await f.store.db
    .prepare('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      randomUUID(),
      trip.id,
      'checkout',
      f.other.id,
      'TO',
      await signature(),
      'approve',
      'private reason',
      new Date().toISOString(),
      f.store.encodeJSON(f.other),
    );
  await createReport({ store: f.store, tripId: trip.id, stage: 'checkout' });
  await f.o.request('/auth/delete-account', { method: 'POST', body: { confirmation: 'DELETE' } });
  assert.equal(await processDeletions(f.store, { time: Date.now() + 12 * 60000 }), 1);
  assert.ok(await f.store.getTrip(trip.id));
  assert.ok(await f.store.getUser(f.staff.id));
  const reviews = await f.store.getReviews(trip.id);
  assert.equal(reviews[0].signature, '');
  assert.equal(reviews[0].userSnapshot.name, 'Deleted account');
  assert.deepEqual(await f.store.evidence.list(`reports/${trip.id}-`), []);
  assert.ok(await createReport({ store: f.store, tripId: trip.id, stage: 'checkout' }));
});

test('cloud deletion remains pending until backup erasure is confirmed', async (t) => {
  const f = await fixture(t);
  f.store.evidence.cloud = true;
  await f.s.request('/auth/delete-account', { method: 'POST', body: { confirmation: 'DELETE' } });
  assert.equal(await processDeletions(f.store, { time: Date.now() + 12 * 60000 }), 1);
  const job = await f.store.db.prepare('SELECT * FROM deletion_jobs').get();
  assert.ok(job.primary_deleted_at);
  assert.equal(job.completed_at, null);
});

test('60-day cleanup removes closed trip evidence while preserving active trips and vehicle mileage', async (t) => {
  const f = await fixture(t);
  const { expireRecords } = await import('../server/retention.js');
  const v = await f.addVehicle();
  const trip = (await f.checkout(f.s, v)).data.trip;
  await f.returnTrip(f.s, trip);
  const mileage = (await f.store.getVehicle(v.id)).currentMileage;
  await f.store.db
    .prepare('UPDATE trips SET returned_at=? WHERE id=?')
    .run(new Date(Date.now() - 61 * 86400000).toISOString(), trip.id);
  const v2 = await f.addVehicle();
  const active = (await f.checkout(f.o, v2)).data.trip;
  process.env.RETENTION_ENABLED = 'true';
  t.after(() => delete process.env.RETENTION_ENABLED);
  assert.equal(await expireRecords(f.store), 1);
  assert.equal(await processDeletions(f.store), 1);
  assert.equal(await f.store.getTrip(trip.id), null);
  assert.ok(await f.store.getTrip(active.id));
  assert.equal((await f.store.getVehicle(v.id)).currentMileage, mileage);
});
