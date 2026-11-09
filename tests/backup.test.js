import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { fixture } from './helpers.js';
import { createBackup } from '../scripts/backup.js';
import { restoreBackup } from '../scripts/restore.js';

test('backup restores referenced private photos and database, revokes sessions and detects corrupted evidence', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  await f.checkout(f.s, v);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-backup-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'snapshot');
  const backup = await createBackup({ dataDir: f.directory, destination: source });
  assert.equal(backup.manifest.files.length, 9);
  await assert.rejects(restoreBackup({ source, dataDir: path.join(root, 'restored') }), /offline/);
  const restored = await restoreBackup({
    source,
    dataDir: path.join(root, 'restored'),
    offline: true,
  });
  const db = new Database(path.join(restored.destination, 'fleet.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trips').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM notifications').get().status, 'unknown');
  db.close();
  await writeFile(path.join(source, backup.manifest.files[1].path), 'corruption');
  await assert.rejects(
    restoreBackup({ source, dataDir: path.join(root, 'corrupt'), offline: true }),
    /checksum/,
  );
});

test('backup rejects symlinked evidence and never overwrites a snapshot', async (t) => {
  const f = await fixture(t),
    v = await f.addVehicle();
  const c = await f.checkout(f.s, v);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-backup-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createBackup({ dataDir: f.directory, destination: path.join(root, 'snapshot') });
  await assert.rejects(
    createBackup({ dataDir: f.directory, destination: path.join(root, 'snapshot') }),
    /exist/,
  );
  const p = f.store.getTripBundle(c.data.trip.id).photos[0].originalPath;
  await rm(p);
  await symlink(f.store.getTripBundle(c.data.trip.id).photos[1].originalPath, p);
  await assert.rejects(
    createBackup({ dataDir: f.directory, destination: path.join(root, 'symlink') }),
    /non-regular/,
  );
});
