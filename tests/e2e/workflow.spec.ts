import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { checkControls } from './layout';
import { readFile } from 'node:fs/promises';
import { signature } from '../helpers.js';

async function login(page: Page, email = 'admin@example.test') {
  if (!(await page.getByRole('heading', { name: 'Welcome back' }).isVisible()))
    await page.goto('/');
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Use existing password', exact: true }).click();
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
async function signAndSubmit(page: Page, returning = false, checkAppearance = false) {
  const checks = page.locator('.workflow-main input[type=checkbox]:visible');
  for (let i = 0; i < (await checks.count()); i++) await checks.nth(i).check();
  await draw(page);
  if (checkAppearance) {
    const canvas = page.locator('canvas:visible').last();
    const original = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(canvas).toHaveCSS('filter', 'none');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(canvas).toHaveCSS('filter', 'invert(1) grayscale(1)');
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(
      original,
    );
  }
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
  await page.emulateMedia({ colorScheme: 'dark' });
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
  await page.getByRole('tab', { name: 'Reviewers', exact: true }).click();
  await page.getByLabel('Reviewer email addresses').fill('admin@example.test');
  await page.getByRole('button', { name: 'Save return reviewers', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Return reviewers saved');
  await page.screenshot({
    path: `artifacts/return-reviewers-${testInfo.project.name}.png`,
    fullPage: true,
  });
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
  await checkControls(page, 'Odometer');
  // Use the browser local clock rather than assuming the machine's timezone.
  const due = await page.evaluate(() => {
    const d = new Date(Date.now() + 3600000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  await page.getByLabel('Projected return date and time', { exact: true }).fill(due);
  await page.getByRole('checkbox', { name: /I compared the dashboard/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const kits = page.getByRole('group', {
    name: 'Are all emergency service kits assigned to this vehicle present?',
  });
  await expect(kits.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'false');
  await expect(kits.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'false');
  await checkControls(page, 'Inspection');
  const kitNames = page.getByLabel('Which emergency kit or kits are missing?');
  await kits.getByRole('button', { name: 'No' }).click();
  await kitNames.fill('First aid kit');
  await kits.getByRole('button', { name: 'Yes' }).click();
  await expect(kitNames).toHaveCount(0);
  await kits.getByRole('button', { name: 'No' }).click();
  await expect(kitNames).toHaveValue('');
  await inspect(page);
  // An interrupted upload must remain incomplete and be explicitly retried.
  let interrupted = false;
  await page.route(/\/api\/photos(?:\/upload-ticket\/[^/]+\/complete)?$/, async (route) => {
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
  await expect(page.getByRole('alert').filter({ hasText: /interrupted/i })).toBeVisible();
  await checkControls(page, 'Photo retry');
  await page.getByRole('button', { name: 'Save & exit' }).click();
  await signOut(page);
  await login(page);
  await page.getByLabel('Search vehicles', { exact: true }).fill(name);
  await expect(page.getByRole('button', { name: 'Check out', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume checkout' })).toHaveCount(0);
  await signOut(page);
  await login(page, 'driver@example.test');
  await page.getByLabel('Search vehicles', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Resume checkout' }).click();
  await checkControls(page, 'Resume draft');
  await page.locator('.workflow').screenshot({
    path: `artifacts/resume-inspection-${testInfo.project.name}.png`,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Resume inspection' }).click();
  await expect(page.getByRole('heading', { name: 'Photographs', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry upload', exact: false }).click();
  await expect(page.locator('.photo-label').filter({ hasText: 'Stored' })).toHaveCount(1);
  await page.unroute(/\/api\/photos(?:\/upload-ticket\/[^/]+\/complete)?$/);
  await photos(page, 31);
  await page.screenshot({
    path: `artifacts/review-${testInfo.project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await checkControls(page, 'Review and sign');
  let firstRequest = '';
  let firstKey = '';
  await page.route('**/api/trips/checkout', async (route) => {
    if (!firstRequest) {
      firstRequest = route.request().postData()!;
      expect(JSON.parse(firstRequest).inspection.emergencyKitsPresent).toBe(true);
      firstKey = route.request().headers()['idempotency-key'];
      await route.abort('failed');
    } else {
      expect(route.request().postData()).toBe(firstRequest);
      expect(route.request().headers()['idempotency-key']).toBe(firstKey);
      await route.continue();
    }
  });
  await signAndSubmit(page, false, true);
  await expect(page.getByText('The response was interrupted.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save & exit' }).click();
  await page.reload();
  await page.getByLabel('Search vehicles', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Resume checkout' }).click();
  await page.getByRole('button', { name: 'Resume inspection' }).click();
  await page.getByRole('button', { name: 'Retry submission' }).click();
  await expect(page.getByText('Checkout confirmed. Your vehicle is ready to use.')).toBeVisible();
  await checkControls(page, 'Active trip');
  await page.getByRole('button', { name: 'Return vehicle', exact: true }).click();
  await checkControls(page, 'Return odometer');
  await page.getByLabel('Ending odometer reading', { exact: true }).fill('42625');
  await page.getByRole('button', { name: 'Save & exit' }).click();
  await page.getByRole('button', { name: 'Resume return' }).click();
  await page.getByRole('button', { name: 'Resume inspection' }).click();
  await expect(page.getByLabel('Ending odometer reading', { exact: true })).toHaveValue('42625');
  await expect(page.locator('.trip-total strong')).toContainText('125');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Checkout answer: Yes')).toBeVisible();
  await expect(kits.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'false');
  await expect(kits.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'false');
  const questions = page.locator('.question');
  for (const q of await questions.all()) await q.getByRole('button', { name: 'Yes' }).click();
  await kits.getByRole('button', { name: 'No' }).click();
  await page.getByLabel('Windshield condition').selectOption('clear');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Name the missing emergency kit or kits.')).toBeVisible();
  await checkControls(page, 'Return missing equipment');
  await kitNames.fill('Roadside kit');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await checkControls(page, 'Return photographs');
  await photos(page, 103);
  await checkControls(page, 'Return signature');
  await signAndSubmit(page, true);
  await expect(
    page.getByText(
      'Physical return recorded. Fleet availability is managed separately from this completed trip.',
    ),
  ).toBeVisible();
  await expect(page.locator('.review-summary')).toContainText('125 mi');
  await checkControls(page, 'Completed trip');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Both forms & photos' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /_Out-\d{4}-\d{2}-\d{2}_In-\d{4}-\d{2}-\d{2}_Checkout-and-Check-in\.pdf$/,
  );
  expect(download.suggestedFilename()).toContain(name.replace(/[^a-zA-Z0-9]+/g, '-'));
  await signOut(page);
  await login(page);
  await page.getByLabel('Search vehicles', { exact: true }).fill(name);
  await expect(page.locator('.vehicle-mileage strong')).toHaveText('42,625');
  await expect(page.locator('.vehicle-row .status')).toHaveText('Pending Review');
  await page.getByRole('button', { name: `Review ${name} ·`, exact: false }).click();
  const correction = page.getByRole('button', { name: 'Document a mileage correction' });
  await correction.click();
  await checkControls(page, 'Mileage correction');
  await correction.click();
  await page.getByRole('button', { name: 'Review return as', exact: false }).click();
  await checkControls(page, 'Return review');
  await page.getByLabel('Your representative initials').fill('QA');
  await page.getByLabel('Review reason').fill('Inspected return mileage, condition and receipts');
  await draw(page);
  await page.getByRole('button', { name: 'Save signed review', exact: true }).click();
  await expect(
    page.getByText('Inspected return mileage, condition and receipts', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await expect(
    page.locator('.vehicle-row').filter({ hasText: name }).locator('.status'),
  ).toHaveText('Available');
  // Restore default policy so other scenarios retain their independent expectations.
  const reviewerSession = await (await page.request.get('/api/auth/me')).json();
  expect(
    (
      await page.request.patch('/api/admin/settings', {
        headers: { 'X-CSRF-Token': reviewerSession.csrfToken },
        data: { returnReviewerEmails: [], reason: 'Restore default test review policy' },
      })
    ).ok(),
  ).toBe(true);
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
  const camera = page.getByRole('dialog', { name: 'Capture vehicle photograph' });
  await expect(camera).toBeVisible();
  await expect(camera.getByRole('heading')).toBeFocused();
  await checkControls(page, 'Camera permission denied');
  await page.keyboard.press('Escape');
  await expect(camera).toBeHidden();

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
  await page.getByRole('button', { name: 'Use existing password', exact: true }).click();
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

test('touch diagram marks can be moved, removed, undone and saved with exact positions', async ({
  page,
}, testInfo) => {
  await login(page);
  const session = await (await page.request.get('/api/auth/me')).json();
  const name = `Diagram test ${testInfo.project.name}`;
  const result = await page.request.post('/api/admin/vehicles', {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: {
      name,
      make: 'Ford',
      model: 'Escape',
      year: 2024,
      plate: 'MARK-01',
      vinLast4: '1111',
      site: 'QA',
      currentMileage: 42500,
      status: 'available',
    },
  });
  expect(result.status()).toBe(201);
  await signOut(page);
  await login(page, 'driver@example.test');
  await page.getByLabel('Search vehicles', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Check out', exact: true }).click();
  await page.getByLabel('Projected return date and time', { exact: true }).fill('2027-01-01T17:00');
  await page.getByRole('checkbox', { name: /I compared the dashboard/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const svg = page.getByRole('application', { name: 'Vehicle damage diagram' });
  const place = async (x: number, y: number) => {
    await svg.scrollIntoViewIfNeeded();
    const b = (await svg.boundingBox())!;
    const options = { position: { x: b.width * x, y: b.height * y } };
    if (testInfo.project.use.hasTouch) await svg.tap(options);
    else await svg.click(options);
  };
  await place(0.2, 0.5);
  await expect(page.locator('.damage-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Move mark', exact: true }).click();
  await place(0.25, 0.45);
  await page.getByRole('button', { name: 'Scratch', exact: false }).first().click();
  await place(0.7, 0.7);
  await page.getByRole('button', { name: 'Remove mark', exact: true }).click();
  await place(0.6, 0.2);
  await page.getByRole('button', { name: 'Undo last mark', exact: true }).click();
  await expect(page.locator('.damage-row')).toHaveCount(1);
  await page
    .locator('.damage-row')
    .getByLabel('Notes', { exact: true })
    .fill('Door dent marked on diagram');
  await page.screenshot({
    path: `artifacts/damage-diagram-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await inspect(page);
  await photos(page, 157);
  await signAndSubmit(page);
  await expect(
    page.getByText(
      'Checkout inspection saved. Do not take the vehicle until an administrator approves it.',
    ),
  ).toBeVisible();
  const trips = (await (await page.request.get('/api/trips')).json()).trips;
  const trip = trips.find((t: any) => t.vehicleSnapshot.name === name);
  expect(trip.checkoutInspection.damage).toHaveLength(1);
  expect(trip.checkoutInspection.damage[0].position.x).toBeCloseTo(0.25, 2);
  expect(trip.checkoutInspection.damage[0].position.y).toBeCloseTo(0.45, 2);
  expect(trip.checkoutInspection.damage[0].notes).toBe('Door dent marked on diagram');
  await page.reload();
  await page.getByRole('button', { name: 'Trip history', exact: true }).click();
  // API reread and saved diagram are independent of the in-memory inspection draft.
  const saved = await page.request.get(`/api/trips/${trip.id}`);
  expect(saved.status()).toBe(200);
  const report = await page.request.get(`/api/trips/${trip.id}/report?stage=checkout`);
  expect(report.status()).toBe(200);
  expect((await report.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await signOut(page);
  await login(page);
  const adminSession = await (await page.request.get('/api/auth/me')).json();
  const approval = await page.request.post(`/api/trips/${trip.id}/review`, {
    headers: { 'X-CSRF-Token': adminSession.csrfToken },
    data: {
      stage: 'checkout',
      initials: 'QA',
      signature: await signature(),
      decision: 'approve',
      reason: 'Cosmetic checkout mark reviewed',
    },
  });
  expect(approval.status()).toBe(200);
  await signOut(page);
  await login(page, 'driver@example.test');
  const current = page.locator('.my-checkouts .notice').filter({ hasText: name });
  await expect(current).toBeVisible();
  await current.getByRole('button', { name: 'View checkout', exact: true }).click();
  await page.getByRole('button', { name: 'Return vehicle', exact: true }).click();
  await page.getByLabel('Ending odometer reading', { exact: true }).fill('42625');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(svg.locator('[aria-label="Checkout mark C1: dent"]')).toHaveCount(1);
  await expect(page.locator('.damage-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Scratch', exact: false }).first().click();
  await place(0.7, 0.8);
  await expect(page.locator('.damage-row')).toHaveCount(1);
  await expect(svg.locator('[aria-label="Checkout mark C1: dent"]')).toHaveCount(1);
  await page.screenshot({
    path: `artifacts/return-baseline-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await inspect(page);
  await photos(page, 195);
  await signAndSubmit(page, true);
  await expect(
    page.getByText(
      'Physical return recorded. Fleet availability is managed separately from this completed trip.',
    ),
  ).toBeVisible();
  const returned = await (await page.request.get(`/api/trips/${trip.id}`)).json();
  expect(returned.trip.checkoutInspection.damage[0]).toEqual(trip.checkoutInspection.damage[0]);
  expect(returned.trip.returnInspection.damageScope).toBe('new');
  expect(returned.trip.returnInspection.damage).toHaveLength(1);
  expect(returned.trip.returnInspection.damage[0].position.x).toBeCloseTo(0.7, 2);
});

test('email codes create and remember an encrypted profile on a shared device', async ({
  page,
}, testInfo) => {
  const email = `profile-${testInfo.project.name}@example.test`;
  async function codeLogin() {
    await page.goto('/');
    await page.getByLabel('Work email').fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    await expect(page.getByLabel('One-time code')).toBeVisible();
    const mail = JSON.parse(await readFile('artifacts/e2e-mailbox.json', 'utf8'));
    expect(mail.to).toEqual([email]);
    await page.getByLabel('One-time code').fill(mail.text.match(/code is (\d{6})/)[1]);
    await page.getByRole('button', { name: 'Verify code & sign in', exact: true }).click();
  }
  await login(page);
  await page.getByRole('button', { name: 'Administration', exact: false }).click();
  await page.getByRole('tab', { name: 'Staff', exact: true }).click();
  await page.getByLabel('Staff email to approve').fill(email);
  await page.getByRole('button', { name: 'Approve email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Staff access approved');
  await signOut(page);
  await codeLogin();
  await expect(page.getByRole('heading', { name: 'Welcome. Tell us about you.' })).toBeVisible();
  await checkControls(page, 'First-time profile');
  await page.getByLabel('Full name').fill('Profile Test Driver');
  await page.getByLabel('Charter / school').fill('QA Saved Charter');
  await page.getByLabel('Manager', { exact: true }).fill('QA Manager');
  await page.getByRole('button', { name: 'Save my details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My current checkouts' })).toBeVisible();
  await expect(page.getByText('You have no vehicle checked out.')).toBeVisible();
  await signOut(page);
  await codeLogin();
  await expect(page.getByRole('heading', { name: 'Find your next vehicle.' })).toBeVisible();
  await page.getByRole('button', { name: 'My profile', exact: true }).click();
  await expect(page.getByLabel('Full name')).toHaveValue('Profile Test Driver');
  await expect(page.getByLabel('Work email')).toHaveValue(email);
  await expect(page.getByLabel('Charter / school')).toHaveValue('QA Saved Charter');
  await page.screenshot({
    path: `artifacts/saved-profile-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test('administrators can add, save and remove assistant form-email recipients', async ({
  page,
}, testInfo) => {
  await login(page);
  await page.getByRole('button', { name: 'Administration', exact: false }).click();
  await page.getByRole('tab', { name: 'Form emails', exact: true }).click();
  await page.getByLabel('Email address 1', { exact: true }).fill('assistant.one@example.test');
  await page.getByRole('button', { name: 'Add recipient', exact: true }).click();
  await page.getByLabel('Email address 2', { exact: true }).fill('assistant.two@example.test');
  await page.getByLabel('Also email a copy to the employee who checked out the vehicle').check();
  await page.getByRole('button', { name: 'Save email recipients', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Form email recipients saved');
  await page.reload();
  await page.getByRole('button', { name: 'Administration', exact: false }).click();
  await page.getByRole('tab', { name: 'Form emails', exact: true }).click();
  await expect(page.getByLabel('Email address 1', { exact: true })).toHaveValue(
    'assistant.one@example.test',
  );
  await expect(page.getByLabel('Email address 2', { exact: true })).toHaveValue(
    'assistant.two@example.test',
  );
  await expect(
    page.getByLabel('Also email a copy to the employee who checked out the vehicle'),
  ).toBeChecked();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await page.screenshot({
    path: `artifacts/form-emails-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Remove recipient 2', exact: true }).click();
  await page.getByRole('button', { name: 'Save email recipients', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Form email recipients saved');
  const session = await (await page.request.get('/api/auth/me')).json();
  expect(session.settings.notificationRecipients).toEqual(['assistant.one@example.test']);
});

test('sign-in offers resend after 60 seconds and clears the old code', async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  await page.route('**/api/auth/request-code', async (route) => {
    requests++;
    await route.fulfill({
      json: {
        challengeId: String(requests).repeat(48),
        expiresInSeconds: 600,
        retryAfterSeconds: 60,
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('Work email').fill('resend@example.test');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await expect(page.getByRole('button', { name: /Resend code in/ })).toBeDisabled();
  await checkControls(page, 'Email verification');
  await page.getByLabel('One-time code').fill('123456');
  await page.clock.fastForward(59000);
  await expect(page.getByRole('button', { name: /Resend code in/ })).toBeDisabled();
  expect(requests).toBe(1);
  await page.clock.fastForward(1000);
  await page.getByRole('button', { name: 'Resend code', exact: true }).click();
  await expect(page.getByLabel('One-time code')).toHaveValue('');
  await expect(page.getByRole('status').filter({ hasText: 'Use the newest email' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend code in/ })).toBeDisabled();
  expect(requests).toBe(2);
});

test('system appearance changes live and preserves input with readable dark controls', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByLabel('Work email').fill('draft@example.test');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(246, 247, 243)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(18, 26, 23)');
  await expect(page.getByLabel('Work email')).toHaveValue('draft@example.test');
  await expect(page.getByLabel('Work email')).toHaveCSS('background-color', 'rgb(27, 39, 33)');
  // Wait for the existing button background transition before measuring contrast.
  await expect(page.locator('.login-form .primary')).toHaveCSS(
    'background-color',
    'rgb(129, 205, 185)',
  );
  const contrast = await page.locator('.login-form .primary').evaluate((button) => {
    const style = getComputedStyle(button);
    const luminance = (color: string) => {
      const rgb = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const a = luminance(style.color),
      b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    path: `artifacts/dark-login-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await login(page);
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(25, 37, 31)');
  await page.getByRole('button', { name: 'My profile', exact: true }).click();
  await page.getByLabel('Full name').fill('Unsaved appearance test');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(246, 247, 243)');
  await expect(page.getByLabel('Full name')).toHaveValue('Unsaved appearance test');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByLabel('Full name')).toHaveValue('Unsaved appearance test');
  await expect(page.getByLabel('Work email')).toHaveCSS('background-color', 'rgb(37, 53, 44)');
  await page.screenshot({
    path: `artifacts/dark-profile-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test('page controls have usable spacing across the staff workspace and public pages', async ({
  page,
}) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ['/privacy', '/support', '/deletion-status', '/report-copy.html']) {
      await page.goto(path);
      await expect(page.locator('main h1')).toBeVisible();
      await checkControls(page, path);
    }
    await page.goto('/');
    await expect(page.getByLabel('Work email')).toBeVisible();
    await checkControls(page, 'Sign-in');
    await login(page);
    await checkControls(page, 'Fleet');
    await page.getByRole('button', { name: 'Trip history' }).click();
    await checkControls(page, 'History');
    await page.getByRole('button', { name: 'Administration' }).click();
    for (const tab of ['Vehicles', 'Staff', 'Reviewers', 'Settings', 'Form emails', 'Audit']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page.locator('.storage-panel')).toBeVisible();
      await checkControls(page, tab);
      if (
        tab === 'Vehicles' &&
        (await page.getByRole('button', { name: 'Edit vehicle' }).count())
      ) {
        await page.getByRole('button', { name: 'Edit vehicle' }).first().click();
        await page.getByLabel('This correction documents an odometer replacement').check();
        await checkControls(page, 'Edit vehicle and odometer replacement');
      }
      if (tab === 'Staff' || tab === 'Vehicles') {
        await page
          .getByRole('button', {
            name: tab === 'Staff' ? 'Invite staff' : 'Add vehicle',
            exact: true,
          })
          .click();
        await checkControls(page, tab + ' editor');
      }
    }
    await page.getByRole('button', { name: 'My profile' }).click();
    await checkControls(page, 'Profile');
    await page.getByRole('button', { name: 'Delete my account…' }).click();
    await checkControls(page, 'Account deletion confirmation');
    await page.getByRole('button', { name: 'Keep my account' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  }
});

test('a personal passkey signs its owner in without an email and can be removed', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The virtual authenticator uses Chromium DevTools.');
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await login(page, 'driver@example.test');
  await page.getByRole('button', { name: 'My profile' }).click();
  await expect(page.getByText(/select your personal password manager/)).toBeVisible();
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByRole('status')).toContainText('Passkey saved');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Work email')).toHaveValue('');
  const remembered = page.getByRole('checkbox', { name: /Remember me for 60 days/ });
  await expect(remembered).not.toBeChecked();
  await remembered.check();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect
    .poll(
      async () =>
        (await page.context().cookies()).find((c) => c.name === 'fleet_session')?.expires ?? 0,
    )
    .toBeGreaterThan(Date.now() / 1000 + 59 * 86400);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Find your next vehicle.' })).toBeVisible();
  await page.getByRole('button', { name: 'My profile' }).click();
  await expect(page.getByLabel('Work email')).toHaveValue('driver@example.test');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Remove all passkeys' }).click();
  await expect(page.getByRole('status')).toContainText('Passkeys removed');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText('Passkey verification did not complete');
});

test('staff can book, see calendar details, cancel, and defer a workspace update safely', async ({
  page,
}, info) => {
  await login(page);
  const session = await (await page.request.get('/api/auth/me')).json();
  const vehicleName = 'Calendar ' + info.project.name;
  const added = await page.request.post('/api/admin/vehicles', {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: {
      name: vehicleName,
      make: 'Ford',
      model: 'Escape',
      year: 2024,
      plate: 'CAL-' + info.project.name,
      vinLast4: '7210',
      site: 'Calendar QA',
      currentMileage: 2000,
      status: 'available',
    },
  });
  expect(added.status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: 'Check availability & view calendar' }).click();
  await expect(page.getByRole('heading', { name: 'Vehicle calendar' })).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Vehicle', exact: true })
    .selectOption({ label: vehicleName });
  const base = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  await page.getByRole('button', { name: 'Check availability', exact: true }).click();
  await page.getByLabel('Pickup ·').fill(base + 'T10:00');
  await page.getByLabel('Expected return ·').fill(base + 'T12:00');
  await page
    .getByRole('dialog', { name: 'Check availability' })
    .getByRole('button', { name: 'Check availability', exact: true })
    .click();
  await checkControls(page, 'Availability results');
  await page.getByRole('button', { name: 'Select vehicle' }).first().click();
  await checkControls(page, 'Reservation form');
  await page.getByRole('button', { name: 'Reserve vehicle', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Reservation details' });
  await expect(dialog).toBeVisible();
  await checkControls(page, 'Reservation details');
  await dialog.getByRole('button', { name: 'Cancel reservation' }).click();
  await checkControls(page, 'Cancel reservation');
  await dialog.getByRole('button', { name: 'Keep reservation' }).click();
  await dialog.getByRole('button', { name: 'Cancel reservation' }).click();
  await dialog.getByLabel('Reason (optional)').fill('Test itinerary changed');
  await dialog.getByRole('button', { name: 'Cancel reservation' }).click();
  await expect(dialog).toContainText('Test itinerary changed');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(
    page.getByText('Reservation canceled. This booking no longer holds the vehicle.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await checkControls(page, 'Agenda schedule');
  await expect(page.getByText('No bookings in this period.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Agenda', pressed: true })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: 'artifacts/booking-' + info.project.name + '.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Vehicle fleet' }).click();
  await page.getByRole('button', { name: 'Check out', exact: true }).first().click();
  await page.route('**/release.json', (r) =>
    r.fulfill({ json: { release: 'synthetic-next-release' } }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const banner = page.getByRole('complementary', { name: 'App update' });
  await expect(banner).toBeVisible();
  await checkControls(page, 'App update notice');
  await banner.getByRole('button', { name: 'Refresh now' }).click();
  await expect(banner).toContainText('Finish or leave the open form first');
  await banner.getByRole('button', { name: 'Later' }).click();
  await expect(banner).toBeHidden();
});

test('web release offers a safe refresh and confirms the new version on the next visit', async ({
  page,
}) => {
  await login(page);
  await page.evaluate(() =>
    localStorage.setItem('fleet-workspace-release', 'previous-test-release'),
  );
  await page.reload();
  const update = page.getByRole('complementary', { name: 'App update' });
  await expect(update).toContainText('running the latest update');
  await update.getByRole('button', { name: 'Got it' }).click();
  let next = true;
  await page.route('**/release.json', async (route) => {
    if (next) return route.fulfill({ json: { release: 'test-deployment-ready' } });
    return route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(update.getByRole('button', { name: 'Refresh now' })).toBeVisible();
  next = false;
  const navigate = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await update.getByRole('button', { name: 'Refresh now' }).click();
  await navigate;
  await expect(update).toBeHidden();
  await expect(page.getByRole('heading', { name: 'My current checkouts' })).toBeVisible();
});

test('booking times handle both occurrences of the autumn clock change and explain the spring gap', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Check availability & view calendar' }).click();
  function nextSunday(month: number, occurrence: number) {
    const tomorrow = new Date(Date.now() + 86400000);
    for (let year = tomorrow.getUTCFullYear(); ; year++) {
      const firstDay = new Date(Date.UTC(year, month, 1));
      const day = new Date(
        Date.UTC(year, month, 1 + ((7 - firstDay.getUTCDay()) % 7) + 7 * (occurrence - 1)),
      );
      if (day > tomorrow) return day.toISOString().slice(0, 10);
    }
  }
  const spring = nextSunday(2, 2);
  await page.getByRole('button', { name: 'Check availability', exact: true }).click();
  await page.getByLabel('Pickup ·').fill(spring + 'T02:30');
  await page.getByLabel('Expected return ·').fill(spring + 'T03:30');
  await page
    .getByRole('dialog', { name: 'Check availability' })
    .getByRole('button', { name: 'Check availability', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('clock skips');
  const autumn = nextSunday(10, 1);
  await page.getByLabel('Pickup ·').fill(autumn + 'T01:15');
  await page.getByLabel('Expected return ·').fill(autumn + 'T01:15');
  await page.getByLabel('Return clock change').selectOption('later');
  const request = page.waitForRequest((req) => new URL(req.url()).pathname === '/api/availability');
  await page
    .getByRole('dialog', { name: 'Check availability' })
    .getByRole('button', { name: 'Check availability', exact: true })
    .click();
  const received = new URL((await request).url()).searchParams;
  expect(Date.parse(received.get('end')!) - Date.parse(received.get('start')!)).toEqual(3600000);
});

test('calendar browsing, scope changes and closed panels preserve the right interval', async ({
  page,
}, info) => {
  await login(page);
  const { csrfToken } = await (await page.request.get('/api/auth/me')).json();
  const name = 'Accessible Operations Vehicle for Extended Regional Support ' + info.project.name;
  const site = 'Central Valley Multi-School Transportation and Technology Services';
  const add = await page.request.post('/api/admin/vehicles', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      name,
      site,
      make: 'Ford',
      model: 'Escape',
      plate: 'UX-' + info.project.name,
      year: 2024,
      vinLast4: '5146',
      currentMileage: 2500,
      status: 'available',
    },
  });
  expect(add.status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: 'Check availability & view calendar' }).click();
  const pick = page.getByRole('combobox', { name: 'Vehicle', exact: true });
  await page.getByRole('combobox', { name: 'Site', exact: true }).selectOption(site);
  await pick.selectOption({ label: name });
  await checkControls(page, 'Month schedule');
  await expect(page.getByRole('button', { name: 'Month', pressed: true })).toBeVisible();
  const today = page.locator('[data-calendar-day][aria-current="date"]');
  await expect(today).toBeVisible();
  const dateInCalendar = (await today.getAttribute('data-calendar-day'))!;
  const endOfMonth = new Date(dateInCalendar + 'T12:00:00Z');
  endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1, 0);
  const dateSelector = (d: Date) => '[data-calendar-day="' + d.toISOString().slice(0, 10) + '"]';
  await page.locator(dateSelector(endOfMonth)).click();
  await page.locator(dateSelector(endOfMonth)).press('ArrowRight');
  endOfMonth.setUTCDate(endOfMonth.getUTCDate() + 1);
  await expect(page.locator(dateSelector(endOfMonth))).toBeFocused();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await checkControls(page, 'Week schedule');
  await expect(page.getByLabel('Week schedule')).toBeVisible();
  await page.getByRole('button', { name: 'Check availability', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Check availability' });
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await panel.getByLabel('Pickup ·').fill(date + 'T10:07');
  await panel.getByLabel('Expected return ·').fill(date + 'T12:41');
  await panel.getByRole('button', { name: 'Check availability', exact: true }).click();
  await expect(panel.getByLabel('Availability results')).toContainText(name);
  await expect(panel.getByLabel('Availability results')).toContainText('12:41');
  await panel.getByRole('button', { name: 'Select vehicle' }).click();
  await page.getByRole('button', { name: 'Back to results' }).click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: /View results/ }).click();
  await expect(panel.getByLabel('Pickup ·')).toHaveValue(date + 'T10:07');
  await panel.getByLabel('Expected return ·').fill(date + 'T12:42');
  await expect(panel.getByLabel('Availability results')).toHaveCount(0);
  await page.route('**/api/availability?*', (r) =>
    r.fulfill({ status: 503, json: { error: 'Availability is temporarily unavailable.' } }),
  );
  await panel.getByRole('button', { name: 'Check availability', exact: true }).click();
  await checkControls(page, 'Availability service error');
  await expect(panel.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(panel.getByRole('button', { name: 'Select vehicle' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(pick).toHaveValue('');
  await expect(page.getByRole('button', { name: /View results/ })).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '23px';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.route('**/api/reservations?*', (r) =>
    r.fulfill({ status: 503, json: { error: 'Calendar is temporarily unavailable.' } }),
  );
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await checkControls(page, 'Calendar service error');
  await expect(page.getByRole('alert')).toContainText('Calendar is temporarily unavailable');
  await expect(page.getByText('No bookings on this day.')).toHaveCount(0);
});
