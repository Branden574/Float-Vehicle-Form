import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import { pruneBackups } from './backup-retention.js';

const MAGIC = Buffer.from('L4LBK001');
const MAX_OBJECT = 128 * 1024 * 1024;
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function backupKey(value) {
  if (!/^[a-f0-9]{64}$/i.test(value || ''))
    throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes in hex.');
  return Buffer.from(value, 'hex');
}
export function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}
export function unseal(value, key) {
  if (value.length < 36 || !value.subarray(0, 8).equals(MAGIC))
    throw new Error('Invalid backup format');
  const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(8, 20));
  cipher.setAAD(MAGIC);
  cipher.setAuthTag(value.subarray(20, 36));
  return Buffer.concat([cipher.update(value.subarray(36)), cipher.final()]);
}
export function safeEvidence(value) {
  if (
    !/^(photos|reports)\//.test(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Invalid evidence path');
  return value;
}
export async function command(bin, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    // Never forward connection strings, dump contents, or provider error bodies into CI logs.
    child.stderr.resume();
    child.on('error', () => reject(new Error(`Unable to start ${bin}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} failed (exit ${code})`)),
    );
  });
}
export function pgEnvironment(url, caPath) {
  const connection = new URL(url);
  if (!/^postgres(ql)?:$/.test(connection.protocol)) throw new Error('Invalid database URL');
  return {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || '5432',
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: caPath,
  };
}
export function storage(env = process.env, source = false) {
  return new S3Client({
    endpoint: env.R2_ENDPOINT,
    region: 'auto',
    forcePathStyle: true,
    maxAttempts: 4,
    credentials: {
      accessKeyId: source ? env.BACKUP_SOURCE_ACCESS_KEY_ID : env.BACKUP_R2_ACCESS_KEY_ID,
      secretAccessKey: source
        ? env.BACKUP_SOURCE_SECRET_ACCESS_KEY
        : env.BACKUP_R2_SECRET_ACCESS_KEY,
    },
  });
}
export async function readObject(client, bucket, key) {
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (object.ContentLength > MAX_OBJECT + 36) {
    object.Body.destroy();
    throw new Error('Backup object exceeds supported size');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of object.Body) {
    bytes += chunk.length;
    if (bytes > MAX_OBJECT + 36) {
      object.Body.destroy();
      throw new Error('Backup object exceeds supported size');
    }
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), etag: object.ETag, metadata: object.Metadata || {} };
}
export async function listObjects(client, bucket, prefix) {
  const objects = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    objects.push(...(page.Contents || []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}
async function putVerified(client, bucket, objectPath, plain, key) {
  const encrypted = seal(plain, key);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectPath,
      Body: encrypted,
      ContentType: 'application/octet-stream',
      IfNoneMatch: '*',
      Metadata: { sha256: hash(plain), bytes: String(plain.length) },
    }),
  );
  const saved = unseal((await readObject(client, bucket, objectPath)).body, key);
  if (hash(saved) !== hash(plain)) throw new Error('Backup read-back verification failed');
}
export async function createCloudBackup(env = process.env) {
  for (const name of [
    'BACKUP_DATABASE_URL',
    'BACKUP_SOURCE_ACCESS_KEY_ID',
    'BACKUP_SOURCE_SECRET_ACCESS_KEY',
    'BACKUP_R2_ACCESS_KEY_ID',
    'BACKUP_R2_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
  ]) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  const key = backupKey(env.BACKUP_ENCRYPTION_KEY);
  if (!env.BACKUP_BUCKET || !env.R2_BUCKET || env.BACKUP_BUCKET === env.R2_BUCKET)
    throw new Error('A separate private backup bucket is required');
  const caPath = fileURLToPath(new URL('../server/certs/supabase-ca.crt', import.meta.url));
  const pool = new pg.Pool({
    connectionString: env.BACKUP_DATABASE_URL,
    ssl: { ca: await fs.readFile(caPath, 'utf8'), rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 15000,
  });
  const source = storage(env, true);
  const target = storage(env);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-cloud-backup-'));
  await fs.chmod(temp, 0o700);
  const startedAt = new Date().toISOString();
  const id = `${startedAt.replaceAll(':', '-')}-${randomBytes(6).toString('hex')}`;
  const manifest = {
    format: 1,
    application: 'learn4life-fleet-checkout',
    id,
    startedAt,
    gitCommit: env.GITHUB_SHA || null,
    tables: {},
    files: [],
  };
  let client;
  try {
    const deletionJobs = (await pool.query('SELECT id,primary_deleted_at FROM fleet.deletion_jobs'))
      .rows;
    if (deletionJobs.some((j) => !j.primary_deleted_at))
      throw Error('An erasure is pending; retry after primary cleanup');
    const cutoff = deletionJobs
      .map((j) => j.primary_deleted_at)
      .sort()
      .at(-1);
    await pruneBackups({ client: target, bucket: env.BACKUP_BUCKET, key, cutoff });
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='120s'");
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const tables = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='fleet' ORDER BY tablename",
      )
    ).rows;
    if (!tables.length) throw new Error('No fleet tables found');
    for (const { tablename } of tables) {
      if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table name');
      manifest.tables[tablename] = Number(
        (await client.query(`SELECT count(*) AS count FROM fleet.${tablename}`)).rows[0].count,
      );
    }
    const closed = (
      await client.query(
        "SELECT COALESCE(returned_at,checkout_at) AS ended FROM fleet.trips WHERE status IN ('returned','cancelled')",
      )
    ).rows;
    const expiry = Math.min(
      Date.now() + 60 * 86400000,
      ...closed.map((r) => Date.parse(r.ended) + 60 * 86400000),
    );
    if (expiry <= Date.now()) throw Error('Trip retention cleanup must finish before backup');
    manifest.expiresAt = new Date(expiry).toISOString();
    const photos = (await client.query('SELECT original_path, display_path FROM fleet.photos'))
      .rows;
    const trips = new Set(
      (await client.query('SELECT id FROM fleet.trips')).rows.map((row) => row.id),
    );
    manifest.profileKeyFingerprint = (
      await client.query('SELECT key_check FROM fleet.privacy_meta WHERE id=1')
    ).rows[0]?.key_check;
    const dumpFile = path.join(temp, 'database.dump');
    await command(
      'pg_dump',
      [
        '--format=custom',
        '--schema=fleet',
        '--no-owner',
        '--no-acl',
        '--enable-row-security',
        `--snapshot=${snapshot}`,
        `--file=${dumpFile}`,
      ],
      pgEnvironment(env.BACKUP_DATABASE_URL, caPath),
    );
    await client.query('COMMIT');
    client.release();
    client = null;
    const dump = await fs.readFile(dumpFile);
    if (dump.length > MAX_OBJECT)
      throw new Error('Database backup exceeds supported size; increase backup capacity');
    await command('pg_restore', ['--list', dumpFile]);
    manifest.database = {
      key: `snapshots/${id}/database.aes`,
      bytes: dump.length,
      sha256: hash(dump),
    };
    await putVerified(target, env.BACKUP_BUCKET, manifest.database.key, dump, key);
    const paths = new Set(
      photos.flatMap((row) => [safeEvidence(row.original_path), safeEvidence(row.display_path)]),
    );
    const reports = await listObjects(source, env.R2_BUCKET, 'reports/');
    for (const report of reports) {
      if (
        report.Key.endsWith('.pdf') &&
        [...trips].some((trip) => report.Key.startsWith(`reports/${trip}-`))
      )
        paths.add(safeEvidence(report.Key));
    }
    for (const originalPath of [...paths].sort()) {
      const head = await source.send(
        new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: originalPath }),
      );
      if (head.ContentLength > MAX_OBJECT)
        throw new Error('Evidence exceeds supported backup size');
      const objectKey = `evidence/${hash(`${originalPath}\n${head.ETag}\n${head.ContentLength}`)}.aes`;
      let existing;
      try {
        existing = await target.send(
          new HeadObjectCommand({ Bucket: env.BACKUP_BUCKET, Key: objectKey }),
        );
      } catch (error) {
        if (error.$metadata?.httpStatusCode !== 404) throw error;
      }
      let checksum;
      if (existing) {
        checksum = existing.Metadata?.sha256;
        if (
          !/^[a-f0-9]{64}$/.test(checksum || '') ||
          existing.Metadata?.bytes !== String(head.ContentLength) ||
          existing.ContentLength !== head.ContentLength + 36
        )
          throw new Error('Existing backup metadata mismatch');
      } else {
        const object = await readObject(source, env.R2_BUCKET, originalPath);
        if (object.etag !== head.ETag || object.body.length !== head.ContentLength)
          throw new Error('Evidence changed during backup');
        checksum = hash(object.body);
        await putVerified(target, env.BACKUP_BUCKET, objectKey, object.body, key);
      }
      manifest.files.push({
        path: originalPath,
        key: objectKey,
        bytes: head.ContentLength,
        sha256: checksum,
      });
    }
    manifest.completedAt = new Date().toISOString();
    // Commit marker is written last. An interrupted run is never a restorable snapshot.
    const manifestKey = `snapshots/${id}/manifest.aes`;
    await putVerified(
      target,
      env.BACKUP_BUCKET,
      manifestKey,
      Buffer.from(JSON.stringify(manifest)),
      key,
    );
    const latestJobs = (await pool.query('SELECT id,primary_deleted_at FROM fleet.deletion_jobs'))
      .rows;
    if (
      latestJobs.some(
        (j) => !j.primary_deleted_at || Date.parse(j.primary_deleted_at) >= Date.parse(startedAt),
      )
    ) {
      await pruneBackups({
        client: target,
        bucket: env.BACKUP_BUCKET,
        key,
        cutoff: new Date().toISOString(),
      });
      throw Error('Erasure occurred during backup; retry with a fresh snapshot');
    }
    await pruneBackups({ client: target, bucket: env.BACKUP_BUCKET, key, cutoff });
    for (const job of deletionJobs)
      await pool.query(
        'UPDATE fleet.deletion_jobs SET completed_at=$1 WHERE id=$2 AND primary_deleted_at IS NOT NULL AND completed_at IS NULL',
        [new Date().toISOString(), job.id],
      );
    const result = {
      id,
      manifestKey,
      completedAt: manifest.completedAt,
      tables: Object.keys(manifest.tables).length,
      evidenceFiles: manifest.files.length,
      evidenceBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    };
    console.log(JSON.stringify(result));
    if (env.BACKUP_RESULT_FILE)
      await fs.writeFile(env.BACKUP_RESULT_FILE, JSON.stringify(result), { mode: 0o600 });
    if (env.GITHUB_STEP_SUMMARY)
      await fs.appendFile(
        env.GITHUB_STEP_SUMMARY,
        `### Fleet backup completed\n\n- Snapshot: ${id}\n- Tables: ${result.tables}\n- Evidence files: ${result.evidenceFiles}\n- Evidence bytes: ${result.evidenceBytes}\n- New encrypted objects downloaded and verified after upload.\n- Restore manifest committed last; incomplete runs cannot be selected.\n`,
      );
    return result;
  } finally {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    await pool.end();
    source.destroy();
    target.destroy();
    await fs.rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createCloudBackup().catch((error) => {
    console.error(
      `Cloud backup failed: ${error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]')}`,
    );
    process.exitCode = 1;
  });
}
