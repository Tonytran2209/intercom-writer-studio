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
    const upload = engine.getByLabel('Upload material', { exact: true });
    const analyze = engine.getByRole('button', { name: 'Kiểm tra thông tin và chạy Gate 1', exact: true });
    await expect(upload).toBeEnabled();
    await expect(analyze).toBeDisabled();
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
    await topic.fill('');
    await expect(analyze).toBeDisabled();
  });
}
