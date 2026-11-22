import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, migrate } from '../backend/db.mjs';
import { hashPassword } from '../backend/passwords.mjs';
import { readReviewedSource, restoreReviewedSource } from '../scripts/data/source-content.mjs';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2kAAAAASUVORK5CYII=',
  'base64',
);

function formatLocalDatetimeInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatViDate(date) {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(date);
}

async function waitForView(page) {
  await page.locator('#content[aria-busy]').waitFor({ state: 'detached' });
  await page.locator('.intro, .article, .empty').first().waitFor();
}

async function forceDecodeImages(page) {
  await page.locator('img').evaluateAll(async (imgs) => {
    await Promise.all(
      imgs.map(async (img) => {
        img.loading = 'eager';
        try {
          await img.decode();
        } catch {}
      }),
    );
  });
}

async function runAcceptanceSuite() {
  const temp = await mkdtemp(join(tmpdir(), 'uth-acceptance-'));
  const sqlitePath = join(temp, 'acceptance.db');
  const uploadPath = join(temp, 'uploads');

  const prevSqlite = process.env.SQLITE_PATH;
  const prevUpload = process.env.UPLOAD_PATH;
  const prevDbUrl = process.env.DATABASE_URL;

  process.env.SQLITE_PATH = sqlitePath;
  process.env.UPLOAD_PATH = uploadPath;
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  else delete process.env.DATABASE_URL;

  let db = null;
  let child = null;
  let browser = null;
  const failures = [];
  const results = [];

  const step = async (name, fn) => {
    try {
      await fn();
      results.push({ name, status: 'PASS' });
      console.log(`PASS: ${name}`);
    } catch (err) {
      results.push({ name, status: 'FAIL', error: err.message });
      failures.push({ name, err });
      console.error(`FAIL: ${name}\n  ${err.stack || err.message}`);
    }
  };

  try {
    db = await connect();
    await migrate(db);
    const snapshot = await readReviewedSource();
    await restoreReviewedSource(db, snapshot);

    const password = randomUUID();
    const runTag = randomUUID().slice(0, 8);
    const users = [
      {
        id: `e2e-reader-${runTag}-${randomUUID().slice(0, 6)}`,
        email: `e2e-reader-${runTag}@test.invalid`,
        name: 'E2E Reader',
        role: 'reader',
      },
      {
        id: `e2e-author-${runTag}-${randomUUID().slice(0, 6)}`,
        email: `e2e-author-${runTag}@test.invalid`,
        name: 'E2E Author',
        role: 'author',
      },
      {
        id: `e2e-editor-${runTag}-${randomUUID().slice(0, 6)}`,
        email: `e2e-editor-${runTag}@test.invalid`,
        name: 'E2E Editor',
        role: 'editor',
      },
    ];
    for (const u of users) {
      await db.run(
        'INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING',
        [u.id, u.email, u.name, u.role, hashPassword(password)],
      );
    }

    const childEnv = {
      ...process.env,
      SQLITE_PATH: sqlitePath,
      UPLOAD_PATH: uploadPath,
      PORT: '0',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      SCHEDULER_INTERVAL_MS: '600000',
    };
    if (!process.env.TEST_DATABASE_URL) delete childEnv.DATABASE_URL;

    child = spawn(process.execPath, ['backend/server.mjs'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Server startup timeout. stderr: ${stderr}`)),
        15000,
      );
      child.stdout.on('data', (b) => {
        const m = b.toString().match(/Campus News: (http:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}. stderr: ${stderr}`));
      });
    });

    browser = await chromium.launch({
      channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
      headless: true,
    });

    const pageErrors = [];
    const consoleErrors = [];
    let allowExpectedHttp400 = false;
    let allowExpectedHttp401 = false;
    let allowExpectedBlobRevoke = false;

    const attachErrorListeners = (p) => {
      p.on('pageerror', (e) => pageErrors.push(e.message));
      p.on('console', (m) => {
        if (m.type() === 'error') {
          const text = m.text();
          if (allowExpectedHttp400 && /status of 400|Bad Request/i.test(text)) return;
          if (allowExpectedHttp401 && /status of 401|Unauthorized/i.test(text)) return;
          if (allowExpectedBlobRevoke && /ERR_FILE_NOT_FOUND/i.test(text)) return;
          consoleErrors.push(text);
        }
      });
    };

    const loginUI = async (p, role, expectWorkspace = true) => {
      const account = users.find((u) => u.role === role);
      assert.ok(account, `Missing test user for role ${role}`);
      await p.locator('#account').click();
      await p.getByLabel('Email', { exact: true }).fill(account.email);
      await p.getByLabel('Mật khẩu', { exact: true }).fill(password);
      await p.locator('#dialog button[type=submit]').click();
      await p.locator('#dialog').waitFor({ state: 'hidden' });
      if (expectWorkspace) {
        await waitForView(p);
        await p.locator('#new-article').waitFor();
      }
    };

    const logoutUI = async (p) => {
      await p.locator('#account').click();
      await p.locator('#logout').click();
      await p.locator('#dialog').waitFor({ state: 'hidden' });
      await p.locator('#account .account-label').filter({ hasText: 'Đăng nhập' }).waitFor();
      await p.locator('#content .intro h1').filter({ hasText: 'Nhịp sống UTH.' }).waitFor();
      await waitForView(p);
    };

    // =========================================================================
    // Scenario 1: Public Campus Portal Discovery, Vietnamese Search & Caching
    // (T1-F2-05, T1-F9-05, T3-12)
    // =========================================================================
    await step(
      'Scenario 1: Public portal discovery, diacritic & % search, detail reload, popstate, ETag 304',
      async () => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        attachErrorListeners(page);

        try {
          await page.goto(base);
          await waitForView(page);

          // 30 UTH articles -> 2 featured + 28 feed
          assert.match(
            await page.locator('#news-heading .result-count').innerText(),
            /^28 bài viết/,
          );

          // Pagination & reload / popstate (T1-F9-05)
          await page.locator('#next').click();
          assert.equal(new URL(page.url()).searchParams.get('page'), '2');
          const page2First = await page.locator('.news-layout .card h3').first().innerText();
          await page.reload();
          await waitForView(page);
          assert.equal(await page.locator('.news-layout .card h3').first().innerText(), page2First);
          await page.goBack();
          await waitForView(page);
          assert.equal(new URL(page.url()).searchParams.get('page'), null);

          // Category filter
          await page.locator('[data-category="notices"]').click();
          await waitForView(page);
          assert.equal(await page.locator('.intro h1').innerText(), 'Thông báo');
          assert.equal(new URL(page.url()).searchParams.get('category'), 'notices');
          const noticeTags = await page.locator('.card .tag').allTextContents();
          assert.ok(noticeTags.length > 0, 'Filtered notices category must render cards');
          for (const tagText of noticeTags) {
            assert.match(tagText.trim(), /^Thông báo(?:\s*·\s*PDF)?$/);
          }

          // Vietnamese diacritic search clears category scope
          await page.locator('#site-search').fill('Đào tạo');
          await page.locator('#site-search').press('Enter');
          await waitForView(page);
          assert.equal(new URL(page.url()).searchParams.get('category'), null);
          assert.equal(new URL(page.url()).searchParams.get('q'), 'Đào tạo');
          assert.ok(
            (await page.locator('#content').innerText()).includes(
              'Quan điểm của Chủ tịch Hồ Chí Minh với vị trí, vai trò của Giáo dục và Đào tạo',
            ),
          );

          await page.locator('#site-search').fill('Ái Quốc');
          await page.locator('#site-search').press('Enter');
          await waitForView(page);
          assert.ok((await page.locator('#content').innerText()).includes('Nguyễn Ái Quốc'));

          // Literal % must not match all 30 articles
          await page.locator('#site-search').fill('%');
          await page.locator('#site-search').press('Enter');
          await waitForView(page);
          assert.equal(await page.locator('.card').count(), 0);
          await page.locator('.empty').waitFor();

          // Open uth-1672 detail & verify PDF CTA + reload (T1-F2-05)
          const slug1672 =
            'ke-hoach-to-chuc-xay-dung-mo-hinh-khong-gian-van-hoa-ho-chi-minh-tren-nen-tang-so';
          await page.goto(`${base}/article/${slug1672}`);
          await waitForView(page);
          const h1Text = await page.locator('.article h1').innerText();
          assert.match(h1Text, /Không gian văn hóa Hồ Chí Minh/);
          assert.ok((await page.locator('.article-body').innerText()).length > 100);
          const pdfHref = await page.locator('.source-document a').getAttribute('href');
          assert.ok(pdfHref && pdfHref.endsWith('.pdf'));
          await page.reload();
          await waitForView(page);
          assert.equal(await page.locator('.article h1').innerText(), h1Text);

          // Conditional ETag / 304 & security headers (cookie-free fetch)
          const apiRes = await fetch(`${base}/api/public/articles`);
          assert.equal(apiRes.status, 200);
          assert.equal(apiRes.headers.get('x-frame-options'), 'DENY');
          assert.ok(apiRes.headers.get('x-request-id'));
          const etag = apiRes.headers.get('etag');
          assert.ok(etag);
          const reval = await fetch(`${base}/api/public/articles`, {
            headers: { 'If-None-Match': etag },
          });
          assert.equal(reval.status, 304);
        } finally {
          await ctx.close();
        }
      },
    );

    // =========================================================================
    // Scenario 2: Full Editorial Lifecycle with Category Edit, Private /media/*
    // Preview Modal, XSS Escaping, Row Locking, RBAC UI & Scheduling
    // (T1-F6-04, T1-F6-05, T2-F6-06, T2-F9-04, T2-F9-05, T3-03, T3-10)
    // =========================================================================
    let scenario2Slug = '';
    let scenario2MediaUrl = '';
    const scenario2Title = 'Bài kiểm thử toàn trình M2';

    await step(
      'Scenario 2: Reader/Author RBAC UI, draft category edit, private PNG preview & XSS escape, scheduling UI',
      async () => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        attachErrorListeners(page);

        try {
          await page.goto(base);
          await waitForView(page);

          // T2-F9-05: Reader has no #workspace access
          await loginUI(page, 'reader', false);
          assert.equal(await page.locator('#workspace').isHidden(), true);
          await logoutUI(page);

          // Author logs in; manage/ops tabs hidden (T2-F9-05)
          await loginUI(page, 'author', true);
          assert.equal(await page.locator('[data-tab="manage"]').count(), 0);
          assert.equal(await page.locator('[data-tab="ops"]').count(), 0);

          // Create draft in uth-news with PNG + multi-paragraph body & XSS payload
          await page.locator('#new-article').click();
          await page.locator('#title').fill('Bài nháp ban đầu');
          await page.locator('#category').selectOption('uth-news');
          await page.locator('#summary').fill('Tóm tắt bản thảo có ảnh riêng tư.');
          await page
            .locator('#body')
            .fill(
              'Đoạn văn thứ nhất.\n\nĐoạn văn thứ hai <script>window.__xss_executed=true;</script>.',
            );
          await page.locator('#image').setInputFiles({
            name: 'pixel.png',
            mimeType: 'image/png',
            buffer: VALID_PNG,
          });
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await waitForView(page);

          // T1-F6-05: Edit saved draft -> #category is enabled -> change to education + untrimmed title
          const row = page.locator('.editorial-item').filter({ hasText: 'Bài nháp ban đầu' });
          await row.getByRole('button', { name: 'Sửa', exact: true }).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          assert.equal(
            await page.locator('#category').isDisabled(),
            false,
            'Saved draft #category must be enabled',
          );
          await page.locator('#category').selectOption('education');
          await page.locator('#title').fill(`  ${scenario2Title}  `);
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await waitForView(page);

          // Verify persisted category & trimmed title in /api/editorial
          const edData = await page.evaluate(async () => (await fetch('/api/editorial')).json());
          const saved = edData.find((v) => v.title === scenario2Title);
          assert.ok(saved, 'Saved trimmed title must appear in /api/editorial');
          assert.equal(saved.category_id, 'education');
          assert.match(saved.image, /^\/media\/[a-f0-9-]+\.png$/);
          scenario2MediaUrl = saved.image;
          scenario2Slug = saved.slug;

          // T1-F6-04 & T2-F6-06: Open [data-preview] modal -> image renders, summary & 2 <p> tags, no XSS
          const updatedRow = page.locator('.editorial-item').filter({ hasText: scenario2Title });
          await updatedRow.locator(`[data-preview="${saved.id}"]`).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          await page.locator('#dialog-body .summary').waitFor();
          assert.equal(
            await page.locator('#dialog-body .summary').innerText(),
            'Tóm tắt bản thảo có ảnh riêng tư.',
          );
          assert.equal(await page.locator('#dialog-body .article-body p').count(), 2);
          const previewImg = page.locator('#dialog-body img');
          await previewImg.waitFor({ state: 'visible' });
          await previewImg.evaluate(
            (img) =>
              new Promise((resolve, reject) => {
                if (img.complete && img.naturalWidth > 0) return resolve();
                const timer = setTimeout(
                  () => reject(new Error('Preview image failed to load')),
                  5000,
                );
                img.addEventListener('load', () => {
                  clearTimeout(timer);
                  resolve();
                });
                img.addEventListener('error', () => {
                  clearTimeout(timer);
                  reject(new Error('Preview image errored'));
                });
              }),
          );
          assert.ok((await previewImg.evaluate((i) => i.naturalWidth)) > 0);
          const previewSrc = await previewImg.getAttribute('src');
          assert.ok(previewSrc, 'Preview img must have a src attribute');
          assert.equal(await page.locator('#dialog-body .article-body script').count(), 0);
          assert.ok(
            (await page.locator('#dialog-body .article-body').innerText()).includes('<script>'),
            'Preview modal must render literal escaped <script> text',
          );
          assert.equal(await page.evaluate(() => window.__xss_executed), undefined);
          const checkBlobImgAlive = (u) =>
            page.evaluate(
              (url) =>
                new Promise((resolve) => {
                  const img = new Image();
                  img.onload = () => resolve(true);
                  img.onerror = () => resolve(false);
                  img.src = url;
                }),
              u,
            );
          assert.ok(
            previewSrc.startsWith('blob:'),
            'Private /media/* preview must resolve to a blob: ObjectURL',
          );
          assert.equal(
            await checkBlobImgAlive(previewSrc),
            true,
            'Preview blob: ObjectURL must load via <img> while dialog is open',
          );
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          let blobAlive;
          allowExpectedBlobRevoke = true;
          try {
            blobAlive = await checkBlobImgAlive(previewSrc);
            await delay(50);
          } finally {
            allowExpectedBlobRevoke = false;
          }
          assert.equal(
            blobAlive,
            false,
            'Preview blob: ObjectURL must be revoked when dialog closes',
          );

          // T3-03: Anonymous 401 on private /media/* (cookie-free fetch)
          const anonRes = await fetch(`${base}${scenario2MediaUrl}`);
          assert.equal(anonRes.status, 401);

          // Author submits
          await updatedRow.getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
          await updatedRow.locator('.status.submitted').waitFor();
          await logoutUI(page);

          // Editor logs in
          await loginUI(page, 'editor', true);
          const edRow = page.locator('.editorial-item').filter({ hasText: scenario2Title });

          // T2-F9-04: Network-gate approve and verify sibling row buttons disabled during mutation
          let releaseApprove;
          let markIntercepted;
          let markHandled;
          let intercepted = false;
          const approveGate = new Promise((resolve) => (releaseApprove = resolve));
          const interceptedPromise = new Promise((resolve) => (markIntercepted = resolve));
          const handledPromise = new Promise((resolve) => (markHandled = resolve));
          const approvePattern = `**/api/versions/${saved.id}/approve`;
          const approveHandler = async (route) => {
            intercepted = true;
            markIntercepted();
            await approveGate;
            try {
              await route.continue();
            } finally {
              markHandled();
            }
          };
          await page.route(approvePattern, approveHandler);
          try {
            await edRow.getByRole('button', { name: 'Duyệt', exact: true }).click();
            await interceptedPromise;
            const rejectBtn = edRow.getByRole('button', { name: 'Yêu cầu sửa', exact: true });
            assert.equal(
              await rejectBtn.isDisabled(),
              true,
              'Sibling action button must be disabled during mutation',
            );
          } finally {
            releaseApprove?.();
            if (intercepted) await handledPromise;
            await page.unroute(approvePattern, approveHandler);
          }
          await edRow.locator('.status.approved').waitFor();

          // T3-10: Schedule via UI for future time (+2 days so scheduled_at date differs from updated_at)
          await edRow.getByRole('button', { name: /^Hẹn giờ/i }).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          const dtInput = page
            .locator('#dialog input[type="datetime-local"], #dialog input[name="scheduled_at"]')
            .first();
          const inputType = await dtInput.getAttribute('type');
          const futureDate = new Date(Date.now() + 2 * 86400 * 1000);
          await dtInput.fill(
            inputType === 'datetime-local'
              ? formatLocalDatetimeInput(futureDate)
              : futureDate.toISOString(),
          );
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await edRow.locator('.status.scheduled').waitFor();

          // Verify [data-preview] while scheduled shows .status.scheduled & scheduled_at (PROJECT.md §4)
          await edRow.locator(`[data-preview="${saved.id}"]`).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          await page.locator('#dialog-body .status.scheduled').waitFor();
          const previewScheduledText = await page.locator('#dialog-body').innerText();
          assert.ok(
            previewScheduledText.includes(formatViDate(futureDate)),
            `Scheduled preview modal must display scheduled_at date (${formatViDate(futureDate)}), got: ${previewScheduledText}`,
          );
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          // Exercise UI rescheduling (scheduled -> Đổi lịch hẹn -> +3 days -> scheduled)
          await edRow.getByRole('button', { name: /^(Hẹn giờ|Đổi lịch hẹn)/i }).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          const dtResched = page
            .locator('#dialog input[type="datetime-local"], #dialog input[name="scheduled_at"]')
            .first();
          const reschedType = await dtResched.getAttribute('type');
          const rescheduledDate = new Date(Date.now() + 3 * 86400 * 1000);
          await dtResched.fill(
            reschedType === 'datetime-local'
              ? formatLocalDatetimeInput(rescheduledDate)
              : rescheduledDate.toISOString(),
          );
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await edRow.locator('.status.scheduled').waitFor();
          const edAfterResched = await page.evaluate(async () =>
            (await fetch('/api/editorial')).json(),
          );
          const reschedRow = edAfterResched.find((v) => v.id === saved.id);
          assert.ok(
            reschedRow &&
              reschedRow.scheduled_at &&
              Date.parse(reschedRow.scheduled_at) > futureDate.getTime() + 43200000,
            'UI reschedule must update scheduled_at to +3 days',
          );

          // Filter #editorial-status by scheduled
          await page.locator('#editorial-status').selectOption('scheduled');
          assert.ok(
            (await page.locator('.editorial-item').filter({ hasText: scenario2Title }).count()) ===
              1,
          );
          await page.locator('#editorial-status').selectOption('');

          // Scheduled article must remain hidden on public portal (cookie-free fetch)
          const pubWhileScheduled = await (await fetch(`${base}/api/public/articles`)).json();
          assert.equal(
            pubWhileScheduled.some((a) => a.slug === scenario2Slug),
            false,
          );

          // Unschedule via UI -> approved
          await edRow.getByRole('button', { name: /Hủy hẹn giờ/i }).click();
          await edRow.locator('.status.approved').waitFor();

          // Schedule due shortly (+1500ms) and trigger via Ops Scheduler UI
          const dueIso = new Date(Date.now() + 1500).toISOString();
          const schedRes = await page.evaluate(
            async ({ id, scheduled_at }) => {
              const r = await fetch(`/api/versions/${id}/schedule`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Campus-Client': '1' },
                body: JSON.stringify({ scheduled_at }),
              });
              return r.status;
            },
            { id: saved.id, scheduled_at: dueIso },
          );
          assert.equal(schedRes, 200);
          await delay(1650);

          await page.locator('[data-tab="ops"]').click();
          const runBtn = page
            .locator('#run-scheduler, [data-action="run-scheduler"], [data-scheduler-run]')
            .or(
              page.getByRole('button', {
                name: /Chạy lịch|lập lịch|Xuất bản.*lịch|hẹn giờ|đến hạn|scheduler/i,
              }),
            );
          await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().includes('/api/ops/scheduler/run') &&
                r.request().method() === 'POST' &&
                r.status() === 200,
            ),
            runBtn.click(),
          ]);

          // Verify now live on public portal under Đào tạo & /media/* is 200 no-store (cookie-free fetch)
          const liveDetail = await fetch(`${base}/api/public/articles/${scenario2Slug}`);
          assert.equal(liveDetail.status, 200);
          assert.equal((await liveDetail.json()).category_id, 'education');
          const pubImg = await fetch(`${base}${scenario2MediaUrl}`);
          assert.equal(pubImg.status, 200);
          assert.equal(pubImg.headers.get('cache-control'), 'no-store');
        } finally {
          await ctx.close();
        }
      },
    );

    // =========================================================================
    // Scenario 3: Published Revision, Duplicate-Retirement & ETag Invalidation
    // (T1-F7-04, T2-F7-05)
    // =========================================================================
    await step(
      'Scenario 3: Published revision retires old version, single active badge, ETag invalidated',
      async () => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        attachErrorListeners(page);

        try {
          await page.goto(base);
          await waitForView(page);
          await loginUI(page, 'editor', true);

          // Self-contained setup: create & publish v1 via authenticated API in browser context
          const v1Title = 'Bài viết Scenario 3 Bản v1';
          const v2Title = 'Bài viết Scenario 3 Bản v2';
          const created = await page.evaluate(async (title) => {
            const hdrs = { 'Content-Type': 'application/json', 'X-Campus-Client': '1' };
            const c = await (
              await fetch('/api/articles', {
                method: 'POST',
                headers: hdrs,
                body: JSON.stringify({
                  title,
                  summary: 'Tóm tắt Scenario 3 bản v1.',
                  body: 'Nội dung Scenario 3 bản v1.',
                  category_id: 'education',
                  image: '/assets/news/uth-2095.png',
                }),
              })
            ).json();
            for (const act of ['submit', 'approve', 'publish']) {
              await fetch(`/api/versions/${c.version_id}/${act}`, {
                method: 'POST',
                headers: hdrs,
                body: '{}',
              });
            }
            const ed = await (await fetch('/api/editorial')).json();
            return ed.find((v) => v.id === c.version_id);
          }, v1Title);
          assert.ok(created && created.slug, 'Failed to seed Scenario 3 v1');
          const v1Slug = created.slug;

          const beforeList = await fetch(`${base}/api/public/articles`);
          const etag1 = beforeList.headers.get('etag');
          assert.equal(
            (
              await fetch(`${base}/api/public/articles`, {
                headers: { 'If-None-Match': etag1 },
              })
            ).status,
            304,
          );

          await page.reload();
          await waitForView(page);

          const itemV1 = page
            .locator('.editorial-item')
            .filter({ has: page.locator('h3', { hasText: new RegExp(`^${v1Title}$`) }) });
          await itemV1.getByRole('button', { name: 'Tạo bản sửa', exact: true }).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          assert.equal(
            await page.locator('#category').isDisabled(),
            true,
            'Published version revision modal must keep #category disabled',
          );
          await page.locator('#title').fill(v2Title);
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await waitForView(page);

          // T2-F7-05: Only v1 (published) has "Tạo bản sửa", NOT v2 (draft)
          const v1AfterDraft = page
            .locator('.editorial-item')
            .filter({ has: page.locator('h3', { hasText: new RegExp(`^${v1Title}$`) }) });
          const v2DraftRow = page
            .locator('.editorial-item')
            .filter({ has: page.locator('h3', { hasText: new RegExp(`^${v2Title}$`) }) });
          assert.equal(await v1AfterDraft.count(), 1);
          assert.equal(
            await v1AfterDraft.getByRole('button', { name: 'Tạo bản sửa', exact: true }).count(),
            1,
          );
          assert.equal(
            await v2DraftRow.getByRole('button', { name: 'Tạo bản sửa', exact: true }).count(),
            0,
          );

          // Edit draft v2 to change category to notices (PROJECT.md §4: enabled on saved drafts)
          await v2DraftRow.getByRole('button', { name: 'Sửa', exact: true }).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          await page.locator('#category').selectOption('notices');
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await waitForView(page);

          // Live public ETag remains E1 until v2 published (cookie-free fetch)
          assert.equal(
            (
              await fetch(`${base}/api/public/articles`, {
                headers: { 'If-None-Match': etag1 },
              })
            ).status,
            304,
          );

          await v2DraftRow.getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
          await v2DraftRow.locator('.status.submitted').waitFor();
          await v2DraftRow.getByRole('button', { name: 'Duyệt', exact: true }).click();
          await v2DraftRow.locator('.status.approved').waitFor();
          await v2DraftRow.getByRole('button', { name: 'Xuất bản', exact: true }).click();
          await v2DraftRow.locator('.status.published').waitFor();

          // T1-F7-04: v1 retired, only v2 shows in editorial list with "Tạo bản sửa"
          assert.equal(await v1AfterDraft.count(), 0);
          const activeV2 = v2DraftRow;
          assert.equal(await activeV2.count(), 1);
          assert.equal(await activeV2.locator('.status.published').count(), 1);
          assert.equal(
            await activeV2.getByRole('button', { name: 'Tạo bản sửa', exact: true }).count(),
            1,
          );

          // History retains both v1 & v2
          await page.locator('[data-tab="history"]').click();
          await page.locator('.history-table').waitFor();
          assert.ok(
            (await page.locator('.history-table tbody tr').filter({ hasText: v1Title }).count()) >=
              1,
          );
          assert.ok(
            (await page.locator('.history-table tbody tr').filter({ hasText: v2Title }).count()) ===
              1,
          );

          // Public ETag invalidated (E2 !== E1) and category updated to notices (cookie-free fetch)
          const afterList = await fetch(`${base}/api/public/articles`, {
            headers: { 'If-None-Match': etag1 },
          });
          assert.equal(afterList.status, 200);
          assert.notEqual(afterList.headers.get('etag'), etag1);
          const updatedDetail = await (await fetch(`${base}/api/public/articles/${v1Slug}`)).json();
          assert.equal(updatedDetail.title, v2Title);
          assert.equal(updatedDetail.category_id, 'notices');
        } finally {
          await ctx.close();
        }
      },
    );

    // =========================================================================
    // Scenario 5: Responsive Desktop/Mobile/320px Branding, Reduced Motion,
    // Malformed URI Recovery, OAuth ?code= Cleanup & Read-Only UI
    // (T1-F9-01..04, T2-F9-01..03, T3-09, T3-12)
    // =========================================================================
    await step(
      'Scenario 5: Desktop/Mobile/320px/2560px branding & layout, reduced motion, URI & OAuth error recovery',
      async () => {
        // Responsive & branding checks across 1440, 375, 320, 2560
        for (const vp of [
          { width: 1440, height: 900 },
          { width: 375, height: 812 },
          { width: 320, height: 812 },
          { width: 2560, height: 1440 },
        ]) {
          const ctx = await browser.newContext({ viewport: vp });
          const page = await ctx.newPage();
          attachErrorListeners(page);
          try {
            await page.goto(base);
            await waitForView(page);
            await forceDecodeImages(page);

            const layout = await page.evaluate(() => {
              const box = (s) => document.querySelector(s).getBoundingClientRect();
              const brand = box('.brand');
              const img = box('.feature img');
              const frame = box('.feature-media');
              const rootStyle = getComputedStyle(document.documentElement);
              return {
                overflow: document.documentElement.scrollWidth > innerWidth,
                brandCenter: brand.x + brand.width / 2,
                width: innerWidth,
                logoOk:
                  document.querySelector('.brand-logo').complete &&
                  document.querySelector('.brand-logo').naturalWidth > 0,
                wordmarkOk:
                  document.querySelector('.campus-wordmark').complete &&
                  document.querySelector('.campus-wordmark').naturalWidth > 0,
                imageInside: img.top >= frame.top - 1 && img.bottom <= frame.bottom + 1,
                headlineTop: box('.feature h2').top,
                imageBottom: img.bottom,
                navColor: getComputedStyle(document.querySelector('.nav-link.active')).color,
                primary: rootStyle.getPropertyValue('--primary').trim().toLowerCase(),
                primaryDeep: rootStyle.getPropertyValue('--primary-deep').trim().toLowerCase(),
                secondary: rootStyle.getPropertyValue('--secondary').trim().toLowerCase(),
                accent: rootStyle.getPropertyValue('--accent').trim().toLowerCase(),
              };
            });

            assert.equal(layout.overflow, false, `Horizontal overflow at ${vp.width}px`);
            assert.ok(
              Math.abs(layout.brandCenter - vp.width / 2) < 2,
              `.brand not centered at ${vp.width}px`,
            );
            assert.equal(layout.logoOk, true);
            assert.equal(layout.wordmarkOk, true);
            assert.equal(layout.imageInside, true);
            assert.equal(layout.navColor, 'rgb(255, 255, 255)');
            assert.equal(layout.primary, '#018486');
            assert.equal(layout.primaryDeep, '#006568');
            assert.equal(layout.secondary, '#aa1f00');
            assert.equal(layout.accent, '#f3c50f');

            if (vp.width <= 375) {
              assert.ok(
                layout.headlineTop >= layout.imageBottom - 1,
                'Mobile hero headline must sit below image',
              );
            }

            // T3-12: Mobile Vietnamese search + article detail + popstate back
            if (vp.width === 375) {
              await page.locator('#site-search').fill('Đào tạo');
              await page.locator('#site-search').press('Enter');
              await waitForView(page);
              assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
                false,
              );
              await page.locator('.card a[data-route]').first().click();
              await waitForView(page);
              assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
                false,
              );
              await page.goBack();
              await waitForView(page);
              assert.equal(new URL(page.url()).searchParams.get('q'), 'Đào tạo');
            }
          } finally {
            await ctx.close();
          }
        }

        // T1-F9-04: prefers-reduced-motion
        const rmCtx = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          reducedMotion: 'reduce',
        });
        const rmPage = await rmCtx.newPage();
        attachErrorListeners(rmPage);
        try {
          await rmPage.goto(base);
          await waitForView(rmPage);
          assert.equal(
            await rmPage.locator('#content').evaluate((el) => getComputedStyle(el).opacity),
            '1',
          );
          const animName = await rmPage.evaluate(() => {
            const probe = document.createElement('div');
            probe.className = 'skeleton';
            document.body.appendChild(probe);
            const name = getComputedStyle(probe).animationName;
            probe.remove();
            return name;
          });
          assert.equal(animName, 'none');
        } finally {
          await rmCtx.close();
        }

        // T2-F9-01: Malformed URI /article/%E0%A4%A recovery (zero pageerror, no raw URI malformed)
        const errCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const errPage = await errCtx.newPage();
        attachErrorListeners(errPage);
        try {
          allowExpectedHttp400 = true;
          try {
            await errPage.goto(`${base}/article/%E0%A4%A`);
            await errPage.locator('#content .empty, #content .intro').first().waitFor();
          } finally {
            allowExpectedHttp400 = false;
          }
          const malformedContent = await errPage.locator('#content').innerText();
          assert.equal(
            /URI malformed/i.test(malformedContent),
            false,
            `Malformed URI must not expose raw URIError: ${malformedContent}`,
          );
          await errPage.locator('a.brand').click();
          await waitForView(errPage);
          assert.equal(new URL(errPage.url()).pathname, '/');

          // T2-F9-02: OAuth ?code=&state= cleanup on failure
          await errPage.route('**/api/config', async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                localAuth: false,
                authAvailable: true,
                cognitoDomain: `${base}/mock-cognito`,
                clientId: 'test-client',
                redirectUri: `${base}/`,
              }),
            });
          });
          await errPage.route('**/mock-cognito/oauth2/token', async (route) => {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'invalid_grant' }),
            });
          });
          try {
            await errPage.evaluate(() => {
              sessionStorage.setItem('oauth_state', 'expected-state');
              sessionStorage.setItem('oauth_verifier', 'verifier');
            });
            allowExpectedHttp400 = true;
            try {
              await errPage.goto(`${base}/?code=stale-code&state=expected-state`);
              await errPage.locator('#retry').waitFor();
            } finally {
              allowExpectedHttp400 = false;
            }

            const cleanUrl = new URL(errPage.url());
            assert.equal(
              cleanUrl.searchParams.has('code'),
              false,
              'finishOAuth failure must strip ?code=',
            );
            assert.equal(
              cleanUrl.searchParams.has('state'),
              false,
              'finishOAuth failure must strip ?state=',
            );
            const oauthStorage = await errPage.evaluate(() => ({
              oauthState: sessionStorage.getItem('oauth_state'),
              oauthVerifier: sessionStorage.getItem('oauth_verifier'),
            }));
            assert.equal(
              oauthStorage.oauthState,
              null,
              'finishOAuth failure must clear oauth_state from sessionStorage',
            );
            assert.equal(
              oauthStorage.oauthVerifier,
              null,
              'finishOAuth failure must clear oauth_verifier from sessionStorage',
            );
          } finally {
            await errPage.unroute('**/api/config');
            await errPage.unroute('**/mock-cognito/oauth2/token');
          }
          await errPage.locator('#retry').click();
          await waitForView(errPage);
          assert.equal(await errPage.locator('.intro h1').innerText(), 'Nhịp sống UTH.');
        } finally {
          await errCtx.close();
        }
      },
    );

    await step('T3-09: PUBLIC_READ_ONLY UI contract blocks editorial workspace', async () => {
      const roCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const roPage = await roCtx.newPage();
      attachErrorListeners(roPage);
      try {
        await roPage.route('**/api/config', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              localAuth: false,
              authAvailable: false,
              cognitoDomain: '',
              clientId: '',
              redirectUri: '',
            }),
          });
        });
        try {
          await roPage.goto(base);
          await waitForView(roPage);
          assert.equal(await roPage.locator('#account').isDisabled(), true);
          assert.match(await roPage.locator('#account').innerText(), /Biên tập chưa mở/);
          assert.equal(await roPage.locator('#contribute').count(), 0);
        } finally {
          await roPage.unroute('**/api/config');
        }
      } finally {
        await roCtx.close();
      }
    });

    await step(
      'Tier 5 Frontend Hardening & UI Edge-Case Flows (FE-01..FE-03, E2E-02)',
      async () => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        attachErrorListeners(page);

        try {
          await page.goto(base);
          await waitForView(page);

          // FE-02: 768px tablet .history-table zero horizontal scroll overflow & button containment
          await loginUI(page, 'editor', true);
          await page.setViewportSize({ width: 768, height: 900 });
          await page.locator('[data-tab="history"]').click();
          await page.locator('.history-table tbody tr').first().waitFor();
          const histLayout = await page.evaluate(() => {
            const wrap = document.querySelector('.history-table-wrap');
            const btn = document.querySelector('.history-table [data-history-version]');
            const cell = btn?.closest('td');
            const wrapRect = wrap.getBoundingClientRect();
            const btnRect = btn.getBoundingClientRect();
            const cellRect = cell.getBoundingClientRect();
            return {
              wrapScrollWidth: wrap.scrollWidth,
              wrapClientWidth: wrap.clientWidth,
              btnRight: btnRect.right,
              cellRight: cellRect.right,
              wrapRight: wrapRect.right,
            };
          });
          assert.ok(
            histLayout.wrapScrollWidth <= histLayout.wrapClientWidth,
            `768px .history-table-wrap overflowed: ${JSON.stringify(histLayout)}`,
          );
          assert.ok(
            histLayout.btnRight <= histLayout.cellRight + 0.5 &&
              histLayout.btnRight <= histLayout.wrapRight + 0.5,
            `768px Xem phiên bản button clipped cell/wrap: ${JSON.stringify(histLayout)}`,
          );

          // FE-03: 320px #new-article modal zero horizontal overflow
          await page.setViewportSize({ width: 320, height: 800 });
          await page.locator('[data-tab="articles"]').click();
          await page.locator('#new-article').click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          const modal320 = await page.evaluate(() => {
            const dialog = document.querySelector('#dialog');
            const imgInput = document.querySelector('#image');
            const dRect = dialog.getBoundingClientRect();
            const iRect = imgInput.getBoundingClientRect();
            return {
              scrollWidth: dialog.scrollWidth,
              clientWidth: dialog.clientWidth,
              inputRight: iRect.right,
              dialogRight: dRect.right,
            };
          });
          assert.ok(
            modal320.scrollWidth <= modal320.clientWidth,
            `320px #dialog horizontal overflow: ${JSON.stringify(modal320)}`,
          );
          assert.ok(
            modal320.inputRight <= modal320.dialogRight + 0.5,
            `320px #image input overflows #dialog: ${JSON.stringify(modal320)}`,
          );
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          // Reset to desktop & switch to author for DraftSession, #clear-image, reject, and popstate
          await page.setViewportSize({ width: 1440, height: 900 });
          await logoutUI(page);
          await loginUI(page, 'author', true);

          // E2E-02 (1): DraftSession category_id restore across dialog close/reopen
          await page.locator('#new-article').click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          await page.locator('#title').fill('Bản lưu tạm Tier 5');
          await page.locator('#summary').fill('Tóm tắt lưu tạm.');
          await page.locator('#body').fill('Nội dung lưu tạm.');
          await page.locator('#category').selectOption('education');
          await page
            .locator('#draft-backup')
            .filter({ hasText: 'Đã lưu tạm trong tab này' })
            .waitFor();
          page.once('dialog', (d) => d.accept());
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          await page.locator('#new-article').click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          assert.equal(await page.locator('#category').inputValue(), 'education');
          assert.equal(await page.locator('#title').inputValue(), 'Bản lưu tạm Tier 5');
          page.once('dialog', (d) => d.accept());
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          // E2E-02 (2): #clear-image removes saved draft /media/* image
          const clearTitle = `Bài xóa ảnh Tier 5 ${randomUUID().slice(0, 6)}`;
          await page.locator('#new-article').click();
          await page.locator('#title').fill(clearTitle);
          await page.locator('#category').selectOption('uth-news');
          await page.locator('#summary').fill('Tóm tắt xóa ảnh.');
          await page.locator('#body').fill('Nội dung xóa ảnh.');
          await page.locator('#image').setInputFiles({
            name: 'clear-test.png',
            mimeType: 'image/png',
            buffer: VALID_PNG,
          });
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await waitForView(page);

          const clearRow = page.locator('.editorial-item').filter({ hasText: clearTitle });
          await clearRow.getByRole('button', { name: 'Sửa', exact: true }).click();
          await page.locator('#editor-image-preview').waitFor({ state: 'visible' });
          await page.locator('#clear-image').check();
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await waitForView(page);

          const edAfterClear = await page.evaluate(async () =>
            (await fetch('/api/editorial')).json(),
          );
          const clearedItem = edAfterClear.find((v) => v.title === clearTitle);
          assert.ok(clearedItem);
          assert.equal(clearedItem.image, '');
          await clearRow.locator(`[data-preview="${clearedItem.id}"]`).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          assert.equal(await page.locator('#dialog-body img').count(), 0);
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          // E2E-02 (3): reject (Yêu cầu sửa) UI + author .review-callout
          await clearRow.getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
          await clearRow.locator('.status.submitted').waitFor();
          await logoutUI(page);

          await loginUI(page, 'editor', true);
          const rejectRow = page.locator('.editorial-item').filter({ hasText: clearTitle });
          await rejectRow.getByRole('button', { name: 'Yêu cầu sửa', exact: true }).click();
          await rejectRow.locator('.status.rejected').waitFor();
          await logoutUI(page);

          await loginUI(page, 'author', true);
          await page.locator('.review-callout').waitFor({ state: 'visible' });
          assert.match(await page.locator('.review-callout').innerText(), /cần bạn chỉnh sửa/);
          await page.locator('#open-queue').click();
          await waitForView(page);
          assert.equal(
            await page.locator('.editorial-item').first().locator('h3').innerText(),
            clearTitle,
          );

          // E2E-02 (4): scheduleArticle past-timestamp error message
          const authorClearRow = page.locator('.editorial-item').filter({ hasText: clearTitle });
          await authorClearRow.getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
          await authorClearRow.locator('.status.submitted').waitFor();
          await logoutUI(page);

          await loginUI(page, 'editor', true);
          const edSchedRow = page.locator('.editorial-item').filter({ hasText: clearTitle });
          await edSchedRow.getByRole('button', { name: 'Duyệt', exact: true }).click();
          await edSchedRow.locator('.status.approved').waitFor();
          await edSchedRow.getByRole('button', { name: /^Hẹn giờ/i }).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          await page.locator('#schedule-at').evaluate((el) => el.removeAttribute('min'));
          await page
            .locator('#schedule-at')
            .fill(formatLocalDatetimeInput(new Date(Date.now() - 3600_000)));
          await page.locator('#dialog button[type=submit]').click();
          assert.equal(
            await page.locator('#form-error').innerText(),
            'Thời gian hẹn xuất bản phải ở tương lai.',
          );
          assert.equal(await page.locator('#dialog').isVisible(), true);
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          // E2E-02 (5): popstate confirmDraftLeave dismiss vs accept
          await page.locator('[data-tab="history"]').click();
          await page.locator('.history-table').waitFor();
          await page.locator('[data-tab="articles"]').click();
          await page.locator('#new-article').click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          await page.locator('#title').fill('Popstate Unsaved Guard');

          const urlBeforeBack = page.url();
          page.once('dialog', (d) => d.dismiss());
          await page.goBack();
          await delay(100);
          assert.equal(await page.locator('#dialog').isVisible(), true);
          assert.equal(page.url(), urlBeforeBack);

          page.once('dialog', (d) => d.accept());
          await page.goBack();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await waitForView(page);

          // E2E-02 (7): delayed /media/* fetch aborted cleanly on quick Escape close
          const mediaTitle = `Bài abort ảnh Tier 5 ${randomUUID().slice(0, 6)}`;
          await page.locator('#new-article').click();
          await page.locator('#title').fill(mediaTitle);
          await page.locator('#category').selectOption('uth-news');
          await page.locator('#summary').fill('Tóm tắt abort media.');
          await page.locator('#body').fill('Nội dung abort media.');
          await page.locator('#image').setInputFiles({
            name: 'abort-test.png',
            mimeType: 'image/png',
            buffer: VALID_PNG,
          });
          await page.locator('#dialog button[type=submit]').click();
          await page.locator('#dialog').waitFor({ state: 'hidden' });
          await waitForView(page);

          let releaseMedia;
          let mediaSeen;
          const mediaGate = new Promise((resolve) => (releaseMedia = resolve));
          const mediaSeenPromise = new Promise((resolve) => (mediaSeen = resolve));
          const mediaHandler = async (route) => {
            mediaSeen();
            await mediaGate;
            try {
              await route.continue();
            } catch {}
          };
          await page.route('**/media/**', mediaHandler);
          try {
            const mediaRow = page.locator('.editorial-item').filter({ hasText: mediaTitle });
            await mediaRow.locator('[data-preview]').click();
            await mediaSeenPromise;
            await page.keyboard.press('Escape');
            await page.locator('#dialog').waitFor({ state: 'hidden' });
          } finally {
            releaseMedia?.();
            await delay(50);
            await page.unroute('**/media/**', mediaHandler);
          }

          // FE-01: 401 session expiration mid-workspace (form submit -> dismiss -> #editorial-status & #new-article)
          const expiredRow = page.locator('.editorial-item').filter({ hasText: mediaTitle });
          await expiredRow.getByRole('button', { name: 'Sửa', exact: true }).click();
          await page.locator('#dialog').waitFor({ state: 'visible' });
          await ctx.clearCookies();
          allowExpectedHttp401 = true;
          try {
            await page.locator('#dialog button[type=submit]').click();
            await page
              .locator('#form-error')
              .filter({ hasText: /Bạn cần đăng nhập/ })
              .waitFor();
          } finally {
            allowExpectedHttp401 = false;
          }
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          await page.locator('#editorial-status').selectOption('draft');
          await page.locator('#editorial-status').selectOption('');
          await page.locator('#new-article').click();
          await page.locator('#dialog #email').waitFor({ state: 'visible' });
          await page.locator('#dialog #password').waitFor({ state: 'visible' });
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          // Also verify 401 outside an open form (action button) prompts re-login cleanly
          await loginUI(page, 'editor', true);
          const actionRow = page.locator('.editorial-item').filter({ hasText: mediaTitle });
          await ctx.clearCookies();
          allowExpectedHttp401 = true;
          try {
            await actionRow.getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
            await page.locator('#workspace-login').waitFor({ state: 'visible' });
            await page.locator('#dialog #email').waitFor({ state: 'visible' });
          } finally {
            allowExpectedHttp401 = false;
          }
          await page.keyboard.press('Escape');
          await page.locator('#dialog').waitFor({ state: 'hidden' });

          // E2E-02 (6): /article/ and /article/foo/bar invalid-path client alerts
          for (const badArticlePath of ['/article/', '/article/foo/bar']) {
            await page.goto(`${base}${badArticlePath}`);
            await page.locator('#content .empty[role="alert"]').waitFor();
            assert.match(
              await page.locator('#content .empty[role="alert"]').innerText(),
              /Đường dẫn bài viết không hợp lệ/,
            );
            assert.equal(
              await page.locator('#content .empty[role="alert"] a[href="/"]').count(),
              1,
            );
          }
        } finally {
          await ctx.close();
        }
      },
    );

    await step('Zero unexpected pageerror or console.error events', async () => {
      assert.deepEqual(pageErrors, [], `Unexpected pageerror(s): ${pageErrors.join(' | ')}`);
      assert.deepEqual(
        consoleErrors,
        [],
        `Unexpected console.error(s): ${consoleErrors.join(' | ')}`,
      );
    });
  } finally {
    await browser?.close();
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
            resolve();
          }, 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        }
      });
    }
    if (db) await db.close();
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    if (prevUpload === undefined) delete process.env.UPLOAD_PATH;
    else process.env.UPLOAD_PATH = prevUpload;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log(
    `\nSummary: ${results.filter((r) => r.status === 'PASS').length}/${results.length} scenarios passed.`,
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

runAcceptanceSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
