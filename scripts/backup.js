import Database from 'better-sqlite3';
import { constants, createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_FORMAT = 1;

export function safeRelative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.isAbsolute(value)
  ) {
    throw new Error('Backup contains an invalid relative file path.');
  }
  if (value.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new Error('Backup file paths must not contain traversal or empty segments.');
  }
  return value;
}

export async function requirePlainPath(root, relative, kind = 'file') {
  const parts = safeRelative(relative).split('/');
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current);
    const expectedDirectory = i < parts.length - 1 || kind === 'directory';
    if (stat.isSymbolicLink() || (expectedDirectory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Refusing non-regular backup path: ${relative}`);
    }
  }
  return current;
}

export async function requirePlainDirectory(directory) {
  const resolved = path.resolve(directory);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Data and backup roots must be real directories, not symlinks.');
  if ((await fs.realpath(resolved)) !== resolved)
    throw new Error('Data and backup parent paths must not contain symlinks.');
  return resolved;
}

export async function checksum(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  })) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

export async function copyPrivate(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let bytes = 0;
  const tracker = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }),
    tracker,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
  return { bytes, sha256: hash.digest('hex') };
}

async function reportFiles(dataDir, relative = 'reports') {
  const directory = path.join(dataDir, relative);
  if (!existsSync(directory)) return [];
  await requirePlainPath(dataDir, relative, 'directory');
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.endsWith('.tmp') || entry.name.includes('.tmp-')) continue;
    const next = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in reports: ${next}`);
    if (entry.isDirectory()) result.push(...(await reportFiles(dataDir, next)));
    else if (entry.isFile() && entry.name.endsWith('.pdf')) result.push(next);
    else if (!entry.isFile()) throw new Error(`Refusing non-regular report: ${next}`);
  }
  return result;
}

export async function createBackup({
  dataDir = process.env.DATA_DIR || './data',
  destination,
} = {}) {
  const sourceRoot = await requirePlainDirectory(dataDir);
  await requirePlainPath(sourceRoot, 'fleet.sqlite');
  const backupRoot = path.resolve(
    destination || `backups/fleet-${new Date().toISOString().replaceAll(':', '-')}`,
  );
  if (
    backupRoot === sourceRoot ||
    backupRoot.startsWith(`${sourceRoot}${path.sep}`) ||
    sourceRoot.startsWith(`${backupRoot}${path.sep}`)
  ) {
    throw new Error('The backup destination must be separate from the data directory.');
  }
  await fs.mkdir(path.dirname(backupRoot), { recursive: true, mode: 0o700 });
  await requirePlainDirectory(path.dirname(backupRoot));
  await fs.mkdir(backupRoot, { mode: 0o700 }); // Exclusive: never overwrite a backup.
  await fs.writeFile(
    path.join(backupRoot, '.incomplete'),
    'Backup has not completed. Do not restore.\n',
    { mode: 0o600, flag: 'wx' },
  );
  const database = new Database(path.join(sourceRoot, 'fleet.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  const snapshotPath = path.join(backupRoot, 'fleet.sqlite');
  try {
    await database.backup(snapshotPath);
  } finally {
    database.close();
  }
  await fs.chmod(snapshotPath, 0o600);
  const snapshotAt = new Date().toISOString();
  const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  let photoPaths;
  try {
    if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error('Database snapshot failed integrity verification.');
    photoPaths = snapshot
      .prepare('SELECT original_path, display_path FROM photos')
      .all()
      .flatMap((row) => [row.original_path, row.display_path]);
  } finally {
    snapshot.close();
  }
  const files = [{ path: 'fleet.sqlite', ...(await checksum(snapshotPath)) }];
  const evidencePaths = [...new Set([...photoPaths, ...(await reportFiles(sourceRoot))])].sort();
  for (const relative of evidencePaths) {
    safeRelative(relative);
    if (!relative.startsWith('photos/') && !relative.startsWith('reports/'))
      throw new Error('Evidence must be stored in photos/ or reports/.');
    const source = await requirePlainPath(sourceRoot, relative);
    const details = await copyPrivate(source, path.join(backupRoot, relative));
    files.push({ path: relative, ...details });
  }
  const manifest = {
    format: BACKUP_FORMAT,
    application: 'learn4life-fleet-checkout',
    snapshotAt,
    completedAt: new Date().toISOString(),
    consistency:
      'SQLite online snapshot; immutable photo files referenced by that snapshot; complete immutable report files available during backup.',
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  await fs.writeFile(
    path.join(backupRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await fs.unlink(path.join(backupRoot, '.incomplete'));
  return { destination: backupRoot, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (existsSync('.env') && process.loadEnvFile) process.loadEnvFile();
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length > 1) {
    console.log(
      'Usage: npm run backup -- [new-backup-directory]\nUses DATA_DIR from .env or ./data. Destination must not already exist.',
    );
    process.exitCode = args.includes('--help') ? 0 : 1;
  } else {
    createBackup({ destination: args[0] })
      .then(({ destination, manifest }) => {
        console.log(
          `Backup verified: ${destination}\n${manifest.files.length} files, ${manifest.totalBytes} bytes. Copy to a separate encrypted backup destination.`,
        );
      })
      .catch((error) => {
        console.error(
          `Backup failed: ${error.message}\nAny incomplete directory is retained for inspection and must not be restored.`,
        );
        process.exitCode = 1;
      });
  }
}
