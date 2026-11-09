import test from 'node:test';
import assert from 'node:assert/strict';
import { reportFilename } from '../server/report-filename.js';

test('PDF names use signed employee and vehicle values with local checkout and return dates', () => {
  const trip = {
    employeeSnapshot: { name: 'José O’Neil' },
    vehicleSnapshot: { name: 'Pool Vehicle 01' },
    checkoutAt: '2026-11-10T07:30:00Z',
    returnedAt: '2026-11-11T08:30:00Z',
    checkoutSettings: { timezone: 'America/Los_Angeles' },
  };
  assert.equal(
    reportFilename(trip, 'checkout'),
    'Jose-O-Neil_Pool-Vehicle-01_Out-2026-11-09_Checkout.pdf',
  );
  assert.equal(
    reportFilename(trip, 'return'),
    'Jose-O-Neil_Pool-Vehicle-01_Out-2026-11-09_In-2026-11-11_Checkout-and-Check-in.pdf',
  );
  trip.checkoutSettings.timezone = 'Pacific/Honolulu';
  assert.match(reportFilename(trip, 'return'), /In-2026-11-10_/);
});

test('PDF names are bounded and safe for headers and file paths', () => {
  const trip = {
    employeeSnapshot: { name: '../\r\n"\\' + 'A'.repeat(300) },
    vehicleSnapshot: { name: '/..' },
    checkoutAt: 'invalid',
  };
  const name = reportFilename(trip, 'checkout');
  assert.match(name, /^[a-zA-Z0-9_.-]+\.pdf$/);
  assert.ok(name.length < 200);
  assert.ok(!name.includes('..'));
  assert.match(name, /_Vehicle_Out-Date-not-recorded_Checkout.pdf$/);
  assert.throws(() => reportFilename(trip, 'invalid'), /Invalid report stage/);
});
