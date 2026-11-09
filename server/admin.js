import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import {
  fail,
  validate,
  vehicleSchema,
  userSchema,
  settingsSchema,
  reasonSchema,
} from './validation.js';
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
      users: (await db.prepare('SELECT * FROM users ORDER BY name').all())
        .map(store.publicUser)
        .sort((a, b) => a.name.localeCompare(b.name)),
      vehicles: (await db.prepare('SELECT * FROM vehicles ORDER BY archived,name').all()).map(
        store.mapVehicle,
      ),
      notifications: await store.listNotifications(),
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
          latestTrip.returnReviewMode === 'representative' &&
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
        const { reason: _reason, ...changes } = req.body,
          { id: _id, ...current } = before;
        const data = validate(userSchema.strict(), { ...current, ...changes });
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
        // Immediately revoke sessions on access changes, including driver authorization.
        if (
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
          .prepare('UPDATE users SET invite_hash=?,invite_expires_at=? WHERE id=?')
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
    const reason = validate(reasonSchema, req.body.reason),
      { reason: _reason, ...changes } = req.body;
    const before = await store.getSettings(),
      settings = validate(settingsSchema.strict(), { ...before, ...changes });
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
          row.stage === 'checkout'
            ? signedTrip.status === 'pending_checkout'
            : signedTrip.returnReviewMode === 'representative' &&
              !(await store.getReviews(row.trip_id)).some((review) => review.stage === 'return');
        if (needsSignature)
          fail(409, 'Complete the required representative signature before sending this report.');
        const resend = ['accepted', 'delivered', 'unknown'].includes(row.status);
        if (resend && (req.body.resend !== true || !req.body.reason))
          fail(400, 'Review provider records, then request an explicit resend with a reason.');
        const reason = resend
          ? validate(reasonSchema, req.body.reason)
          : 'Administrator retried a failed notification';
        const settings = await store.getSettings(),
          trip = await store.getTrip(row.trip_id),
          recipients = [...settings.notificationRecipients];
        if (settings.employeeCopy) recipients.push(trip.employeeSnapshot.email);
        if (!recipients.length) fail(400, 'Configure notification recipients before retrying.');
        await db
          .prepare(
            "UPDATE notifications SET status='pending',error=NULL,updated_at=?,recipients_json=?,message_id=?,accepted_at=NULL,delivered_at=NULL,provider_id=NULL WHERE id=?",
          )
          .run(
            now(),
            store.encodeJSON([...new Set(recipients)]),
            resend ? `<fleet-${randomUUID()}@fleet.local>` : row.message_id,
            row.id,
          );
        await store.audit(
          req.user.id,
          resend ? 'resend_notification' : 'retry_notification',
          'notification',
          row.id,
          { status: row.status },
          { status: 'pending', recipients },
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
