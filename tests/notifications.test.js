import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, signature } from './helpers.js';
import { processNotification, createEmailSender } from '../server/notifications.js';
import { PDFDocument } from 'pdf-lib';

test('assistant recipients receive checkout and check-in PDFs; settings persist and staff cannot edit them', async (t) => {
  const f = await fixture(t);
  const recipients = ['assistant.one@example.test', 'assistant.two@example.test'];
  const body = {
    notificationRecipients: recipients,
    employeeCopy: true,
    reason: 'Configure assistant form copies',
  };
  assert.equal((await f.s.request('/admin/settings', { method: 'PATCH', body })).status, 403);
  assert.equal(
    (
      await f.a.request('/admin/settings', {
        method: 'PATCH',
        body: { ...body, notificationRecipients: ['invalid-address'] },
      })
    ).status,
    400,
  );
  assert.equal((await f.a.request('/admin/settings', { method: 'PATCH', body })).status, 200);
  assert.deepEqual((await f.store.getSettings()).notificationRecipients, recipients);
  const vehicle = await f.addVehicle();
  const checkout = await f.checkout(f.s, vehicle);
  assert.equal(checkout.status, 201);
  const messages = [];
  const send = async (message) => {
    messages.push(message);
    return { accepted: true, id: `test-${messages.length}` };
  };
  const checkoutNotification = (await f.store.listNotifications(checkout.data.trip.id))[0];
  await processNotification({ store: f.store, notificationId: checkoutNotification.id, send });
  assert.deepEqual(messages[0].to, [...recipients, f.staff.email]);
  assert.match(messages[0].text, /Not yet returned/);
  const checkoutPdf = await PDFDocument.load(messages[0].attachments[0].content);
  assert.ok(checkoutPdf.getPageCount() >= 4, 'two original-layout forms and photo appendix');
  const returned = await f.returnTrip(f.s, checkout.data.trip);
  assert.equal(returned.status, 201);
  const returnNotification = (await f.store.listNotifications(checkout.data.trip.id)).find(
    (row) => row.stage === 'return',
  );
  await processNotification({ store: f.store, notificationId: returnNotification.id, send });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].to, [...recipients, f.staff.email]);
  assert.match(messages[1].text, /both completed forms/);
  assert.match(messages[1].attachments[0].filename, /return\.pdf$/);
  const returnPdf = await PDFDocument.load(messages[1].attachments[0].content);
  assert.ok(
    returnPdf.getPageCount() > checkoutPdf.getPageCount(),
    'return adds its own inspection and photo evidence',
  );
});

test('saved trip survives email failure, admin retry works, acceptance is not delivery, no automatic duplicate send', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: { notificationRecipients: ['fleet@example.test'], reason: 'Test mailbox configuration' },
  });
  const c = await f.checkout(f.s, v);
  let notification = (await f.store.listNotifications(c.data.trip.id))[0];
  assert.equal(notification.status, 'pending');
  let calls = 0;
  const failure = async () => {
    calls++;
    throw Object.assign(new Error('Mail provider quota exceeded'), { definiteFailure: true });
  };
  const report = async () => Buffer.from('%PDF-test');
  notification = await processNotification({
    store: f.store,
    notificationId: notification.id,
    send: failure,
    report,
  });
  assert.equal(notification.status, 'failed');
  assert.equal((await f.store.getTrip(c.data.trip.id)).status, 'active');
  await f.a.request(`/admin/notifications/${notification.id}/retry`, { method: 'POST', body: {} });
  const send = async (message) => {
    calls++;
    assert.equal(message.attachments.length, 1);
    assert.equal(message.to[0], 'fleet@example.test');
    return { accepted: true, id: 'test-provider-id' };
  };
  const results = await Promise.all([
    processNotification({ store: f.store, notificationId: notification.id, send, report }),
    processNotification({ store: f.store, notificationId: notification.id, send, report }),
  ]);
  assert.ok(results.some((r) => r.status === 'accepted'));
  assert.equal(calls, 2);
  notification = (await f.store.listNotifications())[0];
  assert.equal(notification.deliveredAt, null);
  assert.ok(notification.acceptedAt);
  assert.equal(
    (
      await f.a.request(`/admin/notifications/${notification.id}/retry`, {
        method: 'POST',
        body: {},
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.s.request(`/admin/notifications/${notification.id}/retry`, {
        method: 'POST',
        body: {},
      })
    ).status,
    403,
  );
});

test('ambiguous sends become unknown and require explicit reasoned resend', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: { notificationRecipients: ['fleet@example.test'], reason: 'Test mailbox configuration' },
  });
  await f.checkout(f.s, v);
  const n = (await f.store.listNotifications())[0];
  const result = await processNotification({
    store: f.store,
    notificationId: n.id,
    send: async () => {
      throw new Error('Connection lost after message transmission');
    },
    report: async () => Buffer.from('%PDF'),
  });
  assert.equal(result.status, 'unknown');
  assert.equal(
    (await f.a.request(`/admin/notifications/${n.id}/retry`, { method: 'POST', body: {} })).status,
    400,
  );
  assert.equal(
    (
      await f.a.request(`/admin/notifications/${n.id}/retry`, {
        method: 'POST',
        body: { resend: true, reason: 'Provider confirms no delivery; explicit resend' },
      })
    ).status,
    200,
  );
  assert.notEqual((await f.store.listNotifications())[0].messageId, n.messageId);
});

test('mail is disabled by default and cannot silently send externally', async () => {
  await assert.rejects(createEmailSender({})({}), /not configured/);
  assert.throws(() => createEmailSender({ EMAIL_PROVIDER: 'smtp' }), /EMAIL_FROM/);
});

test('representative-required reports wait for signatures and cannot be released through generic edits', async (t) => {
  const f = await fixture(t);
  await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: {
      reviewMode: 'representative',
      notificationRecipients: ['fleet@example.test'],
      reason: 'Require signed representative review',
    },
  });
  const v = await f.addVehicle(),
    c = await f.checkout(f.s, v),
    trip = c.data.trip;
  const checkoutNotification = (await f.store.listNotifications(trip.id))[0];
  assert.equal(checkoutNotification.status, 'awaiting_review');
  assert.equal(
    (
      await f.a.request(`/admin/notifications/${checkoutNotification.id}/retry`, {
        method: 'POST',
        body: {},
      })
    ).status,
    409,
  );
  await f.a.request(`/trips/${trip.id}/review`, {
    method: 'POST',
    body: {
      stage: 'checkout',
      initials: 'TA',
      signature: await signature(),
      decision: 'approve',
      reason: 'Representative verified checkout',
    },
  });
  assert.equal((await f.store.listNotifications(trip.id))[0].status, 'pending');
  await f.returnTrip(f.s, await f.store.getTrip(trip.id));
  assert.equal(
    (await f.store.listNotifications(trip.id)).find((n) => n.stage === 'return').status,
    'awaiting_review',
  );
  assert.equal(
    (
      await f.a.request(`/admin/vehicles/${v.id}`, {
        method: 'PATCH',
        body: { status: 'available', reason: 'Attempt bypass representative signature' },
      })
    ).status,
    409,
  );
  await f.a.request(`/trips/${trip.id}/review`, {
    method: 'POST',
    body: {
      stage: 'return',
      initials: 'TA',
      signature: await signature(),
      decision: 'approve',
      reason: 'Representative verified physical return',
    },
  });
  assert.equal(
    (await f.store.listNotifications(trip.id)).find((n) => n.stage === 'return').status,
    'pending',
  );
  assert.equal((await f.store.getVehicle(v.id)).status, 'available');
});
