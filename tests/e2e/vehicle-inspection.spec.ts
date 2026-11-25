import { expect, test, type APIRequestContext } from '@playwright/test';

test('an administrator refers a held vehicle and the assigned reviewer inspects and releases it', async ({
  page,
  request,
  baseURL,
}, info) => {
  // This scenario only creates records on the disposable browser-test server.
  expect(new URL(baseURL!).hostname).toBe('localhost');
  const localLogin = async (client: APIRequestContext, email: string) => {
    const response = await client.post('/api/auth/login', {
      data: { email, password: 'Local-test-password-123!' },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const admin = await localLogin(request, 'admin@example.test');
  const headers = { 'X-CSRF-Token': admin.csrfToken, Origin: baseURL! };
  const name = 'Inspection ' + info.project.name;
  const created = await request.post('/api/admin/vehicles', {
    headers,
    data: {
      name,
      make: 'Ford',
      model: 'Focus',
      year: 2024,
      plate: 'INSP-' + info.parallelIndex,
      vinLast4: '1234',
      site: 'Local test site',
      currentMileage: 1000,
      status: 'pending_review',
    },
  });
  expect(created.status()).toBe(201);
  const { vehicle } = await created.json();
  const setReviewers = (returnReviewerEmails: string[]) =>
    request.patch('/api/admin/settings', {
      headers,
      data: {
        returnReviewerEmails,
        reason: 'Configure reviewers for isolated browser verification',
      },
    });
  try {
    expect((await setReviewers(['driver@example.test'])).ok()).toBeTruthy();
    await localLogin(page.request, 'admin@example.test');
    await page.goto('/');
    await page.getByRole('button', { name: 'Administration', exact: false }).click();
    await page
      .locator('.admin-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Edit vehicle' })
      .click();
    await page
      .getByLabel('Reason for changes')
      .fill('Original trip no longer available. Please inspect on site.');
    await page.getByRole('button', { name: 'Request a physical inspection' }).click();
    await expect(page.getByRole('status')).toContainText('Physical inspection requested');

    await localLogin(page.request, 'driver@example.test');
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Vehicles needing a physical inspection' }),
    ).toBeVisible();
    const vehicleRow = page.getByRole('article').filter({ hasText: name });
    await expect(vehicleRow.getByRole('button', { name: 'Check out' })).toBeDisabled();
    const task = page.locator('details').filter({ hasText: name });
    await task.locator('summary').click();
    const complete = task.getByRole('button', { name: 'Complete inspection' });
    await expect(complete).toBeDisabled();
    await task.getByRole('checkbox', { name: /physically inspected/ }).check();
    await task.getByLabel('Inspection decision').selectOption('approve');
    await task
      .getByLabel('Inspection notes')
      .fill('Emergency kits, keys and odometer checked on site.');
    await complete.click();
    await expect(task).toHaveCount(0);
    await expect(vehicleRow.getByRole('button', { name: 'Check out' })).toBeEnabled();
    await page.reload();
    await expect(vehicleRow.getByRole('button', { name: 'Check out' })).toBeEnabled();
  } finally {
    await setReviewers(admin.settings.returnReviewerEmails || []);
    await request.patch('/api/admin/vehicles/' + vehicle.id, {
      headers,
      data: { archived: true, reason: 'Archive isolated browser test vehicle' },
    });
  }
});
