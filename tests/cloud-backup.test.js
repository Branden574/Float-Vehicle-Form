import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { backupKey, seal, unseal, safeEvidence } from '../scripts/cloud-backup.js';

test('cloud backups authenticate ciphertext, keys and envelope headers', () => {
  const key = backupKey(randomBytes(32).toString('hex'));
  const data = Buffer.from('private fleet record');
  const encrypted = seal(data, key);
  assert.deepEqual(unseal(encrypted, key), data);
  assert.notDeepEqual(encrypted, seal(data, key));
  assert.throws(() => unseal(encrypted, randomBytes(32)));
  for (const at of [0, 8, 20, 36]) {
    const corrupt = Buffer.from(encrypted);
    corrupt[at] ^= 1;
    assert.throws(() => unseal(corrupt, key));
  }
  assert.throws(() => backupKey('short'));
});
test('recovery paths cannot escape the evidence directory', () => {
  for (const value of [
    '../secret',
    'photos/../secret',
    '/photos/x',
    'photos//x',
    'reports/./x',
    'photos/a\\b',
    'photos/a\0b',
    'other/file',
  ])
    assert.throws(() => safeEvidence(value));
  assert.equal(safeEvidence('photos/trip/image.jpg'), 'photos/trip/image.jpg');
});
