import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const release = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || randomUUID();
// Publish the web release after the matching beta is available to testers.
const project = readFileSync(new URL('./ios/project.yml', import.meta.url), 'utf8');
const betaBuild = Number(project.match(/^\s*CURRENT_PROJECT_VERSION:\s*['"]?(\d+)['"]?\s*$/m)?.[1]);
if (!Number.isSafeInteger(betaBuild) || betaBuild < 1) throw Error('Missing iOS build number');
const workspaceContent = JSON.parse(
  readFileSync(new URL('./ios/FleetCheckout/WorkspaceContent.json', import.meta.url), 'utf8'),
);
if (
  workspaceContent.schema !== 1 ||
  ['fleetReminder', 'damageInstructions', 'receiptInstructions'].some(
    (key) =>
      typeof workspaceContent[key] !== 'string' ||
      !workspaceContent[key].trim() ||
      workspaceContent[key].length > 500,
  )
)
  throw Error('Invalid native workspace content');
export default defineConfig({
  define: { __FLEET_RELEASE__: JSON.stringify(release) },
  plugins: [
    react(),
    {
      name: 'fleet-release',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'release.json',
          source: JSON.stringify({ release, betaBuild, workspaceContent }),
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: { sourcemap: false },
});
