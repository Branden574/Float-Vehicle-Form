import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, signature, inspection } from './helpers.js';
import { processNotification, createEmailSender } from '../server/notifications.js';
import { PDFDocument } from 'pdf-lib';
import { reportFilename } from '../server/report-filename.js';
import { createReport } from '../server/reports.js';

test('assistant recipients receive checkout and check-in PDFs; settings persist and staff cannot edit them', async (t) => {
  const f = await fixture(t, { reports: true });
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
  assert.deepEqual(
    messages.map((m) => m.to),
    [...recipients, f.staff.email].map((email) => [email]),
  );
  assert.match(messages[0].text, /Not yet returned/);
  assert.equal(messages[0].attachments[0].filename, reportFilename(checkout.data.trip, 'checkout'));
  const checkoutPdf = await PDFDocument.load(messages[0].attachments[0].content);
  assert.ok(checkoutPdf.getPageCount() >= 4, 'two original-layout forms and photo appendix');
  const receiptDraft = await f.draft(f.s, vehicle, {
    stage: 'return',
    tripId: checkout.data.trip.id,
  });
  for (let page = 0; page < 2; page++) {
    const receipt = await f.upload(f.s, vehicle.id, {
      stage: 'return',
      tripId: checkout.data.trip.id,
      draftId: receiptDraft.draftId,
      view: 'receipt',
      source: 'camera',
    });
    assert.equal(receipt.status, 201);
    receiptDraft.photoIds.push(receipt.data.photo.id);
  }
  const unanswered = await f.returnTrip(f.s, checkout.data.trip, { ...receiptDraft, inspection });
  assert.equal(unanswered.status, 400);
  const unnamed = await f.returnTrip(f.s, checkout.data.trip, {
    ...receiptDraft,
    inspection: { ...inspection, emergencyKitsPresent: false },
  });
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.data.error, /Name the missing/);
  const returned = await f.returnTrip(f.s, checkout.data.trip, {
    ...receiptDraft,
    inspection: {
      ...inspection,
      emergencyKitsPresent: false,
      missingEmergencyKits: 'Roadside kit',
    },
  });
  assert.equal(returned.status, 201);
  assert.equal(returned.data.trip.returnInspection.emergencyKitsPresent, false);
  assert.ok(
    returned.data.trip.flags.includes('Emergency service kit newly reported missing at check-in'),
  );
  assert.equal((await f.store.getVehicle(vehicle.id)).status, 'pending_review');
  const returnNotification = (await f.store.listNotifications(checkout.data.trip.id)).find(
    (row) => row.stage === 'return',
  );
  await processNotification({ store: f.store, notificationId: returnNotification.id, send });
  assert.equal(messages.length, 6);
  assert.deepEqual(
    messages.slice(3).map((m) => m.to),
    [...recipients, f.staff.email].map((email) => [email]),
  );
  assert.match(messages[3].text, /both completed forms/);
  const expectedName = reportFilename(returned.data.trip, 'return');
  assert.equal(messages[3].attachments[0].filename, expectedName);
  const detail = await f.s.request(`/trips/${checkout.data.trip.id}`);
  assert.equal(detail.data.reportFilenames.return, expectedName);
  assert.equal(
    detail.data.photos.filter((p) => p.view === 'receipt' && p.stage === 'return').length,
    2,
  );
  const downloaded = await f.s.request(`/trips/${checkout.data.trip.id}/report?stage=return`);
  assert.equal(
    downloaded.headers.get('content-disposition'),
    `attachment; filename="${expectedName}"`,
  );
  // Cached cloud copies receive the same friendly label without renaming storage objects.
  let signedName;
  await createReport({
    store: {
      ...f.store,
      evidence: {
        ...f.store.evidence,
        cloud: true,
        signedRead: async (key, name) => {
          assert.match(key, /^reports\/[a-f0-9-]+-return-[a-f0-9]+\.pdf$/);
          signedName = name;
          return 'https://storage.example.test/report';
        },
      },
    },
    tripId: checkout.data.trip.id,
    stage: 'return',
    download: true,
  });
  assert.equal(signedName, expectedName);
  const returnPdf = await PDFDocument.load(messages[3].attachments[0].content);
  assert.ok(
    returnPdf.getPageCount() >= checkoutPdf.getPageCount() + 4,
    'return adds two photo pages and a full page for each scanned receipt',
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

test('a delayed or retried checkout cannot send a blank check-in after return', async (t) => {
  const f = await fixture(t);
  await f.a.request('/admin/settings', {
    method: 'PATCH',
    body: {
      notificationRecipients: ['assistant@example.test'],
      reason: 'Test completed report ordering',
    },
  });
  const checkout = await f.checkout(f.s, await f.addVehicle());
  const trip = checkout.data.trip;
  const notice = (await f.store.listNotifications(trip.id))[0];
  let sends = 0;
  const send = async () => {
    sends++;
    return { accepted: true };
  };
  // Reproduce a return completing while the old checkout PDF is rendering.
  const result = await processNotification({
    store: f.store,
    notificationId: notice.id,
    send,
    report: async () => {
      assert.equal((await f.returnTrip(f.s, trip)).status, 201);
      return Buffer.from('obsolete checkout');
    },
  });
  assert.equal(sends, 0);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /superseded/);
  await f.a.request(`/admin/notifications/${notice.id}/retry`, { method: 'POST', body: {} });
  await processNotification({
    store: f.store,
    notificationId: notice.id,
    send,
    report: async () => {
      throw new Error('Obsolete PDF must not be rendered');
    },
  });
  assert.equal(sends, 0);
  const returned = (await f.store.listNotifications(trip.id)).find((n) => n.stage === 'return');
  let message;
  await processNotification({
    store: f.store,
    notificationId: returned.id,
    send: async (m) => {
      message = m;
      return { accepted: true };
    },
    report: async () => Buffer.from('completed forms'),
  });
  assert.match(message.subject, /COMPLETED CHECK-IN - print this copy/);
  assert.match(message.text, /both completed forms/);
});

test('a signed check-in goes only to queued recipients still eligible at dispatch', async (t) => {
  const f = await fixture(t);
  const retained = 'assistant.one@example.test';
  const removed = 'assistant.two@example.test';
  const newlyAdded = 'new-assistant@example.test';
  const configure = async (changes) => {
    const result = await f.a.request('/admin/settings', {
      method: 'PATCH',
      body: { ...changes, reason: 'Update assistant form copies' },
    });
    assert.equal(result.status, 200);
  };
  await configure({
    notificationRecipients: [retained, removed],
    returnReviewerEmails: [f.other.email],
    employeeCopy: true,
  });
  const checkout = await f.checkout(f.s, await f.addVehicle());
  const trip = checkout.data.trip;
  await f.returnTrip(f.s, trip);
  const notice = (await f.store.listNotifications(trip.id)).find((n) => n.stage === 'return');
  assert.equal(notice.status, 'awaiting_review');
  await configure({ notificationRecipients: [retained, newlyAdded] });
  const review = await f.o.request(`/trips/${trip.id}/review`, {
    method: 'POST',
    body: {
      stage: 'return',
      decision: 'approve',
      initials: 'OD',
      signature: await signature(),
      reason: 'Physical check-in complete',
    },
  });
  assert.ok(review.status < 300, JSON.stringify(review.data));
  const sent = [];
  const result = await processNotification({
    store: f.store,
    notificationId: notice.id,
    report: async () => Buffer.from('%PDF'),
    send: async (message) => {
      sent.push(...message.to);
      await configure({ employeeCopy: false });
      return { accepted: true, id: 'local-approved' };
    },
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(sent, [retained]);
  const record = (await f.a.request('/admin/overview')).data.notifications.find(
    (n) => n.id === notice.id,
  );
  assert.deepEqual(Object.fromEntries(record.deliveries.map((d) => [d.email, d.status])), {
    [retained]: 'accepted',
    [removed]: 'skipped',
    [f.staff.email]: 'skipped',
  });
});

test('removing a recipient after queueing a retry skips the delivery and issues no private link', async (t) => {
  const f = await fixture(t);
  const recipient = 'assistant@example.test';
  const configure = async (recipients) =>
    assert.equal(
      (
        await f.a.request('/admin/settings', {
          method: 'PATCH',
          body: { notificationRecipients: recipients, reason: 'Update assistant addresses' },
        })
      ).status,
      200,
    );
  await configure([recipient]);
  const trip = (await f.checkout(f.s, await f.addVehicle())).data.trip;
  const [notice] = await f.store.listNotifications(trip.id);
  let sends = 0;
  const send = async () => {
    sends++;
    throw Object.assign(new Error('Test rejection'), { definiteFailure: true });
  };
  const run = () =>
    processNotification({
      store: f.store,
      notificationId: notice.id,
      send,
      report: async () => Buffer.alloc(21 * 1024 * 1024),
    });
  assert.equal((await run()).status, 'failed');
  assert.equal(
    (
      await f.a.request(`/admin/notifications/${notice.id}/retry`, {
        method: 'POST',
        body: { recipient },
      })
    ).status,
    200,
  );
  await configure([]);
  const skipped = await run();
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.acceptedAt, null);
  assert.equal(sends, 1);
  const record = (await f.a.request('/admin/overview')).data.notifications.find(
    (n) => n.id === notice.id,
  );
  assert.equal(record.deliveries[0].status, 'skipped');
  assert.equal(record.deliveries[0].viaLink, false);
});

test('unavailable receipt withholds check-in PDF until it can be included and cached', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.a.request('/admin/settings', {
        method: 'PATCH',
        body: {
          notificationRecipients: ['assistant@example.test'],
          reason: 'Receive completed forms',
        },
      })
    ).status,
    200,
  );
  const vehicle = await f.addVehicle(),
    trip = (await f.checkout(f.s, vehicle)).data.trip;
  const draft = await f.draft(f.s, vehicle, { stage: 'return', tripId: trip.id });
  const receipt = await f.upload(f.s, vehicle.id, {
    stage: 'return',
    tripId: trip.id,
    draftId: draft.draftId,
    view: 'receipt',
  });
  assert.equal(receipt.status, 201);
  draft.photoIds.push(receipt.data.photo.id);
  assert.equal((await f.returnTrip(f.s, trip, draft)).status, 201);
  const notice = (await f.store.listNotifications(trip.id)).find((n) => n.stage === 'return');
  const originalRead = f.store.evidence.read;
  const path = (await f.store.getPhoto(receipt.data.photo.id)).displayPath;
  const expectedImage = await originalRead(path);
  let available = false;
  f.store.evidence.read = async (key) => {
    if (key === path && !available) throw new Error('Test storage temporarily offline');
    return originalRead(key);
  };
  const messages = [];
  const run = () =>
    processNotification({
      store: f.store,
      notificationId: notice.id,
      send: async (message) => {
        messages.push(message);
        return { accepted: true, id: 'local-report' };
      },
    });
  const delayed = await run();
  assert.equal(delayed.status, 'pending');
  assert.match(delayed.error, /receipt/i);
  assert.equal(messages.length, 0);
  assert.deepEqual(await f.store.evidence.list(`reports/${trip.id}-return-`), []);
  available = true;
  assert.equal((await run()).status, 'accepted');
  const attached = messages[0].attachments[0].content;
  assert.ok(
    attached.includes(expectedImage),
    'recovered receipt JPEG is embedded in the official PDF',
  );
  assert.deepEqual(
    await createReport({ store: f.store, tripId: trip.id, stage: 'return' }),
    attached,
  );
});

