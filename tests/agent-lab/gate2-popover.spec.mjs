import { test, expect,setTheme } from './browser-fixture.mjs';

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
      } else if (request.method() === 'GET') return route.fallback();
    }
    unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  await page.goto('/?screen=eb');
  // The fixture mounts the workspace directly, without App's h-dvh flex shell.
  // Supply only that parent constraint so the real board owns scrolling.
  await page.addStyleTag({ content: '#root { height: 100dvh; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }' });
  await setTheme(page,theme);
  await expect(page.getByRole('button', { name: `Open task: ${approvedTitle}`, exact: true })).toBeAttached();
  return { unexpected, mutations, activities, errors };
}
async function view(page, name) {
  const control = page.getByRole('button',{name:name==='grid'?'Grid view':'List view',exact:true});
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
      const menu = page.getByRole('dialog', { name: 'Task actions' });
      await expect(menu).toBeVisible();
      await expect(menu).toBeInViewport({ ratio: 1 });
      expect(await menu.evaluate(element => !element.closest('.eb-workspace'))).toBe(true);
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
      await expect(menu).toBeHidden();
      // Find the List or Gate's own vertical scroll container.
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
    const menu = page.getByRole('dialog', { name: 'Task actions' });
    await expect(menu.getByRole('button', { name: 'Regenerate', exact: true })).toBeVisible();
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click(); await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.getByRole('heading', { name: 'Adapt channel', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('aside').filter({ has: page.getByRole('heading', { name: approvedTitle, exact: true }) })).toHaveCount(0);
    expect(state.activities).toEqual([]);
    const running = card(page, runningTitle);
    const runningToggle = await openMenu(running);
    await expect(running.getByText('Drafting', { exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Regenerate', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(runningToggle).toHaveAttribute('aria-expanded', 'false');
    const open = target.getByRole('button', { name: 'Open article', exact: true });
    await expect(open).toBeEnabled(); await open.click();
    await expect(page.locator('aside').filter({ has: page.getByRole('heading', { name: approvedTitle, exact: true }) })).toBeVisible();
    await expect.poll(() => state.activities).toEqual(['/api/eb-v2/activity/approved']);
    assertOffline(state);
  });
}
