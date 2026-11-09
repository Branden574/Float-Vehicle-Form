import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_FORMAT,
  checksum,
  copyPrivate,
  requirePlainDirectory,
  requirePlainPath,
  safeRelative,
} from './backup.js';

export async function restoreBackup({
  source,
  dataDir = process.env.DATA_DIR || './data',
  offline = false,
  overwrite = false,
} = {}) {
  if (!offline)
    throw new Error(
      'Stop the application first, then pass --offline to acknowledge the offline restore requirement.',
    );
  if (!source) throw new Error('A backup directory is required.');
  const backupRoot = await requirePlainDirectory(source);
  const destination = path.resolve(dataDir);
  if (
    backupRoot === destination ||
    backupRoot.startsWith(`${destination}${path.sep}`) ||
    destination.startsWith(`${backupRoot}${path.sep}`)
  ) {
    throw new Error('Source backup and destination data directories must be separate.');
  }
  if (existsSync(path.join(backupRoot, '.incomplete')))
    throw new Error('Refusing an incomplete backup.');
  const manifestPath = await requirePlainPath(backupRoot, 'manifest.json');
  if ((await fs.stat(manifestPath)).size > 20 * 1024 ** 2)
    throw new Error('Backup manifest is too large.');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (
    manifest.format !== BACKUP_FORMAT ||
    manifest.application !== 'learn4life-fleet-checkout' ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('Unsupported backup manifest.');
  }
  const names = new Set();
  for (const file of manifest.files) {
    safeRelative(file.path);
    if (
      names.has(file.path) ||
      (file.path !== 'fleet.sqlite' &&
        !file.path.startsWith('photos/') &&
        !file.path.startsWith('reports/'))
    ) {
      throw new Error('Backup contains duplicate or unexpected file paths.');
    }
    names.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('Invalid backup checksum record.');
    const sourcePath = await requirePlainPath(backupRoot, file.path);
    const actual = await checksum(sourcePath);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error(`Backup checksum mismatch: ${file.path}`);
  }
  if (!names.has('fleet.sqlite')) throw new Error('Backup has no database.');
  if (existsSync(destination)) {
    await requirePlainDirectory(destination);
    if ((await fs.readdir(destination)).length > 0 && !overwrite) {
      throw new Error(
        'Destination is not empty. Use a new DATA_DIR or pass --overwrite to preserve and replace the existing directory.',
      );
    }
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await requirePlainDirectory(path.dirname(destination));
  const staging = path.join(path.dirname(destination), `.fleet-restore-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  let previousDirectory = null;
  try {
    for (const file of manifest.files) {
      const actual = await copyPrivate(
        await requirePlainPath(backupRoot, file.path),
        path.join(staging, file.path),
      );
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
        throw new Error(`Backup changed while restoring: ${file.path}`);
    }
    await fs.mkdir(path.join(staging, 'photos'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(staging, 'reports'), { recursive: true, mode: 0o700 });
    const database = new Database(path.join(staging, 'fleet.sqlite'), { fileMustExist: true });
    try {
      if (database.pragma('integrity_check', { simple: true }) !== 'ok')
        throw new Error('Restored database failed integrity verification.');
      if (database.pragma('foreign_key_check').length)
        throw new Error('Restored database failed foreign-key verification.');
      for (const row of database.prepare('SELECT original_path, display_path FROM photos').all()) {
        if (!names.has(row.original_path) || !names.has(row.display_path))
          throw new Error('Backup is missing a database-referenced photo.');
      }
      database.transaction(() => {
        database.prepare('DELETE FROM sessions').run();
        database.prepare('UPDATE users SET invite_hash=NULL, invite_expires_at=NULL').run();
        // A queued message may have been sent after this snapshot was taken.
        database
          .prepare(
            "UPDATE notifications SET status='unknown', error=?, updated_at=? WHERE status IN ('pending','sending','processing','failed','awaiting_review')",
          )
          .run(
            'Restored backup: delivery may have occurred after the snapshot. Review provider records before resending.',
            new Date().toISOString(),
          );
      })();
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      database.close();
    }
    await fs.writeFile(
      path.join(staging, 'restore-record.json'),
      JSON.stringify(
        {
          restoredAt: new Date().toISOString(),
          snapshotAt: manifest.snapshotAt,
          sessionsRevoked: true,
          invitationTokensRevoked: true,
          emailQueueRequiresReview: true,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    if (existsSync(destination)) {
      if ((await fs.readdir(destination)).length === 0) await fs.rmdir(destination);
      else {
        previousDirectory = `${destination}.before-restore-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
        await fs.rename(destination, previousDirectory);
      }
    }
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (previousDirectory && !existsSync(destination))
        await fs.rename(previousDirectory, destination);
      throw error;
    }
    return { destination, previousDirectory, snapshotAt: manifest.snapshotAt };
  } catch (error) {
    // Only this script's unique staging directory is removed, never source or live data.
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (existsSync('.env') && process.loadEnvFile) process.loadEnvFile();
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (
    args.includes('--help') ||
    positional.length !== 1 ||
    args.some((arg) => arg.startsWith('--') && !['--offline', '--overwrite'].includes(arg))
  ) {
    console.log(
      'Usage: node scripts/restore.js BACKUP_DIRECTORY --offline [--overwrite]\nStop the application before restoring. Uses DATA_DIR from .env or ./data. Existing nonempty data is preserved as a dated sibling only with --overwrite.',
    );
    process.exitCode = args.includes('--help') ? 0 : 1;
  } else {
    restoreBackup({
      source: positional[0],
      offline: args.includes('--offline'),
      overwrite: args.includes('--overwrite'),
    })
      .then((result) => {
        console.log(
          `Restored verified backup to: ${result.destination}\nAll sessions and pending invitation tokens were revoked. Review uncertain email jobs before resending.`,
        );
        if (result.previousDirectory)
          console.log(`Previous data preserved at: ${result.previousDirectory}`);
      })
      .catch((error) => {
        console.error(`Restore failed: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
