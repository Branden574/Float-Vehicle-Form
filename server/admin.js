import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { deliveryHistory } from './delivery-access.js';
import { requireAdmin } from './auth.js';
import {
  fail,
  validate,
  vehicleSchema,
  userSchema,
  settingsSchema,
  reasonSchema,
} from './validation.js';
import { inspectionReferralIds } from './vehicle-inspections.js';
import { hash, now } from './store.js';

function diskUsage(directory) {
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += diskUsage(file);
    else if (entry.isFile()) bytes += statSync(file).size;
  }
  return bytes;
}
const csv = (value) => {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export function installAdmin(app, store, { notificationService } = {}) {
  const { db } = store;
  app.use('/api/admin', requireAdmin);
  app.get('/api/admin/overview', async (req, res) => {
    res.json({
      users: (
        await db
          .prepare("SELECT * FROM users WHERE email <> 'deleted-system-actor' ORDER BY name")
          .all()
      )
        .map(store.publicUser)
        .sort((a, b) => a.name.localeCompare(b.name)),
      vehicles: (await db.prepare('SELECT * FROM vehicles ORDER BY archived,name').all()).map(
        store.mapVehicle,
      ),
      inspectionReferralVehicleIds: await inspectionReferralIds(db),
      notifications: await deliveryHistory(store),
      settings: await store.getSettings(),
      storage: {
        bytes: diskUsage(store.dataDir),
        photoBytes: (await db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM photos').get())
          .bytes,
        limitBytes: (await store.getSettings()).storageLimitBytes,
      },
      audit: await Promise.all(
        (
          await db.prepare('SELECT audit.* FROM audit ORDER BY created_at DESC LIMIT 500').all()
        ).map(async (r) => ({
          id: r.id,
          actorId: r.actor_id,
          actorName: (await store.getUser(r.actor_id))?.name || r.actor_id,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          before: r.before_json ? store.decodeJSON(r.before_json) : null,
          after: r.after_json ? store.decodeJSON(r.after_json) : null,
          reason: r.reason,
          createdAt: r.created_at,
        })),
      ),
    });
  });
  app.post('/api/admin/vehicles', async (req, res) => {
    const data = validate(vehicleSchema.strict(), req.body);
    const id = randomUUID(),
      time = now();
    await db
      .transaction(async () => {
        await db
          .prepare(
            'INSERT INTO vehicles(id,name,make,model,year,plate,vin_last4,site,current_mileage,status,photo_url,notes,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            data.name,
            data.make,
            data.model,
            data.year,
            data.plate,
            data.vinLast4,
            data.site,
            data.currentMileage,
            data.status,
            data.photoUrl,
            data.notes,
            +data.archived,
            time,
            time,
          );
        await store.audit(
          req.user.id,
          'create_vehicle',
          'vehicle',
          id,
          null,
          await store.getVehicle(id),
          'Administrator created vehicle master record',
        );
      })
      .immediate();
    res.status(201).json({ vehicle: await store.getVehicle(id) });
  });
  app.post('/api/admin/vehicles/:id/physical-inspection', async (req, res) => {
    const { reason } = validate(z.object({ reason: reasonSchema }).strict(), req.body);
    await db.transaction(async () => {
      const vehicleId = req.params.id;
      if (!(await inspectionReferralIds(db)).includes(vehicleId))
        fail(
          409,
          'This vehicle has an existing review, an active trip, or no eligible hold. Refresh the fleet.',
        );
      await db
        .prepare('INSERT INTO vehicle_inspections(id,vehicle_id) VALUES(?,?)')
        .run(randomUUID(), vehicleId);
      await store.audit(
        req.user.id,
        'request_physical_vehicle_inspection',
        'vehicle',
        vehicleId,
        null,
        { status: 'pending_review' },
        reason,
      );
    })();
    res.status(201).json({ ok: true });
  });
  app.patch('/api/admin/vehicles/:id', async (req, res) => {
    const reason = validate(reasonSchema, req.body.reason);
    const result = await db
      .transaction(async () => {
        const before = await store.getVehicle(req.params.id);
        if (!before) fail(404, 'Vehicle not found.');
        const {
          reason: _reason,
          odometerReplacement = false,
          mileageVersion: _ignoredVersion,
          ...changes
        } = req.body;
        const { id: _id, mileageVersion: _version, ...current } = before;
        // Checked-out state is exclusively controlled by trip transactions.
        const data = validate(
          vehicleSchema
            .extend({
              status: z.enum(['available', 'checked_out', 'pending_review', 'out_of_service']),
            })
            .strict(),
          { ...current, ...changes },
        );
        const open = await db
          .prepare(
            "SELECT id FROM trips WHERE vehicle_id=? AND status IN ('active','pending_checkout')",
          )
          .get(before.id);
        if (
          open &&
          (data.currentMileage !== before.currentMileage ||
            data.status !== before.status ||
            data.archived)
        )
          fail(
            409,
            'Complete or review the open trip before changing mileage, availability, or archiving.',
          );
        if (
          (data.status !== before.status || (data.archived && !before.archived)) &&
          (await db.prepare('SELECT 1 FROM vehicle_inspections WHERE vehicle_id=?').get(before.id))
        )
          fail(
            409,
            'An assigned reviewer must complete the physical inspection before changing availability or archiving.',
          );
        const latestTrip = await store.mapTrip(
          await db
            .prepare(
              'SELECT * FROM trips WHERE vehicle_id=? ORDER BY vehicle_mileage_version DESC,checkout_at DESC,id DESC LIMIT 1',
            )
            .get(before.id),
        );
        if (
          data.status === 'available' &&
          latestTrip?.status === 'returned' &&
          (latestTrip.returnReviewMode === 'representative' ||
            (await store.getSettings()).returnReviewerEmails.length > 0) &&
          !(await store.getReviews(latestTrip.id)).some((r) => r.stage === 'return')
        )
          fail(409, 'Complete the representative return signature before releasing this vehicle.');
        if (!open && data.status === 'checked_out')
          fail(400, 'Checked-out status can only be set by a checkout.');
        if (data.currentMileage < before.currentMileage && odometerReplacement !== true)
          fail(
            400,
            'A lower vehicle reading requires an explicit odometer replacement exception and reason.',
          );
        if (
          data.status === 'available' &&
          (await db
            .prepare(
              'SELECT 1 FROM revisions r JOIN trips t ON r.trip_id=t.id WHERE t.vehicle_id=? AND r.affects_current=1 AND r.acknowledged_at IS NULL',
            )
            .get(before.id))
        )
          fail(
            409,
            'The employee must acknowledge the pending mileage correction before the vehicle is released.',
          );
        await db
          .prepare(
            'UPDATE vehicles SET name=?,make=?,model=?,year=?,plate=?,vin_last4=?,site=?,current_mileage=?,status=?,photo_url=?,notes=?,archived=?,mileage_version=mileage_version+?,updated_at=? WHERE id=?',
          )
          .run(
            data.name,
            data.make,
            data.model,
            data.year,
            data.plate,
            data.vinLast4,
            data.site,
            data.currentMileage,
            data.status,
            data.photoUrl,
            data.notes,
            +data.archived,
            +(data.currentMileage !== before.currentMileage),
            now(),
            before.id,
          );
        await store.audit(
          req.user.id,
          'update_vehicle',
          'vehicle',
          before.id,
          before,
          { ...(await store.getVehicle(before.id)), odometerReplacement },
          reason,
        );
        return await store.getVehicle(before.id);
      })
      .immediate();
    res.json({ vehicle: result });
  });
  app.post('/api/admin/staff-approvals', async (req, res) => {
    const { email } = validate(
      z.object({ email: z.string().trim().pipe(z.email().max(254)) }).strict(),
      req.body,
    );
    const user = await db.transaction(async () => {
      const previous = await db
        .prepare('SELECT * FROM users WHERE email=?')
        .get(store.emailLookup(email));
      if (previous && !previous.active)
        fail(409, 'This account is inactive. Edit staff access to reactivate it first.');
      if (previous?.staff_approved) return store.publicUser(previous);
      let user;
      if (previous) {
        await db.prepare('UPDATE users SET staff_approved=1 WHERE id=?').run(previous.id);
        user = await store.getUser(previous.id);
      } else {
        user = await store.createUser({ email, name: '', staffApproved: true });
      }
      await store.audit(
        req.user.id,
        'approve_staff_email',
        'user',
        user.id,
        null,
        { email: user.email },
        'Administrator approved staff email for fleet access',
      );
      return user;
    })();
    res.json({ user });
  });
  app.post('/api/admin/users', async (req, res) => {
    const data = validate(userSchema.strict(), req.body),
      inviteToken = randomBytes(32).toString('hex');
    const user = await db
      .transaction(async () => {
        const user = await store.createUser({ ...data, inviteToken });
        await store.audit(
          req.user.id,
          'invite_user',
          'user',
          user.id,
          null,
          user,
          'Administrator invited individual staff account',
        );
        return user;
      })
      .immediate();
    res.status(201).json({ user, inviteToken });
  });
  app.patch('/api/admin/users/:id', async (req, res) => {
    const reason = validate(reasonSchema, req.body.reason);
    const user = await db
      .transaction(async () => {
        const before = await store.getUser(req.params.id);
        if (!before) fail(404, 'Staff member not found.');
        const { reason: _reason, staffApproved: requestedApproval, ...changes } = req.body,
          { id: _id, staffApproved, ...current } = before;
        const approval = validate(z.boolean().optional(), requestedApproval);
        // Access edits can precede first sign-in, when the employee fills in their name.
        const schema = before.name
          ? userSchema
          : userSchema.extend({ name: z.string().trim().max(200) });
        const data = validate(schema.strict(), { ...current, ...changes });
        if (before.id === req.user.id && (!data.active || data.role !== 'admin'))
          fail(400, 'Another administrator must change your administrator access.');
        if (
          before.role === 'admin' &&
          before.active &&
          (!data.active || data.role !== 'admin') &&
          (
            await db
              .prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1")
              .get()
          ).count <= 1
        )
          fail(409, 'Keep at least one active administrator.');
        await store.updateUser(before.id, data);
        if (approval === false && (data.authorizedDriver || data.role === 'admin'))
          fail(400, 'Remove driver and administrator privileges before removing staff approval.');
        const nextApproval =
          approval ?? (staffApproved || data.authorizedDriver || data.role === 'admin');
        if (nextApproval !== staffApproved)
          await db
            .prepare('UPDATE users SET staff_approved=? WHERE id=?')
            .run(+nextApproval, before.id);
        // Immediately revoke sessions on access changes, including driver authorization.
        if (
          nextApproval !== staffApproved ||
          data.email.trim().toLowerCase() !== before.email ||
          data.role !== before.role ||
          data.active !== before.active ||
          data.authorizedDriver !== before.authorizedDriver
        )
          await db.prepare('DELETE FROM sessions WHERE user_id=?').run(before.id);
        const after = await store.getUser(before.id);
        await store.audit(req.user.id, 'update_user', 'user', before.id, before, after, reason);
        return after;
      })
      .immediate();
    res.json({ user });
  });
  app.post('/api/admin/users/:id/invite', async (req, res) => {
    const reason = validate(reasonSchema, req.body.reason),
      user = await store.getUser(req.params.id);
    if (!user || !user.active) fail(404, 'Active staff member not found.');
    const inviteToken = randomBytes(32).toString('hex');
    await db
      .transaction(async () => {
        await db
          .prepare('UPDATE users SET staff_approved=1,invite_hash=?,invite_expires_at=? WHERE id=?')
          .run(hash(inviteToken), new Date(Date.now() + 72 * 3600000).toISOString(), user.id);
        await db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        await store.audit(
          req.user.id,
          'renew_invitation',
          'user',
          user.id,
          null,
          { invitationExpiresInHours: 72 },
          reason,
        );
      })
      .immediate();
    res.json({ user, inviteToken });
  });
  app.patch('/api/admin/settings', async (req, res) => {
    if (
      process.env.RETENTION_ENABLED === 'true' &&
      req.body.retentionDays !== undefined &&
      req.body.retentionDays !== 60
    )
      fail(400, 'The published retention policy is 60 days.');
    const reason = validate(reasonSchema, req.body.reason),
      { reason: _reason, ...changes } = req.body;
    const before = await store.getSettings(),
      settings = validate(settingsSchema.strict(), { ...before, ...changes });
    settings.reservationManagerEmails = [
      ...new Set(settings.reservationManagerEmails.map((email) => email.trim().toLowerCase())),
    ];
    settings.returnReviewerEmails = [
      ...new Set(settings.returnReviewerEmails.map((email) => email.trim().toLowerCase())),
    ];
    for (const email of settings.reservationManagerEmails) {
      if (before.reservationManagerEmails?.includes(email)) continue;
      const account = await db
        .prepare('SELECT * FROM users WHERE email=?')
        .get(store.emailLookup(email));
      if (
        !account?.active ||
        !(
          account.staff_approved ||
          account.role === 'admin' ||
          settings.returnReviewerEmails.includes(email)
        )
      )
        fail(400, 'Reservation managers must be active, approved fleet staff.');
    }
    settings.requiredPhotoViews = [
      ...new Set(['front', 'rear', 'driver', 'passenger', ...(settings.requiredPhotoViews || [])]),
    ];
    await db
      .transaction(async () => {
        await db
          .prepare('UPDATE settings SET data_json=? WHERE id=1')
          .run(store.encodeJSON(settings));
        await store.audit(
          req.user.id,
          'update_settings',
          'settings',
          '1',
          before,
          settings,
          reason,
        );
      })
      .immediate();
    res.json({ settings });
  });
  app.post('/api/admin/notifications/:id/retry', async (req, res) => {
    const notification = await db
      .transaction(async () => {
        const row = await db.prepare('SELECT * FROM notifications WHERE id=?').get(req.params.id);
        if (!row) fail(404, 'Notification not found.');
        if (['processing', 'pending', 'awaiting_review'].includes(row.status))
          fail(409, 'This notification is already queued or sending.');
        const signedTrip = await store.getTrip(row.trip_id);
        const needsSignature =
          row.stage === 'return_review'
            ? false
            : row.stage === 'checkout'
              ? signedTrip.status === 'pending_checkout'
              : signedTrip.returnReviewMode === 'representative' &&
                !(await store.getReviews(row.trip_id)).some((review) => review.stage === 'return');
        if (needsSignature)
          fail(409, 'Complete the required representative signature before sending this report.');
        const target =
          req.body.recipient === undefined
            ? null
            : validate(z.email(), req.body.recipient).toLowerCase();
        const delivery =
          target &&
          (await db
            .prepare(
              `SELECT status FROM notification_deliveries WHERE notification_id=? AND recipient_key=?
               ORDER BY CASE WHEN status='skipped' THEN 1 ELSE 0 END, attempt DESC LIMIT 1`,
            )
            .get(row.id, store.emailLookup(target)));
        if (target && !delivery) fail(404, 'Recipient delivery not found.');
        const possiblePriorSend = target
          ? !['bounced', 'failed', 'suppressed', 'skipped'].includes(delivery.status)
          : await db
              .prepare(
                `SELECT 1 FROM notification_deliveries d WHERE notification_id=?
            AND status NOT IN ('bounced','failed','suppressed','skipped')
            AND NOT EXISTS (SELECT 1 FROM notification_deliveries newer
              WHERE newer.notification_id=d.notification_id AND newer.recipient_key=d.recipient_key
                AND newer.status<>'skipped' AND newer.attempt>d.attempt)
            LIMIT 1`,
              )
              .get(row.id);
        const resend =
          Boolean(possiblePriorSend) ||
          (!target && ['accepted', 'delivered', 'unknown'].includes(row.status));
        if (resend && (req.body.resend !== true || !req.body.reason))
          fail(400, 'Review provider records, then request an explicit resend with a reason.');
        const reason = resend
          ? validate(reasonSchema, req.body.reason)
          : 'Administrator retried a failed notification';
        const recipients = await store.getNotificationRecipients(signedTrip, row.stage);
        const sendTo = target
          ? recipients.filter((email) => email.toLowerCase() === target)
          : recipients;
        if (!sendTo.length) fail(400, 'Configure this notification recipient before retrying.');
        await db
          .prepare(
            "UPDATE notifications SET status='pending',error=NULL,updated_at=?,recipients_json=?,message_id=?,accepted_at=NULL,delivered_at=NULL,provider_id=NULL WHERE id=?",
          )
          .run(
            now(),
            store.encodeJSON([...new Set(sendTo)]),
            resend ? `<fleet-${randomUUID()}@fleet.local>` : row.message_id,
            row.id,
          );
        await store.audit(
          req.user.id,
          resend ? 'resend_notification' : 'retry_notification',
          'notification',
          row.id,
          { status: row.status },
          { status: 'pending', recipients: sendTo },
          reason,
        );
        return store.mapNotification(
          await db.prepare('SELECT * FROM notifications WHERE id=?').get(row.id),
        );
      })
      .immediate();
    if (notificationService) await notificationService({ store, notificationId: notification.id });
    res.json({
      notification: store.mapNotification(
        await db.prepare('SELECT * FROM notifications WHERE id=?').get(notification.id),
      ),
    });
  });
  app.get('/api/admin/export.csv', async (req, res) => {
    const rows = [
      [
        'Trip ID',
        'Vehicle ID',
        'Vehicle',
        'Plate',
        'Employee',
        'Department',
        'Checkout',
        'Projected return',
        'Physical return',
        'Status',
        'Starting miles',
        'Ending miles',
        'Trip miles',
        'Flags',
      ],
    ];
    for (const raw of await db.prepare('SELECT * FROM trips ORDER BY checkout_at DESC').all()) {
      const t = await store.mapTrip(raw);
      rows.push([
        t.id,
        t.vehicleId,
        t.vehicleSnapshot.name,
        t.vehicleSnapshot.plate,
        t.employeeSnapshot.name,
        t.employeeSnapshot.department,
        t.checkoutAt,
        t.projectedReturnAt,
        t.returnedAt,
        t.status,
        t.startingMileage,
        t.endingMileage,
        t.tripMileage,
        t.flags.join('; '),
      ]);
    }
    res
      .type('text/csv')
      .set('Content-Disposition', 'attachment; filename="fleet-trips.csv"')
      .send('\uFEFF' + rows.map((row) => row.map(csv).join(',')).join('\r\n'));
  });
}
