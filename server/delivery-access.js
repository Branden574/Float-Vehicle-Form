import express from 'express';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { Webhook } from 'standardwebhooks';
import { rateLimitStore } from './rate-limits.js';
import { createEmailSender } from './notifications.js';
import { createReport } from './reports.js';
import { reportFilename } from './report-filename.js';
import { fail } from './validation.js';

const states = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
  'email.delivery_delayed': 'delayed',
};
const weight = { delayed: 1, delivered: 2, bounced: 3, suppressed: 3, failed: 3 };
const same = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a, 'ascii'), Buffer.from(b, 'ascii'));

export function installDeliveryWebhook(app, store, options) {
  app.post(
    '/api/hooks/resend',
    express.raw({ type: 'application/json', limit: '128kb' }),
    async (req, res) => {
      const secret = options.resendWebhookSecret || process.env.RESEND_WEBHOOK_SECRET;
      if (!secret) fail(503, 'Delivery webhook is not configured.');
      let event;
      try {
        event = new Webhook(secret).verify(req.body, {
          'webhook-id': req.get('svix-id'),
          'webhook-timestamp': req.get('svix-timestamp'),
          'webhook-signature': req.get('svix-signature'),
        });
      } catch {
        fail(401, 'Invalid webhook signature.');
      }
      const state = states[event.type];
      if (!state) return res.sendStatus(204);
      const { email_id: providerId, to, tags } = event.data || {};
      if (Array.isArray(to) && to.length !== 1) return res.sendStatus(204);
      if (
        !providerId ||
        !Array.isArray(to) ||
        typeof to[0] !== 'string' ||
        !Number.isFinite(Date.parse(event.created_at))
      )
        fail(400, 'Invalid email event.');
      const at = new Date(event.created_at).toISOString();
      const recipientKey = store.emailLookup(to[0]);
      const db = store.db;
      await db.transaction(async () => {
        let row = tags?.fleet_delivery
          ? await db
              .prepare('SELECT * FROM notification_deliveries WHERE id=? AND recipient_key=?')
              .get(tags.fleet_delivery, recipientKey)
          : await db
              .prepare(
                'SELECT * FROM notification_deliveries WHERE provider_id=? AND recipient_key=?',
              )
              .get(providerId, recipientKey);
        if (!row && !tags?.fleet_delivery) {
          // A previously sent group message can still receive a signed per-recipient event.
          const old = await db
            .prepare('SELECT * FROM notifications WHERE provider_id=?')
            .get(providerId);
          if (
            !old ||
            !store
              .decodeJSON(old.recipients_json)
              .some((email) => store.emailLookup(email) === recipientKey)
          )
            return;
          await db
            .prepare(
              "INSERT OR IGNORE INTO notification_deliveries(id,notification_id,recipient_key,recipient_json,attempt,status,provider_id,updated_at) VALUES(?,?,?,?,?,'accepted',?,?)",
            )
            .run(
              randomUUID(),
              old.id,
              recipientKey,
              store.encodeJSON(to[0]),
              old.attempts,
              providerId,
              at,
            );
          row = await db
            .prepare(
              'SELECT * FROM notification_deliveries WHERE provider_id=? AND recipient_key=?',
            )
            .get(providerId, recipientKey);
        }
        if (!row || (row.provider_id && row.provider_id !== providerId)) return;
        if (
          row.event_at &&
          (at < row.event_at ||
            weight[state] < weight[row.status] ||
            (at === row.event_at && weight[state] <= weight[row.status]))
        )
          return;
        await db
          .prepare(
            'UPDATE notification_deliveries SET status=?,provider_id=?,event_at=?,updated_at=? WHERE id=?',
          )
          .run(state, providerId, at, at, row.id);
      })();
      res.sendStatus(204);
    },
  );
}

