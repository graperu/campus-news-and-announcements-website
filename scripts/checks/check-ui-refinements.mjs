import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'msedge',
  headless: true,
});
try {
  for (const width of [375, 390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(base);
    await page.locator('.featured-grid').waitFor();
    const hero = await page.locator('.feature').boundingBox(),
      search = await page.locator('#search').boundingBox();
    assert.ok(search.y + search.height <= hero.y, 'Search should appear before featured news');
    const featured = await page
      .locator('.featured-grid a[data-route]')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    const feed = await page
      .locator('.news-layout .card a[data-route]')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    assert.ok(
      feed.every((h) => !featured.includes(h)),
      'Featured articles must not repeat in the feed',
    );
    if (width <= 760) {
      const image = await page.locator('.feature img').boundingBox(),
        title = await page.locator('.feature h2').boundingBox();
      assert.ok(title.y >= image.y + image.height, 'Mobile title must be below image');
    }
    const overflow = await page
      .locator('#category-nav')
      .evaluate((el) => el.scrollWidth > el.clientWidth + 2);
    if (overflow)
      assert.ok(
        await page.locator('#nav-next').isVisible(),
        'Scrollable categories need a visible affordance',
      );
    assert.ok(
      await page.locator('.brand-logo').evaluate((img) => img.complete && img.naturalWidth > 0),
    );
    await page.screenshot({ path: `storage/reports/screenshots/refined-home-${width}.png` });
    const sourcedArticle = await page.evaluate(async () => {
      const response = await fetch('/api/public/articles');
      const articles = await response.json();
      return articles.find(
        (article) => article.source_url && article.source_url.startsWith('https://'),
      )?.slug;
    });

    assert.ok(sourcedArticle, 'A published article with an HTTPS source is required');

    await page.goto(`${base}/article/${encodeURIComponent(sourcedArticle)}`);
    await page.locator('.source-top').waitFor();
    await page.locator('.related').waitFor();

    const source = await page.locator('.source-top').boundingBox();
    const image = await page.locator('.article-hero').boundingBox();

    assert.ok(source, 'Source CTA must exist');
    assert.ok(image, 'Article hero image must exist');
    assert.ok(source.y < image.y, 'Source CTA must be near the article heading');
    assert.equal(
      await page
        .locator('.article')
        .getByText(/Phiên bản:/)
        .count(),
      0,
    );
    assert.ok((await page.locator('.related .card').count()) > 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: `storage/reports/screenshots/refined-article-${width}.png` });
    await page.close();
  }
  if (process.env.ADMIN_LOGIN_FILE) {
    const credentials = await readFile(process.env.ADMIN_LOGIN_FILE, 'utf8');
    const email = credentials.match(/^Email: (.+)$/m)?.[1],
      password = credentials.match(/^Password: (.+)$/m)?.[1];
    assert.ok(email && password, 'Private login file is missing required fields');
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(base);
    await page.locator('.intro').waitFor();
    await page.locator('#account').click();
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.locator('#dialog button[type=submit]').click();
    await page.locator('#editorial-filters').waitFor();
    assert.equal(await page.locator('.editorial-item').count(), 8);
    const first = await page.locator('.editorial-item h3').first().innerText();
    await page.locator('#editorial-next').click();
    assert.notEqual(await page.locator('.editorial-item h3').first().innerText(), first);
    await page.locator('#editorial-status').selectOption('draft');
    assert.equal(await page.locator('.editorial-item').count(), 0);
    await page.locator('#clear-filters').click();
    assert.equal(await page.locator('.editorial-item').count(), 8);
    await page.locator('#editorial-query').fill(first);
    assert.equal(await page.locator('.editorial-item').count(), 1);
    await page.locator('#clear-filters').click();
    await page.locator('#editorial-category').selectOption('notices');
    const categoryTexts = await page.locator('.editorial-item .meta').allTextContents();
    assert.ok(
      categoryTexts.length > 0 && categoryTexts.every((text) => text.includes('Thông báo')),
    );
    await page.locator('#clear-filters').click();
    await page.screenshot({ path: 'storage/reports/screenshots/refined-editorial-1440.png' });
    await page.setViewportSize({ width: 375, height: 1000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: 'storage/reports/screenshots/refined-editorial-375.png' });
    await page.close();
  }
  console.log(
    'UI refinements verified: mobile hero, top search, unique feed, source CTA, related news, official logo and responsive layout' +
      (process.env.ADMIN_LOGIN_FILE
        ? ', editorial search/status/category filters and pagination.'
        : '.'),
  );
} finally {
  await browser.close();
}
