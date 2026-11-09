import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal } from '../scripts/cloud-backup.js';
import { pruneBackups, assertRestorable } from '../scripts/backup-retention.js';

test('backup erasure removes obsolete snapshots and unreferenced evidence, preserving newer clean recovery', async () => {
  const key = randomBytes(32),
    objects = new Map(),
    deleted = [];
  const oldEvidence = 'evidence/' + 'a'.repeat(64) + '.aes',
    shared = 'evidence/' + 'b'.repeat(64) + '.aes';
  const manifest = (id, date, files) => {
    objects.set(
      `snapshots/${id}/manifest.aes`,
      seal(
        Buffer.from(
          JSON.stringify({
            startedAt: date,
            database: { key: `snapshots/${id}/database.aes` },
            files: files.map((key) => ({ key })),
          }),
        ),
        key,
      ),
    );
    objects.set(`snapshots/${id}/database.aes`, Buffer.from('encrypted db'));
  };
  manifest('old', '2026-11-01T00:00:00Z', [oldEvidence, shared]);
  manifest('new', '2026-11-09T00:00:00Z', [shared]);
  objects.set(oldEvidence, Buffer.from('old'));
  objects.set(shared, Buffer.from('new'));
  const client = {
    send: async (command) => {
      const x = command.input;
      switch (command.constructor.name) {
        case 'ListObjectsV2Command':
          return {
            Contents: [...objects.keys()]
              .filter((k) => k.startsWith(x.Prefix))
              .map((Key) => ({ Key })),
          };
        case 'GetObjectCommand':
          return {
            Body: (async function* () {
              yield objects.get(x.Key);
            })(),
          };
        case 'DeleteObjectCommand':
          objects.delete(x.Key);
          deleted.push(x.Key);
          return {};
        default:
          throw Error('unexpected command');
      }
    },
  };
  assert.equal(
    await pruneBackups({
      client,
      bucket: 'test',
      key,
      cutoff: '2026-11-08T00:00:00Z',
      time: Date.parse('2026-11-10'),
    }),
    3,
  );
  assert.ok(!objects.has(oldEvidence));
  assert.ok(objects.has(shared));
  assert.ok(objects.has('snapshots/new/manifest.aes'));
  const pool = {
    query: async () => ({
      rows: [{ requested_at: '2026-11-08', primary_deleted_at: '2026-11-08' }],
    }),
  };
  await assert.rejects(
    assertRestorable(pool, { startedAt: '2026-11-01' }, Date.parse('2026-11-10')),
  );
  await assertRestorable(pool, { startedAt: '2026-11-09' }, Date.parse('2026-11-10'));
  await assert.rejects(
    assertRestorable(
      { query: async () => ({ rows: [{ primary_deleted_at: null }] }) },
      { startedAt: '2026-11-09' },
      Date.parse('2026-11-10'),
    ),
  );
});
