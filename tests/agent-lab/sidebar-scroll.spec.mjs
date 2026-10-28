import {test, expect} from './browser-fixture.mjs';

// Isolated synthetic contract regression; no production API or data is used.
test.beforeEach(async ({page}) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === 'http://127.0.0.1:4173' && !url.pathname.startsWith('/api/')
      ? route.fallback() : route.abort();
  });
});

async function expectNoPageOverflow(page) {
  expect(await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > innerWidth,
    vertical: document.documentElement.scrollHeight > innerHeight,
  }))).toEqual({horizontal:false, vertical:false});
}

async function wheelToEnd(page, region) {
  await expect.poll(() => region.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await region.hover();
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => region.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
}

test('short desktop sidebar scrolls while footer controls remain usable', async ({page}) => {
  await page.setViewportSize({width:1024,height:480});
  await page.goto('/?screen=sidebar');
  const sidebar = page.locator('aside.eb-sidebar');
  const content = sidebar.locator(':scope > div').first();
  const last = sidebar.getByRole('button', {name:'Fixture package 20',exact:true});
  await expect(last).toHaveCount(1);
  await wheelToEnd(page, content);
  await expect(last).toBeInViewport({ratio:1});
  await last.click();
  await expect(page.getByTestId('sidebar-action')).toHaveText('selected:sidebar-20');
  for (const collapsed of [false,true]) {
    if (collapsed) {
      await content.evaluate(el => {el.scrollTop=0;});
      await sidebar.getByRole('button',{name:'Toggle sidebar'}).click();
    }
    await expect(sidebar.getByRole('button',{name:'Settings',exact:true})).toBeInViewport({ratio:1});
    await sidebar.getByRole('button',{name:'Settings',exact:true}).click();
    await expect(page.getByTestId('sidebar-action')).toHaveText('settings');
    await expect(sidebar.getByRole('button',{name:'Search',exact:true})).toBeInViewport({ratio:1});
    await sidebar.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByPlaceholder('Search started packages…').fill('Fixture package 20');
    // Search is a viewport overlay, rendered outside the aside on mobile-capable shells.
    // The visible input scopes the popup; do not click the obscured background package.
    const searchPopup=page.getByPlaceholder('Search started packages…').locator('..').locator('..');
    await searchPopup.getByRole('button',{name:'Fixture package 20',exact:true}).click();
    await expect(page.getByTestId('sidebar-action')).toHaveText('selected:sidebar-20');
    await expect(page.getByPlaceholder('Search started packages…')).toHaveCount(0);
    await expectNoPageOverflow(page);
  }
});

test('mobile Packages retains scrolling and selection', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/?screen=sidebar');
  await page.getByRole('button',{name:'Packages',exact:true}).click();
  const sheet = page.locator('section').filter({has:page.getByRole('heading',{name:'Started packages'})});
  const last = sheet.getByRole('button',{name:'Fixture package 20',exact:true});
  await expect(last).toHaveCount(1);
  await wheelToEnd(page,sheet);
  await expect(last).toBeInViewport({ratio:1});
  await last.click();
  await expect(page.getByTestId('sidebar-action')).toHaveText('selected:sidebar-20');
  await expectNoPageOverflow(page);
});
