import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, inspection } from './helpers.js';
import { expireRecords } from '../server/retention.js';
import { processDeletions } from '../server/deletion.js';

const future = () => Date.now() + 61 * 86400000;
const resolve = (client, id, decision = 'approve') =>
  client.request('/vehicle-inspections/' + id + '/resolve', {
    method: 'POST',
    body: {
      decision,
      inspected: true,
      reason: 'Emergency kits, odometer, keys and vehicle inspected.',
    },
  });
const tasks = async (client) => (await client.request('/trips')).data.vehicleInspections;
const reviewers = async (f, emails) =>
  assert.equal(
    (
      await f.a.request('/admin/settings', {
        method: 'PATCH',
        body: { returnReviewerEmails: emails, reason: 'Assign authorized reviewers' },
      })
    ).status,
    200,
  );

for (const erase of ['retention', 'account deletion']) {
  test(erase + ' preserves a physical inspection without keeping the original trip', async (t) => {
    const f = await fixture(t);
    const vehicle = await f.addVehicle();
    await reviewers(f, [f.other.email, f.staff.email]);
    const trip = (await f.checkout(f.s, vehicle)).data.trip;
    assert.equal(
      (
        await f.returnTrip(f.s, trip, {
          inspection: {
            ...inspection,
            emergencyKitsPresent: false,
            missingEmergencyKits: 'Roadside kit',
          },
        })
      ).status,
      201,
    );
    if (erase === 'retention') {
      const before = process.env.RETENTION_ENABLED;
      process.env.RETENTION_ENABLED = 'true';
      try {
        assert.equal(await expireRecords(f.store, { time: future() }), 1);
      } finally {
        if (before == null) delete process.env.RETENTION_ENABLED;
        else process.env.RETENTION_ENABLED = before;
      }
    } else {
      assert.equal(
        (
          await f.s.request('/auth/delete-account', {
            method: 'POST',
            body: { confirmation: 'DELETE' },
          })
        ).status,
        202,
      );
      assert.equal(await processDeletions(f.store, { time: Date.now() + 12 * 60000 }), 1);
    }
    assert.equal(await f.store.getTrip(trip.id), null);
    assert.equal((await f.store.getVehicle(vehicle.id)).status, 'pending_review');
    const rows = await tasks(f.o);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'plate', 'site']);
    assert.deepEqual(await tasks(f.a), []);
    assert.equal((await resolve(f.a, row.id)).status, 403);
    if (erase === 'retention') {
      assert.deepEqual(await tasks(f.s), []);
      assert.equal((await resolve(f.s, row.id)).status, 403);
    }
    assert.equal(
      (
        await f.a.request('/admin/vehicles/' + vehicle.id, {
          method: 'PATCH',
          body: { status: 'available', reason: 'Ordinary record edit' },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.o.request('/vehicle-inspections/' + row.id + '/resolve', {
          method: 'POST',
          body: { inspected: false, decision: 'approve', reason: 'Independent check' },
        })
      ).status,
      400,
    );
    assert.equal(
      (await resolve(f.o, row.id, erase === 'retention' ? 'approve' : 'hold')).status,
      200,
    );
    assert.equal(
      (await f.store.getVehicle(vehicle.id)).status,
      erase === 'retention' ? 'available' : 'out_of_service',
    );
    assert.deepEqual(await tasks(f.o), []);
    assert.equal((await resolve(f.o, row.id)).status, 409);
    assert.equal(
      (await f.store.db.prepare('SELECT COUNT(*) AS count FROM inspection_exclusions').get()).count,
      0,
    );
  });
}

test('erasing an older return leaves the current signed-record review with its reviewer', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  const first = (await f.checkout(f.s, v)).data.trip;
  assert.equal((await f.returnTrip(f.s, first)).status, 201);
  await reviewers(f, [f.admin.email]);
  const latest = (await f.checkout(f.o, await f.store.getVehicle(v.id))).data.trip;
  assert.equal((await f.returnTrip(f.o, latest)).status, 201);
  await f.s.request('/auth/delete-account', { method: 'POST', body: { confirmation: 'DELETE' } });
  assert.equal(await processDeletions(f.store, { time: Date.now() + 12 * 60000 }), 1);
  const queue = (await f.a.request('/trips')).data;
  assert.deepEqual(queue.vehicleInspections, []);
  assert.deepEqual(
    queue.pendingReturns.map((row) => row.id),
    [latest.id],
  );
  assert.equal((await f.store.getVehicle(v.id)).status, 'pending_review');
});

test('a legacy hold stays held until an explicit admin referral and separate reviewer decision', async (t) => {
  const f = await fixture(t),
    vehicle = await f.addVehicle({ status: 'pending_review' });
  await reviewers(f, [f.other.email]);
  const url = '/admin/vehicles/' + vehicle.id + '/physical-inspection';
  const referral = { method: 'POST', body: { reason: 'Trip no longer available for review' } };
  assert.deepEqual(await tasks(f.o), []);
  assert.ok(
    (await f.a.request('/admin/overview')).data.inspectionReferralVehicleIds.includes(vehicle.id),
  );
  assert.equal((await f.o.request(url, referral)).status, 403);
  assert.equal((await f.a.request(url, referral)).status, 201);
  assert.equal((await f.a.request(url, referral)).status, 409);
  assert.equal((await f.store.getVehicle(vehicle.id)).status, 'pending_review');
  const [task] = await tasks(f.o);
  assert.equal((await resolve(f.o, task.id)).status, 200);
  assert.equal((await f.store.getVehicle(vehicle.id)).status, 'available');

  const trip = (await f.checkout(f.s, await f.store.getVehicle(vehicle.id))).data.trip;
  assert.equal((await f.returnTrip(f.s, trip)).status, 201);
  assert.equal((await f.a.request(url, referral)).status, 409);
  assert.deepEqual(
    (await f.o.request('/trips')).data.pendingReturns.map((row) => row.id),
    [trip.id],
  );
});
