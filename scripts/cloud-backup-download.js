import fs from 'node:fs/promises';
import pg from 'pg';
import { assertRestorable } from './backup-retention.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupKey, hash, readObject, safeEvidence, storage, unseal } from './cloud-backup.js';

// Download-only recovery tool: it cannot write into PostgreSQL or the live evidence bucket.
export async function downloadBackup({ manifestKey, destination, env = process.env }) {
  if (!/^snapshots\/[a-zA-Z0-9T.:-]+\/manifest\.aes$/.test(manifestKey || ''))
    throw new Error('Supply a valid snapshot manifest key');
  const root = path.resolve(destination);
  await fs.mkdir(root, { mode: 0o700 }); // Exclusive; never replace an existing recovery directory.
  await fs.writeFile(path.join(root, '.incomplete'), 'Do not restore this incomplete download.\n', {
    mode: 0o600,
  });
  if (!env.BACKUP_DATABASE_URL) throw Error('Live erasure ledger is required before recovery');
  const pool = new pg.Pool({
    connectionString: env.BACKUP_DATABASE_URL,
    ssl: {
      ca: await fs.readFile(new URL('../server/certs/supabase-ca.crt', import.meta.url), 'utf8'),
      rejectUnauthorized: true,
    },
    max: 1,
  });
  const client = storage(env);
  const key = backupKey(env.BACKUP_ENCRYPTION_KEY);
  try {
    const manifest = JSON.parse(
      unseal((await readObject(client, env.BACKUP_BUCKET, manifestKey)).body, key),
    );
    if (
      manifest.format !== 1 ||
      manifest.application !== 'learn4life-fleet-checkout' ||
      !manifest.completedAt ||
      !Array.isArray(manifest.files) ||
      !manifestKey.startsWith(`snapshots/${manifest.id}/`)
    )
      throw new Error('Invalid manifest');
    await assertRestorable(pool, manifest);
    for (const entry of [{ ...manifest.database, path: 'database.dump' }, ...manifest.files]) {
      if (entry.path !== 'database.dump') safeEvidence(entry.path);
      if (
        entry.path === 'database.dump'
          ? entry.key !== `snapshots/${manifest.id}/database.aes`
          : !/^evidence\/[a-f0-9]{64}\.aes$/.test(entry.key)
      )
        throw new Error('Invalid backup object key');
      const data = unseal((await readObject(client, env.BACKUP_BUCKET, entry.key)).body, key);
      if (hash(data) !== entry.sha256 || data.length !== entry.bytes)
        throw new Error('Recovery checksum mismatch');
      const target = path.join(root, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 });
    }
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    await assertRestorable(pool, manifest);
    await fs.unlink(path.join(root, '.incomplete'));
    return manifest;
  } finally {
    client.destroy();
    await pool.end();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  downloadBackup({ manifestKey: process.argv[2], destination: process.argv[3] })
    .then((m) =>
      console.log(`Verified recovery download: ${m.id}; ${m.files.length} evidence files`),
    )
    .catch(() => {
      console.error('Recovery failed; do not restore an incomplete directory.');
      process.exitCode = 1;
    });
}
