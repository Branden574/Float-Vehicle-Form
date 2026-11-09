import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, inspection, acknowledgments, signature, image } from './helpers.js';
import { createReport } from '../server/reports.js';

test('complete checkout/return carries 42500 → 42625, saves PDFs and snapshots, replays duplicate taps once', async (t) => {
  const f = await fixture(t, { reports: true }),
    vehicle = await f.addVehicle();
  const checkout = await f.checkout(f.s, vehicle);
  assert.equal(checkout.status, 201, JSON.stringify(checkout.data));
  const trip = checkout.data.trip;
  assert.equal(trip.status, 'active');
  assert.equal(f.store.getVehicle(vehicle.id).status, 'checked_out');
  const duplicate = await f.s.request('/trips/checkout', {
    method: 'POST',
    body: checkout.body,
    headers: { 'Idempotency-Key': checkout.key },
  });
  assert.equal(duplicate.data.trip.id, trip.id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM trips').get().n, 1);
  await f.a.request(`/admin/vehicles/${vehicle.id}`, {
    method: 'PATCH',
    body: { name: 'Renamed pool vehicle', reason: 'Fleet naming updated' },
  });
  assert.equal(f.store.getTrip(trip.id).vehicleSnapshot.name, 'Test pool vehicle');
  const returned = await f.returnTrip(f.s, trip);
  assert.equal(returned.status, 201, JSON.stringify(returned.data));
  assert.equal(returned.data.trip.tripMileage, 125);
  assert.equal(f.store.getVehicle(vehicle.id).currentMileage, 42625);
  assert.equal(f.store.getVehicle(vehicle.id).status, 'available');
  const returnedAgain = await f.s.request(`/trips/${trip.id}/return`, {
    method: 'POST',
    body: returned.body,
    headers: { 'Idempotency-Key': returned.key },
  });
  assert.equal(returnedAgain.data.trip.endingMileage, 42625);
  assert.equal(f.store.listNotifications().length, 2);
  assert.equal(f.store.getTripBundle(trip.id).photos.length, 8);
  const report = await createReport({ store: f.store, tripId: trip.id, stage: 'return' });
  assert.equal(report.subarray(0, 5).toString(), '%PDF-');
  assert.ok(report.length > 10000);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/sample-completed-trip.pdf', report);
  const next = await f.checkout(f.o, f.store.getVehicle(vehicle.id));
  assert.equal(next.status, 201);
  assert.equal(next.data.trip.startingMileage, 42625);
});

test('simultaneous requests from two app/database connections produce one checkout', async (t) => {
  const f = await fixture(t),
    vehicle = await f.addVehicle();
  const first = await f.draft(f.s, vehicle),
    second = await f.draft(f.o, vehicle),
    sig = await signature();
  const payload = (d) => ({
    ...d,
    vehicleId: vehicle.id,
    projectedReturnAt: new Date(Date.now() + 3600000).toISOString(),
    startingMileage: 42500,
    mileageConfirmed: true,
    inspection,
    signature: sig,
    acknowledgments,
  });
  const { createApp } = await import('../server/app.js');
  const app2 = createApp({ dataDir: f.directory, secureCookies: false });
  const server2 = app2.listen(0, '127.0.0.1');
  await new Promise((resolve) => server2.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server2.close(resolve));
    app2.locals.store.close();
  });
  const url = `http://127.0.0.1:${server2.address().port}/api/trips/checkout`;
  const [a, b] = await Promise.all([
    f.s.request('/trips/checkout', {
      method: 'POST',
      body: payload(first),
      headers: { 'Idempotency-Key': randomUUID() },
    }),
    fetch(url, {
      method: 'POST',
      headers: {
        Cookie: f.o.cookie,
        'X-CSRF-Token': f.o.csrf,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload(second)),
    }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM trips WHERE status='active'").get().n,
    1,
  );
});

test('database unique index independently blocks two open trips for a vehicle', async (t) => {
  const f = await fixture(t),
    vehicle = await f.addVehicle();
  await f.checkout(f.s, vehicle);
  assert.throws(
    () =>
      f.store.db
        .prepare(
          'INSERT INTO trips SELECT ?,vehicle_id,employee_id,status,checkout_at,projected_return_at,returned_at,starting_mileage,ending_mileage,vehicle_mileage_version,return_mileage_version,checkout_json,return_json,flags_json FROM trips LIMIT 1',
        )
        .run(randomUUID()),
    /UNIQUE/,
  );
});

test('staff isolation, CSRF, session expiry, invitation and driver eligibility are enforced', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  assert.equal((await f.s.request('/admin/overview')).status, 403);
  assert.equal(
    (
      await f.s.request(`/admin/vehicles/${v.id}`, {
        method: 'PATCH',
        body: { name: 'Nope', reason: 'Unauthorized edit' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.a.request('/admin/settings', {
        method: 'PATCH',
        body: { reason: 'Cross origin' },
        headers: { Origin: 'https://untrusted.test' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.a.request('/admin/settings', {
        method: 'PATCH',
        body: { reason: 'Missing CSRF' },
        headers: { 'X-CSRF-Token': '' },
      })
    ).status,
    403,
  );
  const c = await f.checkout(f.s, v),
    p = f.store.getTripBundle(c.data.trip.id).photos[0];
  assert.equal((await f.o.request(`/trips/${c.data.trip.id}`)).status, 403);
  assert.equal((await f.o.request(`/photos/${p.id}`)).status, 403);
  assert.equal((await fetch(f.url + `/api/photos/${p.id}`)).status, 401);
  const photo = await f.s.request(`/photos/${p.id}`);
  assert.match(photo.headers.get('cache-control'), /no-store/);
  assert.ok(photo.data.length);
  const invitation = await f.a.request('/admin/users', {
    method: 'POST',
    body: { name: 'Invited Person', email: 'invite@example.test', authorizedDriver: false },
  });
  assert.equal(invitation.status, 201);
  const accept = await fetch(f.url + '/api/auth/accept-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: invitation.data.inviteToken,
      password: 'Test-only-private-password-123!',
    }),
  });
  assert.equal(accept.status, 200);
  const unauth = await f.client('invite@example.test'),
    available = await f.addVehicle({ plate: 'TEST-002' });
  assert.equal((await f.upload(unauth, available.id)).status, 409);
  f.store.db
    .prepare("UPDATE sessions SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE user_id=?")
    .run(f.staff.id);
  assert.equal((await f.s.request('/auth/me')).status, 401);
});

test('required photo storage, retry, distinct views, originals and return freshness', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle(),
    buffer = await image(),
    draftId = randomUUID();
  const a = await f.upload(f.s, v.id, { buffer, draftId }),
    retry = await f.upload(f.s, v.id, { buffer, draftId });
  assert.equal(a.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(a.data.photo.id, retry.data.photo.id);
  const stored = f.store.getPhoto(a.data.photo.id);
  assert.deepEqual(await readFile(stored.originalPath), buffer);
  assert.notDeepEqual(await readFile(stored.displayPath), buffer);
  const body = {
    vehicleId: v.id,
    draftId,
    photoIds: [a.data.photo.id],
    startingMileage: 42500,
    mileageConfirmed: true,
    projectedReturnAt: new Date(Date.now() + 3600000).toISOString(),
    inspection,
    acknowledgments,
    signature: await signature(),
  };
  assert.equal(
    (
      await f.s.request('/trips/checkout', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': randomUUID() },
      })
    ).status,
    400,
  );
  assert.equal(f.store.getVehicle(v.id).status, 'available');
  const d = await f.draft(f.s, v);
  const fakeIds = [...d.photoIds];
  fakeIds[3] = fakeIds[0];
  assert.equal(
    (
      await f.s.request('/trips/checkout', {
        method: 'POST',
        body: { ...body, ...d, photoIds: fakeIds },
        headers: { 'Idempotency-Key': randomUUID() },
      })
    ).status,
    400,
  );
  const c = await f.checkout(f.s, v),
    trip = c.data.trip;
  const original = await readFile(f.store.getTripBundle(trip.id).photos[0].originalPath);
  assert.equal(
    (await f.upload(f.s, v.id, { stage: 'return', tripId: trip.id, buffer: original })).status,
    400,
  );
  const invalid = new FormData();
  invalid.append('file', new Blob(['not an image']), 'bad.jpg');
  Object.entries({
    vehicleId: v.id,
    stage: 'return',
    view: 'front',
    tripId: trip.id,
    draftId: randomUUID(),
    source: 'upload',
  }).forEach(([k, v]) => invalid.append(k, v));
  assert.equal((await f.s.request('/photos', { method: 'POST', body: invalid })).status, 400);
  assert.equal(
    (await f.s.request('/photos', { method: 'POST', body: new FormData() })).status,
    400,
  );
});

test('invalid mileage and damaged return hold; physical return remains completed', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle(),
    c = await f.checkout(f.s, v),
    trip = c.data.trip;
  const d = await f.draft(f.s, v, { stage: 'return', tripId: trip.id }),
    body = {
      ...d,
      endingMileage: 42499,
      inspection,
      acknowledgments,
      signature: await signature(),
    };
  assert.equal(
    (
      await f.s.request(`/trips/${trip.id}/return`, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': randomUUID() },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.s.request(`/trips/${trip.id}/return`, {
        method: 'POST',
        body: { ...body, endingMileage: 42500.5 },
        headers: { 'Idempotency-Key': randomUUID() },
      })
    ).status,
    400,
  );
  const result = await f.s.request(`/trips/${trip.id}/return`, {
    method: 'POST',
    body: {
      ...body,
      endingMileage: 42625,
      inspection: { ...inspection, windshield: 'cracked', fuelFull: false },
    },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(result.status, 201);
  assert.equal(f.store.getTrip(trip.id).status, 'returned');
  assert.equal(f.store.getVehicle(v.id).status, 'pending_review');
  const review = await f.a.request(`/trips/${trip.id}/review`, {
    method: 'POST',
    body: {
      stage: 'return',
      initials: 'TA',
      signature: await signature(),
      decision: 'out_of_service',
      reason: 'Windshield repair is required',
    },
  });
  assert.equal(review.status, 200);
  assert.equal(f.store.getVehicle(v.id).status, 'out_of_service');
});

test('representative approval is separate and declined checkout can be closed without a false return', async (t) => {
  const f = await fixture(t);
  await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: { reviewMode: 'representative', reason: 'Representative workflow required' },
  });
  const v = await f.addVehicle(),
    c = await f.checkout(f.s, v);
  assert.equal(c.data.trip.status, 'pending_checkout');
  const review = {
    stage: 'checkout',
    initials: 'TA',
    signature: await signature(),
    decision: 'approve',
    reason: 'Inspection reviewed by representative',
  };
  assert.equal(
    (await f.s.request(`/trips/${c.data.trip.id}/review`, { method: 'POST', body: review })).status,
    403,
  );
  assert.equal(
    (await f.a.request(`/trips/${c.data.trip.id}/review`, { method: 'POST', body: review })).status,
    200,
  );
  assert.equal(f.store.getTrip(c.data.trip.id).status, 'active');
  const second = await f.addVehicle({ plate: 'TEST-002' }),
    declined = await f.checkout(f.s, second);
  const r = await f.a.request(`/trips/${declined.data.trip.id}/review`, {
    method: 'POST',
    body: {
      ...review,
      decision: 'out_of_service',
      reason: 'Do not drive; mechanical repair needed',
    },
  });
  assert.equal(r.data.trip.status, 'cancelled');
  assert.equal(r.data.trip.returnedAt, null);
  assert.equal(
    (
      await f.a.request(`/admin/vehicles/${second.id}`, {
        method: 'PATCH',
        body: { status: 'available', reason: 'Repairs completed and verified' },
      })
    ).status,
    200,
  );
});

