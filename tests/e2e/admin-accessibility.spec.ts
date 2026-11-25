import { expect, test } from '@playwright/test';

test('administration recovers from a failed load and moves focus into and out of its editors', async ({
  page,
  baseURL,
}) => {
  expect(new URL(baseURL!).hostname).toBe('localhost');
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@example.test', password: 'Local-test-password-123!' },
  });
  expect(login.ok()).toBeTruthy();
  await page.route('**/api/admin/overview', (route) =>
    route.fulfill({ status: 503, json: { error: 'Overview unavailable' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: /Administration/ }).click();
  await expect(page.getByRole('alert')).toContainText('Overview unavailable');
  await expect(page.getByText('Loading administration…')).toHaveCount(0);
  await page.unroute('**/api/admin/overview');
  await page.getByRole('button', { name: 'Retry loading administration' }).click();
  const add = page.getByRole('button', { name: 'Add vehicle' });
  await add.click();
  const vehicleTitle = page.getByRole('heading', { name: 'Add vehicle' });
  await expect(vehicleTitle).toBeFocused();
  await expect(vehicleTitle).toBeInViewport();
  await page.getByRole('button', { name: 'Close vehicle editor' }).click();
  await expect(add).toBeFocused();

  await page.getByRole('tab', { name: 'Vehicles' }).press('ArrowRight');
  const staff = page.getByRole('tab', { name: 'Staff' });
  await expect(staff).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Staff' })).toBeVisible();
  const invite = page.getByRole('button', { name: 'Invite staff' });
  await invite.click();
  const staffTitle = page.getByRole('heading', { name: 'Invite a staff member' });
  await expect(staffTitle).toBeFocused();
  await expect(staffTitle).toBeInViewport();
  await page.getByRole('button', { name: 'Close staff editor' }).click();
  await expect(invite).toBeFocused();
  await staff.press('End');
  await expect(page.getByRole('tab', { name: 'Audit' })).toBeFocused();
});

test('long vehicle names, audit values and calendar controls fit at double text size', async ({
  page,
  baseURL,
}, info) => {
  expect(new URL(baseURL!).hostname).toBe('localhost');
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@example.test', password: 'Local-test-password-123!' },
  });
  expect(login.ok()).toBeTruthy();
  const { csrfToken } = await login.json();
  const headers = { 'X-CSRF-Token': csrfToken, Origin: baseURL! };
  const name = 'NorthDistrictSharedVehicleEmergencyResponseUnitAlpha' + info.project.name;
  const response = await page.request.post('/api/admin/vehicles', {
    headers,
    data: {
      name,
      make: 'Ford',
      model: 'Transit',
      year: 2025,
      plate: 'LAYOUT-' + info.project.name.slice(-5),
      vinLast4: '1234',
      currentMileage: 10,
      site: 'Regional transportation department',
      status: 'available',
    },
  });
  expect(response.status()).toBe(201);
  const { vehicle } = await response.json();
  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    const fitsPage = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      );
    await page.getByRole('button', { name: /Administration/ }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    expect(await fitsPage()).toBeTruthy();
    await page.getByRole('tab', { name: 'Audit' }).click();
    const change = page.locator('.audit-row').filter({ hasText: name }).first();
    await change.locator('summary').click();
    await expect(change.locator('pre').last()).toContainText(name);
    expect(await fitsPage()).toBeTruthy();

    await page.getByRole('button', { name: /Vehicle fleet/ }).click();
    await page.getByRole('button', { name: 'Check availability & view calendar' }).click();
    const month = page.getByLabel('Month schedule');
    await expect(month).toBeVisible();
    const clipped = await month
      .locator('.weekday, .calendar-date')
      .evaluateAll((cells) =>
        cells
          .filter((cell) => cell.scrollWidth > cell.clientWidth + 2)
          .map((cell) => cell.textContent),
      );
    expect(clipped).toEqual([]);
    await page.getByRole('combobox', { name: 'Vehicle', exact: true }).selectOption(vehicle.id);
    await page.getByRole('button', { name: 'Check availability', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(name);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await dialog.getByLabel('Pickup ·').fill(day + 'T09:12');
    await dialog.getByLabel('Expected return ·').fill(day + 'T11:22');
    await dialog.getByRole('button', { name: 'Check availability', exact: true }).click();
    await dialog.getByRole('button', { name: 'Select vehicle', exact: true }).click();
    const title = dialog.getByRole('heading', { name: 'Reserve vehicle' });
    await expect(title).toBeFocused();
    await expect(title).toBeInViewport();
    await expect(dialog.getByRole('heading', { name })).toBeVisible();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    await dialog.getByRole('button', { name: 'Back to results' }).click();
    const results = dialog.getByRole('heading', { name: 'Results' });
    await expect(results).toBeFocused();
    await expect(results).toBeInViewport();
  } finally {
    await page.request.patch('/api/admin/vehicles/' + vehicle.id, {
      headers,
      data: { archived: true, reason: 'Archive isolated layout test vehicle' },
    });
  }
});