test('a skipped retry preserves the prior delivery confirmation requirement', async (t) => {
  const f = await fixture(t);
  const recipient = 'assistant@example.test';
  const set = async (recipients) =>
    assert.equal(
      (
        await f.a.request('/admin/settings', {
          method: 'PATCH',
          body: { notificationRecipients: recipients, reason: 'Change authorized assistants' },
        })
      ).status,
      200,
    );
  await set([recipient]);
  const trip = (await f.checkout(f.s, await f.addVehicle())).data.trip;
  const [notice] = await f.store.listNotifications(trip.id);
  const run = () =>
    processNotification({
      store: f.store,
      notificationId: notice.id,
      report: async () => Buffer.from('%PDF'),
      send: async () => ({ accepted: true, id: 'first-delivery' }),
    });
  const retry = (body) =>
    f.a.request(`/admin/notifications/${notice.id}/retry`, { method: 'POST', body });
  assert.equal((await run()).status, 'accepted');
  assert.equal(
    (await retry({ resend: true, reason: 'Authorized duplicate form copy' })).status,
    200,
  );
  await set([]);
  assert.equal((await run()).status, 'skipped');
  await set([recipient]);
  const record = (await f.a.request('/admin/overview')).data.notifications.find(
    (n) => n.id === notice.id,
  );
  assert.equal(record.requiresResendConfirmation, true);
  assert.equal(record.deliveries[0].status, 'skipped');
  assert.equal((await retry({})).status, 400);
  assert.equal((await retry({ recipient })).status, 400);
});
