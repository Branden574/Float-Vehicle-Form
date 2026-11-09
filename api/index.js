import { waitUntil } from '@vercel/functions';
import { createApp } from '../server/app.js';
import { createReport } from '../server/reports.js';
import { createEmailSender, processNotification } from '../server/notifications.js';
import { runMaintenance } from '../server/maintenance.js';

let initialization;
function application() {
  initialization ||= createApp({
    dataDir: '/tmp/fleet',
    secureCookies: true,
    trustProxy: 1,
    // Preview domains also receive same-origin CSRF checks based on their request host.
    publicOrigin: process.env.PUBLIC_ORIGIN,
    reportService: createReport,
    notificationService: (options) =>
      processNotification({ ...options, send: createEmailSender() }),
  }).catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
export default async function handler(req, res) {
  try {
    const app = await application();
    if (req.url.split('?')[0] === '/api/maintenance') {
      if (
        !process.env.CRON_SECRET ||
        req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
      )
        return res.status(401).json({ error: 'Unauthorized' });
      return res.json(await runMaintenance({ store: app.locals.store, send: createEmailSender() }));
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      res.once('finish', () => {
        if (res.statusCode < 400)
          waitUntil(
            runMaintenance({ store: app.locals.store, send: createEmailSender() }).catch(() =>
              console.error('Background maintenance will retry on the next invocation.'),
            ),
          );
      });
    return app(req, res);
  } catch (error) {
    console.error('Fleet initialization failed', error.code || error.name);
    if (!res.headersSent)
      res
        .status(503)
        .json({ error: 'The fleet service is temporarily unavailable. Please retry shortly.' });
  }
}
