import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'msedge',
  headless: true,
});
const wait = async (page) => {
  await page.locator('#content[aria-busy]').waitFor({ state: 'detached' });
  await page.locator('.intro,.article,.empty').first().waitFor();
};
await mkdir('storage/reports/ui-audit-fixed', { recursive: true });
const measurements = [];
try {
  for (const width of [320, 375, 768, 1366, 1920, 2560]) {
    const page = await browser.newPage({
        viewport: { width, height: 1000 },
        reducedMotion: 'reduce',
      }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await wait(page);
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
    const result = await page.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const image = box('.feature img'),
        frame = box('.feature-media'),
        brand = box('.brand');
      return {
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        heroTop: box('.feature').top,
        firstFeedTop: box('.news-layout .card').top,
        brandCenter: brand.x + brand.width / 2,
        navColor: getComputedStyle(document.querySelector('.nav-link.active')).color,
        imageInside: image.top >= frame.top - 1 && image.bottom <= frame.bottom + 1,
      };
    });
    assert.equal(result.overflow, false);
    assert.ok(result.imageInside);
    assert.ok(Math.abs(result.brandCenter - width / 2) < 2);
    assert.equal(result.navColor, 'rgb(255, 255, 255)');
    if (width === 375) {
      assert.ok(result.heroTop < 400);
      assert.ok(result.firstFeedTop < 1200);
    }
    if ([375, 1920].includes(width))
      await page.screenshot({ path: `storage/reports/ui-audit-fixed/home-${width}.png` });
    await page.locator('.feature-media').click();
    await page.locator('.article').waitFor();
    assert.ok(new URL(page.url()).pathname.startsWith('/article/'));
    assert.deepEqual(errors, []);
    measurements.push(result);
    await page.close();
  }
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
    reducedMotion: 'reduce',
  });
  await page.goto(base);
  await wait(page);
  await page.locator('[data-category="notices"]').click();
  await wait(page);
  assert.equal(new URL(page.url()).searchParams.get('category'), 'notices');
  await page.reload();
  await wait(page);
  assert.equal(await page.locator('.intro h1').innerText(), 'Thông báo');
  await page.goBack();
  await wait(page);
  assert.equal(await page.locator('.intro h1').innerText(), 'Nhịp sống UTH.');
  await page.locator('[data-category="notices"]').click();
  await wait(page);
  await page.locator('#site-search').fill('UTH');
  await page.locator('#site-search').press('Enter');
  await wait(page);
  assert.equal(new URL(page.url()).searchParams.get('category'), null);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'UTH');
  assert.equal(await page.locator('.nav-link.active').innerText(), 'Tất cả tin tức');
  assert.ok((await page.locator('.card').count()) > 0);
  await page.goto(base);
  await wait(page);
  await page.locator('#next').scrollIntoViewIfNeeded();
  const headerNode = await page.locator('header').elementHandle();
  await page.locator('#next').click();
  assert.equal(new URL(page.url()).searchParams.get('page'), '2');
  assert.ok(
    await page
      .locator('#news-heading')
      .evaluate(
        (el) => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top <= 25,
      ),
  );
  assert.equal(await page.locator('#content .loading-shell').count(), 0);
  assert.ok(await headerNode.evaluate((el) => el.isConnected));
  const secondPageTitle = await page.locator('.news-layout .card h3').first().innerText();
  await page.reload();
  await wait(page);
  assert.equal(await page.locator('.news-layout .card h3').first().innerText(), secondPageTitle);
  await page.locator('#account').click();
  assert.equal(await page.locator('#dialog').getAttribute('aria-labelledby'), 'dialog-title');
  assert.equal(await page.locator('#email').evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(
    await page.locator('#account').evaluate((el) => el === document.activeElement),
    true,
  );
  if (process.env.ADMIN_LOGIN_FILE) {
    const text = await readFile(process.env.ADMIN_LOGIN_FILE, 'utf8');
    await page.locator('#account').click();
    await page.getByLabel('Email', { exact: true }).fill(text.match(/^Email: (.+)$/m)[1].trim());
    await page
      .getByLabel('Mật khẩu', { exact: true })
      .fill(text.match(/^Password: (.+)$/m)[1].trim());
    await page.locator('#dialog button[type=submit]').click();
    await page.locator('#editorial-filters').waitFor();
    await page.locator('#editorial-status').selectOption('published');
    await page.locator('#editorial-sort').selectOption('title');
    await page.locator('#editorial-next').click();
    await page.reload();
    await page.locator('#editorial-filters').waitFor();
    assert.equal(await page.locator('#editorial-status').inputValue(), 'published');
    assert.equal(await page.locator('#editorial-sort').inputValue(), 'title');
    assert.equal(new URL(page.url()).searchParams.get('ep'), '2');
    await page.locator('[data-tab="history"]').click();
    await page.locator('.history-table').waitFor();
    await page.locator('#history-next').click();
    await page.reload();
    await page.locator('.history-table').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'history');
    assert.equal(new URL(page.url()).searchParams.get('hp'), '2');
    await page
      .locator('.history-table tbody tr')
      .first()
      .getByRole('button', { name: 'Xem phiên bản' })
      .click();
    await page.locator('#dialog-title').waitFor();
    assert.ok((await page.locator('#dialog-body .article-body').innerText()).length > 0);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.locator('[data-tab="articles"]').click();
    await page.locator('.workspace-overview').waitFor();
    assert.equal(await page.locator('.workspace-overview').getAttribute('open'), null);
    assert.equal(await page.locator('.filter-panel').getAttribute('open'), null);
    await page.screenshot({ path: 'storage/reports/ui-audit-fixed/editorial-375.png' });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.close();
  await writeFile(
    'storage/reports/ui-audit-fixed/measurements.json',
    JSON.stringify(measurements, null, 2),
  );
  console.log(JSON.stringify(measurements));
  console.log(
    'Audit regressions passed: responsive vector brand, contrast, media links, URL Back/Reload, global search, stable pagination, labelled/focused dialog, compact workspace and version snapshots.',
  );
} finally {
  await browser.close();
}
