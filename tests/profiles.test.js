import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { openStore } from '../server/store.js';

async function post(f, route, body) {
  const response = await fetch(f.url + '/api/auth/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}

test('email code signs into the same account, is single-use, and profiles are saved encrypted', async (t) => {
  const messages = [];
  const f = await fixture(t, { sendSignInCode: async (mail) => messages.push(mail) });
  const requested = await post(f, 'request-code', { email: f.staff.email });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.code, undefined);
  assert.deepEqual(messages[0].to, [f.staff.email]);
  const code = messages[0].text.match(/code is (\d{6})/)[1];
  const cooldown = await post(f, 'request-code', { email: f.staff.email });
  assert.equal(cooldown.status, 429);
  const verified = await post(f, 'verify-code', { challengeId: requested.body.challengeId, code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.user.id, f.staff.id);
  assert.equal(
    (await post(f, 'verify-code', { challengeId: requested.body.challengeId, code })).status,
    401,
  );
  const profile = {
    name: 'Private Profile Name',
    email: f.staff.email,
    charter: 'Private Charter Name',
    department: 'Operations',
    manager: 'Private Manager',
  };
  const saved = await f.s.request('/auth/profile', { method: 'PATCH', body: profile });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.user.charter, profile.charter);
  assert.equal(
    (await f.s.request('/auth/profile', { method: 'PATCH', body: { ...profile, role: 'admin' } }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.s.request('/auth/profile', {
        method: 'PATCH',
        body: { ...profile, email: 'changed@example.test' },
      })
    ).status,
    400,
  );
  const second = openStore(f.directory);
  assert.equal(second.getUser(f.staff.id).charter, profile.charter);
  second.close();
  const row = f.store.db.prepare('SELECT * FROM users WHERE id=?').get(f.staff.id);
  assert.equal(row.name, '');
  assert.notEqual(row.email, profile.email);
  assert.match(row.profile_json, /^enc:v1:/);
  f.store.db.pragma('wal_checkpoint(TRUNCATE)');
  const bytes = await readFile(path.join(f.directory, 'fleet.sqlite'));
  for (const value of [profile.name, profile.email, profile.charter, profile.manager])
    assert.equal(bytes.includes(Buffer.from(value)), false, value);
});

test('email verification limits guesses, expires codes, refuses disabled accounts and removes failed deliveries', async (t) => {
  const messages = [];
  let failDelivery = false;
  const f = await fixture(t, {
    sendSignInCode: async (mail) => {
      if (failDelivery) throw new Error('delivery unavailable');
      messages.push(mail);
    },
  });
  const request = async (email) => {
    const r = await post(f, 'request-code', { email });
    assert.equal(r.status, 200);
    return {
      challengeId: r.body.challengeId,
      code: messages.at(-1).text.match(/code is (\d{6})/)[1],
    };
  };
  const limited = await request('attempts@example.test');
  const wrong = limited.code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++)
    assert.equal((await post(f, 'verify-code', { ...limited, code: wrong })).status, 401);
  assert.equal((await post(f, 'verify-code', limited)).status, 401);
  const expired = await request('expired@example.test');
  f.store.db
    .prepare('UPDATE login_codes SET expires_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z', expired.challengeId);
  assert.equal((await post(f, 'verify-code', expired)).status, 401);
  const disabled = await request(f.other.email);
  f.store.updateUser(f.other.id, { ...f.other, active: false });
  assert.equal((await post(f, 'verify-code', disabled)).status, 401);
  failDelivery = true;
  assert.equal((await post(f, 'request-code', { email: 'failed@example.test' })).status, 503);
  assert.equal(
    f.store.db
      .prepare('SELECT id FROM login_codes WHERE email_lookup=?')
      .get(f.store.emailLookup('failed@example.test')),
    undefined,
  );
});

test('first verified email creates a staff profile without driver or administrator privileges', async (t) => {
  let message;
  const f = await fixture(t, {
    sendSignInCode: async (mail) => {
      message = mail;
    },
  });
  const requested = await post(f, 'request-code', { email: 'new@example.test' });
  const session = await post(f, 'verify-code', {
    challengeId: requested.body.challengeId,
    code: message.text.match(/code is (\d{6})/)[1],
  });
  assert.equal(session.status, 200);
  assert.equal(session.body.user.role, 'staff');
  assert.equal(session.body.user.authorizedDriver, false);
  assert.equal(session.body.user.charter, '');
  const headers = {
    Cookie: session.cookie,
    'X-CSRF-Token': session.body.csrfToken,
    'Content-Type': 'application/json',
  };
  const profile = await fetch(f.url + '/api/auth/profile', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      name: 'New Driver',
      email: 'new@example.test',
      charter: 'New Charter',
      manager: 'New Manager',
    }),
  });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).user.department, 'New Charter');
  assert.equal((await fetch(f.url + '/api/admin/users', { headers })).status, 403);
  assert.equal(
    (
      await fetch(f.url + '/api/trips/checkout', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: '{}',
      })
    ).status,
    403,
  );
});

test('legacy profiles and snapshots migrate without changing signed content; wrong keys fail closed', async (t) => {
  const f = await fixture(t);
  const vehicle = await f.addVehicle();
  const checkout = await f.checkout(f.s, vehicle);
  const snapshot = f.store.getTrip(checkout.data.trip.id).employeeSnapshot;
  f.store.db
    .prepare('UPDATE users SET email=?,name=?,department=?,manager=?,profile_json=NULL WHERE id=?')
    .run(f.staff.email, f.staff.name, f.staff.department, f.staff.manager, f.staff.id);
  const row = f.store.db
    .prepare('SELECT checkout_json FROM trips WHERE id=?')
    .get(checkout.data.trip.id);
  const decoded = f.store.decodeJSON(row.checkout_json);
  f.store.db
    .prepare('UPDATE trips SET checkout_json=? WHERE id=?')
    .run(JSON.stringify(decoded), checkout.data.trip.id);
  const migrated = openStore(f.directory);
  assert.equal(migrated.getUser(f.staff.id).email, f.staff.email);
  assert.deepEqual(migrated.getTrip(checkout.data.trip.id).employeeSnapshot, snapshot);
  migrated.close();
  const keyPath = path.join(f.directory, '.development-profile-key');
  const correctKey = await readFile(keyPath);
  await writeFile(keyPath, 'cd'.repeat(32));
  try {
    assert.throws(() => openStore(f.directory), /Incorrect profile encryption key/);
  } finally {
    await writeFile(keyPath, correctKey);
  }
  const reopened = openStore(f.directory);
  assert.equal(reopened.getUser(f.staff.id).email, f.staff.email);
  reopened.close();
});
