import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'msedge',
  headless: true,
});
try {
  for (const width of [375, 768, 1440, 1920]) {
    const context = await browser.newContext({
        viewport: { width, height: 1080 },
        reducedMotion: 'reduce',
      }),
      page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let hold = true;
    await page.route('**/api/public/articles**', async (route) => {
      if (hold) await gate;
      try {
        await route.continue();
      } catch {}
    });
    await page.goto(base);
    await page.locator('.skeleton-heading').waitFor();
    assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'true');
    assert.equal(
      await page
        .locator('.skeleton')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      'none',
    );
    hold = false;
    release();
    await page.locator('.featured-grid').waitFor();
    await page.locator('#content[aria-busy]').waitFor({ state: 'detached' });
    assert.equal(
      await page.locator('.feature img').evaluate((el) => getComputedStyle(el).objectFit),
      'contain',
    );
    const image = await page.locator('.feature img').boundingBox(),
      heading = await page.locator('.feature h2').boundingBox();
    assert.ok(
      heading.x >= image.x + image.width - 1 || heading.y >= image.y + image.height - 1,
      'Headline must not overlay the image',
    );
    assert.equal(
      await page.locator('.news-layout .card>p').count(),
      0,
      'Sourced cards should not repeat a generic source summary',
    );
    assert.ok(
      await page
        .locator('.card h3')
        .first()
        .evaluate((el) => getComputedStyle(el).webkitLineClamp === '3'),
    );
    await page.keyboard.press('Tab');
    await page.locator('#account').focus();
    assert.equal(
      await page.locator('#account').evaluate((el) => getComputedStyle(el).outlineStyle),
      'solid',
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.locator('img').evaluateAll(async (imgs) =>
      Promise.all(
        imgs.map(async (img) => {
          img.loading = 'eager';
          try {
            await img.decode();
          } catch {}
        }),
      ),
    );
    await page.screenshot({ path: `storage/reports/screenshots/upgraded-home-${width}.png` });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Hold a real earlier request: a newer search must win, including after release.
  const page = await browser.newPage();
  await page.goto(base);
  await page.locator('.featured-grid').waitFor();
  let releaseSlow;
  const slow = new Promise((resolve) => (releaseSlow = resolve));
  await page.route('**/api/public/articles**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === 'hội') await slow;
    try {
      await route.continue();
    } catch {}
  });
  await page.locator('#site-search').fill('hội');
  await page.locator('#site-search').press('Enter');
  await page.locator('.loading-shell').waitFor();
  await page.locator('#site-search').fill('UTH');
  await page.locator('#site-search').press('Enter');
  await page.locator('.intro h1').filter({ hasText: 'Kết quả cho “UTH”' }).waitFor();
  releaseSlow();
  assert.equal(await page.locator('.intro h1').innerText(), 'Kết quả cho “UTH”');
  await page.close();
  if (process.env.ADMIN_LOGIN_FILE) {
    const credentials = await readFile(process.env.ADMIN_LOGIN_FILE, 'utf8');
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    await page.goto(base);
    await page.locator('.intro').waitFor();
    await page.locator('#account').click();
    await page.getByLabel('Email', { exact: true }).fill(credentials.match(/^Email: (.+)$/m)[1]);
    await page
      .getByLabel('Mật khẩu', { exact: true })
      .fill(credentials.match(/^Password: (.+)$/m)[1]);
    await page.locator('#dialog button[type=submit]').click();
    await page.locator('#editorial-sort').waitFor();
    const versions = await (await page.request.get(base + '/api/editorial')).json();
    for (const [sort, compare] of [
      ['title', (a, b) => a.title.localeCompare(b.title, 'vi')],
      ['updated-asc', (a, b) => a.updated_at.localeCompare(b.updated_at)],
      ['updated-desc', (a, b) => b.updated_at.localeCompare(a.updated_at)],
    ]) {
      await page.locator('#editorial-sort').selectOption(sort);
      assert.deepEqual(
        await page.locator('.editorial-item h3').allTextContents(),
        [...versions]
          .sort(compare)
          .slice(0, 8)
          .map((v) => v.title),
      );
    }
    await page.locator('[data-tab="history"]').click();
    await page.locator('.history-table').waitFor();
    assert.equal(await page.locator('.history-table tbody tr').count(), 10);
    const title = await page
      .locator('.history-table tbody tr')
      .first()
      .locator('td')
      .first()
      .innerText();
    await page.locator('#history-next').click();
    assert.notEqual(
      await page.locator('.history-table tbody tr').first().locator('td').first().innerText(),
      title,
    );
    await page.locator('#history-query').fill(title);
    assert.ok(
      (await page.locator('.history-table tbody tr').allTextContents()).every((text) =>
        text.includes(title),
      ),
    );
    await page.locator('#history-query').fill('');
    await page.screenshot({ path: 'storage/reports/screenshots/upgraded-history-1440.png' });
    await page.setViewportSize({ width: 375, height: 1080 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: 'storage/reports/screenshots/upgraded-history-375.png' });
    await page.close();
  }
  console.log(
    'UI upgrade checks passed: real loading, cancellation, image/headline separation, cards, keyboard focus, reduced motion, sorting and publication history.',
  );
} finally {
  await browser.close();
}
