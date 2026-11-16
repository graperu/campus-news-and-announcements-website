import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const snapshot = JSON.parse(
  await readFile(new URL('../../database/sources/uth.json', import.meta.url), 'utf8'),
);
const articles = await (await fetch(base + '/api/public/articles')).json();
assert.equal(articles.length, 30);
for (const article of articles) {
  const record = snapshot.records.find((r) => r.id === article.id);
  assert.equal(article.body, record.body);
  assert.equal(article.summary, record.summary);
  assert.ok(article.body.length > 300);
  assert.ok(article.summary.length > 50);
  assert.equal(article.document_url || '', record.source_document_url || '');
}
assert.equal(articles.filter((a) => a.document_url).length, 20);
await mkdir('storage/reports/news-content', { recursive: true });
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'msedge',
  headless: true,
});
try {
  for (const width of [375, 768, 1440]) {
    const page = await browser.newPage({
        viewport: { width, height: 1000 },
        reducedMotion: 'reduce',
      }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    for (const type of ['news', 'document']) {
      const article = articles.find((a) =>
        type === 'document' ? !!a.document_url : !a.document_url,
      );
      await page.goto(base + '/article/' + encodeURIComponent(article.slug));
      await page.locator('.article-body p').first().waitFor();
      assert.ok((await page.locator('.article-body p').count()) >= 2);
      assert.equal((await page.locator('.article .summary').innerText()).trim(), article.summary);
      assert.ok(
        (await page.locator('.article-body').innerText()).includes(article.body.split('\n\n')[0]),
      );
      const body = await page.locator('.article-body').boundingBox(),
        image = await page.locator('.article-hero').boundingBox();
      assert.ok(body.y < image.y, 'Source article text must be available before its poster/image');
      if (type === 'document')
        await expect(page.locator('.source-document a')).toHaveAttribute(
          'href',
          article.document_url,
        );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.locator('img').evaluateAll(async (images) => {
        for (const image of images) image.loading = 'eager';
        await Promise.all(images.map((image) => image.decode()));
      });
      await page.screenshot({
        path: `storage/reports/news-content/${type}-${width}.png`,
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    JSON.stringify({
      base,
      reviewedArticles: 30,
      originalPdfLinks: 20,
      viewports: [375, 768, 1440],
      contentVisible: true,
      errors: [],
    }),
  );
} finally {
  await browser.close();
}
