import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { fixture, image } from './helpers.js';
import { PHOTO_STAMP_HEIGHT } from '../server/photo-layout.js';

test('existing photo views restore the same caption as a new upload without changing stored evidence', async (t) => {
  const f = await fixture(t);
  const original = await image();
  const vehicle = await f.addVehicle();
  const uploaded = await f.upload(f.s, vehicle.id, { buffer: original });
  assert.equal(uploaded.status, 201);
  const { id, url } = uploaded.data.photo;
  const fresh = await f.s.request('/photos/' + id);
  assert.equal(fresh.status, 200);
  const { width, height } = await sharp(fresh.data).metadata();
  const band = { left: 0, top: height - PHOTO_STAMP_HEIGHT, width, height: PHOTO_STAMP_HEIGHT };
  const oldPath = `photos/${id}.jpg`;
  const blank = await sharp(fresh.data)
    .composite([
      {
        input: {
          create: { width, height: PHOTO_STAMP_HEIGHT, channels: 3, background: '#102c33' },
        },
        left: 0,
        top: band.top,
      },
    ])
    .jpeg()
    .toBuffer();
  await f.store.evidence.put(oldPath, blank);
  await f.store.db.prepare('UPDATE photos SET display_path=? WHERE id=?').run(oldPath, id);

  const repaired = await f.s.request(url.replace('/api', ''));
  assert.equal(repaired.status, 200);
  assert.equal((await f.o.request('/photos/' + id)).status, 403);
  const pixels = async (bytes) => sharp(bytes).extract(band).greyscale().raw().toBuffer();
  const expected = await pixels(fresh.data);
  const actual = await pixels(repaired.data);
  assert.ok(expected.filter((v) => v > 200).length > 300, 'caption has visible lettering');
  assert.ok(expected.reduce((sum, v, i) => sum + Math.abs(v - actual[i]), 0) / expected.length < 3);
  assert.deepEqual(await f.store.evidence.read(oldPath), blank);
  assert.deepEqual((await f.s.request('/photos/' + id + '?original=1')).data, original);
});
