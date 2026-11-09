import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function openPrivacy(dataDir, explicit = process.env.PROFILE_ENCRYPTION_KEY_FILE) {
  if (process.env.NODE_ENV === 'production' && !explicit && !process.env.PROFILE_ENCRYPTION_KEY)
    throw new Error(
      'PROFILE_ENCRYPTION_KEY or PROFILE_ENCRYPTION_KEY_FILE is required in production. Keep this key separate from database backups.',
    );
  const filename = explicit || path.join(dataDir, '.development-profile-key');
  if (!process.env.PROFILE_ENCRYPTION_KEY && !existsSync(filename) && !explicit)
    writeFileSync(filename, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  const encoded = (process.env.PROFILE_ENCRYPTION_KEY || readFileSync(filename, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(encoded))
    throw new Error('Profile encryption key must contain exactly 32 random bytes encoded as hex.');
  const key = Buffer.from(encoded, 'hex');
  const lookup = (email) =>
    createHmac('sha256', key)
      .update('email-lookup-v1\0' + email.trim().toLowerCase())
      .digest('hex');
  const fingerprint = createHmac('sha256', key).update('fleet-key-check-v1').digest('hex');
  const encode = (value) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('learn4life-private-record-v1'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  };
  const decode = (value) => {
    if (!value.startsWith('enc:v1:')) return JSON.parse(value); // Legacy rows are migrated at startup.
    const payload = Buffer.from(value.slice(7), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
    decipher.setAAD(Buffer.from('learn4life-private-record-v1'));
    decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8'),
    );
  };
  return { encode, decode, lookup, fingerprint };
}
