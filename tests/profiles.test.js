import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, password } from './helpers.js';
import { openStore } from '../server/store.js';

async function post(f, route, body) {
  const response = await fetch(f.url + '/api/auth/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: Number(response.headers.get('Retry-After')),
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
  const second = await openStore(f.directory);
  assert.equal((await second.getUser(f.staff.id)).charter, profile.charter);
  await second.close();
  const row = await f.store.db.prepare('SELECT * FROM users WHERE id=?').get(f.staff.id);
  assert.equal(row.name, '');
  assert.notEqual(row.email, profile.email);
  assert.match(row.profile_json, /^enc:v1:/);
  await f.store.db.pragma('wal_checkpoint(TRUNCATE)');
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
  for (const email of ['attempts@example.test', 'expired@example.test', 'failed@example.test']) {
    const result = await f.a.request('/admin/staff-approvals', { method: 'POST', body: { email } });
    assert.equal(result.status, 200);
  }
  const limited = await request('attempts@example.test');
  const wrong = limited.code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++)
    assert.equal((await post(f, 'verify-code', { ...limited, code: wrong })).status, 401);
  assert.equal((await post(f, 'verify-code', limited)).status, 401);
  const expired = await request('expired@example.test');
  await f.store.db
    .prepare('UPDATE login_codes SET expires_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z', expired.challengeId);
  assert.equal((await post(f, 'verify-code', expired)).status, 401);
  const disabled = await request(f.other.email);
  await f.store.updateUser(f.other.id, { ...f.other, active: false });
  assert.equal((await post(f, 'verify-code', disabled)).status, 401);
  failDelivery = true;
  assert.equal((await post(f, 'request-code', { email: 'failed@example.test' })).status, 503);
  assert.equal(
    await f.store.db
      .prepare('SELECT id FROM login_codes WHERE email_lookup=?')
      .get(f.store.emailLookup('failed@example.test')),
    undefined,
  );
});

test('an administrator approves a staff email for passwordless access without driver or administrator privileges', async (t) => {
  let message;
  const f = await fixture(t, {
    sendSignInCode: async (mail) => {
      message = mail;
    },
  });
  const email = 'new@example.test';
  const approval = { method: 'POST', body: { email: ' NEW@example.test ' } };
  assert.equal((await f.s.request('/admin/staff-approvals', approval)).status, 403);
  const approved = await f.a.request('/admin/staff-approvals', approval);
  assert.equal(approved.status, 200);
  assert.equal(approved.data.user.email, email);
  assert.equal(approved.data.user.staffApproved, true);
  assert.equal(
    (await f.a.request('/admin/staff-approvals', approval)).data.user.id,
    approved.data.user.id,
  );
  const requested = await post(f, 'request-code', { email });
  const session = await post(f, 'verify-code', {
    challengeId: requested.body.challengeId,
    code: message.text.match(/code is (\d{6})/)[1],
  });
  assert.equal(session.status, 200);
  assert.equal(session.body.user.role, 'staff');
  assert.equal(session.body.user.canAccessFleet, true);
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
  const snapshot = (await f.store.getTrip(checkout.data.trip.id)).employeeSnapshot;
  await f.store.db
    .prepare('UPDATE users SET email=?,name=?,department=?,manager=?,profile_json=NULL WHERE id=?')
    .run(f.staff.email, f.staff.name, f.staff.department, f.staff.manager, f.staff.id);
  const row = await f.store.db
    .prepare('SELECT checkout_json FROM trips WHERE id=?')
    .get(checkout.data.trip.id);
  const decoded = f.store.decodeJSON(row.checkout_json);
  await f.store.db
    .prepare('UPDATE trips SET checkout_json=? WHERE id=?')
    .run(JSON.stringify(decoded), checkout.data.trip.id);
  const migrated = await openStore(f.directory);
  assert.equal((await migrated.getUser(f.staff.id)).email, f.staff.email);
  assert.deepEqual((await migrated.getTrip(checkout.data.trip.id)).employeeSnapshot, snapshot);
  await migrated.close();
  const keyPath = path.join(f.directory, '.development-profile-key');
  const correctKey = await readFile(keyPath);
  await writeFile(keyPath, 'cd'.repeat(32));
  try {
    await assert.rejects(
      async () => await openStore(f.directory),
      /Incorrect profile encryption key/,
    );
  } finally {
    await writeFile(keyPath, correctKey);
  }
  const reopened = await openStore(f.directory);
  assert.equal((await reopened.getUser(f.staff.id)).email, f.staff.email);
  await reopened.close();
});

