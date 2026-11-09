import { randomUUID } from 'node:crypto';
import { openR2Evidence } from './r2-evidence.js';
import { readFile, writeFile, mkdir, unlink, link, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Evidence remains private. Only authenticated API handlers issue download URLs. */
export function openEvidence(dataDir, env = process.env) {
  const key = (value) => {
    const relative = path.isAbsolute(value) ? path.relative(dataDir, value) : value;
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('../') ||
      path.isAbsolute(relative) ||
      relative.includes('\\')
    )
      throw new Error('Invalid evidence path');
    return relative;
  };
  if (env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET)
    return openR2Evidence(env, key);
  if (env.VERCEL) throw new Error('Private R2 storage configuration is required');
  return {
    cloud: false,
    list: async (prefix) => {
      const safe = key(prefix);
      const dir = path.dirname(safe);
      let files;
      try {
        files = await readdir(path.join(dataDir, dir));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      return files.map((name) => `${dir}/${name}`).filter((name) => name.startsWith(safe));
    },
    read: (value) => readFile(path.join(dataDir, key(value))),
    put: async (value, bytes) => {
      const filename = path.join(dataDir, key(value));
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      try {
        await link(temporary, filename);
      } finally {
        await unlink(temporary);
      }
    },
    remove: (value) => unlink(path.join(dataDir, key(value))),
  };
}
