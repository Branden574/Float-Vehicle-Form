import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('only the verified owner can unlock a local inspection draft after signing back in', async (t) => {
  const f = await fixture(t);
  const route = '/inspection-draft-key';
  const anonymous = await fetch(f.url + '/api' + route);
  assert.equal(anonymous.status, 401);
  const mine = await f.s.request(route);
  assert.equal(mine.status, 200);
  assert.match(mine.headers.get('Cache-Control'), /no-store/);
  assert.equal(mine.data.owner, f.staff.id);
  assert.equal(Buffer.from(mine.data.key, 'base64').length, 32);
  const other = await f.o.request(route + '?owner=' + f.staff.id);
  assert.equal(other.data.owner, f.other.id);
  assert.notEqual(other.data.key, mine.data.key);
  await f.s.request('/auth/logout', { method: 'POST', body: {} });
  assert.equal((await f.s.request(route)).status, 401);
  const next = await f.client(f.staff.email);
  assert.deepEqual((await next.request(route)).data, mine.data);
});
