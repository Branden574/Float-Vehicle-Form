import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { deliverReservationNotices } from '../server/reservations.js';

const at = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
test('shared calendar, private details, concurrent bookings and durable cancellations', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle(),
    manager = f.other.email;
  const settings = await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: { reservationManagerEmails: [manager], reason: 'Assign fleet reservation manager' },
  });
  assert.equal(settings.status, 200, JSON.stringify(settings.data));
  const start = at(24),
    end = at(53),
    event = { id: randomUUID(), vehicleId: v.id, start, end };
  const book = (client, body) => client.request('/reservations', { method: 'POST', body });
  const first = await Promise.all([book(f.s, event), book(f.a, { ...event, id: randomUUID() })]);
  assert.deepEqual(first.map((r) => r.status).sort(), [201, 409]);
  const winner = first.find((r) => r.status === 201).data;
  const own = first[0].status === 201 ? f.s : f.a;
  assert.equal((await book(own, { ...event, id: winner.id })).data.id, winner.id);
  assert.equal((await f.store.getVehicle(v.id)).status, 'available');
  const search = async (a, b) =>
    (await f.o.request('/availability?' + new URLSearchParams({ start: a, end: b }))).data
      .vehicles[0].status;
  assert.equal(await search(at(23), at(25)), 'reserved');
  assert.equal(await search(end, at(55)), 'available');
  const calendar = await f.o.request(
    '/reservations?' + new URLSearchParams({ start: at(30), end: at(40) }),
  );
  assert.equal(calendar.data.events[0].id, winner.id);
  const cancel = (client, id, reason = '') =>
    client.request('/reservations/' + id + '/cancel', { method: 'POST', body: { reason } });
  const other = await book(f.o, { ...event, id: randomUUID(), start: end, end: at(60) });
  assert.equal(other.status, 201);
  const ordinary = (await f.s.request('/reservations/' + other.data.id)).data;
  assert.equal(ordinary.canCancel, false);
  assert.equal(ordinary.owner, undefined);
  assert.equal((await cancel(f.s, other.data.id)).status, 403);
  const canceled = await Promise.all([
    cancel(f.o, winner.id, 'Plans changed'),
    cancel(f.o, winner.id, 'Later retry'),
  ]);
  assert.ok(canceled.every((r) => r.status === 200));
  assert.equal(canceled[0].data.reason, canceled[1].data.reason);
  assert.equal(await search(start, end), 'available');
  assert.equal((await f.o.request('/reservation-inbox')).data.notices.length, 1);
  assert.equal((await own.request('/reservation-inbox')).data.notices.length, 1);
  assert.equal(
    (await f.o.request('/reservations?' + new URLSearchParams({ start, end }))).data.events.length,
    0,
  );
  let calls = 0;
  const messages = [];
  const send = async (m) => {
    calls++;
    messages.push(m);
    if (calls === 1) throw Object.assign(Error('offline'), { definiteFailure: true });
    return { accepted: true };
  };
  await deliverReservationNotices(f.store, send, { provider: 'resend' });
  let failed = await f.store.db
    .prepare("SELECT * FROM reservation_notices WHERE status='failed'")
    .get();
  assert.ok(failed);
  const recipient = failed.recipient_key === f.store.emailLookup(manager) ? f.o : own;
  assert.equal(
    (
      await recipient.request('/reservation-notices/' + failed.id + '/retry', {
        method: 'POST',
        body: {},
      })
    ).status,
    200,
  );
  await deliverReservationNotices(f.store, send, { provider: 'resend' });
  await deliverReservationNotices(f.store, send, { provider: 'resend' });
  assert.equal(calls, 3);
  assert.deepEqual(messages[0], messages[2]);
  assert.ok(messages.every((m) => m.text.includes(winner.id)));
  assert.equal(
    (
      await f.store.db
        .prepare("SELECT COUNT(*) AS n FROM reservation_notices WHERE status='accepted'")
        .get()
    ).n,
    2,
  );
});
test('pickup rechecks the time slot and a canceled or collected booking cannot release an active trip', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  const event = { id: randomUUID(), vehicleId: v.id, start: at(0.2), end: at(3) };
  assert.equal((await f.s.request('/reservations', { method: 'POST', body: event })).status, 201);
  const blocked = await f.checkout(f.o, v);
  assert.equal(blocked.status, 409);
  // Put the synthetic booking into its pickup window without advancing other test clocks.
  await f.store.db
    .prepare('UPDATE reservations SET starts_at=? WHERE id=?')
    .run(at(-0.1), event.id);
  const picked = await f.checkout(f.s, v, { reservationId: event.id });
  assert.equal(picked.status, 201, JSON.stringify(picked.data));
  assert.equal(
    (await f.s.request('/reservations/' + event.id + '/cancel', { method: 'POST', body: {} }))
      .status,
    409,
  );
  const after = await f.s.request(
    '/availability?' + new URLSearchParams({ start: at(0.2), end: at(0.4) }),
  );
  assert.equal(after.data.vehicles[0].status, 'checked_out');
  await f.store.db
    .prepare('UPDATE trips SET projected_return_at=? WHERE id=?')
    .run(at(-1), picked.data.trip.id);
  assert.equal(
    (await f.s.request('/availability?' + new URLSearchParams({ start: at(48), end: at(49) }))).data
      .vehicles[0].status,
    'checked_out',
  );
  assert.equal((await f.returnTrip(f.s, picked.data.trip)).status, 201);
  assert.equal((await f.s.request('/reservations/' + event.id)).data.status, 'returned');
});

test('simultaneous cancellation and signed pickup commit one transition', async (t) => {
  const f = await fixture(t);
  const v = await f.addVehicle();
  const id = randomUUID();
  const reservation = { id, vehicleId: v.id, start: at(0.2), end: at(3) };
  assert.equal(
    (await f.s.request('/reservations', { method: 'POST', body: reservation })).status,
    201,
  );
  // Get the full signed inspection ready while pickup is still in the future.
  const ready = await f.checkout(f.s, v, { reservationId: id });
  assert.equal(ready.status, 409);
  await f.store.db.prepare('UPDATE reservations SET starts_at=? WHERE id=?').run(at(-0.1), id);
  const [pickup, cancel] = await Promise.all([
    f.s.request('/trips/checkout', {
      method: 'POST',
      body: ready.body,
      headers: { 'Idempotency-Key': randomUUID() },
    }),
    f.s.request('/reservations/' + id + '/cancel', { method: 'POST', body: {} }),
  ]);
  const state = (await f.s.request('/reservations/' + id)).data.status;
  if (pickup.status === 201) {
    assert.equal(cancel.status, 409);
    assert.equal(state, 'picked_up');
    assert.equal((await f.store.getVehicle(v.id)).status, 'checked_out');
  } else {
    assert.equal(pickup.status, 409);
    assert.equal(cancel.status, 200);
    assert.equal(state, 'canceled');
    assert.equal((await f.store.getVehicle(v.id)).status, 'available');
  }
});
