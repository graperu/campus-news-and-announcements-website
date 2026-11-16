import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
const request = (path, options = {}) =>
  fetch(base + path, { ...options, signal: AbortSignal.timeout(20000) });
const health = await request('/health');
assert.equal(health.status, 200);
assert.equal((await health.json()).status, 'ok');
const config = await (await request('/api/config')).json();
assert.equal(config.authAvailable, false);
assert.equal(config.localAuth, false);
const list = await request('/api/public/articles'),
  articles = await list.json();
assert.equal(list.status, 200);
const snapshot = JSON.parse(
  await readFile(new URL('../../database/sources/uth.json', import.meta.url), 'utf8'),
);
assert.equal(articles.length, snapshot.records.length);
for (const item of articles) {
  assert.equal(new URL(item.source_url).hostname, 'congdoan.ut.edu.vn');
  const source = snapshot.records.find((record) => record.id === item.id);
  assert.equal(item.title, source.title);
}
for (const path of [
  '/api/auth/login',
  '/api/articles',
  '/api/categories',
  '/api/users',
  '/api/uploads',
  '/api/ops/origin',
]) {
  const result = await request(path, {
    method: 'POST',
    headers: { 'X-Campus-Client': '1', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(result.status, 503, path);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('set-cookie'), null);
}
assert.equal(
  (
    await request('/api/versions/nonexistent', {
      method: 'PUT',
      headers: { 'X-Campus-Client': '1' },
      body: '{}',
    })
  ).status,
  503,
);
for (const path of ['/api/editorial', '/api/history', '/api/ops/metrics']) {
  const result = await request(path, {
    headers: { cookie: 'campus_session=untrusted-local-cookie' },
  });
  assert.equal(result.status, 401, path);
  assert.equal(result.headers.get('cache-control'), 'no-store');
}
assert.equal(
  (
    await (
      await request('/api/auth/me', {
        headers: { cookie: 'campus_session=untrusted-local-cookie' },
      })
    ).json()
  ).user,
  null,
);
const detail = await request(`/api/public/articles/${encodeURIComponent(articles[0].slug)}`);
assert.equal(detail.status, 200);
assert.equal((await detail.json()).id, articles[0].id);
assert.equal((await request(`/article/${encodeURIComponent(articles[0].slug)}`)).status, 200);
for (const path of ['/js/app.js', '/styles/theme.css', '/assets/campus-wordmark.svg'])
  assert.equal((await request(path)).status, 200, path);
for (const path of [
  '/storage/private/admin-login.txt',
  '/backend/server.mjs',
  '/database/sources/uth.json',
  '/config/local.env',
])
  assert.equal((await request(path)).status, 404, path);
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'msedge',
  headless: true,
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const wait = async () => {
    await page.locator('#content[aria-busy]').waitFor({ state: 'detached' });
    await page.locator('.intro,.article,.empty').first().waitFor();
  };
  await page.goto(base);
  await wait();
  await expect(page.locator('#account')).toBeDisabled();
  await expect(page.locator('#account')).toContainText('Biên tập chưa mở');
  await page.locator('[data-category="notices"]').click();
  await wait();
  await expect(page.locator('.intro h1')).toHaveText('Thông báo');
  await page.locator('.brand').click();
  await wait();
  const first = await page.locator('.news-layout .card>a').first().getAttribute('href');
  await page.locator('#next').click();
  await expect(page).toHaveURL(/page=2/);
  const next = await page.locator('.news-layout .card>a').first().getAttribute('href');
  assert.notEqual(next, first);
  await page.reload();
  await wait();
  assert.equal(await page.locator('.news-layout .card>a').first().getAttribute('href'), next);
  await page.locator('[data-category="notices"]').click();
  await wait();
  await page.locator('#site-search').fill('UTH');
  await page.locator('#site-search').press('Enter');
  await wait();
  assert.equal(new URL(page.url()).searchParams.get('category'), null);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'UTH');
  await page.locator('.card>a').first().click();
  await wait();
  await expect(page.locator('.article h1')).toBeVisible();
  const title = await page.locator('.article h1').innerText();
  await page.reload();
  await wait();
  await expect(page.locator('.article h1')).toHaveText(title);
  await page.goto(base + '/?view=workspace');
  await wait();
  await expect(page.locator('#dialog')).toContainText('Không gian biên tập chưa mở');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    base,
    health: 'ok',
    realArticles: articles.length,
    privateApis: 'denied',
    writes: 'denied',
    localSessions: 'ignored',
    assets: 'ok',
  }),
);
