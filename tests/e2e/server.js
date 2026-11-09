// Isolated local-only test server. Never uses production DATA_DIR or sends email.
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import { createReport } from '../../server/reports.js';
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-browser-test-')));
await mkdir('artifacts', { recursive: true });
const app = createApp({
  sendSignInCode: async (mail) =>
    writeFile('artifacts/e2e-mailbox.json', JSON.stringify(mail), { mode: 0o600 }),
  dataDir: directory,
  secureCookies: false,
  publicOrigin: 'http://127.0.0.1:4173',
  reportService: createReport,
});
app.locals.store.createUser({
  charter: 'QA Charter',
  name: 'QA Administrator',
  email: 'admin@example.test',
  role: 'admin',
  authorizedDriver: true,
  password: 'Local-test-password-123!',
});
app.locals.store.createUser({
  charter: 'QA Charter',
  name: 'QA Driver',
  email: 'driver@example.test',
  role: 'staff',
  department: 'QA only',
  manager: 'QA Manager',
  authorizedDriver: true,
  password: 'Local-test-password-123!',
});
const server = app.listen(4173, '127.0.0.1');
const cleanup = () =>
  server.close(async () => {
    app.locals.store.close();
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  });
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