test('email code resend enforces a minute and invalidates the previous challenge', async (t) => {
  const messages = [];
  const f = await fixture(t, { sendSignInCode: async (mail) => messages.push(mail) });
  const first = await post(f, 'request-code', { email: f.staff.email });
  assert.equal(first.body.retryAfterSeconds, 60);
  const blocked = await post(f, 'request-code', { email: f.staff.email });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 60);
  assert.equal(messages.length, 1);
  await f.store.db
    .prepare('UPDATE login_codes SET created_at=? WHERE id=?')
    .run(new Date(Date.now() - 61000).toISOString(), first.body.challengeId);
  const next = await post(f, 'request-code', { email: f.staff.email });
  assert.equal(next.status, 200);
  assert.equal(messages.length, 2);
  assert.notEqual(next.body.challengeId, first.body.challengeId);
  const oldCode = messages[0].text.match(/code is (\d{6})/)[1];
  const newCode = messages[1].text.match(/code is (\d{6})/)[1];
  assert.equal(
    (await post(f, 'verify-code', { challengeId: first.body.challengeId, code: oldCode })).status,
    401,
  );
  assert.equal(
    (await post(f, 'verify-code', { challengeId: next.body.challengeId, code: newCode })).status,
    200,
  );
});

test('unknown and email-copy-only addresses cannot open a fleet account', async (t) => {
  const f = await fixture(t, {
    sendSignInCode: async () => assert.fail('Unknown address received an OTP'),
  });
  const email = 'assistant@example.test';
  assert.equal(
    (
      await f.a.request('/admin/settings', {
        method: 'PATCH',
        body: { notificationRecipients: [email], reason: 'Send form copies to assistant' },
      })
    ).status,
    200,
  );
  const request = await post(f, 'request-code', { email });
  assert.equal(request.status, 200);
  assert.equal(request.body.retryAfterSeconds, 60);
  assert.equal((await post(f, 'request-code', { email })).status, 429);
  assert.equal(
    await f.store.db.prepare('SELECT id FROM users WHERE email=?').get(f.store.emailLookup(email)),
    undefined,
  );
});

test('legacy profiles retain deletion access; reviewer-only access follows the current assignment', async (t) => {
  const messages = [];
  const f = await fixture(t, { sendSignInCode: async (mail) => messages.push(mail) });
  async function signIn(email) {
    const request = await post(f, 'request-code', { email });
    assert.deepEqual(messages.at(-1).to, [email]);
    const session = await post(f, 'verify-code', {
      challengeId: request.body.challengeId,
      code: messages.at(-1).text.match(/code is (\d{6})/)[1],
    });
    assert.equal(session.status, 200);
    return {
      user: session.body.user,
      headers: {
        Cookie: session.cookie,
        'X-CSRF-Token': session.body.csrfToken,
        'Content-Type': 'application/json',
      },
    };
  }
  const legacy = await f.store.createUser({
    name: 'Former applicant',
    email: 'applicant@example.test',
    staffApproved: false,
  });
  const applicant = await signIn(legacy.email);
  assert.equal(applicant.user.canAccessFleet, false);
  for (const route of ['/vehicles', '/trips', '/admin/overview'])
    assert.equal((await fetch(f.url + '/api' + route, { headers: applicant.headers })).status, 403);
  assert.equal(
    (
      await fetch(f.url + '/api/auth/delete-account', {
        method: 'POST',
        headers: applicant.headers,
        body: JSON.stringify({ confirmation: 'DELETE' }),
      })
    ).status,
    202,
  );
  const email = 'reviewer-only@example.test';
  async function setReviewers(emails) {
    assert.equal(
      (
        await f.a.request('/admin/settings', {
          method: 'PATCH',
          body: { returnReviewerEmails: emails, reason: 'Change assigned return reviewers' },
        })
      ).status,
      200,
    );
  }
  await setReviewers([email]);
  const reviewer = await signIn(email);
  assert.equal(reviewer.user.staffApproved, false);
  assert.equal(reviewer.user.canReviewReturns, true);
  assert.equal((await fetch(f.url + '/api/vehicles', { headers: reviewer.headers })).status, 200);
  await setReviewers([]);
  assert.equal((await fetch(f.url + '/api/vehicles', { headers: reviewer.headers })).status, 403);
  assert.equal(
    (await (await fetch(f.url + '/api/auth/me', { headers: reviewer.headers })).json()).user
      .canAccessFleet,
    false,
  );
});

test('removing email approval immediately revokes active sessions, preserves deletion and permits reapproval', async (t) => {
  const f = await fixture(t);
  const remove = await f.a.request('/admin/users/' + f.staff.id, {
    method: 'PATCH',
    body: {
      staffApproved: false,
      authorizedDriver: false,
      reason: 'Remove fleet workspace access',
    },
  });
  assert.equal(remove.status, 200);
  assert.equal(remove.data.user.staffApproved, false);
  assert.equal((await f.s.request('/vehicles')).status, 401);
  const returning = await f.client(f.staff.email);
  assert.equal(returning.user.canAccessFleet, false);
  assert.equal((await returning.request('/vehicles')).status, 403);
  const grant = await f.a.request('/admin/staff-approvals', {
    method: 'POST',
    body: { email: f.staff.email },
  });
  assert.equal(grant.status, 200);
  assert.equal(grant.data.user.id, f.staff.id);
  assert.equal(grant.data.user.authorizedDriver, false);
  assert.equal((await returning.request('/vehicles')).status, 200);
});

