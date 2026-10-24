import { test, expect } from '@playwright/test';

// Synthetic layout fixture; this does not claim to reproduce production data.
const approvedTitle = 'G2_APPROVED_FIXTURE';
const runningTitle = 'G2_RUNNING_FIXTURE';
function workspace() {
  const packages = Array.from({ length: 12 }, (_, i) => ({
    id: `brief-${i}`, title: `Brief filler ${i}`, state: 'brief', source_type: 'input',
  }));
  packages.push(
    { id: 'running', title: runningTitle, state: 'article', source_type: 'input' },
    { id: 'approved', title: approvedTitle, state: 'article', source_type: 'input' },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `review-${i}`, title: `Review filler ${i}`, state: 'review', source_type: 'input' })),
  );
  return { packages, articles: [{ id: 'approved-article', package_id: 'approved', status: 'approved', revision: 1 }], channels: [], runs: [{ package_id: 'running', gate: 'article', status: 'running' }], discovery: [] };
}
async function setup(page, theme) {
  const unexpected = [], mutations = [], activities = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://fonts.googleapis.com' && request.method() === 'GET')
      return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.origin === 'http://127.0.0.1:4173') {
      if (url.pathname.startsWith('/api/')) {
        if (request.method() !== 'GET') mutations.push(`${request.method()} ${url.pathname}`);
        if (request.method() === 'GET' && url.pathname === '/api/eb-v2/workspace') return route.fulfill({ json: workspace() });
        if (request.method() === 'GET' && url.pathname.startsWith('/api/eb-v2/activity/')) {
          activities.push(url.pathname);
          return route.fulfill({ json: { inputs: [], runs: [], actions: [], feedback: [] } });
        }
      } else if (request.method() === 'GET') return route.continue();
    }
    unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  await page.goto('/?screen=eb');
  // The fixture mounts the workspace directly, without App's h-dvh flex shell.
  // Supply only that parent constraint so the real board owns scrolling.
  await page.addStyleTag({ content: '#root { height: 100dvh; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }' });
  await page.locator('body').evaluate((body, theme) => {
    body.classList.toggle('codex-dark', theme === 'dark');
    body.classList.toggle('writer-light', theme === 'light');
  }, theme);
  await expect(page.getByRole('button', { name: `Open task: ${approvedTitle}`, exact: true })).toBeAttached();
  return { unexpected, mutations, activities, errors };
}
async function view(page, name) {
  const control = page.locator(`button:has(svg.lucide-${name === 'grid' ? 'grid2x2' : 'list'})`);
  await expect(control).toBeEnabled();
  await control.click();
}
function card(page, title = approvedTitle) {
  return page.locator('article').filter({ has: page.getByRole('button', { name: `Open task: ${title}`, exact: true }) });
}
async function openMenu(target) {
  const toggle = target.getByRole('button', { name: 'More item actions', exact: true });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return toggle;
}
function assertOffline(state) {
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
}
for (const theme of ['light', 'dark']) {
  for (const layout of ['list', 'grid']) {
    test(`G2_MENU_LAYER ${theme} ${layout}`, async ({ page }, info) => {
      const state = await setup(page, theme);
      await view(page, layout);
      const target = card(page);
      await target.scrollIntoViewIfNeeded();
      await openMenu(target);
      const menu = target.getByRole('button', { name: 'Delete item', exact: true }).locator('..');
      const header = page.getByRole('heading', { name: 'Adapt channel', exact: true }).locator('../../..');
      if (layout === 'list') {
        // Establish real overlap with the following sticky header before hit testing.
        const a = await menu.boundingBox(), b = await header.boundingBox();
        expect(a).not.toBeNull(); expect(b).not.toBeNull();
        expect(Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)).toBeGreaterThan(0);
        expect(Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)).toBeGreaterThan(0);
        // Control: the oracle must detect the original toolbar-below-header bug.
        const control = await menu.evaluate(element => {
          const header = [...document.querySelectorAll('h2')].find(h => h.textContent === 'Adapt channel').parentElement.parentElement.parentElement;
          const h = header.getBoundingClientRect(), toolbar = element.parentElement.parentElement;
          const points = [...element.querySelectorAll('button')].flatMap(button => {
            const b = button.getBoundingClientRect(), top = Math.max(b.top, h.top, 0), bottom = Math.min(b.bottom, h.bottom, innerHeight);
            return bottom > top ? [{ button, x: b.left + b.width / 2, y: (top + bottom) / 2 }] : [];
          });
          const previous = toolbar.style.zIndex;
          try {
            toolbar.style.zIndex = '10';
            return { samples: points.length, detectsCoveredMenu: points.some(p => !p.button.contains(document.elementFromPoint(p.x, p.y))) };
          } finally { toolbar.style.zIndex = previous; }
        });
        expect(control.samples).toBeGreaterThan(0);
        expect(control.detectsCoveredMenu).toBe(true);
        // Include the covered portion, rather than only each button's center.
        await expect.poll(() => menu.evaluate((element) => {
          const heading = [...document.querySelectorAll('h2')].find(h => h.textContent === 'Adapt channel').parentElement.parentElement.parentElement;
          const headerBox = heading.getBoundingClientRect();
          return [...element.querySelectorAll('button')].every(button => {
            const box = button.getBoundingClientRect();
            const ys = [box.top + box.height / 2];
            const top = Math.max(box.top, headerBox.top), bottom = Math.min(box.bottom, headerBox.bottom);
            if (bottom > top) ys.push((top + bottom) / 2);
            return ys.every(y => button.contains(document.elementFromPoint(box.left + box.width / 2, y)));
          });
        })).toBe(true);
      }
      for (const button of await menu.getByRole('button').all()) {
        await expect(button).toBeVisible();
        expect(await button.evaluate(element => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        })).toBe(true);
        await button.click({ trial: true });
      }
      await page.screenshot({ path: info.outputPath(`gate2-${theme}-${layout}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      // Find the board's own scroll container (or desktop grid column).
      const movement = await page.getByRole('button', { name: 'Open task: Brief filler 0', exact: true }).evaluate(button => {
        let element = button.parentElement;
        while (element && !(getComputedStyle(element).overflowY === 'auto' && element.scrollHeight > element.clientHeight)) element = element.parentElement;
        if (!element) return { max: 0, top: 0 };
        const max = element.scrollHeight - element.clientHeight;
        element.scrollTop = 0;
        element.scrollTop = Math.min(100, max);
        return { max, top: element.scrollTop };
      });
      expect(movement.max).toBeGreaterThan(0);
      expect(movement.top).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      assertOffline(state);
    });
  }
  test(`G2_MENU_INTERACTION ${theme}`, async ({ page }) => {
    const state = await setup(page, theme);
    await view(page, 'list');
    const target = card(page);
    const toggle = await openMenu(target);
    await expect(target.getByRole('button', { name: 'Regenerate', exact: true })).toBeVisible();
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click(); await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.getByRole('heading', { name: 'Adapt channel', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('aside').filter({ has: page.getByRole('heading', { name: approvedTitle, exact: true }) })).toHaveCount(0);
    expect(state.activities).toEqual([]);
    const running = card(page, runningTitle);
    const runningToggle = await openMenu(running);
    await expect(running.getByText('Drafting', { exact: true })).toBeVisible();
    await expect(running.getByRole('button', { name: 'Regenerate', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(runningToggle).toHaveAttribute('aria-expanded', 'false');
    const open = target.getByRole('button', { name: 'Open article', exact: true });
    await expect(open).toBeEnabled(); await open.click();
    await expect(page.locator('aside').filter({ has: page.getByRole('heading', { name: approvedTitle, exact: true }) })).toBeVisible();
    await expect.poll(() => state.activities).toEqual(['/api/eb-v2/activity/approved']);
    assertOffline(state);
  });
}
