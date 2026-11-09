import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadBackup } from './cloud-backup-download.js';

async function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Docker could not start')));
    child.on('close', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`Recovery container command failed (${code})`)),
    );
  });
}
export async function verifyCloudBackup({ manifestKey, env = process.env }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-restore-check-'));
  await fs.chmod(temp, 0o700);
  const name = `fleet-restore-check-${randomBytes(8).toString('hex')}`;
  let started = false;
  try {
    const recoveryPath = path.join(temp, 'recovered');
    const manifest = await downloadBackup({ manifestKey, destination: recoveryPath, env });
    // No host ports and no network: recovery cannot reach the live app, DB or email service.
    await docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--network',
      'none',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      'postgres:17',
    ]);
    started = true;
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await docker(['exec', name, 'pg_isready', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (!ready) throw new Error('Recovery database did not become ready');
    await docker([
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE ROLE fleet_app NOLOGIN; CREATE ROLE fleet_backup NOLOGIN;',
    ]);
    await docker(['exec', name, 'createdb', '-U', 'postgres', 'fleet_recovery']);
    await docker(['cp', path.join(recoveryPath, 'database.dump'), `${name}:/tmp/database.dump`]);
    await docker([
      'exec',
      name,
      'pg_restore',
      '-U',
      'postgres',
      '--dbname=fleet_recovery',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '/tmp/database.dump',
    ]);
    const query = (sql) =>
      docker([
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'fleet_recovery',
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        sql,
      ]);
    for (const [table, expected] of Object.entries(manifest.tables)) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected recovery table');
      const actual = Number(await query(`SELECT count(*) FROM fleet.${table}`));
      if (actual !== expected) throw new Error(`Restored ${table} count mismatch`);
    }
    if (
      (await query('SELECT key_check FROM fleet.privacy_meta WHERE id=1')) !==
      manifest.profileKeyFingerprint
    )
      throw new Error('Profile key fingerprint mismatch');
    const result = {
      snapshot: manifest.id,
      restoredTables: Object.keys(manifest.tables).length,
      verifiedEvidenceFiles: manifest.files.length,
      isolatedRestore: true,
    };
    console.log(JSON.stringify(result));
    if (env.GITHUB_STEP_SUMMARY)
      await fs.appendFile(
        env.GITHUB_STEP_SUMMARY,
        `\n### Cloud recovery verified\n\nDownloaded and decrypted the saved snapshot, verified every evidence SHA-256 checksum, restored PostgreSQL in a network-isolated container, and matched all ${result.restoredTables} table counts. The disposable recovery database was removed.\n`,
      );
    return result;
  } finally {
    if (started) await docker(['rm', '--force', name]);
    await fs.rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = JSON.parse(await fs.readFile(process.env.BACKUP_RESULT_FILE, 'utf8'));
  verifyCloudBackup({ manifestKey: result.manifestKey }).catch(() => {
    console.error('Cloud recovery verification failed. Inspect the backup before relying on it.');
    process.exitCode = 1;
  });
}
