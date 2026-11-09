import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createReport } from '../server/reports.js';

export const password = 'Test-only-private-password-123!';
export const inspection = {
  fuelFull: true,
  interiorClean: true,
  gasCard: true,
  receiptReceived: true,
  keyReturned: true,
  windshield: 'clear',
  damage: [],
  notes: '',
};
export const acknowledgments = {
  accurate: true,
  noEating: true,
  removeBelongings: true,
  fullTank: true,
};
let imageNumber = 0;
export async function image() {
  imageNumber++;
  return sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: {
        r: imageNumber % 255,
        g: (imageNumber * 17) % 255,
        b: (imageNumber * 39) % 255,
      },
    },
  })
    .jpeg()
    .toBuffer();
}
export async function signature() {
  return (
    'data:image/png;base64,' +
    (
      await sharp(
        Buffer.from(
          '<svg width="400" height="120"><rect width="400" height="120" fill="white"/><path d="M20 80 Q80 0 50 90 T130 50 T250 70 L350 40" fill="none" stroke="#20392e" stroke-width="4"/></svg>',
        ),
      )
        .png()
        .toBuffer()
    ).toString('base64')
  );
}
export async function fixture(t, { reports = false } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-test-')));
  const app = createApp({
    dataDir: directory,
    secureCookies: false,
    reportService: reports ? createReport : undefined,
  });
  const store = app.locals.store;
  const admin = store.createUser({
    name: 'Test Administrator',
    email: 'admin@example.test',
    role: 'admin',
    authorizedDriver: true,
    password,
  });
  const staff = store.createUser({
    name: 'Test Driver',
    email: 'driver@example.test',
    department: 'Operations',
    manager: 'Test Manager',
    authorizedDriver: true,
    password,
  });
  const other = store.createUser({
    name: 'Other Driver',
    email: 'other@example.test',
    department: 'Operations',
    manager: 'Test Manager',
    authorizedDriver: true,
    password,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t?.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function client(email) {
    const response = await fetch(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const session = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    async function request(route, { method = 'GET', body, headers = {} } = {}) {
      const h = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, ...headers };
      if (body && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
      const result = await fetch(url + '/api' + route, {
        method,
        headers: h,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
      const data = result.headers.get('content-type')?.includes('json')
        ? await result.json()
        : Buffer.from(await result.arrayBuffer());
      return { status: result.status, data, headers: result.headers };
    }
    return { request, user: session.user, csrf: session.csrfToken, cookie };
  }
  const a = await client(admin.email),
    s = await client(staff.email),
    o = await client(other.email);
  async function addVehicle(overrides = {}) {
    const result = await a.request('/admin/vehicles', {
      method: 'POST',
      body: {
        name: 'Test pool vehicle',
        make: 'Toyota',
        model: 'RAV4',
        year: 2024,
        plate: 'TEST-001',
        vinLast4: '1234',
        site: 'Test site',
        currentMileage: 42500,
        status: 'available',
        ...overrides,
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.vehicle;
  }
  async function upload(
    client,
    vehicleId,
    {
      stage = 'checkout',
      tripId,
      draftId = randomUUID(),
      view = 'front',
      buffer,
      source = 'camera',
    } = {},
  ) {
    const form = new FormData();
    form.append('file', new Blob([buffer || (await image())], { type: 'image/jpeg' }), 'photo.jpg');
    for (const [key, value] of Object.entries({
      vehicleId,
      stage,
      tripId,
      draftId,
      view,
      source,
      deviceCapturedAt: new Date().toISOString(),
    }))
      if (value !== undefined) form.append(key, value);
    return client.request('/photos', { method: 'POST', body: form });
  }
  async function draft(client, vehicle, { stage = 'checkout', tripId } = {}) {
    const draftId = randomUUID(),
      photoIds = [];
    for (const view of ['front', 'rear', 'driver', 'passenger']) {
      const result = await upload(client, vehicle.id, { stage, tripId, draftId, view });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      photoIds.push(result.data.photo.id);
    }
    return { draftId, photoIds };
  }
  async function checkout(client, vehicle, extra = {}) {
    const d = await draft(client, vehicle);
    const body = {
      ...d,
      vehicleId: vehicle.id,
      projectedReturnAt: new Date(Date.now() + 3600000).toISOString(),
      startingMileage: vehicle.currentMileage,
      mileageConfirmed: true,
      inspection,
      signature: await signature(),
      acknowledgments,
      ...extra,
    };
    const key = randomUUID();
    return {
      body,
      key,
      ...(await client.request('/trips/checkout', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': key },
      })),
    };
  }
  async function returnTrip(client, trip, extra = {}) {
    const d = await draft(client, { id: trip.vehicleId }, { stage: 'return', tripId: trip.id });
    const body = {
      ...d,
      endingMileage: trip.startingMileage + 125,
      inspection,
      signature: await signature(),
      acknowledgments,
      ...extra,
    };
    const key = randomUUID();
    return {
      body,
      key,
      ...(await client.request(`/trips/${trip.id}/return`, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': key },
      })),
    };
  }
  return {
    directory,
    app,
    store,
    url,
    server,
    a,
    s,
    o,
    admin,
    staff,
    other,
    client,
    addVehicle,
    upload,
    draft,
    checkout,
    returnTrip,
  };
}
