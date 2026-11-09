import { randomUUID } from 'node:crypto';
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
function idempotency(store, req, operation) {
  const key = req.get('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 200)
    fail(400, 'A submission idempotency key is required. Refresh the form and try again.');
  const digest = hash(JSON.stringify(req.body));
  const previous = store.db
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
    previous: previous ? JSON.parse(previous.response_json) : null,
    save: (response) =>
      store.db
        .prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?)')
        .run(req.user.id, key, operation, digest, JSON.stringify(response), now()),
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
  app.get('/api/vehicles', (req, res) =>
    res.json({
      vehicles: db
        .prepare('SELECT * FROM vehicles WHERE archived=0 ORDER BY name')
        .all()
        .map(store.mapVehicle),
    }),
  );
  app.get('/api/trips', (req, res) =>
    res.json({
      trips: (req.user.role === 'admin'
        ? db.prepare('SELECT * FROM trips ORDER BY checkout_at DESC').all()
        : db
            .prepare('SELECT * FROM trips WHERE employee_id=? ORDER BY checkout_at DESC')
            .all(req.user.id)
      ).map(store.mapTrip),
    }),
  );
  app.get('/api/trips/:id', (req, res) => {
    requireTripAccess(store, req, req.params.id);
    const bundle = store.getTripBundle(req.params.id);
    bundle.photos = bundle.photos.map(store.publicPhoto);
    delete bundle.settings;
    if (req.user.role !== 'admin')
      bundle.notifications = bundle.notifications.map(({ recipients, ...n }) => n);
    res.json(bundle);
  });
  app.post('/api/trips/checkout', async (req, res) => {
    const replay = idempotency(store, req, 'checkout');
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
    await validateSignature(b.signature);
    const acknowledgments = checkAcknowledgments(b.acknowledgments, 'checkout');
    const result = db
      .transaction(() => {
        const idem = idempotency(store, req, 'checkout');
        if (idem.previous) return idem.previous;
        const user = store.getUser(req.user.id);
        if (!user.active || !user.authorizedDriver)
          fail(403, 'Driver authorization is no longer active.');
        if (!user.department.trim() || !user.manager.trim())
          fail(
            400,
            'Ask an administrator to complete your department and manager before checkout.',
          );
        const vehicle = store.getVehicle(b.vehicleId);
        if (!vehicle || vehicle.archived) fail(404, 'Vehicle not found.');
        if (vehicle.status !== 'available')
          fail(409, 'This vehicle was just checked out or placed on hold. Choose another vehicle.');
        if (vehicle.currentMileage !== b.startingMileage)
          fail(
            409,
            'The mileage has changed or does not match the accepted reading. Refresh or report a discrepancy.',
          );
        const photos = validatePhotos(store, {
          ids: b.photoIds,
          employeeId: req.user.id,
          vehicleId: vehicle.id,
          stage: 'checkout',
          draftId: b.draftId,
        });
        const id = randomUUID(),
          time = now(),
          settings = store.getSettings(),
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
        db.prepare(
          'INSERT INTO trips(id,vehicle_id,employee_id,status,checkout_at,projected_return_at,starting_mileage,vehicle_mileage_version,checkout_json,flags_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          vehicle.id,
          user.id,
          needsReview ? 'pending_checkout' : 'active',
          time,
          b.projectedReturnAt,
          b.startingMileage,
          vehicle.mileageVersion,
          JSON.stringify(snapshot),
          JSON.stringify(flags),
        );
        const updated = db
          .prepare("UPDATE vehicles SET status=?,updated_at=? WHERE id=? AND status='available'")
          .run(needsReview ? 'pending_review' : 'checked_out', time, vehicle.id);
        if (updated.changes !== 1) fail(409, 'The vehicle is no longer available.');
        for (const photo of photos)
          db.prepare('UPDATE photos SET finalized=1,trip_id=? WHERE id=? AND finalized=0').run(
            id,
            photo.id,
          );
        store.enqueueNotification(id, 'checkout');
        if (needsReview)
          db.prepare(
            "UPDATE notifications SET status='awaiting_review',error='Awaiting authenticated representative signature' WHERE trip_id=? AND stage='checkout'",
          ).run(id);
        const response = { trip: store.getTrip(id) };
        idem.save(response);
        return response;
      })
      .immediate();
    await materialize(result.trip.id, 'checkout');
    res.status(201).json(result);
  });
  app.post('/api/trips/:id/return', async (req, res) => {
    const operation = `return:${req.params.id}`,
      replay = idempotency(store, req, operation);
    if (replay.previous) return res.json(replay.previous);
    const trip = requireTripAccess(store, req, req.params.id);
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
    const result = db
      .transaction(() => {
        const idem = idempotency(store, req, operation);
        if (idem.previous) return idem.previous;
        const current = store.getTrip(trip.id);
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
        const photos = validatePhotos(store, {
          ids: b.photoIds,
          employeeId: req.user.id,
          vehicleId: trip.vehicleId,
          stage: 'return',
          draftId: b.draftId,
          tripId: trip.id,
        });
        const settings = store.getSettings(),
          time = now(),
          vehicle = store.getVehicle(trip.vehicleId),
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
        const hold = settings.reviewMode === 'representative' || flags.length > 0;
        const signed = {
          inspection: b.inspection,
          signature: b.signature,
          acknowledgments,
          odometerReplacement: current.odometerReplacement,
          signedAt: time,
          reviewMode: settings.reviewMode,
          settings: {
            appName: settings.appName,
            organizationName: settings.organizationName,
            site: settings.site,
            timezone: settings.timezone,
            logoUrl: settings.logoUrl,
          },
        };
        db.prepare(
          "UPDATE trips SET status='returned',returned_at=?,ending_mileage=?,return_json=?,flags_json=?,return_mileage_version=? WHERE id=? AND status='active'",
        ).run(
          time,
          b.endingMileage,
          JSON.stringify(signed),
          JSON.stringify(flagUnion(current.flags, flags)),
          vehicle.mileageVersion + 1,
          trip.id,
        );
        db.prepare(
          'UPDATE vehicles SET current_mileage=?,mileage_version=mileage_version+1,status=?,updated_at=? WHERE id=?',
        ).run(b.endingMileage, hold ? 'pending_review' : 'available', time, trip.vehicleId);
        for (const photo of photos)
          db.prepare('UPDATE photos SET finalized=1 WHERE id=? AND finalized=0').run(photo.id);
        store.enqueueNotification(trip.id, 'return');
        if (settings.reviewMode === 'representative')
          db.prepare(
            "UPDATE notifications SET status='awaiting_review',error='Awaiting authenticated representative signature' WHERE trip_id=? AND stage='return'",
          ).run(trip.id);
        const response = { trip: store.getTrip(trip.id) };
        idem.save(response);
        return response;
      })
      .immediate();
    await materialize(trip.id, 'return');
    res.status(201).json(result);
  });
  app.get('/api/trips/:id/report', async (req, res) => {
    const trip = requireTripAccess(store, req, req.params.id),
      stage = req.query.stage === 'checkout' ? 'checkout' : 'return';
    if (stage === 'return' && !trip.returnedAt)
      fail(400, 'A return report is available after the vehicle is physically returned.');
    if (!reportService)
      fail(503, 'Report generation is not configured. The signed inspection is saved.');
    const buffer = await reportService({ store, tripId: trip.id, stage });
    res
      .type('pdf')
      .set('Content-Disposition', `attachment; filename="fleet-${trip.id}-${stage}.pdf"`)
      .send(buffer);
  });
  app.post('/api/trips/:id/review', requireAdmin, async (req, res) => {
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
    const result = db
      .transaction(() => {
        const trip = store.getTrip(req.params.id);
        if (!trip) fail(404, 'Trip not found.');
        if (trip.employeeId === req.user.id)
          fail(
            403,
            'A different administrator must provide representative review for your own trip.',
          );
        if (db.prepare('SELECT 1 FROM reviews WHERE trip_id=? AND stage=?').get(trip.id, b.stage))
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
          db
            .prepare('SELECT 1 FROM revisions WHERE trip_id=? AND acknowledged_at IS NULL')
            .get(trip.id)
        )
          fail(409, 'The employee must acknowledge pending mileage revisions before release.');
        const time = now();
        db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?,?)').run(
          randomUUID(),
          trip.id,
          b.stage,
          req.user.id,
          b.initials,
          b.signature,
          b.decision,
          b.reason,
          time,
          JSON.stringify(req.user),
        );
        const before = store.getVehicle(trip.vehicleId);
        if (b.stage === 'checkout') {
          if (b.decision === 'approve') {
            db.prepare("UPDATE trips SET status='active' WHERE id=?").run(trip.id);
            db.prepare("UPDATE vehicles SET status='checked_out',updated_at=? WHERE id=?").run(
              time,
              trip.vehicleId,
            );
          } else {
            db.prepare("UPDATE trips SET status='cancelled' WHERE id=?").run(trip.id);
            db.prepare("UPDATE vehicles SET status='out_of_service',updated_at=? WHERE id=?").run(
              time,
              trip.vehicleId,
            );
          }
        } else {
          const latest = db
            .prepare(
              'SELECT id FROM trips WHERE vehicle_id=? ORDER BY checkout_at DESC,rowid DESC LIMIT 1',
            )
            .get(trip.vehicleId);
          if (latest.id === trip.id)
            db.prepare('UPDATE vehicles SET status=?,updated_at=? WHERE id=?').run(
              b.decision === 'approve' ? 'available' : 'out_of_service',
              time,
              trip.vehicleId,
            );
        }
        store.audit(
          req.user.id,
          'representative_review',
          'trip',
          trip.id,
          before,
          { vehicle: store.getVehicle(trip.vehicleId), decision: b.decision, stage: b.stage },
          b.reason,
        );
        db.prepare(
          "UPDATE notifications SET status=CASE WHEN recipients_json='[]' THEN 'failed' ELSE 'pending' END,error=CASE WHEN recipients_json='[]' THEN 'No notification recipient configured' ELSE NULL END,updated_at=? WHERE trip_id=? AND stage=? AND status='awaiting_review'",
        ).run(time, trip.id, b.stage);
        return { trip: store.getTrip(trip.id) };
      })
      .immediate();
    await materialize(result.trip.id, b.stage);
    res.json(result);
  });
  app.post('/api/vehicles/:id/discrepancy', (req, res) => {
    const b = validate(
      z.object({ observedMileage: mileageSchema, reason: reasonSchema }).strict(),
      req.body,
    );
    if (!req.user.authorizedDriver)
      fail(403, 'Only authorized drivers can report a checkout discrepancy.');
    db.transaction(() => {
      const before = store.getVehicle(req.params.id);
      if (!before) fail(404, 'Vehicle not found.');
      if (before.status !== 'available') fail(409, 'This vehicle is not available for checkout.');
      db.prepare("UPDATE vehicles SET status='pending_review',updated_at=? WHERE id=?").run(
        now(),
        before.id,
      );
      store.audit(
        req.user.id,
        'mileage_discrepancy',
        'vehicle',
        before.id,
        before,
        { ...store.getVehicle(before.id), observedMileage: b.observedMileage },
        b.reason,
      );
    }).immediate();
    res.json({ vehicle: store.getVehicle(req.params.id) });
  });
  app.post('/api/trips/:id/odometer-replacement', requireAdmin, (req, res) => {
    const b = validate(
      z
        .object({ oldReading: mileageSchema, newReading: mileageSchema, reason: reasonSchema })
        .strict(),
      req.body,
    );
    db.transaction(() => {
      const trip = store.getTrip(req.params.id);
      if (!trip) fail(404, 'Trip not found.');
      if (trip.status !== 'active')
        fail(409, 'An odometer replacement can be recorded on an active trip.');
      if (trip.odometerReplacement) fail(409, 'This trip already has a documented replacement.');
      if (b.oldReading < trip.startingMileage)
        fail(400, 'The old odometer reading must be at least the checkout reading.');
      const id = randomUUID();
      db.prepare('INSERT INTO odometer_replacements VALUES(?,?,?,?,?,?,?)').run(
        id,
        trip.id,
        b.oldReading,
        b.newReading,
        b.reason,
        req.user.id,
        now(),
      );
      store.audit(
        req.user.id,
        'odometer_replacement',
        'trip',
        trip.id,
        null,
        { ...b, id },
        b.reason,
      );
    }).immediate();
    res.status(201).json({ trip: store.getTrip(req.params.id) });
  });
  app.post('/api/trips/:id/corrections', requireAdmin, (req, res) => {
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
    const result = db
      .transaction(() => {
        const trip = store.getTrip(req.params.id);
        if (!trip) fail(404, 'Trip not found.');
        if (trip.status !== 'returned')
          fail(
            409,
            'Trip corrections are available after a physical return. Use a vehicle discrepancy hold for an unsubmitted checkout.',
          );
        const revisions = store.getRevisions(trip.id),
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
        const row = db.prepare('SELECT return_mileage_version FROM trips WHERE id=?').get(trip.id),
          vehicle = store.getVehicle(trip.vehicleId);
        const latestTrip = db
          .prepare(
            'SELECT id FROM trips WHERE vehicle_id=? ORDER BY checkout_at DESC,rowid DESC LIMIT 1',
          )
          .get(trip.vehicleId);
        const affectsCurrent =
          b.field === 'endingMileage' &&
          latestTrip.id === trip.id &&
          vehicle.mileageVersion === row.return_mileage_version;
        const id = randomUUID();
        db.prepare(
          'INSERT INTO revisions(id,trip_id,field,original_value,corrected_value,reason,user_id,created_at,odometer_replacement,affects_current) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(
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
          db.prepare(
            "UPDATE vehicles SET status='pending_review',updated_at=? WHERE id=? AND status='available'",
          ).run(now(), trip.vehicleId);
        store.audit(
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
        return store.getRevisions(trip.id).find((r) => r.id === id);
      })
      .immediate();
    res.status(201).json({ revision: result });
  });
  app.post('/api/trips/:id/revisions/:revisionId/acknowledge', async (req, res) => {
    const trip = requireTripAccess(store, req, req.params.id);
    if (req.user.id !== trip.employeeId)
      fail(403, 'Only the original employee can acknowledge a revision.');
    await validateSignature(req.body.signature);
    const revision = db
      .transaction(() => {
        const row = db
          .prepare('SELECT * FROM revisions WHERE id=? AND trip_id=?')
          .get(req.params.revisionId, trip.id);
        if (!row) fail(404, 'Revision not found.');
        if (row.acknowledged_at) fail(409, 'This revision was already acknowledged.');
        db.prepare(
          'UPDATE revisions SET acknowledged_at=?,acknowledged_by=?,acknowledgment_signature=? WHERE id=?',
        ).run(now(), req.user.id, req.body.signature, row.id);
        if (row.affects_current) {
          const current = store.getVehicle(trip.vehicleId),
            tripRow = db
              .prepare('SELECT return_mileage_version FROM trips WHERE id=?')
              .get(trip.id),
            latest = db
              .prepare(
                'SELECT id FROM trips WHERE vehicle_id=? ORDER BY checkout_at DESC,rowid DESC LIMIT 1',
              )
              .get(trip.vehicleId);
          if (latest.id === trip.id && current.mileageVersion === tripRow.return_mileage_version) {
            db.prepare(
              'UPDATE vehicles SET current_mileage=?,mileage_version=mileage_version+1,updated_at=? WHERE id=?',
            ).run(row.corrected_value, now(), trip.vehicleId);
            db.prepare(
              'UPDATE trips SET return_mileage_version=return_mileage_version+1 WHERE id=?',
            ).run(trip.id);
          } else db.prepare('UPDATE revisions SET affects_current=0 WHERE id=?').run(row.id);
        }
        store.audit(
          req.user.id,
          'acknowledge_trip_correction',
          'trip',
          trip.id,
          null,
          { revisionId: row.id },
          'Employee signed renewed acknowledgment of documented correction',
        );
        return store.getRevisions(trip.id).find((r) => r.id === row.id);
      })
      .immediate();
    await materialize(trip.id, 'return');
    res.json({ revision });
  });
}
