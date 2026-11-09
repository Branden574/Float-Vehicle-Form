/** One-time, verified migration from a local backup into an empty cloud database. */
import Database from 'better-sqlite3';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openStore, hash } from '../server/store.js';
import { openPrivacy } from '../server/privacy.js';
import { safeRelative, checksum } from './backup.js';

const source = process.env.SOURCE_BACKUP;
if (
  !source ||
  !process.env.DATABASE_URL ||
  !process.env.R2_BUCKET ||
  !process.env.PROFILE_ENCRYPTION_KEY
)
  throw Error('SOURCE_BACKUP and private cloud configuration are required');
const sourceDB = new Database(path.join(source, 'fleet.sqlite'), { readonly: true });
const store = await openStore();
const privacy = openPrivacy(source);
const tables = [
  'users',
  'vehicles',
  'trips',
  'photos',
  'reviews',
  'revisions',
  'odometer_replacements',
  'audit',
  'notifications',
  'idempotency',
];
try {
  if (
    sourceDB.prepare('SELECT key_check FROM privacy_meta WHERE id=1').get()?.key_check !==
    privacy.fingerprint
  )
    throw Error('Source encryption key does not match');
  for (const table of tables)
    if ((await store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n)
      throw Error('Cloud database is not empty; refusing to replace existing records');
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  let files = 0,
    bytes = 0;
  for (const item of manifest.files) {
    const relative = safeRelative(item.path);
    if (!/^(photos|reports)\//.test(relative)) continue;
    const local = path.join(source, relative);
    const verified = await checksum(local);
    if (verified.sha256 !== item.sha256 || verified.bytes !== item.bytes)
      throw Error('Backup evidence verification failed');
    const data = await readFile(local);
    try {
      await store.evidence.put(
        relative,
        data,
        relative.endsWith('.pdf')
          ? 'application/pdf'
          : relative.endsWith('.jpg')
            ? 'image/jpeg'
            : 'application/octet-stream',
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const remote = await store.evidence.read(relative);
    if (hash(remote) !== item.sha256) throw Error('Cloud evidence verification failed');
    files++;
    bytes += data.length;
  }
  const counts = {};
  await store.db.transaction(async () => {
    for (const table of tables) {
      const rows = sourceDB.prepare(`SELECT * FROM ${table}`).all();
      counts[table] = rows.length;
      for (const row of rows) {
        const columns = Object.keys(row);
        await store.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((c) => row[c]));
      }
    }
    await store.db
      .prepare('UPDATE settings SET data_json=? WHERE id=1')
      .run(sourceDB.prepare('SELECT data_json FROM settings WHERE id=1').get().data_json);
    for (const table of tables) {
      const local = sourceDB
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const remote = (await store.db.prepare(`SELECT * FROM ${table}`).all())
        .map((r) => Object.fromEntries(Object.keys(local[0] || {}).map((k) => [k, r[k]])))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (JSON.stringify(local) !== JSON.stringify(remote))
        throw Error(`Record verification failed: ${table}`);
    }
  })();
  const admin = await store.db
    .prepare("SELECT * FROM users WHERE role='admin' AND email=?")
    .get(store.emailLookup('branden574@gmail.com'));
  if (!admin || store.publicUser(admin).email !== 'branden574@gmail.com')
    throw Error('Expected administrator account was not preserved');
  const result = {
    counts,
    evidenceFiles: files,
    evidenceBytes: bytes,
    exactRecords: true,
    matchingEvidenceHashes: true,
    administratorPreserved: true,
    sessionsMigrated: false,
    completedAt: new Date().toISOString(),
  };
  if (process.env.MIGRATION_REPORT)
    await writeFile(process.env.MIGRATION_REPORT, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} finally {
  sourceDB.close();
  await store.close();
}
