import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { createReport } from './reports.js';

const time = () => new Date().toISOString();
const safeError = (error) =>
  String(error.message || 'Email processing failed')
    .replace(/\b(?:smtp|https?):\/\/[^\s]+/gi, '[provider]')
    .slice(0, 700);

/** Provider acceptance is recorded separately from confirmed delivery. */
export function createEmailSender(env = process.env) {
  const provider = env.EMAIL_PROVIDER || 'disabled';
  if (provider === 'disabled')
    return async () => {
      throw Object.assign(
        new Error(
          'Email is not configured. Set an approved sender and email provider, then retry.',
        ),
        { definiteFailure: true },
      );
    };
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is required when email is enabled');
  if (provider === 'smtp') {
    if (!env.SMTP_HOST) throw new Error('SMTP_HOST is required');
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === 'true',
      requireTLS: true,
      tls: { rejectUnauthorized: true },
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    return async (message) => {
      try {
        const result = await transport.sendMail({ ...message, from: env.EMAIL_FROM });
        if (result.rejected?.length) {
          const error = new Error(
            `SMTP partially accepted recipients (${result.accepted.length} accepted, ${result.rejected.length} rejected). Review the provider before resending.`,
          );
          error.definiteFailure = false;
          throw error;
        }
        return { id: result.messageId, accepted: true };
      } catch (error) {
        if (['EAUTH', 'ECONNECTION', 'ENOTFOUND', 'EENVELOPE', 'EENOTSUP'].includes(error.code))
          error.definiteFailure = true;
        if (error.responseCode >= 400 && error.responseCode < 600) error.definiteFailure = true;
        throw error;
      }
    };
  }
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required');
    return async (message) => {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': createHash('sha256').update(message.messageId).digest('hex'),
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: message.to,
          subject: message.subject,
          text: message.text,
          attachments: message.attachments.map((a) => ({
            filename: a.filename,
            content: a.content.toString('base64'),
          })),
        }),
      });
      if (!response.ok) {
        // 4xx means provider rejected this request; a timeout/5xx is ambiguous.
        throw Object.assign(
          new Error(
            `Email provider returned HTTP ${response.status}; review configuration or quota and retry.`,
          ),
          { definiteFailure: response.status < 500 },
        );
      }
      const result = await response.json();
      return { id: result.id, accepted: true };
    };
  }
  throw new Error('EMAIL_PROVIDER must be disabled, smtp, or resend');
}

export async function processNotification({ store, notificationId, send, report = createReport }) {
  const { db } = store;
  const claimed = db
    .prepare(
      "UPDATE notifications SET status='processing',attempts=attempts+1,updated_at=?,error=NULL WHERE id=? AND status='pending'",
    )
    .run(time(), notificationId);
  if (!claimed.changes)
    return store.mapNotification(
      db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId),
    );
  let attemptingDelivery = false;
  try {
    const row = db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId);
    const recipients = JSON.parse(row.recipients_json);
    const pdf = await report({ store, tripId: row.trip_id, stage: row.stage });
    if (!recipients.length)
      throw Object.assign(
        new Error('No notification recipient configured. Add recipients and retry.'),
        { definiteFailure: true },
      );
    if (pdf.length > 20 * 1024 * 1024)
      throw Object.assign(
        new Error(
          'Report exceeds the 20 MB attachment safety limit. Download the report and review sending limits with IT.',
        ),
        { definiteFailure: true },
      );
    const trip = store.getTrip(row.trip_id);
    const settings = trip.checkoutSettings || store.getSettings();
    const label = row.stage === 'checkout' ? 'Vehicle checkout' : 'Vehicle checkout and check-in';
    const message = {
      to: recipients,
      messageId: row.message_id,
      subject: `${settings.appName} | ${label} | ${trip.id}`,
      text: `${label}\nTrip: ${trip.id}\nEmployee: ${trip.employeeSnapshot.name}\nVehicle: ${trip.vehicleSnapshot.name}\n\nThe attached report includes the signed inspection${row.stage === 'return' ? 's, checkout and return sections,' : ','} and a labeled condition photo appendix. Representative review may still be pending; check the report. This message contains private workplace records.\n\nEmail acceptance does not confirm delivery.`,
      attachments: [
        {
          filename: `fleet-${trip.id}-${row.stage}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
    };
    attemptingDelivery = true;
    const result = await send(message);
    if (!result?.accepted)
      throw new Error('Provider did not confirm acceptance. Review the provider before resending.');
    db.prepare(
      "UPDATE notifications SET status='accepted',provider_id=?,accepted_at=?,updated_at=?,error=NULL WHERE id=?",
    ).run(result.id || row.message_id, time(), time(), notificationId);
  } catch (error) {
    const status = !attemptingDelivery || error.definiteFailure ? 'failed' : 'unknown';
    db.prepare('UPDATE notifications SET status=?,error=?,updated_at=? WHERE id=?').run(
      status,
      safeError(error),
      time(),
      notificationId,
    );
  }
  return store.mapNotification(
    db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId),
  );
}

export function startNotificationWorker({ store, send, intervalMs = 15_000 }) {
  let busy = false;
  let closed = false;
  const generated = new Set();
  const run = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      // A process that died during an SMTP send cannot safely retry blindly.
      store.db
        .prepare(
          "UPDATE notifications SET status='unknown',error='Interrupted send. Check the provider before an explicit resend.',updated_at=? WHERE status='processing' AND updated_at<?",
        )
        .run(time(), new Date(Date.now() - 15 * 60_000).toISOString());
      const rows = store.db
        .prepare(
          "SELECT * FROM notifications WHERE status IN ('pending','failed') ORDER BY created_at LIMIT 100",
        )
        .all();
      for (const row of rows) {
        if (closed) break;
        // Retain completed PDFs even when mail has no configured recipient.
        if (!generated.has(row.id)) {
          try {
            await createReport({ store, tripId: row.trip_id, stage: row.stage });
            generated.add(row.id);
          } catch (error) {
            store.db
              .prepare('UPDATE notifications SET error=?,updated_at=? WHERE id=?')
              .run(`Report generation failed: ${safeError(error)}`, time(), row.id);
          }
        }
        if (row.status === 'pending')
          await processNotification({ store, notificationId: row.id, send });
      }
    } finally {
      busy = false;
    }
  };
  const interval = setInterval(() => {
    run().catch((error) => process.stderr.write(`Notification worker: ${safeError(error)}\n`));
  }, intervalMs);
  interval.unref();
  run().catch((error) => process.stderr.write(`Notification worker: ${safeError(error)}\n`));
  return {
    run,
    stop: () => {
      closed = true;
      clearInterval(interval);
    },
  };
}
