import { test, expect, setTheme } from './browser-fixture.mjs';

// Synthetic empty workspace exercises real controls; this is not a production reproduction.
for (const theme of ['light', 'dark']) {
  test(`Input Engine stable background without textarea stroke: ${theme}`, async ({ page }) => {
    await page.route('**/api/**', route => {
      if (new URL(route.request().url()).pathname.endsWith('/workspace')) {
        return route.fulfill({ json: { packages: [], runs: [], articles: [], channels: [], discovery: [] } });
      }
      return route.abort();
    });
    await page.goto('/?screen=eb');
    await setTheme(page, theme);
    const engine = page.locator('.eb-input-engine');
    const topic = engine.locator('.eb-input-topic');
    const upload = engine.getByLabel('Đính kèm tài liệu ý tưởng', { exact: true });
    const analyze = engine.getByRole('button', { name: 'Kiểm tra thông tin và chạy Gate 1', exact: true });
    const toggle = engine.getByRole('button', { name: 'Mở thanh nhập ý tưởng', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(topic).toBeHidden();
    const bottomInset = el => el.closest('.eb-board-body').getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
    const launcherInset = await toggle.evaluate(bottomInset);
    await toggle.click();
    await expect(toggle).toBeHidden();
    await expect(topic).toBeVisible();
    await expect.poll(() => engine.locator('.eb-input-row').evaluate(bottomInset)).toBeCloseTo(launcherInset);
    await expect(upload).toBeEnabled();
    await expect(topic).toBeEnabled();
    await expect(analyze).toBeDisabled();
    await expect(topic).toHaveCSS('font-size', '13px');
    await expect(analyze.getByText('Analyze', { exact: true })).toHaveCSS('font-size', '13px');
    await expect(page.getByRole('heading', { name: 'EB Content Packages' })).toHaveCSS('font-size', '16px');
    await expect(topic).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    async function expectNoStroke() {
      await expect(topic).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(topic).toHaveCSS('outline-style', 'none');
      await expect(topic).toHaveCSS('box-shadow', 'none');
      for (const side of ['top', 'right', 'bottom', 'left']) {
        await expect(topic).toHaveCSS(`border-${side}-width`, '0px');
      }
    }
    await topic.hover();
    await expectNoStroke();
    await topic.click();
    await expectNoStroke();
    await topic.pressSequentially('Topic with F source');
    await expect(topic).toHaveValue('Topic with F source');
    await expect(analyze).toBeEnabled();
    const analyzeBounds = await analyze.boundingBox();
    const analyzeLabel = await analyze.getByText('Analyze', { exact: true }).boundingBox();
    expect(analyzeLabel.x + analyzeLabel.width).toBeLessThan(analyzeBounds.x + analyzeBounds.width);
    await expectNoStroke();
    await expect(topic).toHaveCSS('resize', 'vertical');
    await expect(topic).toHaveCSS('overflow-y', 'auto');
    await expect(engine.locator('.eb-input-row')).toHaveCSS('border-top-width', '1px');
    await expect.poll(() => engine.locator('.eb-input-pill').evaluate(el => getComputedStyle(el, '::before').opacity)).toBe('0.85');
    await expect(engine.locator('.eb-input-pill')).toHaveCSS('border-radius', '32px');
    await page.screenshot({ path: test.info().outputPath(`input-focus-${theme}.png`) });

    // Walk backwards from the textarea to the upload, then forwards by Tab.
    await topic.press('Shift+Tab');
    await expect(upload).toBeFocused();
    await expect(engine.locator('.eb-input-upload')).toHaveCSS('outline-style', 'solid');
    await expect(engine.locator('.eb-input-upload')).toHaveCSS('outline-width', '2px');
    await expect(upload).toHaveCSS('outline-style', 'none');
    await upload.press('Tab');
    await expect(topic).toBeFocused();
    await expectNoStroke();
    await expect(topic).toHaveValue('Topic with F source');
    await page.getByRole('heading', { name: 'EB Content Packages' }).click();
    await expect(topic).toBeHidden();
    await expect(toggle).toBeVisible();
    await toggle.press('Enter');
    await expect(topic).toHaveValue('Topic with F source');
    await page.locator('.eb-board-surface').hover();
    await page.mouse.wheel(0, 150);
    await expect(topic).toBeHidden();
    await toggle.click();
    await expect(topic).toHaveValue('Topic with F source');
    await topic.fill('');
    await expect(analyze).toBeDisabled();
  });
}

test('Gate Grid scrolls without tracks and keeps card actions reachable', async ({page}, testInfo) => {
  const desktop = testInfo.project.name === 'desktop';
  await page.setViewportSize(desktop ? {width:1600,height:850} : {width:390,height:700});
  const packages = Array.from({length:24}, (_, index) => ({
    id:'brief-' + index, title:'Synthetic brief ' + index, state:'brief',
  }));
  packages.push({id:'last-gate',title:'Synthetic final review',state:'review'});
  await page.route('**/api/eb-v2/workspace', route => route.fulfill({
    json:{packages,runs:[],articles:[],channels:[],discovery:[]},
  }));
  await page.goto('/?screen=eb');
  // This fixture mounts the workspace directly. Match the app shell's viewport constraint.
  await page.locator('.eb-workspace').evaluate(element => { element.style.height = 'calc(100dvh - 24px)'; });
  const gridToggle = page.getByRole('button',{name:'Grid view',exact:true});
  const listToggle = page.getByRole('button',{name:'List view',exact:true});
  await expect(listToggle).toHaveAttribute('aria-pressed','true');
  const engine = page.locator('.eb-input-engine');
  const list = page.locator('.eb-board-list');
  await expect(engine).toHaveCSS('position', 'absolute');
  await expect(engine).toHaveCSS('pointer-events', 'none');
  await expect(engine.locator('.eb-input-pill')).toHaveCSS('pointer-events', 'auto');
  const engineBounds = await engine.boundingBox();
  const listBounds = await list.boundingBox();
  expect(listBounds.y + listBounds.height).toBeGreaterThan(engineBounds.y);
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const lastListTask = await list.locator('h3').last().boundingBox();
  expect(lastListTask.y + lastListTask.height).toBeLessThan(engineBounds.y);

  await expect(gridToggle).toHaveCSS('width','36px');
  await expect(gridToggle).toHaveCSS('height','36px');
  await expect(listToggle).toHaveCSS('width','36px');
  await expect(listToggle).toHaveCSS('height','36px');
  await gridToggle.focus();
  await gridToggle.press('Enter');
  await expect(gridToggle).toHaveAttribute('aria-pressed','true');
  await expect(listToggle).toHaveAttribute('aria-pressed','false');
  const grid = page.locator('.eb-grid-scroll').first();
  const columns = grid.locator('.gate-column');
  await expect(columns).toHaveCount(4);
  const first = await columns.first().boundingBox();
  const last = await columns.last().boundingBox();
  expect(first.width).toBeGreaterThanOrEqual(304);
  expect(last.y).toBe(first.y);
  await expect(grid).toHaveCSS('scrollbar-width','none');
  if (!desktop) {
    await grid.hover();
    await page.mouse.wheel(1000,0);
    await expect.poll(()=>grid.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
    await expect(columns.last().getByRole('heading',{level:2})).toBeInViewport();
    const lastTrigger = columns.last().getByRole('button',{name:'More item actions',exact:true});
    await lastTrigger.click();
    const lastMenu = page.getByRole('dialog',{name:'Task actions'});
    await expect(lastMenu).toBeInViewport({ratio:1});
    await expect(lastMenu.getByRole('button',{name:'Delete item',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(lastTrigger).toBeFocused();
    await grid.evaluate(element => { element.scrollLeft = 0; });
  }
  const scroll = columns.first().locator('.eb-grid-scroll');
  await expect(scroll).toHaveCSS('scrollbar-width','none');
  await scroll.hover();
  await page.mouse.wheel(0,480);
  await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
  const actions = columns.first().getByRole('button',{name:'More item actions',exact:true}).last();
  await actions.click();
  const regenerate = page.getByRole('dialog',{name:'Task actions'}).getByRole('button',{name:'Regenerate',exact:true});
  await expect(regenerate).toBeInViewport();
  await expect(page.getByRole('button',{name:'Mở thanh nhập ý tưởng',exact:true})).toBeInViewport();
  expect(await grid.evaluate(element=>element.scrollWidth <= element.clientWidth)).toBe(desktop);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
