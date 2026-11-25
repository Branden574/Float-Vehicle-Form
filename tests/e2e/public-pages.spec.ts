import { expect, test } from '@playwright/test';

test('public pages and the expanded report form fit a narrow viewport at double text size', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 694 });
  const expectReflow = async () => {
    await page.addStyleTag({ content: ':root { font-size: 200% !important; }' });
    const { content, viewport } = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(content).toBeLessThanOrEqual(viewport + 1);
  };
  for (const path of ['/privacy', '/support', '/deletion-status']) {
    await page.goto(path);
    await expectReflow();
  }
  await page.route('**/api/report-copy/request-code', (route) => route.fulfill({ json: {} }));
  const token = '00000000-0000-0000-0000-000000000000.' + 'f'.repeat(64);
  await page.goto('/report-copy.html#' + token);
  await page.getByRole('button', { name: 'Email my verification code' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Six-digit verification code')).toBeFocused();
  await expectReflow();
});
