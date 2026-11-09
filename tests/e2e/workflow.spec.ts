import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';

async function login(page: Page, email = 'admin@example.test') {
  await page.goto('/');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Local-test-password-123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Find your next vehicle.' })).toBeVisible();
}
async function signOut(page: Page) {
  const button = page.getByRole('button', { name: 'Sign out', exact: true });
  if (await button.isVisible()) await button.click();
  else await page.getByRole('button', { name: 'Sign out of shared iPad', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}
async function draw(page: Page) {
  const canvas = page.locator('canvas:visible').last();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 30, { steps: 8 });
  await page.mouse.move(box.x + 65, box.y + 100, { steps: 6 });
  await page.mouse.move(box.x + 140, box.y + 55, { steps: 8 });
  await page.mouse.move(box.x + 195, box.y + 82, { steps: 6 });
  await page.mouse.up();
}
async function inspect(page: Page) {
  const questions = page.locator('.question');
  for (let i = 0; i < (await questions.count()); i++)
    await questions.nth(i).getByRole('button', { name: 'Yes', exact: true }).click();
  await page.getByLabel('Windshield condition').selectOption('clear');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function photos(page: Page, offset: number) {
  for (let i = 0; i < 4; i++) {
    const buffer = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: {
          r: (offset + i * 31) % 255,
          g: (offset + i * 57) % 255,
          b: (offset + i * 91) % 255,
        },
      },
    })
      .jpeg()
      .toBuffer();
    await page
      .locator('.photo-slot input[type=file]')
      .nth(i)
      .setInputFiles({ name: `qa-${offset}-${i}.jpg`, mimeType: 'image/jpeg', buffer });
  }
  await expect(page.locator('.photo-label').filter({ hasText: 'Stored' })).toHaveCount(4);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function signAndSubmit(page: Page, returning = false) {
  const checks = page.locator('.workflow-main input[type=checkbox]:visible');
  for (let i = 0; i < (await checks.count()); i++) await checks.nth(i).check();
  await draw(page);
  await page
    .getByRole('button', {
      name: returning ? 'Submit vehicle return' : 'Submit checkout',
      exact: true,
    })
    .click();
}

