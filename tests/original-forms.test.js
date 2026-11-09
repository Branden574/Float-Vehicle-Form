import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, decodePDFRawStream } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import { originalForms, templateBytes, templateHash } from '../server/original-forms.js';
import { inspection, signature } from './helpers.js';

function operators(pdf, index) {
  const streams = pdf.getPage(index).node.Contents();
  return Array.from({ length: streams.size() }, (_, i) =>
    Buffer.from(decodePDFRawStream(pdf.context.lookup(streams.get(i))).decode()).toString(),
  ).join('\n');
}
function strings(content) {
  return [...content.matchAll(/<([A-Fa-f0-9]+)> Tj/g)].map((m) =>
    Buffer.from(m[1], 'hex').toString('latin1'),
  );
}
async function sample() {
  const appendix = await PDFDocument.create();
  appendix.addPage();
  const sig = await signature();
  return {
    stage: 'return',
    zone: 'America/Los_Angeles',
    appendix: await appendix.save(),
    reviews: [],
    trip: {
      id: 'test-original-form',
      employeeSnapshot: {
        name: 'Test Driver',
        department: 'Operations',
        manager: 'Test Manager',
        authorizedDriver: true,
      },
      vehicleSnapshot: { vinLast4: '1234' },
      checkoutAt: '2026-11-09T18:00:00Z',
      projectedReturnAt: '2026-11-10T01:00:00Z',
      returnedAt: '2026-11-10T00:00:00Z',
      startingMileage: 42500,
      endingMileage: 42625,
      checkoutInspection: inspection,
      returnInspection: inspection,
      checkoutSignature: sig,
      returnSignature: sig,
      checkoutReviewMode: 'self_service',
      returnReviewMode: 'self_service',
    },
  };
}
test('clean forms matching the original layout lead the report, retain identity, local dates, mileage, signatures and stage isolation', async () => {
  const input = await sample();
  const pdf = await PDFDocument.load(await originalForms(input));
  assert.equal((await PDFDocument.load(templateBytes)).getPageCount(), 2);
  assert.equal(templateHash.length, 64);
  assert.equal(pdf.getPageCount(), 3);
  for (const i of [0, 1]) {
    const op = operators(pdf, i),
      text = strings(op);
    assert.match(op, /EmbeddedPdfPage.* Do/);
    assert.match(op, /Image.* Do/);
    for (const value of ['Test Driver', 'Operations', 'Test Manager', '1234', '11/09/2026'])
      assert.ok(text.includes(value), value);
    assert.deepEqual(pdf.getPage(i).getSize(), { width: 612, height: 792 });
  }
  assert.deepEqual(
    strings(operators(pdf, 0)).filter((s) => /^\d$/.test(s)),
    ['4', '2', '5', '0', '0'],
  );
  assert.deepEqual(
    strings(operators(pdf, 1)).filter((s) => /^\d$/.test(s)),
    ['4', '2', '6', '2', '5'],
  );
  const checkout = await PDFDocument.load(await originalForms({ ...input, stage: 'checkout' }));
  assert.equal(checkout.getPageCount(), 2);
  assert.ok(strings(operators(checkout, 0)).includes('10:00 AM'));
  assert.ok(!strings(operators(checkout, 0)).includes('04:00 PM'));
});
test('representative signatures are authentic stage-specific images; combined return fuel/receipt question records No when receipt is missing', async () => {
  const input = await sample();
  input.trip.returnInspection = {
    ...inspection,
    receiptReceived: false,
    gasCard: false,
    windshield: 'cracked',
    damage: [{ area: 'driver', type: 'dent', notes: 'Door dent' }],
  };
  input.reviews = [
    {
      stage: 'checkout',
      initials: 'AB',
      signature: await signature(),
      createdAt: input.trip.checkoutAt,
    },
  ];
  const bytes = await originalForms(input),
    pdf = await PDFDocument.load(bytes);
  const checkout = operators(pdf, 0),
    returned = operators(pdf, 1);
  assert.ok(strings(checkout).includes('AB'));
  assert.equal((checkout.match(/\/Image.* Do/g) || []).length, 2);
  assert.equal((returned.match(/\/Image.* Do/g) || []).length, 1);
  assert.ok(strings(returned).includes('N/A - self-service'));
  assert.ok(strings(returned).includes('1: x'));
  // First check stroke is inside the original form's No box (x=797+3), not Yes.
  assert.match(returned, /451\.2442396313364 489\.9085714285714 m/);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/sample-original-exceptions.pdf', bytes);
});

test('clean template is deterministic and positioned damage preserves exact normalized coordinates on both forms', async () => {
  const { buildCleanTemplate } = await import('../server/clean-template.js');
  const { createHash } = await import('node:crypto');
  assert.equal(
    createHash('sha256')
      .update(await buildCleanTemplate())
      .digest('hex'),
    templateHash,
  );
  const input = await sample();
  const mark = {
    area: 'driver',
    type: 'scratch',
    notes: 'Door',
    position: { x: 0.25, y: 0.5, diagram: 'vehicle-v1' },
  };
  input.trip.checkoutInspection = { ...inspection, damage: [mark] };
  input.trip.returnInspection = {
    ...inspection,
    damage: [{ ...mark, position: { ...mark.position, x: 0.75, y: 0.7 } }],
  };
  const bytes = await originalForms(input),
    pdf = await PDFDocument.load(bytes);
  for (const [i, x, y, top] of [
    [0, 0.25, 0.5, 750],
    [1, 0.75, 0.7, 730],
  ]) {
    const sx = 612 / (i ? 1085 : 1082),
      sy = 792 / 1400,
      scale = (250 / 360) * sx;
    const content = operators(pdf, i);
    const expectedX = (600 + x * 250) * sx,
      expectedY = 792 - top * sy - y * 560 * scale;
    const transforms = [...content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) cm/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    assert.ok(
      transforms.some(
        ([tx, ty]) => Math.abs(tx - expectedX) < 0.001 && Math.abs(ty - expectedY) < 0.001,
      ),
      'mark position matches shared diagram',
    );
  }
  await writeFile('artifacts/sample-positioned-damage.pdf', bytes);
});

test('damage-held checkout says representative pending even in self-service mode', async () => {
  const input = await sample();
  input.trip.status = 'pending_checkout';
  const pdf = await PDFDocument.load(await originalForms({ ...input, stage: 'checkout' }));
  const text = strings(operators(pdf, 0));
  assert.ok(text.includes('Pending'));
  assert.ok(text.includes('Pending representative review'));
  assert.ok(!text.includes('N/A - self-service'));
});
