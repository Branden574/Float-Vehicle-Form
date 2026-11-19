import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, signature } from './helpers.js';
import { sendTripReminders } from '../server/reminders.js';

const hour = 3600000;
test('only the driver and currently assigned independent reviewer get one overdue reminder', async (t) => {
  const f = await fixture(t);
  async function assign(emails) {
    const result = await f.a.request('/admin/settings', {
      method: 'PATCH',
      body: { returnReviewerEmails: emails, reason: 'Assign return reviewers' },
    });
    assert.equal(result.status, 200);
  }
  await assign([f.admin.email, f.staff.email]);
  const checkout = await f.checkout(f.s, await f.addVehicle());
  const trip = checkout.data.trip;
  const due = Date.parse(trip.projectedReturnAt);
  const sent = [];
  const tick = (now) =>
    sendTripReminders({
      store: f.store,
      now,
      send: async (m) => {
        sent.push(m);
        return { accepted: true };
      },
    });
  await tick(due - 1);
  assert.equal(sent.length, 0);
  await Promise.all([tick(due + 1), tick(due + 1)]);
  assert.deepEqual(
    sent.map((m) => m.to),
    [[f.staff.email]],
  );
  const returned = await f.returnTrip(f.s, trip);
  assert.equal(returned.status, 201);
  const returnTime = Date.parse(returned.data.trip.returnedAt);
  await tick(returnTime + 23 * hour);
  assert.equal(sent.length, 1);
  await assign([f.staff.email, f.other.email]);
  await tick(returnTime + 24 * hour);
  await tick(returnTime + 25 * hour);
  assert.deepEqual(
    sent.map((m) => m.to),
    [[f.staff.email], [f.other.email]],
  );
  const reviewed = await f.o.request('/trips/' + trip.id + '/review', {
    method: 'POST',
    body: {
      stage: 'return',
      decision: 'approve',
      reason: 'Inspected vehicle and forms',
      initials: 'RV',
      signature: await signature(),
    },
  });
  assert.equal(reviewed.status, 200);
  await assign([f.admin.email]);
  await tick(returnTime + 48 * hour);
  assert.equal(sent.length, 2);
});

test('confirmed reminder failures can retry hourly and an uncertain send stays suppressed', async (t) => {
  const f = await fixture(t);
  const checkout = await f.checkout(f.s, await f.addVehicle());
  const due = Date.parse(checkout.data.trip.projectedReturnAt) + 100;
  const ids = [];
  const send = async (m) => {
    ids.push(m.messageId);
    throw Object.assign(new Error('Provider unavailable'), { definiteFailure: ids.length === 1 });
  };
  for (const now of [due, due + 1, due + hour, due + 2 * hour])
    await sendTripReminders({ store: f.store, now, send });
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  const record = await f.store.db
    .prepare('SELECT status,attempts FROM trip_reminders WHERE trip_id=?')
    .get(checkout.data.trip.id);
  assert.deepEqual(record, { status: 'unknown', attempts: 2 });
});
