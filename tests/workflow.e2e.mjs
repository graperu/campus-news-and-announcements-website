import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect, migrate } from '../backend/db.mjs';
import { hashPassword } from '../backend/passwords.mjs';
const temp = await mkdtemp(join(tmpdir(), 'uth-browser-'));
process.env.SQLITE_PATH = join(temp, 'app.db');
delete process.env.DATABASE_URL;
const db = await connect();
await migrate(db);
const password = randomUUID();
for (const role of ['author', 'editor'])
  await db.run('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [
    role,
    `${role}@test.invalid`,
    `Integration ${role}`,
    role,
    hashPassword(password),
  ]);
await db.run('INSERT INTO categories(id,name,color) VALUES($1,$2,$3)', [
  'test',
  'Integration-only category',
  '#123456',
]);
await db.run('INSERT INTO categories(id,name,color) VALUES($1,$2,$3)', [
  'test-2',
  'Second test category',
  '#654321',
]);
const child = spawn(process.execPath, ['backend/server.mjs'], {
  env: { ...process.env, PORT: '0', NODE_ENV: 'test', UPLOAD_PATH: join(temp, 'uploads') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 15000);
    child.stdout.on('data', (b) => {
      const m = b.toString().match(/Campus News: (http:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Server startup failed'));
    });
  });
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator('#content .intro').waitFor();
  async function login(role) {
    await page.locator('#account').click();
    await page.getByLabel('Email', { exact: true }).fill(`${role}@test.invalid`);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.locator('#dialog button[type=submit]').click();
    await page.locator('#new-article').waitFor();
  }
  async function logout() {
    await page.locator('#account').click();
    await page.locator('#logout').click();
    await page.locator('#content .intro').waitFor();
  }
  await login('author');
  assert.equal(await page.locator('[data-tab="manage"]').count(), 0);
  assert.equal(await page.locator('[data-tab="ops"]').count(), 0);
  await page.goto(`${base}/?view=workspace&tab=manage`);
  await page.locator('#new-article').waitFor();
  assert.equal(await page.locator('#add-category').count(), 0);
  await page.locator('#editorial-filters').waitFor();
  await page.locator('#new-article').click();
  await page.getByLabel('Tiêu đề', { exact: true }).fill('Isolated browser workflow');
  page.once('dialog', (d) => d.dismiss());
  await page.locator('.dialog-close').click();
  assert.ok(await page.locator('#dialog').isVisible());
  page.once('dialog', (d) => d.accept());
  await page.locator('.dialog-close').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#dialog').isVisible(), false);
  await page.reload();
  await page.locator('#new-article').waitFor();
  await page.locator('#new-article').click();
  assert.equal(
    await page.getByLabel('Tiêu đề', { exact: true }).inputValue(),
    'Isolated browser workflow',
  );
  assert.match(await page.locator('#draft-backup').innerText(), /khôi phục/);

  await page.getByLabel('Tóm tắt', { exact: true }).fill('Browser integration test only');
  await page
    .getByLabel('Nội dung', { exact: true })
    .fill('Private browser integration content.\n\nSecond paragraph for preview formatting.');
  await page.locator('#image').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  let releaseSave;
  const saveGate = new Promise((resolve) => (releaseSave = resolve));
  await page.route('**/api/articles', async (route) => {
    await saveGate;
    await route.continue();
  });
  await page.locator('#dialog button[type=submit]').click();
  await page.locator('#dialog form[aria-busy="true"]').waitFor();
  assert.ok(await page.locator('#dialog button[type=submit]').isDisabled());
  assert.match(await page.locator('#form-progress').innerText(), /Đang (lưu|tải ảnh bài viết)/);
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#dialog').isVisible());
  releaseSave();
  await page.getByRole('button', { name: 'Sửa', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sửa', exact: true }).click();
  assert.equal(await page.locator('#category').isEnabled(), true);
  await page.locator('#category').selectOption('test-2');
  await page.waitForFunction(() => {
    const img = document.querySelector('#editor-image-preview');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  await page.locator('#dialog button[type=submit]').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.locator('.editorial-item .meta', { hasText: 'Second test category' }).waitFor();
  assert.match(await page.locator('.editorial-item .meta').innerText(), /Second test category/);
  await page.getByRole('button', { name: 'Xem', exact: true }).click();
  await page.locator('#dialog-title').waitFor();
  assert.equal(await page.locator('#dialog-body .article-body p').count(), 2);
  assert.match(
    await page.locator('#dialog-body .summary').innerText(),
    /Browser integration test only/,
  );
  await page.waitForFunction(() => {
    const img = document.querySelector('#preview-image');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  await page.locator('.dialog-close').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Gửi duyệt', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
  await page.locator('.status.submitted').waitFor();
  const anonymous = await browser.newContext(),
    publicPage = await anonymous.newPage();
  publicPage.on('pageerror', (e) => errors.push(e.message));
  await publicPage.goto(`${base}/article/%E0%A4%A`);
  await publicPage.locator('#content .empty[role="alert"]').waitFor();
  assert.equal(await publicPage.locator('#account').isEnabled(), true);
  assert.equal(await publicPage.locator('#site-search').isEnabled(), true);
  await publicPage.goto(base);
  await publicPage.locator('.empty').waitFor();
  assert.equal(await publicPage.getByText('Isolated browser workflow', { exact: true }).count(), 0);
  await logout();
  await login('editor');
  await page.locator('#open-queue').waitFor();
  await page.locator('#open-queue').click();
  await page.locator('#editorial-sort').waitFor();
  assert.equal(await page.locator('#editorial-sort').inputValue(), 'priority');
  assert.equal(await page.locator('.needs-review').count(), 1);
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await page.locator('.status.approved').waitFor();
  await page.getByRole('button', { name: 'Xuất bản', exact: true }).click();
  await page.locator('.status.published').waitFor();
  await page.locator('[data-tab="history"]').click();
  await page.locator('.history-table').waitFor();
  assert.equal(await page.locator('.history-table tbody tr').count(), 1);
  assert.match(
    await page.locator('.history-table tbody tr').innerText(),
    /Isolated browser workflow/,
  );
  await page.locator('[data-tab="articles"]').click();
  await page.locator('.status.published').waitFor();
  await mkdir('storage/reports/screenshots', { recursive: true });
  await page.screenshot({
    path: 'storage/reports/screenshots/editorial-workflow-test.png',
    fullPage: true,
  });
  await publicPage.reload();
  await publicPage.locator('.feature h2').waitFor();
  await publicPage.locator('.feature a[data-route]').first().click();
  await publicPage.locator('.article-body').waitFor();
  assert.match(
    await publicPage.locator('.article-body').innerText(),
    /Private browser integration content/,
  );
  await page.getByRole('button', { name: 'Tạo bản sửa', exact: true }).click();
  await page.getByLabel('Tiêu đề', { exact: true }).fill('Unpublished browser revision');
  await page.locator('#dialog button[type=submit]').click();
  await page.locator('.status.draft').waitFor();
  await publicPage.reload();
  assert.equal(
    await publicPage.getByText('Unpublished browser revision', { exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
  await page.locator('.status.submitted').waitFor();
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await page.locator('.status.approved').waitFor();
  await page.getByRole('button', { name: 'Hẹn giờ xuất bản', exact: true }).click();
  await page.locator('#schedule-at').waitFor();
  const future = new Date(Date.now() + 2 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  const futureLocal = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
  await page.locator('#schedule-at').fill(futureLocal);
  await page.locator('#dialog button[type=submit]').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.locator('.status.scheduled').waitFor();
  await page.locator('.schedule-pill').waitFor();
  await page.locator('#editorial-status').selectOption('scheduled');
  assert.equal(await page.locator('.editorial-item').count(), 1);
  await page.locator('#editorial-status').selectOption('');
  await publicPage.reload();
  assert.equal(
    await publicPage.getByText('Unpublished browser revision', { exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Hủy hẹn giờ', exact: true }).click();
  await page.locator('.status.approved').waitFor();
  await page.getByRole('button', { name: 'Xuất bản', exact: true }).click();
  await page.locator('.status.approved').waitFor({ state: 'detached' });
  await page.locator('[data-tab="ops"]').click();
  await page.locator('#run-scheduler').waitFor();
  await page.locator('#run-scheduler').click();
  await page.locator('#toast.visible').waitFor();
  await page.locator('[data-tab="articles"]').click();
  await page.locator('.status.published').waitFor();
  assert.equal(await page.locator('.editorial-item').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Tạo bản sửa', exact: true }).count(), 1);
  await page.locator('[data-tab="history"]').click();
  await page.locator('.history-table').waitFor();
  assert.equal(await page.locator('.history-table tbody tr').count(), 2);
  await page
    .locator('.history-table tbody tr')
    .filter({ hasText: 'Isolated browser workflow' })
    .getByRole('button', { name: 'Xem phiên bản', exact: true })
    .click();
  await page.locator('#dialog-title').waitFor();
  assert.equal(await page.locator('#dialog-title').innerText(), 'Isolated browser workflow');
  assert.match(
    await page.locator('#dialog-body .article-body').innerText(),
    /Private browser integration content/,
  );
  await page.locator('.dialog-close').click();
  assert.deepEqual(errors, []);
  console.log(
    'Browser workflow passed: author drafts/submits; editor approves/publishes; public sees only published version; revision stays private. Test DB is isolated.',
  );
  await anonymous.close();
  await context.close();
} finally {
  await browser?.close();
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', resolve);
  });
  await db.close();
  await rm(temp, { recursive: true, force: true });
}
