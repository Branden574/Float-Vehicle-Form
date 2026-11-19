import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { fixture } from './helpers.js';
import { processNotification } from '../server/notifications.js';

test('signed delivery events handle duplicates, early callbacks, unordered events and targeted retries', async (t) => {
  const secret = 'whsec_' + randomBytes(32).toString('base64');
  const f = await fixture(t, { resendWebhookSecret: secret });
  const postEvent = async (event, valid = true) => {
    const now = new Date(),
      id = randomUUID(),
      body = JSON.stringify(event);
    return fetch(f.url + '/api/hooks/resend', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-signature': valid ? new Webhook(secret).sign(id, now, body) : 'fake',
        'svix-timestamp': String(Math.floor(+now / 1000)),
      },
      body,
    });
  };
  const assistants = ['jen@example.test', 'lee@example.test'];
  await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: {
      notificationRecipients: assistants,
      employeeCopy: false,
      reason: 'Test delivery tracking',
    },
  });
  const trip = (await f.checkout(f.s, await f.addVehicle())).data.trip;
  const notificationId = (await f.store.listNotifications(trip.id))[0].id;
  const messages = [];
  const makeEvent = (message, type, at = '2026-11-18T17:00:00Z') => ({
    type,
    created_at: at,
    data: {
      email_id: message.deliveryId,
      to: message.to,
      tags: { fleet_delivery: message.deliveryId },
    },
  });
  // This Resend workspace can send unrelated applications' mail. Ignore those callbacks.
  const unknownEvent = {
    type: 'email.delivered',
    created_at: new Date().toISOString(),
    data: { email_id: randomUUID(), to: ['other-app@example.test'] },
  };
  assert.equal((await postEvent(unknownEvent)).status, 204);
  assert.equal(
    (
      await postEvent({
        ...unknownEvent,
        data: { ...unknownEvent.data, to: ['other-app@example.test', 'private@example.test'] },
      })
    ).status,
    204,
  );
  assert.equal(
    (await f.store.db.prepare('SELECT count(*) AS count FROM notification_deliveries').get()).count,
    0,
  );
  const send = async (msg) => {
    messages.push(msg);
    if (msg.to[0] === assistants[0] && messages.length === 1) {
      assert.equal((await postEvent(makeEvent(msg, 'email.bounced'), false)).status, 401);
      assert.equal((await postEvent(makeEvent(msg, 'email.bounced'))).status, 204);
    }
    return { id: msg.deliveryId, accepted: true };
  };
  const report = async () => Buffer.from('%PDF');
  await processNotification({ store: f.store, notificationId, send, report });
  for (const event of [
    makeEvent(messages[1], 'email.delivered'),
    makeEvent(messages[1], 'email.delivery_delayed', '2026-11-18T16:00:00Z'),
    makeEvent(messages[0], 'email.bounced'),
  ]) {
    assert.equal((await postEvent(event)).status, 204);
  }
  const notice = (await f.a.request('/admin/overview')).data.notifications.find(
    (n) => n.id === notificationId,
  );
  assert.equal(notice.deliveries.find((d) => d.email === assistants[0]).status, 'bounced');
  assert.equal(notice.deliveries.find((d) => d.email === assistants[1]).status, 'delivered');
  assert.equal(
    (
      await f.a.request('/admin/notifications/' + notificationId + '/retry', {
        method: 'POST',
        body: { recipient: assistants[0] },
      })
    ).status,
    200,
  );
  await processNotification({ store: f.store, notificationId, send, report });
  assert.deepEqual(
    messages.map((m) => m.to),
    [[assistants[0]], [assistants[1]], [assistants[0]]],
  );
  await postEvent(makeEvent(messages[0], 'email.bounced', '2026-11-18T18:00:00Z'));
  const updated = (await f.a.request('/admin/overview')).data.notifications.find(
    (n) => n.id === notificationId,
  );
  assert.equal(updated.deliveries.find((d) => d.email === assistants[0]).status, 'accepted');
  assert.equal(updated.deliveries.find((d) => d.email === assistants[1]).status, 'delivered');
});

test('oversized report requires a fresh code for the original non-staff recipient and issues no fleet session', async (t) => {
  let codeMessage;
  const f = await fixture(t, {
    reports: true,
    sendReportCode: async (msg) => {
      codeMessage = msg;
      return { accepted: true };
    },
  });
  const assistant = 'private-recipient@example.test';
  await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: {
      notificationRecipients: [assistant],
      employeeCopy: false,
      reason: 'Test private oversized reports',
    },
  });
  const trip = (await f.checkout(f.s, await f.addVehicle())).data.trip;
  const notice = (await f.store.listNotifications(trip.id))[0];
  let copy;
  await processNotification({
    store: f.store,
    notificationId: notice.id,
    send: async (msg) => {
      copy = msg;
      return { id: randomUUID(), accepted: true };
    },
    report: async () => Buffer.alloc(21 * 1024 * 1024),
  });
  assert.deepEqual(copy.to, [assistant]);
  assert.deepEqual(copy.attachments, []);
  const token = copy.text.match(/report-copy\.html#([^\s]+)/)[1];
  const post = (path, data = {}) =>
    fetch(f.url + '/api/report-copy/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...data }),
    });
  assert.equal((await post('download', { code: '000000' })).status, 403);
  assert.equal((await post('request-code', { email: 'someone-else@example.test' })).status, 200);
  assert.deepEqual(codeMessage.to, [assistant]);
  assert.equal((await post('request-code')).status, 429);
  const code = codeMessage.text.match(/\b(\d{6})\b/)[1];
  const wrong = code === '111111' ? '222222' : '111111';
  assert.equal((await post('download', { code: wrong })).status, 403);
  const pdf = await post('download', { code });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('set-cookie'), null);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    '%PDF',
  );
  assert.equal((await post('download', { code })).status, 403);
  await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: { notificationRecipients: [], employeeCopy: false, reason: 'Revoke this recipient' },
  });
  assert.equal((await post('request-code')).status, 403);
});
