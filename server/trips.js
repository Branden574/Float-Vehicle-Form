import { mayReviewReturns } from './reviewers.js';
import { randomUUID } from 'node:crypto';
import { reportFilename } from './report-filename.js';
import { z } from 'zod';
import { hash, now } from './store.js';
import {
  fail,
  validate,
  mileageSchema,
  inspectionSchema,
  validateSignature,
  checkAcknowledgments,
  inspectionFlags,
  reasonSchema,
} from './validation.js';
import { requireAdmin, requireTripAccess } from './auth.js';
import { validatePhotos } from './photos.js';

const draftSchema = z.string().uuid();
async function idempotency(store, req, operation) {
  const key = req.get('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 200)
    fail(400, 'A submission idempotency key is required. Refresh the form and try again.');
  const digest = hash(JSON.stringify(req.body));
  const previous = await store.db
    .prepare('SELECT * FROM idempotency WHERE user_id=? AND key=?')
    .get(req.user.id, key);
  if (previous && (previous.operation !== operation || previous.request_hash !== digest))
    fail(
      409,
      'This submission key was already used for different information. Review and submit with a new key.',
    );
  return {
    key,
    digest,
    previous: previous ? store.decodeJSON(previous.response_json) : null,
    save: async (response) =>
      await store.db
        .prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?)')
        .run(req.user.id, key, operation, digest, store.encodeJSON(response), now()),
  };
}
const flagUnion = (...arrays) => [...new Set(arrays.flat())];
export function installTrips(app, store, { reportService } = {}) {
  const { db } = store;
  const materialize = async (tripId, stage) => {
    if (reportService) {
      try {
        await reportService({ store, tripId, stage });
      } catch (e) {
        console.error('Report generation pending:', tripId, e.message);
      }
    }
  };
  app.get('/api/vehicles', async (req, res) =>
    res.json({
      vehicles: (
        await db.prepare('SELECT * FROM vehicles WHERE archived=0 ORDER BY name').all()
      ).map(store.mapVehicle),
    }),
  );
  app.get('/api/trips', async (req, res) => {
    const canReviewReturns = mayReviewReturns(req.user, await store.getSettings());
    const rows =
      req.user.role === 'admin'
        ? await db.prepare('SELECT * FROM trips ORDER BY checkout_at DESC').all()
        : canReviewReturns
          ? await db
              .prepare(
                "SELECT * FROM trips WHERE employee_id=? OR status='returned' ORDER BY checkout_at DESC",
              )
              .all(req.user.id)
          : await db
              .prepare('SELECT * FROM trips WHERE employee_id=? ORDER BY checkout_at DESC')
              .all(req.user.id);
    const pending = canReviewReturns
      ? await db
          .prepare(
            "SELECT t.* FROM trips t JOIN vehicles v ON v.id=t.vehicle_id WHERE t.status='returned' AND v.status='pending_review' AND t.employee_id<>? AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.trip_id=t.id AND r.stage='return') AND NOT EXISTS (SELECT 1 FROM trips newer WHERE newer.vehicle_id=t.vehicle_id AND newer.vehicle_mileage_version>t.vehicle_mileage_version) ORDER BY t.returned_at ASC",
          )
          .all(req.user.id)
      : [];
    res.json({
      trips: await Promise.all(rows.map(store.mapTrip)),
      pendingReturns: await Promise.all(pending.map(store.mapTrip)),
      canReviewReturns,
    });
  });
  app.get('/api/trips/:id', async (req, res) => {
    await requireTripAccess(store, req, req.params.id);
    const bundle = await store.getTripBundle(req.params.id);
    bundle.canReviewReturn = mayReviewReturns(req.user, await store.getSettings());
    bundle.reportFilenames = {
      checkout: reportFilename(bundle.trip, 'checkout'),
      ...(bundle.trip.returnedAt ? { return: reportFilename(bundle.trip, 'return') } : {}),
    };
    bundle.photos = bundle.photos.map(store.publicPhoto);
    delete bundle.settings;
    if (req.user.role !== 'admin')
      bundle.notifications = bundle.notifications.map(({ recipients, ...n }) => n);
    res.json(bundle);
  });
  app.post('/api/trips/checkout', async (req, res) => {
    const replay = await idempotency(store, req, 'checkout');
    if (replay.previous) return res.json(replay.previous);
    if (!req.user.authorizedDriver)
      fail(403, 'Your administrator must authorize you as a float-pool driver.');
    const b = validate(
      z
        .object({
          vehicleId: z.string().uuid(),
          draftId: draftSchema,
          projectedReturnAt: z.iso.datetime({ offset: true }),
          startingMileage: mileageSchema,
          mileageConfirmed: z.literal(true),
          inspection: inspectionSchema,
          photoIds: z.array(z.string().uuid()).min(4).max(30),
          signature: z.string(),
          acknowledgments: z.record(z.string(), z.boolean()),
        })
        .strict(),
      req.body,
    );
    if (
      Date.parse(b.projectedReturnAt) <= Date.now() ||
      Date.parse(b.projectedReturnAt) > Date.now() + 366 * 86400000
    )
      fail(400, 'Projected return must be in the future and within one year.');
    if (b.inspection.damageScope === 'new') fail(400, 'Checkout must record all observed damage.');
    await validateSignature(b.signature);
    const acknowledgments = checkAcknowledgments(b.acknowledgments, 'checkout');
    const result = await db
      .transaction(async () => {
        const idem = await idempotency(store, req, 'checkout');
        if (idem.previous) return idem.previous;
        const user = await store.getUser(req.user.id);
        if (!user.active || !user.authorizedDriver)
          fail(403, 'Driver authorization is no longer active.');
        if (
          !user.name.trim() ||
          !user.charter?.trim() ||
          !user.department.trim() ||
          !user.manager.trim()
        )
          fail(400, 'Complete your name, charter and manager in My profile before checkout.');
        const vehicle = await store.getVehicle(b.vehicleId);
        if (!vehicle || vehicle.archived) fail(404, 'Vehicle not found.');
        if (vehicle.status !== 'available')
          fail(409, 'This vehicle was just checked out or placed on hold. Choose another vehicle.');
        if (vehicle.currentMileage !== b.startingMileage)
          fail(
            409,
            'The mileage has changed or does not match the accepted reading. Refresh or report a discrepancy.',
          );
        const photos = await validatePhotos(store, {
          ids: b.photoIds,
          employeeId: req.user.id,
          vehicleId: vehicle.id,
          stage: 'checkout',
          draftId: b.draftId,
        });
        const id = randomUUID(),
          time = now(),
          settings = await store.getSettings(),
          flags = inspectionFlags(b.inspection),
          needsReview = settings.reviewMode === 'representative' || flags.length > 0;
        const snapshot = {
          employee: user,
          vehicle,
          inspection: b.inspection,
          signature: b.signature,
          acknowledgments,
          reviewMode: settings.reviewMode,
          settings: {
            appName: settings.appName,
            organizationName: settings.organizationName,
            site: settings.site,
            timezone: settings.timezone,
            logoUrl: settings.logoUrl,
          },
          signedAt: time,
        };
        await db
          .prepare(
            'INSERT INTO trips(id,vehicle_id,employee_id,status,checkout_at,projected_return_at,starting_mileage,vehicle_mileage_version,checkout_json,flags_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            vehicle.id,
            user.id,
            needsReview ? 'pending_checkout' : 'active',
            time,
            b.projectedReturnAt,
            b.startingMileage,
            vehicle.mileageVersion,
            store.encodeJSON(snapshot),
            JSON.stringify(flags),
          );
        const updated = await db
          .prepare("UPDATE vehicles SET status=?,updated_at=? WHERE id=? AND status='available'")
          .run(needsReview ? 'pending_review' : 'checked_out', time, vehicle.id);
        if (updated.changes !== 1) fail(409, 'The vehicle is no longer available.');
        for (const photo of photos)
          await db
            .prepare('UPDATE photos SET finalized=1,trip_id=? WHERE id=? AND finalized=0')
            .run(id, photo.id);
        await store.enqueueNotification(id, 'checkout');
        if (needsReview)
          await db
            .prepare(
              "UPDATE notifications SET status='awaiting_review',error='Awaiting authenticated representative signature' WHERE trip_id=? AND stage='checkout'",
            )
            .run(id);
        const response = { trip: await store.getTrip(id) };
        await idem.save(response);
        return response;
      })
      .immediate();
    await materialize(result.trip.id, 'checkout');
    res.status(201).json(result);
  });
  app.post('/api/trips/:id/return', async (req, res) => {
    const operation = `return:${req.params.id}`,
      replay = await idempotency(store, req, operation);
    if (replay.previous) return res.json(replay.previous);
    const trip = await requireTripAccess(store, req, req.params.id);
    if (trip.employeeId !== req.user.id)
      fail(403, 'The authenticated employee must complete and sign their own return.');
    const b = validate(
      z
        .object({
          draftId: draftSchema,
          endingMileage: mileageSchema,
          inspection: inspectionSchema,
          photoIds: z.array(z.string().uuid()).min(4).max(30),
          signature: z.string(),
          acknowledgments: z.record(z.string(), z.boolean()),
          odometerReplacementId: z.string().uuid().optional(),
          odometerReplacementAcknowledged: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    if (
      typeof b.inspection.receiptReceived !== 'boolean' ||
      typeof b.inspection.keyReturned !== 'boolean'
    )
      fail(400, 'Confirm whether the receipt and key were returned.');
    if (b.endingMileage < (trip.odometerReplacement?.newReading ?? trip.startingMileage))
      fail(
        400,
        'Ending mileage cannot be below the starting reading. For an odometer replacement, contact an administrator before submitting.',
      );
    await validateSignature(b.signature);
    const acknowledgments = checkAcknowledgments(b.acknowledgments, 'return');
    const result = await db
      .transaction(async () => {
        const idem = await idempotency(store, req, operation);
        if (idem.previous) return idem.previous;
        const current = await store.getTrip(trip.id);
        if (current.status !== 'active')
          fail(
            409,
            'Only an active, approved checkout can be returned. This trip may already have been returned.',
          );
        if (
          current.odometerReplacement &&
          (b.odometerReplacementId !== current.odometerReplacement.id ||
            b.odometerReplacementAcknowledged !== true)
        )
          fail(
            409,
            'Refresh the trip and acknowledge the documented odometer replacement before return.',
          );
        const photos = await validatePhotos(store, {
          ids: b.photoIds,
          employeeId: req.user.id,
          vehicleId: trip.vehicleId,
          stage: 'return',
          draftId: b.draftId,
          tripId: trip.id,
        });
        const settings = await store.getSettings(),
          time = now(),
          vehicle = await store.getVehicle(trip.vehicleId),
          flags = inspectionFlags(b.inspection);
        const distance = current.odometerReplacement
          ? current.odometerReplacement.oldReading -
            trip.startingMileage +
            b.endingMileage -
            current.odometerReplacement.newReading
          : b.endingMileage - trip.startingMileage;
        if (distance > settings.largeMileageThreshold)
          flags.push('Unusually large mileage increase');
        if (current.odometerReplacement) flags.push('Documented odometer replacement');
        const returnReviewMode = settings.returnReviewerEmails.length
          ? 'representative'
          : settings.reviewMode;
        const hold = returnReviewMode === 'representative' || flags.length > 0;
        const signed = {
          inspection: b.inspection,
          signature: b.signature,
          acknowledgments,
          odometerReplacement: current.odometerReplacement,
          signedAt: time,
          reviewMode: returnReviewMode,
          settings: {
            appName: settings.appName,
            organizationName: settings.organizationName,
            site: settings.site,
            timezone: settings.timezone,
            logoUrl: settings.logoUrl,
          },
        };
        await db
          .prepare(
            "UPDATE trips SET status='returned',returned_at=?,ending_mileage=?,return_json=?,flags_json=?,return_mileage_version=? WHERE id=? AND status='active'",
          )
          .run(
            time,
            b.endingMileage,
            store.encodeJSON(signed),
            JSON.stringify(flagUnion(current.flags, flags)),
            vehicle.mileageVersion + 1,
            trip.id,
          );
        await db
          .prepare(
            'UPDATE vehicles SET current_mileage=?,mileage_version=mileage_version+1,status=?,updated_at=? WHERE id=?',
          )
          .run(b.endingMileage, hold ? 'pending_review' : 'available', time, trip.vehicleId);
        for (const photo of photos)
          await db
            .prepare('UPDATE photos SET finalized=1 WHERE id=? AND finalized=0')
            .run(photo.id);
        await store.enqueueNotification(trip.id, 'return');
        if (hold && settings.returnReviewerEmails.length)
          await store.enqueueNotification(trip.id, 'return_review');
        if (returnReviewMode === 'representative')
          await db
            .prepare(
              "UPDATE notifications SET status='awaiting_review',error='Awaiting authenticated representative signature' WHERE trip_id=? AND stage='return'",
            )
            .run(trip.id);
        const response = { trip: await store.getTrip(trip.id) };
        await idem.save(response);
        return response;
      })
      .immediate();
    await materialize(trip.id, 'return');
    res.status(201).json(result);
  });
  app.get('/api/trips/:id/report', async (req, res) => {
    const trip = await requireTripAccess(store, req, req.params.id),
      stage = req.query.stage === 'checkout' ? 'checkout' : 'return';
    if (stage === 'return' && !trip.returnedAt)
      fail(400, 'A return report is available after the vehicle is physically returned.');
    if (!reportService)
      fail(503, 'Report generation is not configured. The signed inspection is saved.');
    const buffer = await reportService({ store, tripId: trip.id, stage, download: true });
    if (typeof buffer === 'string') return res.redirect(303, buffer);
    res
      .type('pdf')
      .set('Content-Disposition', `attachment; filename="${reportFilename(trip, stage)}"`)
      .send(buffer);
  });
  app.post('/api/trips/:id/review', async (req, res) => {
    const b = validate(
      z
        .object({
          stage: z.enum(['checkout', 'return']),
          initials: z.string().trim().min(1).max(12),
          signature: z.string(),
          decision: z.enum(['approve', 'out_of_service']),
          reason: reasonSchema,
        })
        .strict(),
      req.body,
    );
    await validateSignature(b.signature);
    const result = await db
      .transaction(async () => {
        const trip = await store.getTrip(req.params.id);
        if (!trip) fail(404, 'Trip not found.');
        const reviewer = await store.getUser(req.user.id);
        const allowed =
          b.stage === 'return'
            ? mayReviewReturns(reviewer, await store.getSettings())
            : reviewer?.active && reviewer.role === 'admin';
        if (!allowed) fail(403, 'Only an assigned reviewer can approve this inspection.');
        if (trip.employeeId === req.user.id)
          fail(403, 'A different assigned reviewer must approve your own trip.');
        if (
          await db
            .prepare('SELECT 1 FROM reviews WHERE trip_id=? AND stage=?')
            .get(trip.id, b.stage)
        )
          fail(
            409,
            'This inspection already has an authenticated representative signature. Use documented vehicle changes for later availability decisions.',
          );
        if (b.stage === 'checkout' && trip.status !== 'pending_checkout')
          fail(409, 'This checkout is not waiting for representative review.');
        if (b.stage === 'return' && trip.status !== 'returned')
          fail(409, 'Record the physical return before representative review.');
        if (
          b.decision === 'approve' &&
          (await db
            .prepare('SELECT 1 FROM revisions WHERE trip_id=? AND acknowledged_at IS NULL')
            .get(trip.id))
        )
          fail(409, 'The employee must acknowledge pending mileage revisions before release.');
        const time = now();
        await db
          .prepare('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            trip.id,
            b.stage,
            req.user.id,
            b.initials,
            b.signature,
            b.decision,
            b.reason,
            time,
            store.encodeJSON(req.user),
          );
        const before = await store.getVehicle(trip.vehicleId);
        if (b.stage === 'checkout') {
          if (b.decision === 'approve') {
            await db.prepare("UPDATE trips SET status='active' WHERE id=?").run(trip.id);
            await db
              .prepare("UPDATE vehicles SET status='checked_out',updated_at=? WHERE id=?")
              .run(time, trip.vehicleId);
          } else {
            await db.prepare("UPDATE trips SET status='cancelled' WHERE id=?").run(trip.id);
            await db
              .prepare("UPDATE vehicles SET status='out_of_service',updated_at=? WHERE id=?")
              .run(time, trip.vehicleId);
          }
        } else {
          const latest = await db
            .prepare(
              'SELECT id FROM trips WHERE vehicle_id=? ORDER BY vehicle_mileage_version DESC,checkout_at DESC,id DESC LIMIT 1',
            )
            .get(trip.vehicleId);
          if (latest.id === trip.id)
            await db
              .prepare('UPDATE vehicles SET status=?,updated_at=? WHERE id=?')
              .run(b.decision === 'approve' ? 'available' : 'out_of_service', time, trip.vehicleId);
        }
        await store.audit(
          req.user.id,
          'representative_review',
          'trip',
          trip.id,
          before,
          { vehicle: await store.getVehicle(trip.vehicleId), decision: b.decision, stage: b.stage },
          b.reason,
        );
        const queued = await db
          .prepare('SELECT recipients_json FROM notifications WHERE trip_id=? AND stage=?')
          .get(trip.id, b.stage);
        const hasRecipients = queued && store.decodeJSON(queued.recipients_json).length > 0;
        await db
          .prepare(
            "UPDATE notifications SET status=?,error=?,updated_at=? WHERE trip_id=? AND stage=? AND status='awaiting_review'",
          )
          .run(
            hasRecipients ? 'pending' : 'failed',
            hasRecipients ? null : 'No notification recipient configured',
            time,
            trip.id,
            b.stage,
          );
        return { trip: await store.getTrip(trip.id) };
      })
      .immediate();
    await materialize(result.trip.id, b.stage);
    res.json(result);
  });
  app.post('/api/vehicles/:id/discrepancy', async (req, res) => {
    const b = validate(
      z.object({ observedMileage: mileageSchema, reason: reasonSchema }).strict(),
      req.body,
    );
    if (!req.user.authorizedDriver)
      fail(403, 'Only authorized drivers can report a checkout discrepancy.');
    await db
      .transaction(async () => {
        const before = await store.getVehicle(req.params.id);
        if (!before) fail(404, 'Vehicle not found.');
        if (before.status !== 'available') fail(409, 'This vehicle is not available for checkout.');
        await db
          .prepare("UPDATE vehicles SET status='pending_review',updated_at=? WHERE id=?")
          .run(now(), before.id);
        await store.audit(
          req.user.id,
          'mileage_discrepancy',
          'vehicle',
          before.id,
          before,
          { ...(await store.getVehicle(before.id)), observedMileage: b.observedMileage },
          b.reason,
        );
      })
      .immediate();
    res.json({ vehicle: await store.getVehicle(req.params.id) });
  });
  app.post('/api/trips/:id/odometer-replacement', requireAdmin, async (req, res) => {
    const b = validate(
      z
        .object({ oldReading: mileageSchema, newReading: mileageSchema, reason: reasonSchema })
        .strict(),
      req.body,
    );
    await db
      .transaction(async () => {
        const trip = await store.getTrip(req.params.id);
        if (!trip) fail(404, 'Trip not found.');
        if (trip.status !== 'active')
          fail(409, 'An odometer replacement can be recorded on an active trip.');
        if (trip.odometerReplacement) fail(409, 'This trip already has a documented replacement.');
        if (b.oldReading < trip.startingMileage)
          fail(400, 'The old odometer reading must be at least the checkout reading.');
        const id = randomUUID();
        await db
          .prepare('INSERT INTO odometer_replacements VALUES(?,?,?,?,?,?,?)')
          .run(id, trip.id, b.oldReading, b.newReading, b.reason, req.user.id, now());
        await store.audit(
          req.user.id,
          'odometer_replacement',
          'trip',
          trip.id,
          null,
          { ...b, id },
          b.reason,
        );
      })
      .immediate();
    res.status(201).json({ trip: await store.getTrip(req.params.id) });
  });
  app.post('/api/trips/:id/corrections', requireAdmin, async (req, res) => {
    const b = validate(
      z
        .object({
          field: z.enum(['startingMileage', 'endingMileage']),
          value: mileageSchema,
          reason: reasonSchema,
          odometerReplacement: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    const result = await db
      .transaction(async () => {
        const trip = await store.getTrip(req.params.id);
        if (!trip) fail(404, 'Trip not found.');
        if (trip.status !== 'returned')
          fail(
            409,
            'Trip corrections are available after a physical return. Use a vehicle discrepancy hold for an unsubmitted checkout.',
          );
        const revisions = await store.getRevisions(trip.id),
          latest = [...revisions].reverse().find((r) => r.field === b.field && r.acknowledgedAt),
          originalValue = latest?.correctedValue ?? trip[b.field];
        if (revisions.some((r) => r.field === b.field && !r.acknowledgedAt))
          fail(409, 'An acknowledgment is already pending for this field.');
        if (originalValue === b.value)
          fail(400, 'The corrected value must differ from the recorded value.');
        const effectiveStart =
          [...revisions].reverse().find((r) => r.field === 'startingMileage' && r.acknowledgedAt)
            ?.correctedValue ?? trip.startingMileage;
        const effectiveEnd =
          [...revisions].reverse().find((r) => r.field === 'endingMileage' && r.acknowledgedAt)
            ?.correctedValue ?? trip.endingMileage;
        if (
          !b.odometerReplacement &&
          ((b.field === 'endingMileage' && b.value < effectiveStart) ||
            (b.field === 'startingMileage' && b.value > effectiveEnd))
        )
          fail(
            400,
            'This change would create negative trip mileage. Record an explicit odometer replacement exception if applicable.',
          );
        const row = await db
            .prepare('SELECT return_mileage_version FROM trips WHERE id=?')
            .get(trip.id),
          vehicle = await store.getVehicle(trip.vehicleId);
        const latestTrip = await db
          .prepare(
            'SELECT id FROM trips WHERE vehicle_id=? ORDER BY vehicle_mileage_version DESC,checkout_at DESC,id DESC LIMIT 1',
          )
          .get(trip.vehicleId);
        const affectsCurrent =
          b.field === 'endingMileage' &&
          latestTrip.id === trip.id &&
          vehicle.mileageVersion === row.return_mileage_version;
        const id = randomUUID();
        await db
          .prepare(
            'INSERT INTO revisions(id,trip_id,field,original_value,corrected_value,reason,user_id,created_at,odometer_replacement,affects_current) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            trip.id,
            b.field,
            originalValue,
            b.value,
            b.reason,
            req.user.id,
            now(),
            +b.odometerReplacement,
            +affectsCurrent,
          );
        if (affectsCurrent)
          await db
            .prepare(
              "UPDATE vehicles SET status='pending_review',updated_at=? WHERE id=? AND status='available'",
            )
            .run(now(), trip.vehicleId);
        await store.audit(
          req.user.id,
          'propose_trip_correction',
          'trip',
          trip.id,
          { [b.field]: originalValue },
          {
            [b.field]: b.value,
            revisionId: id,
            odometerReplacement: b.odometerReplacement,
            awaitingAcknowledgment: true,
          },
          b.reason,
        );
        return (await store.getRevisions(trip.id)).find((r) => r.id === id);
      })
      .immediate();
    res.status(201).json({ revision: result });
  });
  app.post('/api/trips/:id/revisions/:revisionId/acknowledge', async (req, res) => {
    const trip = await requireTripAccess(store, req, req.params.id);
    if (req.user.id !== trip.employeeId)
      fail(403, 'Only the original employee can acknowledge a revision.');
    await validateSignature(req.body.signature);
    const revision = await db
      .transaction(async () => {
        const row = await db
          .prepare('SELECT * FROM revisions WHERE id=? AND trip_id=?')
          .get(req.params.revisionId, trip.id);
        if (!row) fail(404, 'Revision not found.');
        if (row.acknowledged_at) fail(409, 'This revision was already acknowledged.');
        await db
          .prepare(
            'UPDATE revisions SET acknowledged_at=?,acknowledged_by=?,acknowledgment_signature=? WHERE id=?',
          )
          .run(now(), req.user.id, req.body.signature, row.id);
        if (row.affects_current) {
          const current = await store.getVehicle(trip.vehicleId),
            tripRow = await db
              .prepare('SELECT return_mileage_version FROM trips WHERE id=?')
              .get(trip.id),
            latest = await db
              .prepare(
                'SELECT id FROM trips WHERE vehicle_id=? ORDER BY vehicle_mileage_version DESC,checkout_at DESC,id DESC LIMIT 1',
              )
              .get(trip.vehicleId);
          if (latest.id === trip.id && current.mileageVersion === tripRow.return_mileage_version) {
            await db
              .prepare(
                'UPDATE vehicles SET current_mileage=?,mileage_version=mileage_version+1,updated_at=? WHERE id=?',
              )
              .run(row.corrected_value, now(), trip.vehicleId);
            await db
              .prepare(
                'UPDATE trips SET return_mileage_version=return_mileage_version+1 WHERE id=?',
              )
              .run(trip.id);
          } else await db.prepare('UPDATE revisions SET affects_current=0 WHERE id=?').run(row.id);
        }
        await store.audit(
          req.user.id,
          'acknowledge_trip_correction',
          'trip',
          trip.id,
          null,
          { revisionId: row.id },
          'Employee signed renewed acknowledgment of documented correction',
        );
        return (await store.getRevisions(trip.id)).find((r) => r.id === row.id);
      })
      .immediate();
    await materialize(trip.id, 'return');
    res.json({ revision });
  });
}
