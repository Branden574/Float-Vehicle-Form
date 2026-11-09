import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { createReport } from './reports.js';
import {
  createEmailSender,
  processNotification,
  startNotificationWorker,
} from './notifications.js';

if (existsSync('.env') && process.loadEnvFile) process.loadEnvFile();
const production = process.env.NODE_ENV === 'production';
const secureCookies = process.env.SECURE_COOKIES === 'true' || production;
const publicOrigin = process.env.PUBLIC_ORIGIN;
if (production && (!publicOrigin || !publicOrigin.startsWith('https://')))
  throw new Error('Production requires PUBLIC_ORIGIN with an approved HTTPS origin.');
if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin)
  throw new Error('PUBLIC_ORIGIN must be an exact origin without a path or trailing slash.');
const send = createEmailSender();
const app = await createApp({
  dataDir: process.env.DATA_DIR,
  secureCookies,
  publicOrigin,
  trustProxy: process.env.TRUST_PROXY === '1' ? 1 : false,
  reportService: createReport,
  notificationService: async (options) => await processNotification({ ...options, send }),
});
const worker = startNotificationWorker({ store: app.locals.store, send });
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () =>
  console.log(
    `Fleet Checkout listening on ${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}. Email provider: ${process.env.EMAIL_PROVIDER || 'disabled'}.`,
  ),
);
server.requestTimeout = 180000;
async function stop() {
  worker.stop();
  await server.close(async () => {
    await app.locals.store.close();
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