test('administrator setup, staff checkout/return, photos, signatures, PDF and shared-device switch', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.screenshot({
    path: `artifacts/login-${testInfo.project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await login(page);
  await page.getByRole('button', { name: 'Administration', exact: false }).click();
  await page.getByRole('button', { name: 'Add vehicle', exact: true }).click();
  const name = `QA pool ${testInfo.project.name}`;
  await page.getByLabel('Display name', { exact: true }).fill(name);
  await page.getByLabel('Make', { exact: true }).fill('Toyota');
  await page.getByLabel('Model', { exact: true }).fill('RAV4');
  await page
    .getByLabel('License plate / asset ID', { exact: true })
    .fill(`QA-${testInfo.project.name}`);
  await page.getByLabel('VIN last four', { exact: true }).fill('1234');
  await page.getByLabel('Initial accepted mileage', { exact: true }).fill('42500');
  await page.getByRole('button', { name: 'Save vehicle', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vehicle record saved');
  await signOut(page);
  await login(page, 'driver@example.test');
  await page.getByLabel('Search vehicles', { exact: true }).fill(name);
  await page.screenshot({
    path: `artifacts/fleet-${testInfo.project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Check out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready for the road' })).toBeVisible();
  await expect(page.getByLabel('Starting odometer reading', { exact: true })).toHaveValue('42500');
  await page.getByLabel('Projected return date and time', { exact: true }).fill('2030-01-01T12:00');
  // Use the browser local clock rather than assuming the machine's timezone.
  const due = await page.evaluate(() => {
    const d = new Date(Date.now() + 3600000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  await page.getByLabel('Projected return date and time', { exact: true }).fill(due);
  await page.getByRole('checkbox', { name: /I compared the dashboard/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await inspect(page);
  // An interrupted upload must remain incomplete and be explicitly retried.
  let interrupted = false;
  await page.route('**/api/photos', async (route) => {
    if (route.request().method() === 'POST' && !interrupted) {
      interrupted = true;
      await route.abort('failed');
    } else await route.continue();
  });
  const first = await sharp({
    create: { width: 800, height: 600, channels: 3, background: '#406070' },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('.photo-slot input[type=file]')
    .first()
    .setInputFiles({ name: 'interrupted.jpg', mimeType: 'image/jpeg', buffer: first });
  await expect(page.getByText('Upload interrupted.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Retry upload', exact: false }).click();
  await expect(page.locator('.photo-label').filter({ hasText: 'Stored' })).toHaveCount(1);
  await page.unroute('**/api/photos');
  await photos(page, 31);
  await page.screenshot({
    path: `artifacts/review-${testInfo.project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await signAndSubmit(page);
  await expect(page.getByText('Checkout confirmed. Your vehicle is ready to use.')).toBeVisible();
  await page.getByRole('button', { name: 'Return vehicle', exact: true }).click();
  await page.getByLabel('Ending odometer reading', { exact: true }).fill('42625');
  await expect(page.locator('.trip-total strong')).toContainText('125');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await inspect(page);
  await photos(page, 103);
  await signAndSubmit(page, true);
  await expect(
    page.getByText(
      'Physical return recorded. Fleet availability is managed separately from this completed trip.',
    ),
  ).toBeVisible();
  await expect(page.locator('.review-summary')).toContainText('125 mi');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Both forms & photos' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/return\.pdf$/);
  await signOut(page);
  await login(page);
  await page.getByLabel('Search vehicles', { exact: true }).fill(name);
  await expect(page.locator('.vehicle-mileage strong')).toHaveText('42,625');
  await expect(page.locator('.vehicle-row .status')).toHaveText('Available');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('denied camera access and offline sign-out do not expose a previous draft', async ({
  page,
  context,
}, testInfo) => {
  await login(page);
  const s = await page.request.get('/api/auth/me');
  const session = await s.json();
  const result = await page.request.post('/api/admin/vehicles', {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: {
      name: `QA privacy ${testInfo.project.name}`,
      make: 'Ford',
      model: 'Escape',
      year: 2024,
      plate: 'QA-PRIVATE',
      vinLast4: '9876',
      site: 'QA site',
      currentMileage: 1000,
      status: 'available',
    },
  });
  expect(result.status()).toBe(201);
  await page.getByRole('button', { name: 'Refresh fleet', exact: true }).click();
  await page
    .getByLabel('Search vehicles', { exact: true })
    .fill(`QA privacy ${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Check out', exact: true }).click();
  const due = await page.evaluate(() => {
    const d = new Date(Date.now() + 3600000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  await page.getByLabel('Projected return date and time', { exact: true }).fill(due);
  await page.getByRole('checkbox', { name: /I compared the dashboard/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await inspect(page);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  await page.getByRole('button', { name: 'Take photo', exact: true }).first().click();
  await expect(page.getByText('Camera access was not granted.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Close camera', exact: true }).click();
  await context.setOffline(true);
  await signOut(page);
  await expect(page.locator('.workflow')).toHaveCount(0);
  await expect(page.getByText('QA Administrator', { exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await login(page, 'driver@example.test');
  await expect(page.locator('.workflow')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Administration', exact: false })).toHaveCount(0);
  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await expect(otherTab.getByRole('heading', { name: 'Find your next vehicle.' })).toBeVisible();
  await signOut(page);
  await expect(otherTab.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await otherTab.close();
});

test.describe('public PWA shell', () => {
  test.use({ serviceWorkers: 'allow' });
  test('manifest, worker and private-cache exclusion', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    const manifest = await (await page.request.get('/manifest.webmanifest')).json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.name).toBe('Learn4Life Fleet Checkout');
    const cacheURLs = await page.evaluate(async () => {
      const entries = await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map((r) => r.url),
        ),
      );
      return entries.flat();
    });
    expect(cacheURLs.some((url) => url.includes('/assets/'))).toBe(true);
    expect(cacheURLs.some((url) => url.includes('/api/'))).toBe(false);
  });
  test('offline shell reload', async ({ page, context, browserName }) => {
    test.skip(
      browserName === 'webkit',
      'WebKit automation returned an internal navigation error during offline reload. Physical iPad offline launch is still required; this is not recorded as a pass.',
    );
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await context.setOffline(false);
  });
});

test('late responses from a signed-out administrator are discarded after staff switching', async ({
  page,
}) => {
  await login(page);
  const initial = await (await page.request.get('/api/auth/me')).json();
  const created = await page.request.post('/api/admin/vehicles', {
    headers: { 'X-CSRF-Token': initial.csrfToken },
    data: {
      name: 'QA response isolation',
      make: 'Ford',
      model: 'Escape',
      year: 2024,
      plate: 'QA-RACE',
      vinLast4: '9876',
      site: 'QA',
      currentMileage: 1000,
      status: 'available',
    },
  });
  expect(created.status()).toBe(201);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    waiting = new Promise<void>((resolve) => (started = resolve));
  let intercepted = false;
  await page.route('**/api/trips', async (route) => {
    if (intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    const response = await route.fetch();
    const data = await response.json();
    const user = await (await page.request.get('/api/auth/me')).json();
    const vehicle = (await (await page.request.get('/api/vehicles')).json()).vehicles[0];
    data.trips.push({
      id: 'old-admin-response',
      vehicleId: vehicle.id,
      employeeId: user.user.id,
      status: 'active',
      checkoutAt: new Date().toISOString(),
      projectedReturnAt: new Date(Date.now() + 3600000).toISOString(),
      startingMileage: 1000,
      employeeSnapshot: user.user,
      vehicleSnapshot: { ...vehicle, name: 'PRIVATE OLD ADMIN RESPONSE' },
      flags: [],
      overdue: false,
    });
    started();
    await gate;
    await route.fulfill({ response, json: data });
  });
  await page.getByRole('button', { name: 'Refresh fleet', exact: true }).click();
  await waiting;
  await signOut(page);
  await page.getByLabel('Work email').fill('driver@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Local-test-password-123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Find your next vehicle.' })).toBeVisible();
  await page.getByRole('button', { name: 'Trip history', exact: true }).click();
  release();
  await expect(
    page.getByText('The signed-in session changed. This older response was discarded.'),
  ).toBeVisible();
  await expect(page.getByText('PRIVATE OLD ADMIN RESPONSE')).toHaveCount(0);
});