test('staff migration keeps previously invited staff and drivers while requiring approval for self-registrations', async (t) => {
  const f = await fixture(t);
  if (f.store.db.kind !== 'sqlite') return t.skip('SQLite migration fixture');
  const invited = await f.store.createUser({ name: 'Invited', email: 'invited@example.test' });
  await f.store.audit(
    f.admin.id,
    'invite_user',
    'user',
    invited.id,
    null,
    null,
    'Administrator invited staff member',
  );
  const visitor = await f.store.createUser({ name: 'Visitor', email: 'visitor@example.test' });
  await f.store.db.exec('ALTER TABLE users DROP COLUMN staff_approved');
  const migrated = await openStore(f.directory);
  try {
    for (const user of [f.admin, f.staff, invited])
      assert.equal((await migrated.getUser(user.id)).staffApproved, true);
    assert.equal((await migrated.getUser(visitor.id)).staffApproved, false);
  } finally {
    await migrated.close();
  }
});

test('remembered email sessions have a fixed 60-day lifetime, require fresh authentication for sensitive actions, and sign out per device', async (t) => {
  const messages = [];
  const f = await fixture(t, { sendSignInCode: async (mail) => messages.push(mail) });
  const {
    body: { challengeId },
  } = await post(f, 'request-code', { email: f.staff.email });
  const code = messages[0].text.match(/code is (\d{6})/)[1];
  const response = await fetch(f.url + '/api/auth/verify-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, code, rememberMe: true }),
  });
  assert.equal(response.status, 200);
  const login = await response.json();
  const end = Date.parse(login.rememberedUntil);
  assert.ok(Math.abs(end - Date.now() - 60 * 86400000) < 5000);
  const header = response.headers.get('Set-Cookie');
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Strict/i);
  assert.ok(header.includes('Expires=' + new Date(end).toUTCString()));
  const cookie = header.split(';')[0];
  const call = (path, method = 'GET', session = cookie) =>
    fetch(f.url + '/api/auth/' + path, {
      method,
      headers: { Cookie: session, 'X-CSRF-Token': login.csrfToken },
    });
  await f.store.db
    .prepare('UPDATE sessions SET created_at=?,last_seen_at=? WHERE user_id=?')
    .run(
      new Date(Date.now() - 59 * 86400000).toISOString(),
      new Date(Date.now() - 58 * 86400000).toISOString(),
      f.staff.id,
    );
  const restored = await call('me');
  assert.equal((await restored.json()).rememberedUntil, login.rememberedUntil);
  assert.equal((await call('passkeys/register/options', 'POST')).status, 403);
  assert.equal(
    (await call('me', 'GET', f.s.cookie.replace('fleet_session=', 'fleet_session=r1.'))).status,
    401,
  );
  assert.equal((await f.s.request('/auth/me')).status, 401);
  const other = await post(f, 'login', { email: f.staff.email, password, rememberMe: true });
  assert.equal(other.status, 200);
  assert.equal((await call('logout', 'POST')).status, 204);
  assert.equal((await call('me')).status, 401);
  assert.equal((await call('me', 'GET', other.cookie)).status, 200);
  await f.store.db
    .prepare('UPDATE sessions SET expires_at=? WHERE user_id=?')
    .run(new Date(Date.now() - 1).toISOString(), f.staff.id);
  assert.equal((await call('me', 'GET', other.cookie)).status, 401);
});

test('offline sign-out proof revokes exactly one session and remains idempotent', async (t) => {
  const f = await fixture(t);
  const second = await post(f, 'login', { email: f.staff.email, password, rememberMe: true });
  const sessionId = createHash('sha256')
    .update(f.s.cookie.slice('fleet_session='.length))
    .digest('hex');
  const proof = createHmac('sha256', f.s.csrf)
    .update('fleet.revoke.v1:' + sessionId)
    .digest('hex');
  const revoke = (proof) =>
    fetch(f.url + '/api/auth/revoke-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, proof }),
    });
  assert.equal((await revoke('0'.repeat(64))).status, 403);
  assert.equal((await f.s.request('/auth/me')).status, 200);
  assert.equal((await revoke(proof)).status, 204);
  assert.equal((await revoke(proof)).status, 204);
  assert.equal((await f.s.request('/auth/me')).status, 401);
  assert.equal(
    (await fetch(f.url + '/api/auth/me', { headers: { Cookie: second.cookie } })).status,
    200,
  );
});