export async function deliveryHistory(store) {
  const notices = await store.listNotifications();
  const byId = new Map(notices.map((n) => [n.id, n]));
  const rows = await store.db
    .prepare('SELECT * FROM notification_deliveries ORDER BY attempt DESC')
    .all();
  const seen = new Set();
  const lastDispatch = new Set();
  for (const row of rows) {
    const key = row.notification_id + ':' + row.recipient_key;
    const notice = byId.get(row.notification_id);
    if (!notice) continue;
    if (row.status !== 'skipped' && !lastDispatch.has(key)) {
      lastDispatch.add(key);
      if (!['failed', 'bounced', 'suppressed'].includes(row.status))
        notice.requiresResendConfirmation = true;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    (notice.deliveries ||= []).push({
      email: store.decodeJSON(row.recipient_json),
      status: row.status === 'sending' && notice.status === 'unknown' ? 'unknown' : row.status,
      updatedAt: row.updated_at,
      viaLink: Boolean(row.link_expires_at),
    });
  }
  return notices;
}

export function installReportCopies(app, store, options) {
  const db = store.db;
  const limit = rateLimit({
    windowMs: 10 * 60000,
    limit: 40,
    store: rateLimitStore(db, 'report-verification'),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  app.use('/api/report-copy', limit, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  async function access(token) {
    const invalid = () =>
      fail(
        403,
        'This private report link is unavailable. Ask your fleet administrator for a new copy.',
      );
    if (typeof token !== 'string' || !/^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(token)) invalid();
    const [id, secret] = token.split('.');
    if (!same(secret, store.emailLookup('report-copy:' + id))) invalid();
    const grant = await db.prepare('SELECT * FROM notification_deliveries WHERE id=?').get(id);
    if (!grant?.link_expires_at || Date.parse(grant.link_expires_at) <= Date.now()) invalid();
    const notice = await db
      .prepare('SELECT * FROM notifications WHERE id=?')
      .get(grant.notification_id);
    const trip = notice && (await store.getTrip(notice.trip_id));
    if (
      !trip ||
      !['checkout', 'return'].includes(notice.stage) ||
      (notice.stage === 'checkout' && trip.returnedAt)
    )
      invalid();
    const allowed = await store.getNotificationRecipients(trip, notice.stage);
    if (!allowed.some((email) => store.emailLookup(email) === grant.recipient_key)) invalid();
    return { grant, trip, notice };
  }
  app.post('/api/report-copy/request-code', async (req, res) => {
    const code = String(randomInt(1000000)).padStart(6, '0');
    const grant = await db.transaction(async () => {
      const { grant } = await access(req.body?.token);
      if (Date.parse(grant.code_requested_at) > Date.now() - 60000)
        fail(429, 'Wait one minute before requesting another code.');
      await db
        .prepare(
          'UPDATE notification_deliveries SET code_hash=?,code_requested_at=?,code_attempts=0 WHERE id=?',
        )
        .run(
          store.emailLookup(`report-code:${grant.id}:${code}`),
          new Date().toISOString(),
          grant.id,
        );
      return grant;
    })();
    const send = options.sendReportCode || createEmailSender();
    try {
      const result = await send({
        to: [store.decodeJSON(grant.recipient_json)],
        subject: 'Your Fleet Checkout private report code',
        text: `Use code ${code} to download the private report you requested. The code expires in 10 minutes and works once.`,
        messageId: `<report-code-${randomUUID()}@fleet.local>`,
        attachments: [],
      });
      if (!result?.accepted) throw new Error();
    } catch {
      await db
        .prepare(
          'UPDATE notification_deliveries SET code_hash=NULL,code_requested_at=NULL WHERE id=? AND code_hash=?',
        )
        .run(grant.id, store.emailLookup(`report-code:${grant.id}:${code}`));
      fail(503, 'The verification email could not be sent. Try again.');
    }
    res.json({ sent: true });
  });
  app.post('/api/report-copy/download', async (req, res) => {
    if (typeof req.body?.code !== 'string' || !/^\d{6}$/.test(req.body.code))
      fail(400, 'Enter the six-digit email code.');
    const allowed = await db.transaction(async () => {
      const data = await access(req.body.token);
      const { grant } = data;
      if (
        !grant.code_hash ||
        grant.code_attempts >= 5 ||
        Date.parse(grant.code_requested_at) <= Date.now() - 600000
      )
        return null;
      await db
        .prepare('UPDATE notification_deliveries SET code_attempts=code_attempts+1 WHERE id=?')
        .run(grant.id);
      if (!same(grant.code_hash, store.emailLookup(`report-code:${grant.id}:${req.body.code}`)))
        return null;
      await db
        .prepare('UPDATE notification_deliveries SET code_hash=NULL WHERE id=?')
        .run(grant.id);
      return data;
    })();
    if (!allowed) fail(403, 'Incorrect or expired code. Request a new code.');
    const { trip, notice } = allowed;
    const report = await (options.reportService || createReport)({
      store,
      tripId: trip.id,
      stage: notice.stage,
      download: true,
    });
    await access(req.body.token);
    if (typeof report === 'string') return res.json({ url: report });
    res.attachment(reportFilename(trip, notice.stage)).type('application/pdf').send(report);
  });
}
