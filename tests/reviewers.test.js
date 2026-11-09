import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, signature } from './helpers.js';
import { processNotification } from '../server/notifications.js';

const assignment = (emails) => ({
  returnReviewerEmails: emails,
  reason: 'Assign fleet return reviewers',
});
const approval = async (stage) => ({
  stage,
  initials: 'RV',
  signature: await signature(),
  decision: 'approve',
  reason: 'Inspected mileage, condition and receipt evidence',
});

test('assigned email reviewers approve returns without admin access; self-review and bypass are denied', async (t) => {
  const f = await fixture(t, { reports: true });
  assert.equal(
    (await f.s.request('/admin/settings', { method: 'PATCH', body: assignment([f.staff.email]) }))
      .status,
    403,
  );
  const saved = await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: {
      ...assignment([f.other.email.toUpperCase(), f.staff.email]),
      notificationRecipients: ['assistant@example.test'],
    },
  });
  assert.equal(saved.status, 200);
  assert.ok(saved.data.settings.returnReviewerEmails.includes(f.other.email));
  const account = await f.o.request('/auth/me');
  assert.equal(account.data.user.canReviewReturns, true);
  assert.equal(account.data.user.role, 'staff');
  assert.equal(account.data.settings.returnReviewerEmails, undefined);
  assert.equal((await f.o.request('/admin/overview')).status, 403);
  const vehicle = await f.addVehicle();
  const checkout = await f.checkout(f.s, vehicle);
  assert.equal(
    checkout.data.trip.status,
    'active',
    'return reviewers do not require checkout review',
  );
  assert.equal(
    (await f.o.request(`/trips/${checkout.data.trip.id}`)).status,
    403,
    'no access to another active trip',
  );
  assert.equal(
    (
      await f.o.request(`/trips/${checkout.data.trip.id}/review`, {
        method: 'POST',
        body: await approval('checkout'),
      })
    ).status,
    403,
  );
  const returned = await f.returnTrip(f.s, checkout.data.trip);
  const id = returned.data.trip.id;
  assert.equal(returned.data.trip.returnReviewMode, 'representative');
  assert.equal((await f.store.getVehicle(vehicle.id)).status, 'pending_review');
  assert.deepEqual((await f.s.request('/trips')).data.pendingReturns, [], 'own return excluded');
  assert.equal((await f.o.request('/trips')).data.pendingReturns[0].id, id);
  const detail = await f.o.request(`/trips/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.canReviewReturn, true);
  assert.equal((await f.o.request(detail.data.photos[0].url.replace('/api', ''))).status, 200);
  const unusedVehicle = await f.addVehicle();
  const unfinished = await f.upload(f.s, unusedVehicle.id, { view: 'receipt' });
  assert.equal(unfinished.status, 201);
  assert.equal(
    (await f.o.request(`/photos/${unfinished.data.photo.id}`)).status,
    403,
    'no access to unfinalized photos',
  );
  assert.equal(
    (await f.s.request(`/trips/${id}/review`, { method: 'POST', body: await approval('return') }))
      .status,
    403,
  );
  assert.equal(
    (await f.a.request(`/trips/${id}/review`, { method: 'POST', body: await approval('return') }))
      .status,
    403,
    'unassigned admin cannot sign a return',
  );
  assert.equal(
    (
      await f.a.request(`/admin/vehicles/${vehicle.id}`, {
        method: 'PATCH',
        body: { status: 'available', reason: 'Attempt to bypass return review' },
      })
    ).status,
    409,
  );
  const notices = await f.store.listNotifications(id);
  assert.equal(notices.find((n) => n.stage === 'return').status, 'awaiting_review');
  const reviewNotice = notices.find((n) => n.stage === 'return_review');
  let sent;
  await processNotification({
    store: f.store,
    notificationId: reviewNotice.id,
    send: async (m) => {
      sent = m;
      return { accepted: true, id: 'review-message' };
    },
  });
  assert.deepEqual(sent.to, [f.other.email]);
  assert.equal(sent.attachments.length, 0);
  assert.match(sent.text, /Returns awaiting your review/);
  const reviewed = await f.o.request(`/trips/${id}/review`, {
    method: 'POST',
    body: await approval('return'),
  });
  assert.equal(reviewed.status, 200);
  assert.equal((await f.store.getVehicle(vehicle.id)).status, 'available');
  assert.deepEqual((await f.o.request('/trips')).data.pendingReturns, []);
  assert.equal(
    (await f.store.listNotifications(id)).find((n) => n.stage === 'return').status,
    'pending',
  );
  assert.equal(
    (await f.o.request(`/trips/${id}/review`, { method: 'POST', body: await approval('return') }))
      .status,
    409,
  );
});

test('removing a reviewer immediately revokes an existing session and queued requests do not email them', async (t) => {
  const f = await fixture(t);
  await f.a.request('/admin/settings', { method: 'PATCH', body: assignment([f.other.email]) });
  const vehicle = await f.addVehicle();
  const checkout = await f.checkout(f.s, vehicle);
  const returned = await f.returnTrip(f.s, checkout.data.trip);
  const id = returned.data.trip.id;
  const notice = (await f.store.listNotifications(id)).find((n) => n.stage === 'return_review');
  await f.a.request('/admin/settings', { method: 'PATCH', body: assignment([f.admin.email]) });
  assert.equal((await f.o.request('/auth/me')).data.user.canReviewReturns, false);
  assert.equal((await f.o.request(`/trips/${id}`)).status, 403);
  assert.equal(
    (await f.o.request(`/trips/${id}/review`, { method: 'POST', body: await approval('return') }))
      .status,
    403,
  );
  const result = await processNotification({
    store: f.store,
    notificationId: notice.id,
    send: async () => {
      assert.fail('Removed reviewer must not receive mail');
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(
    (await f.a.request(`/trips/${id}/review`, { method: 'POST', body: await approval('return') }))
      .status,
    200,
  );
});
