import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mayReviewReturns } from './reviewers.js';
import { fail, reasonSchema, validate } from './validation.js';

const exclusionKey = (store, id) => store.emailLookup('vehicle-inspection-exclusion:' + id);

// Call before deleting any of the candidate trips; a newer trip may also be erased.
export async function preserveVehicleInspection(store, tripId, retainExclusion) {
  const db = store.db;
  const trip = await db
    .prepare(
      `SELECT t.vehicle_id,t.employee_id FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
     WHERE t.id=? AND t.status='returned' AND v.status='pending_review'
       AND (t.return_mileage_version IS NULL OR t.return_mileage_version=v.mileage_version)
       AND t.id=(SELECT latest.id FROM trips latest WHERE latest.vehicle_id=t.vehicle_id
         ORDER BY latest.vehicle_mileage_version DESC,latest.checkout_at DESC,latest.id DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.trip_id=t.id AND r.stage='return')
       AND NOT EXISTS (SELECT 1 FROM vehicle_inspections i WHERE i.vehicle_id=v.id)`,
    )
    .get(tripId);
  if (!trip) return;
  const id = randomUUID();
  await db
    .prepare('INSERT INTO vehicle_inspections(id,vehicle_id) VALUES(?,?)')
    .run(id, trip.vehicle_id);
  // The task carries no link to the erased driver. For an existing account,
  // keep only an opaque exclusion on that account until resolution or account deletion.
  if (retainExclusion)
    await db
      .prepare('INSERT INTO inspection_exclusions(lookup,user_id) VALUES(?,?)')
      .run(exclusionKey(store, id), trip.employee_id);
}

// Older installations may have a hold whose trip has already gone. Administrators
// explicitly refer these vehicles; a migration cannot infer their condition.
export async function inspectionReferralIds(db) {
  const rows = await db
    .prepare(
      `SELECT v.id FROM vehicles v WHERE v.status='pending_review' AND v.archived=0
    AND NOT EXISTS (SELECT 1 FROM vehicle_inspections i WHERE i.vehicle_id=v.id)
    AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.vehicle_id=v.id AND
      (t.status IN ('active','pending_checkout') OR (t.status='returned' AND
        (t.return_mileage_version=v.mileage_version OR t.return_mileage_version IS NULL))))
    AND NOT EXISTS (SELECT 1 FROM revisions r JOIN trips t ON r.trip_id=t.id
      WHERE t.vehicle_id=v.id AND r.affects_current=1 AND r.acknowledged_at IS NULL)`,
    )
    .all();
  return rows.map((row) => row.id);
}

export async function listVehicleInspections(store, userId) {
  const exclusions = new Set(
    (
      await store.db.prepare('SELECT lookup FROM inspection_exclusions WHERE user_id=?').all(userId)
    ).map((row) => row.lookup),
  );
  const rows = await store.db
    .prepare(
      `SELECT i.id,v.name,v.plate,v.site FROM vehicle_inspections i JOIN vehicles v ON v.id=i.vehicle_id
     WHERE v.status='pending_review' AND v.archived=0 ORDER BY v.name,v.plate`,
    )
    .all();
  return rows.filter((row) => !exclusions.has(exclusionKey(store, row.id)));
}

export function installVehicleInspections(app, store) {
  const db = store.db;
  app.post('/api/vehicle-inspections/:id/resolve', async (req, res) => {
    const { decision, reason } = validate(
      z
        .object({
          inspected: z.literal(true),
          decision: z.enum(['approve', 'hold']),
          reason: reasonSchema,
        })
        .strict(),
      req.body,
    );
    await db.transaction(async () => {
      if (!mayReviewReturns(await store.getUser(req.user.id), await store.getSettings()))
        fail(403, 'Only an assigned reviewer can complete this inspection.');
      const task = await db
        .prepare('SELECT vehicle_id FROM vehicle_inspections WHERE id=?')
        .get(req.params.id);
      if (!task) fail(409, 'This inspection is no longer pending. Refresh the fleet.');
      const key = exclusionKey(store, req.params.id);
      if (
        await db
          .prepare('SELECT 1 FROM inspection_exclusions WHERE lookup=? AND user_id=?')
          .get(key, req.user.id)
      )
        fail(403, 'A different assigned reviewer must inspect this vehicle.');
      const changed = await db
        .prepare(
          `UPDATE vehicles SET status=?,updated_at=? WHERE id=? AND status='pending_review' AND archived=0
         AND NOT EXISTS (SELECT 1 FROM trips WHERE vehicle_id=? AND status IN ('active','pending_checkout'))
         AND NOT EXISTS (SELECT 1 FROM revisions r JOIN trips t ON r.trip_id=t.id WHERE t.vehicle_id=? AND r.affects_current=1 AND r.acknowledged_at IS NULL)`,
        )
        .run(
          decision === 'approve' ? 'available' : 'out_of_service',
          new Date().toISOString(),
          task.vehicle_id,
          task.vehicle_id,
          task.vehicle_id,
        );
      if (changed.changes !== 1)
        fail(
          409,
          'The vehicle changed or has an outstanding mileage correction. Refresh the fleet.',
        );
      await db.prepare('DELETE FROM inspection_exclusions WHERE lookup=?').run(key);
      await db.prepare('DELETE FROM vehicle_inspections WHERE id=?').run(req.params.id);
      await store.audit(
        req.user.id,
        'physical_vehicle_inspection',
        'vehicle',
        task.vehicle_id,
        { status: 'pending_review' },
        { status: decision === 'approve' ? 'available' : 'out_of_service' },
        reason,
      );
    })();
    res.json({ ok: true });
  });
}
