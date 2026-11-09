import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { listObjects, readObject, unseal } from './cloud-backup.js';

/** Fail closed: no deletion receipt is completed until every obsolete object is gone. */
export async function pruneBackups({ client, bucket, key, cutoff, time = Date.now() }) {
  const objects = await listObjects(client, bucket, 'snapshots/');
  const keep = new Set();
  const evidence = new Set();
  for (const object of objects.filter((o) => o.Key.endsWith('/manifest.aes'))) {
    const manifest = JSON.parse(unseal((await readObject(client, bucket, object.Key)).body, key));
    const start = Date.parse(manifest.startedAt);
    if (!Number.isFinite(start)) throw Error('Invalid snapshot timestamp');
    if (
      start <= Date.parse(cutoff || '1970-01-01') ||
      start <= time - 60 * 86400000 ||
      (manifest.expiresAt && Date.parse(manifest.expiresAt) <= time)
    )
      continue;
    if (manifest.database.key !== object.Key.replace('/manifest.aes', '/database.aes'))
      throw Error('Invalid snapshot database key');
    keep.add(object.Key);
    keep.add(manifest.database.key);
    for (const file of manifest.files) {
      if (!/^evidence\/[a-f0-9]{64}\.aes$/.test(file.key)) throw Error('Invalid evidence key');
      evidence.add(file.key);
    }
  }
  const remove = [
    ...objects.filter((o) => !keep.has(o.Key)),
    ...(await listObjects(client, bucket, 'evidence/')).filter((o) => !evidence.has(o.Key)),
  ];
  for (const object of remove)
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
  // R2 listings are strongly consistent. Verify removal, including any formerly locked files.
  const remaining = [
    ...(await listObjects(client, bucket, 'snapshots/')),
    ...(await listObjects(client, bucket, 'evidence/')),
  ];
  const removed = new Set(remove.map((o) => o.Key));
  if (remaining.some((o) => removed.has(o.Key))) throw Error('Backup erasure verification failed');
  return remove.length;
}

export async function assertRestorable(pool, manifest, time = Date.now()) {
  if (manifest.expiresAt && Date.parse(manifest.expiresAt) <= time) throw Error('Snapshot expired');
  if (Date.parse(manifest.startedAt) <= time - 60 * 86400000) throw Error('Snapshot expired');
  const result = await pool.query(
    'SELECT requested_at, primary_deleted_at FROM fleet.deletion_jobs',
  );
  if (
    result.rows.some(
      (r) =>
        !r.primary_deleted_at || Date.parse(r.primary_deleted_at) >= Date.parse(manifest.startedAt),
    )
  )
    throw Error('Snapshot predates an erasure; restoring it would restore deleted data');
}
