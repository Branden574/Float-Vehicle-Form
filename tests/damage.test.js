import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectionSchema } from '../server/validation.js';
import { fixture, inspection, signature } from './helpers.js';
test('damage positions validate finite bounds and diagram version; legacy entries remain valid', () => {
  const mark = {
    area: 'front',
    type: 'dent',
    notes: '',
    position: { x: 0.5, y: 0.2, diagram: 'vehicle-v1' },
  };
  assert.ok(inspectionSchema.safeParse({ ...inspection, damage: [mark] }).success);
  for (const position of [
    { x: -0.1, y: 0.5, diagram: 'vehicle-v1' },
    { x: 0.5, y: 1.1, diagram: 'vehicle-v1' },
    { x: Infinity, y: 0.5, diagram: 'vehicle-v1' },
    { x: 0.5, diagram: 'vehicle-v1' },
    { x: 0.5, y: 0.5, diagram: 'other' },
  ])
    assert.equal(
      inspectionSchema.safeParse({ ...inspection, damage: [{ ...mark, position }] }).success,
      false,
    );
  const { position, ...legacy } = mark;
  assert.ok(inspectionSchema.safeParse({ ...inspection, damage: [legacy] }).success);
});
test('submitted and reopened checkout/return retain separate damage positions and notes', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  const first = {
    area: 'driver',
    type: 'dent',
    notes: 'Existing door dent',
    position: { x: 0.2, y: 0.5, diagram: 'vehicle-v1' },
  };
  const second = {
    area: 'rear',
    type: 'scratch',
    notes: 'Rear bumper',
    position: { x: 0.5, y: 0.92, diagram: 'vehicle-v1' },
  };
  const c = await f.checkout(f.s, v, { inspection: { ...inspection, damage: [first] } });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const reviewed = await f.a.request(`/trips/${c.data.trip.id}/review`, {
    method: 'POST',
    body: {
      stage: 'checkout',
      initials: 'TA',
      signature: await signature(),
      decision: 'approve',
      reason: 'Existing cosmetic damage reviewed',
    },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  const returned = await f.returnTrip(f.s, c.data.trip, {
    inspection: { ...inspection, damage: [second] },
  });
  assert.equal(returned.status, 201, JSON.stringify(returned.data));
  const saved = await f.store.getTrip(c.data.trip.id);
  assert.deepEqual(saved.checkoutInspection.damage, [first]);
  assert.deepEqual(saved.returnInspection.damage, [second]);
});
