import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openStore } from '../server/store.js';
import { userSchema, validate } from '../server/validation.js';

if (existsSync('.env') && process.loadEnvFile) process.loadEnvFile();
const email = process.env.INITIAL_ADMIN_EMAIL,
  name = process.env.INITIAL_ADMIN_NAME;
if (!email || !name) {
  console.error(
    'Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_NAME for the first administrator, then run npm run setup. Optionally set INITIAL_ADMIN_PASSWORD (12+ characters); otherwise a one-use 72-hour invitation link is printed. No default account exists.',
  );
  process.exit(1);
}
const store = await openStore();
try {
  if (await store.db.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1").get())
    throw new Error(
      'An administrator already exists. Sign in to manage invitations; setup will not overwrite accounts.',
    );
  const data = validate(userSchema, { email, name, role: 'admin', authorizedDriver: false });
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (password && (password.length < 12 || password.length > 200))
    throw new Error('Administrator password must contain 12 to 200 characters.');
  const inviteToken = password ? undefined : randomBytes(32).toString('hex');
  const user = await store.createUser({ ...data, password, inviteToken });
  await store.audit(
    user.id,
    'bootstrap_administrator',
    'user',
    user.id,
    null,
    user,
    'Initial administrator created by local server operator',
  );
  console.log(
    'Initial administrator created. Remove INITIAL_ADMIN_PASSWORD from the environment after setup.',
  );
  if (inviteToken)
    console.log(
      `Open privately within 72 hours: ${process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173'}/#invite=${inviteToken}`,
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await store.close();
}
