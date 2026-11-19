import { expect, type Page } from '@playwright/test';

export async function checkControls(page: Page, screen: string) {
  const problems = await page.evaluate(() => {
    const issues: string[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1)
      issues.push('Page overflows horizontally');
    const controls = [
      ...document.querySelectorAll<HTMLElement>('button, a.button, label.file-button, nav a'),
    ].filter((el) => el.getBoundingClientRect().height > 0);
    const label = (el: HTMLElement) =>
      (el.getAttribute('aria-label') || el.innerText).trim().slice(0, 55);
    for (const [i, el] of controls.entries()) {
      const a = el.getBoundingClientRect();
      if (a.height < 43.5) issues.push(label(el) + ' is shorter than 44px');
      if (el.scrollWidth > el.clientWidth + 1) issues.push(label(el) + ' clips its label');
      for (const next of controls.slice(i + 1)) {
        if (
          el.parentElement !== next.parentElement ||
          (el.matches('.trip-row') && next.matches('.trip-row'))
        )
          continue;
        const b = next.getBoundingClientRect();
        const dx = Math.max(a.left - b.right, b.left - a.right);
        const dy = Math.max(a.top - b.bottom, b.top - a.bottom);
        if (Math.max(dx, dy) < 6.5) issues.push(label(el) + ' crowds ' + label(next));
      }
    }
    return issues;
  });
  expect(problems, screen).toEqual([]);
}