test('historical corrections preserve signed forms and newer mileage; current revisions require acknowledgment', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle(),
    first = await f.checkout(f.s, v);
  await f.returnTrip(f.s, first.data.trip);
  const latest = await f.checkout(f.o, f.store.getVehicle(v.id));
  await f.returnTrip(f.o, latest.data.trip);
  const mileage = f.store.getVehicle(v.id).currentMileage;
  const old = await f.a.request(`/trips/${first.data.trip.id}/corrections`, {
    method: 'POST',
    body: { field: 'endingMileage', value: 42600, reason: 'Old form transposition documented' },
  });
  assert.equal(old.status, 201);
  assert.equal(old.data.revision.affectsCurrent, false);
  assert.equal(
    (
      await f.s.request(
        `/trips/${first.data.trip.id}/revisions/${old.data.revision.id}/acknowledge`,
        { method: 'POST', body: { signature: await signature() } },
      )
    ).status,
    200,
  );
  assert.equal(f.store.getVehicle(v.id).currentMileage, mileage);
  assert.equal(f.store.getTrip(first.data.trip.id).endingMileage, 42625);
  const current = await f.a.request(`/trips/${latest.data.trip.id}/corrections`, {
    method: 'POST',
    body: {
      field: 'endingMileage',
      value: mileage + 10,
      reason: 'Verified dashboard reading correction',
    },
  });
  assert.equal(current.status, 201);
  assert.equal(f.store.getVehicle(v.id).status, 'pending_review');
  assert.equal(
    (
      await f.a.request(`/admin/vehicles/${v.id}`, {
        method: 'PATCH',
        body: { status: 'available', reason: 'Attempt release before acknowledgement' },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.s.request(
        `/trips/${latest.data.trip.id}/revisions/${current.data.revision.id}/acknowledge`,
        { method: 'POST', body: { signature: await signature() } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.o.request(
        `/trips/${latest.data.trip.id}/revisions/${current.data.revision.id}/acknowledge`,
        { method: 'POST', body: { signature: await signature() } },
      )
    ).status,
    200,
  );
  assert.equal(f.store.getVehicle(v.id).currentMileage, mileage + 10);
  assert.equal(f.store.getTrip(latest.data.trip.id).endingMileage, mileage);
});

test('live odometer replacement is documented and explicitly acknowledged with correct distance', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle(),
    c = await f.checkout(f.s, v),
    trip = c.data.trip;
  const event = await f.a.request(`/trips/${trip.id}/odometer-replacement`, {
    method: 'POST',
    body: {
      oldReading: 42550,
      newReading: 0,
      reason: 'Repair shop replaced odometer; receipt verified',
    },
  });
  assert.equal(event.status, 201);
  const d = await f.draft(f.s, v, { stage: 'return', tripId: trip.id }),
    body = { ...d, endingMileage: 75, inspection, signature: await signature(), acknowledgments };
  assert.equal(
    (
      await f.s.request(`/trips/${trip.id}/return`, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': randomUUID() },
      })
    ).status,
    409,
  );
  const returned = await f.s.request(`/trips/${trip.id}/return`, {
    method: 'POST',
    body: {
      ...body,
      odometerReplacementId: event.data.trip.odometerReplacement.id,
      odometerReplacementAcknowledged: true,
    },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(returned.status, 201, JSON.stringify(returned.data));
  assert.equal(returned.data.trip.tripMileage, 125);
  assert.equal(f.store.getVehicle(v.id).currentMileage, 75);
  assert.equal(f.store.getVehicle(v.id).status, 'pending_review');
});

test('discrepancy, unusually large mileage, storage ceiling and archive policies', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  assert.equal(
    (
      await f.s.request(`/vehicles/${v.id}/discrepancy`, {
        method: 'POST',
        body: { observedMileage: 42600, reason: 'Dashboard is higher than stored reading' },
      })
    ).status,
    200,
  );
  assert.equal(f.store.getVehicle(v.id).currentMileage, 42500);
  assert.equal(f.store.getVehicle(v.id).status, 'pending_review');
  await f.a.request(`/admin/vehicles/${v.id}`, {
    method: 'PATCH',
    body: { currentMileage: 42600, status: 'available', reason: 'Dashboard discrepancy verified' },
  });
  const c = await f.checkout(f.s, f.store.getVehicle(v.id)),
    r = await f.returnTrip(f.s, c.data.trip, { endingMileage: 44000 });
  assert.equal(r.status, 201);
  assert.ok(r.data.trip.flags.includes('Unusually large mileage increase'));
  assert.equal(f.store.getVehicle(v.id).status, 'pending_review');
  assert.equal(
    (
      await f.a.request(`/admin/vehicles/${v.id}`, {
        method: 'PATCH',
        body: { archived: true, reason: 'Vehicle retired from service' },
      })
    ).status,
    200,
  );
  assert.equal((await f.a.request('/vehicles')).data.vehicles.length, 0);
  assert.equal(f.store.getTrip(c.data.trip.id).vehicleSnapshot.archived, false);
  const v2 = await f.addVehicle();
  f.store.db
    .prepare('UPDATE settings SET data_json=? WHERE id=1')
    .run(JSON.stringify({ ...f.store.getSettings(), storageLimitBytes: 1 }));
  assert.equal((await f.upload(f.s, v2.id)).status, 507);
});
