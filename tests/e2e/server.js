import { cloudFixture } from '../cloud-fixture.js';
// Isolated test server. Cloud mode uses a disposable schema and tracked test objects. Never sends email.
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import { createReport } from '../../server/reports.js';
const cleanCloud = await cloudFixture();
const port = Number(process.env.FLEET_E2E_PORT || 4173);
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-browser-test-')));
await mkdir('artifacts', { recursive: true });
const app = await createApp({
  sendSignInCode: async (mail) =>
    writeFile('artifacts/e2e-mailbox.json', JSON.stringify(mail), { mode: 0o600 }),
  dataDir: directory,
  secureCookies: false,
  publicOrigin: `http://127.0.0.1:${port}`,
  reportService: createReport,
});
const objects = new Set();
if (app.locals.store.evidence.cloud) {
  const evidence = app.locals.store.evidence;
  const put = evidence.put,
    signedUpload = evidence.signedUpload;
  evidence.put = async (key, ...args) => {
    objects.add(key);
    return put(key, ...args);
  };
  evidence.signedUpload = async (key, ...args) => {
    objects.add(key);
    return signedUpload(key, ...args);
  };
}
await app.locals.store.createUser({
  charter: 'QA Charter',
  name: 'QA Administrator',
  email: 'admin@example.test',
  role: 'admin',
  authorizedDriver: true,
  password: 'Local-test-password-123!',
});
await app.locals.store.createUser({
  charter: 'QA Charter',
  name: 'QA Driver',
  email: 'driver@example.test',
  role: 'staff',
  department: 'QA only',
  manager: 'QA Manager',
  authorizedDriver: true,
  password: 'Local-test-password-123!',
});
const server = app.listen(port, '127.0.0.1');
const cleanup = async () =>
  await server.close(async () => {
    for (const key of objects) await app.locals.store.evidence.remove(key);
    await app.locals.store.close();
    await cleanCloud?.();
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  });
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
