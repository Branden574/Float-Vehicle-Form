import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'webkit-ipad',
      use: {
        browserName: 'webkit',
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'chromium-phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: 'node tests/e2e/server.js',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
