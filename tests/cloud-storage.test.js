import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fixture, signature, inspection, acknowledgments } from './helpers.js';
import { createReport } from '../server/reports.js';

test(
  'private R2 direct uploads preserve large originals, reject replacement and foreign completion, and produce signed PDF downloads',
  { skip: !process.env.FLEET_TEST_R2 },
  async (t) => {
    const f = await fixture(t, { reports: true });
    const objects = new Set();
    const evidence = f.store.evidence;
    const put = evidence.put;
    evidence.put = async (key, ...args) => {
      objects.add(key);
      return put(key, ...args);
    };
    t.after(async () => {
      for (const key of objects) await evidence.remove(key);
    });
    const v = await f.addVehicle();
    const draftId = randomUUID();
    const ids = [];
    for (const view of ['front', 'rear', 'driver', 'passenger']) {
      const file = await sharp(randomBytes(1600 * 1100 * 3), {
        raw: { width: 1600, height: 1100, channels: 3 },
      })
        .png()
        .toBuffer();
      assert.ok(file.length > 4.5 * 1024 * 1024);
      const ticket = await f.s.request('/photos/upload-ticket', {
        method: 'POST',
        body: {
          vehicleId: v.id,
          stage: 'checkout',
          view,
          draftId,
          source: 'upload',
          bytes: file.length,
        },
      });
      assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
      const objectPath = (
        await f.store.db
          .prepare('SELECT object_path FROM upload_tickets WHERE id=?')
          .get(ticket.data.ticketId)
      ).object_path;
      objects.add(objectPath);
      const upload = await fetch(ticket.data.url, {
        method: 'PUT',
        headers: ticket.data.headers,
        body: file,
      });
      assert.equal(upload.status, 200, await upload.text());
      const again = await fetch(ticket.data.url, {
        method: 'PUT',
        headers: ticket.data.headers,
        body: file,
      });
      assert.equal(again.status, 412, 'signed upload must not replace an existing object');
      const foreign = await f.o.request(`/photos/upload-ticket/${ticket.data.ticketId}/complete`, {
        method: 'POST',
        body: {},
      });
      assert.equal(foreign.status, 404);
      const complete = await f.s.request(`/photos/upload-ticket/${ticket.data.ticketId}/complete`, {
        method: 'POST',
        body: {},
      });
      assert.equal(complete.status, 201, JSON.stringify(complete.data));
      ids.push(complete.data.photo.id);
      const repeated = await f.s.request(`/photos/upload-ticket/${ticket.data.ticketId}/complete`, {
        method: 'POST',
        body: {},
      });
      assert.equal(repeated.data.photo.id, complete.data.photo.id);
      const original = await f.s.request(`/photos/${complete.data.photo.id}?original=1`);
      assert.deepEqual(original.data, file);
      assert.equal((await f.o.request(`/photos/${complete.data.photo.id}`)).status, 403);
      const publicUrl = new URL(ticket.data.url);
      publicUrl.search = '';
      assert.ok((await fetch(publicUrl)).status >= 400, 'unsigned object URL must stay private');
    }
    const result = await f.s.request('/trips/checkout', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        vehicleId: v.id,
        draftId,
        photoIds: ids,
        startingMileage: v.currentMileage,
        mileageConfirmed: true,
        projectedReturnAt: new Date(Date.now() + 3600000).toISOString(),
        inspection,
        acknowledgments,
        signature: await signature(),
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const url = await createReport({
      store: f.store,
      tripId: result.data.trip.id,
      stage: 'checkout',
      download: true,
    });
    assert.equal(typeof url, 'string');
    const pdf = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    const response = await f.s.request(`/trips/${result.data.trip.id}/report?stage=checkout`);
    assert.equal(response.status, 200);
    assert.equal(response.data.subarray(0, 4).toString(), '%PDF');
  },
);
