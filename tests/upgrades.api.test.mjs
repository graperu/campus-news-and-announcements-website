import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, migrate } from '../backend/db.mjs';
import { hashPassword } from '../backend/passwords.mjs';
import { createRequestHandler } from '../backend/server.mjs';
import { readReviewedSource, restoreReviewedSource } from '../scripts/data/source-content.mjs';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2kAAAAASUVORK5CYII=',
  'base64',
);

async function spawnIsolatedServer({ seedSource = false, seedUsers = true, extraEnv = {} } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'uth-upgrades-'));
  const sqlitePath = join(temp, 'test.db');
  const uploadPath = join(temp, 'uploads');

  const prevSqlite = process.env.SQLITE_PATH;
  const prevUpload = process.env.UPLOAD_PATH;
  const prevDbUrl = process.env.DATABASE_URL;

  process.env.SQLITE_PATH = sqlitePath;
  process.env.UPLOAD_PATH = uploadPath;
  if (extraEnv.SQLITE_ONLY || !process.env.TEST_DATABASE_URL) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }

  let db = null;
  let child = null;
  const password = randomUUID();
  const runTag = randomUUID().slice(0, 8);
  const seededUsers = [
    {
      id: `u-reader-${runTag}-${randomUUID().slice(0, 6)}`,
      email: `reader-${runTag}@test.invalid`,
      name: 'Test Reader',
      role: 'reader',
    },
    {
      id: `u-author-${runTag}-${randomUUID().slice(0, 6)}`,
      email: `author-${runTag}@test.invalid`,
      name: 'Test Author',
      role: 'author',
    },
    {
      id: `u-author2-${runTag}-${randomUUID().slice(0, 6)}`,
      email: `author2-${runTag}@test.invalid`,
      name: 'Test Author 2',
      role: 'author',
    },
    {
      id: `u-editor-${runTag}-${randomUUID().slice(0, 6)}`,
      email: `editor-${runTag}@test.invalid`,
      name: 'Test Editor',
      role: 'editor',
    },
  ];

  const cleanup = async () => {
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
  };

  try {
    // Prepare isolated DB using SQLite/PG outside production NODE_ENV restriction unless TEST_DATABASE_URL is used
    db = await connect();
    await migrate(db);

    if (seedSource) {
      const snapshot = await readReviewedSource();
      await restoreReviewedSource(db, snapshot);
    } else {
      for (const [id, name] of [
        ['uth-news', 'Tin UTH'],
        ['notices', 'Thông báo'],
        ['community', 'Hoạt động'],
        ['union', 'Công đoàn'],
        ['education', 'Đào tạo'],
      ]) {
        await db.run(
          'INSERT INTO categories(id,name,color) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
          [id, name, '#155b65'],
        );
      }
    }

    if (seedUsers) {
      for (const u of seededUsers) {
        await db.run(
          'INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING',
          [u.id, u.email, u.name, u.role, hashPassword(password)],
        );
      }
    }

    const childEnv = {
      ...process.env,
      SQLITE_PATH: sqlitePath,
      UPLOAD_PATH: uploadPath,
      PORT: '0',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      SCHEDULER_INTERVAL_MS: '600000',
      ...extraEnv,
    };
    if (extraEnv.SQLITE_ONLY || !process.env.TEST_DATABASE_URL) {
      delete childEnv.DATABASE_URL;
    } else {
      childEnv.DATABASE_URL = process.env.TEST_DATABASE_URL;
    }
    delete childEnv.SQLITE_ONLY;

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
      child.stdout.on('data', (chunk) => {
        const match = chunk.toString().match(/Campus News: (http:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}. stderr: ${stderr}`));
      });
    });

    const request = async (path, { method = 'GET', body, rawBody, headers = {}, cookie } = {}) => {
      const reqHeaders = { ...headers };
      if (
        !('Origin' in reqHeaders) &&
        !('origin' in reqHeaders) &&
        !('omitClientHeader' in reqHeaders)
      ) {
        if (method === 'POST' || method === 'PUT') {
          reqHeaders['X-Campus-Client'] = '1';
        }
      }
      delete reqHeaders.omitClientHeader;
      if (cookie) reqHeaders.cookie = cookie;

      let payload;
      if (rawBody !== undefined) {
        payload = rawBody;
      } else if (body !== undefined) {
        reqHeaders['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }

      const res = await fetch(base + path, {
        method,
        headers: reqHeaders,
        body: payload,
      });
      const text = await res.text();
      let data = null;
      const ctype = res.headers.get('content-type') || '';
      if (text.length > 0 && ctype.includes('application/json')) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      return { status: res.status, headers: res.headers, text, data };
    };

    const login = async (email) => {
      const r = await request('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      assert.equal(r.status, 200, `Login failed for ${email}: ${r.text}`);
      const setCookie = r.headers.get('set-cookie');
      assert.ok(setCookie, `Missing Set-Cookie on login for ${email}`);
      return { cookie: setCookie.split(';')[0], user: r.data, headers: r.headers };
    };

    return {
      base,
      db,
      temp,
      password,
      users: {
        reader: seededUsers[0],
        author: seededUsers[1],
        author2: seededUsers[2],
        editor: seededUsers[3],
      },
      request,
      login,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function assertSecurityHeaders(headers) {
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.ok(headers.get('content-security-policy'), 'Content-Security-Policy must be set');
  assert.ok(headers.get('x-request-id'), 'X-Request-ID must be set');
}

function assertPublicCacheHeaders(headers) {
  const cc = headers.get('cache-control') || '';
  assert.match(cc, /\bpublic\b/);
  assert.match(cc, /\bs-maxage=30\b/);
  assert.match(cc, /\bmust-revalidate\b/);
  assertSecurityHeaders(headers);
}

function assertErrorPayload(res, expectedStatus) {
  assert.equal(
    res.status,
    expectedStatus,
    `Expected ${expectedStatus}, got ${res.status}: ${res.text}`,
  );
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const reqId = res.headers.get('x-request-id');
  assert.ok(reqId, 'Missing X-Request-ID header on error response');
  assert.ok(res.data && typeof res.data.error === 'string' && res.data.error.length > 0);
  assert.equal(res.data.requestId, reqId);
}

test('Upgrades API Suite — Tiers 1–4 (F1–F8 + API F9)', async (t) => {
  const srv = await spawnIsolatedServer({ seedSource: true, seedUsers: true });
  const { request, db, users } = srv;

  let cookies = {};
  try {
    const rLogin = await srv.login(users.reader.email);
    const aLogin = await srv.login(users.author.email);
    const a2Login = await srv.login(users.author2.email);
    const eLogin = await srv.login(users.editor.email);
    cookies = {
      reader: rLogin.cookie,
      author: aLogin.cookie,
      author2: a2Login.cookie,
      editor: eLogin.cookie,
    };

    const createDraft = async (cookie, overrides = {}) => {
      const payload = {
        title: `Bài viết kiểm thử ${randomUUID().slice(0, 8)}`,
        summary: 'Tóm tắt kiểm thử độc lập cho hệ thống tin tức UTH.',
        body: 'Đoạn văn thứ nhất của bài viết kiểm thử.\n\nĐoạn văn thứ hai của bài viết kiểm thử.',
        category_id: 'uth-news',
        image: '/assets/news/uth-2095.png',
        ...overrides,
      };
      const res = await request('/api/articles', { method: 'POST', body: payload, cookie });
      return { res, payload };
    };

    const publishDraft = async (versionId) => {
      const s = await request(`/api/versions/${versionId}/submit`, {
        method: 'POST',
        body: {},
        cookie: cookies.author,
      });
      assert.equal(s.status, 200, s.text);
      const a = await request(`/api/versions/${versionId}/approve`, {
        method: 'POST',
        body: {},
        cookie: cookies.editor,
      });
      assert.equal(a.status, 200, a.text);
      const p = await request(`/api/versions/${versionId}/publish`, {
        method: 'POST',
        body: {},
        cookie: cookies.editor,
      });
      assert.equal(p.status, 200, p.text);
    };

    const [{ l: dbLowerCheck }] = await db.all("SELECT LOWER('Đ') AS l");
    const supportsViLower = dbLowerCheck === 'đ';

    // =========================================================================
    // F1 Tier 1 (runs while DB has all 30 UTH source records)
    // =========================================================================
    await t.test(
      'T1-F1-01: GET /api/public/articles returns 30 UTH articles with required schema',
      async () => {
        const snapshot = await readReviewedSource();
        const res = await request('/api/public/articles');
        assert.equal(res.status, 200);
        if (process.env.TEST_DATABASE_URL) {
          assert.ok(res.data.length >= 30, `Expected >= 30 articles, got ${res.data.length}`);
        } else {
          assert.equal(res.data.length, 30);
        }
        const ids = new Set(res.data.map((a) => a.id));
        for (const rec of snapshot.records) {
          assert.ok(ids.has(rec.id), `Missing uth.json article ${rec.id}`);
        }
        const required = [
          'id',
          'slug',
          'title',
          'summary',
          'body',
          'category_id',
          'category_name',
          'published_at',
          'version_id',
          'source_url',
          'document_url',
          'document_title',
        ];
        for (const item of res.data) {
          for (const key of required) assert.ok(key in item, `Missing field ${key}`);
        }
      },
    );

    await t.test(
      'T1-F1-02: GET /api/public/articles?category=notices filters strictly by notices',
      async () => {
        const res = await request('/api/public/articles?category=notices');
        assert.equal(res.status, 200);
        assert.ok(res.data.length > 0);
        for (const item of res.data) {
          assert.equal(item.category_id, 'notices');
          assert.equal(item.category_name, 'Thông báo');
        }
      },
    );

    await t.test(
      'T1-F1-03: Vietnamese diacritic search Đ/đ ("Đào tạo") matches uth-2011',
      async () => {
        const upper = await request(`/api/public/articles?q=${encodeURIComponent('Đào tạo')}`);
        const lower = await request(`/api/public/articles?q=${encodeURIComponent('đào tạo')}`);
        assert.equal(upper.status, 200);
        assert.equal(lower.status, 200);
        assert.ok(upper.data.some((a) => a.id === 'uth-2011'));
        if (supportsViLower) {
          assert.deepEqual(
            upper.data.map((a) => a.id),
            lower.data.map((a) => a.id),
          );
        }
      },
    );

    await t.test(
      'T1-F1-04: Vietnamese diacritic search Á/á ("Ái Quốc") matches uth-1780 case-insensitively',
      async () => {
        const upper = await request(`/api/public/articles?q=${encodeURIComponent('Ái Quốc')}`);
        const lower = await request(`/api/public/articles?q=${encodeURIComponent('ái quốc')}`);
        assert.equal(upper.status, 200);
        assert.equal(lower.status, 200);
        assert.ok(upper.data.some((a) => a.id === 'uth-1780'));
        if (supportsViLower) {
          assert.deepEqual(
            upper.data.map((a) => a.id),
            lower.data.map((a) => a.id),
          );
        }
      },
    );

    await t.test(
      'T1-F1-05: Combined category=uth-news and q="Hồ Chí Minh" returns intersecting results',
      async () => {
        const res = await request(
          `/api/public/articles?category=uth-news&q=${encodeURIComponent('Hồ Chí Minh')}`,
        );
        assert.equal(res.status, 200);
        assert.ok(res.data.length > 0);
        for (const item of res.data) {
          assert.equal(item.category_id, 'uth-news');
          assert.match(
            `${item.title} ${item.summary} ${item.body}`.toLocaleLowerCase('vi'),
            /hồ chí minh/,
          );
        }
      },
    );

    // =========================================================================
    // F2 Tier 1 & Tier 2
    // =========================================================================
    await t.test(
      'T1-F2-01: Article detail uth-1672 returns non-null PDF document_url',
      async () => {
        const slug =
          'ke-hoach-to-chuc-xay-dung-mo-hinh-khong-gian-van-hoa-ho-chi-minh-tren-nen-tang-so';
        const res = await request(`/api/public/articles/${slug}`);
        assert.equal(res.status, 200);
        assert.equal(res.data.id, 'uth-1672');
        assert.ok(res.data.document_url && res.data.document_url.endsWith('.pdf'));
      },
    );

    await t.test(
      'T1-F2-02: Article detail phuong-phap-giao-duc returns full body and version_id',
      async () => {
        const res = await request('/api/public/articles/phuong-phap-giao-duc');
        assert.equal(res.status, 200);
        assert.equal(res.data.id, 'uth-2018');
        assert.ok(res.data.body.length > 300);
        assert.equal(res.data.version_id, 'uth-2018-2d1ba71e46ea');
      },
    );

    await t.test(
      'T1-F2-03: Article detail without PDF has document_url === null and document_title === null',
      async () => {
        const slug =
          'uth-to-chuc-hop-mat-ky-niem-ngay-phu-nu-viet-nam-20-10-lan-toa-yeu-thuong-gan-ket-tap-the';
        const res = await request(`/api/public/articles/${encodeURIComponent(slug)}`);
        assert.equal(res.status, 200);
        assert.equal(res.data.id, 'uth-2095');
        assert.equal(res.data.document_url, null);
        assert.equal(res.data.document_title, null);
      },
    );

    await t.test('T1-F2-04: GET /article/:slug serves SPA text/html shell', async () => {
      const res = await request('/article/phuong-phap-giao-duc');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
    });

    await t.test(
      'T2-F2-01: Malformed percent-encoding on /api/public/articles/:slug returns 400 (never 500)',
      async () => {
        for (const bad of ['%E0%A4%A', '%ZZ', '%2']) {
          const res = await request(`/api/public/articles/${bad}`);
          assertErrorPayload(res, 400);
        }
      },
    );

    await t.test(
      'T2-F2-02: Prefix and path boundary on /api/public/articles returns 400 or 404 (never 500)',
      async () => {
        for (const path of [
          '/api/public/articles/',
          '/api/public/articles/a/b',
          '/api/public/articles-extra/foo',
        ]) {
          const res = await request(path);
          assert.ok(
            res.status === 400 || res.status === 404,
            `Expected 400/404 for ${path}, got ${res.status}`,
          );
          assert.equal(res.headers.get('cache-control'), 'no-store');
          assert.ok(res.data && res.data.error && res.data.requestId);
        }
      },
    );

    await t.test(
      'T2-F2-03 & T2-F2-04: Unpublished draft slug and nonexistent slug return 404 no-store',
      async () => {
        const { res: created } = await createDraft(cookies.author);
        assert.equal(created.status, 201);
        const [row] = await db.all('SELECT slug FROM articles WHERE id=$1', [created.data.id]);
        const unpub = await request(`/api/public/articles/${row.slug}`);
        assertErrorPayload(unpub, 404);
        const missing = await request('/api/public/articles/khong-ton-tai-999');
        assertErrorPayload(missing, 404);
      },
    );

    await t.test('T2-F2-05: GET /article/%E0%A4%A does not crash or return 500', async () => {
      const res = await request('/article/%E0%A4%A');
      assert.ok(res.status === 200 || res.status === 400, `Unexpected status ${res.status}`);
    });

    // =========================================================================
    // F3 Tier 1 & Tier 2
    // =========================================================================
    await t.test(
      'T1-F3-01 & T1-F3-02 & T1-F3-05: Public list strong ETag, Cache-Control, GET/HEAD 304',
      async () => {
        const first = await request('/api/public/articles');
        assert.equal(first.status, 200);
        const etag = first.headers.get('etag');
        assert.ok(
          etag && etag.startsWith('"') && etag.endsWith('"') && !etag.startsWith('W/'),
          `Bad ETag: ${etag}`,
        );
        assertPublicCacheHeaders(first.headers);

        const notMod = await request('/api/public/articles', {
          headers: { 'If-None-Match': etag },
        });
        assert.equal(notMod.status, 304);
        assert.equal(notMod.text, '');
        assert.equal(notMod.headers.get('etag'), etag);
        assertPublicCacheHeaders(notMod.headers);

        const head304 = await request('/api/public/articles', {
          method: 'HEAD',
          headers: { 'If-None-Match': etag },
        });
        assert.equal(head304.status, 304);
        assert.equal(head304.text, '');
        assert.equal(head304.headers.get('etag'), etag);
        assertPublicCacheHeaders(head304.headers);
      },
    );

    await t.test(
      'T1-F3-03 & T1-F3-04: ETag + 304 on /api/public/articles/:slug and /api/categories',
      async () => {
        const detail = await request('/api/public/articles/phuong-phap-giao-duc');
        assert.equal(detail.status, 200);
        assert.equal(detail.headers.get('etag'), '"uth-2018-2d1ba71e46ea"');
        assertPublicCacheHeaders(detail.headers);
        const detail304 = await request('/api/public/articles/phuong-phap-giao-duc', {
          headers: { 'If-None-Match': '"uth-2018-2d1ba71e46ea"' },
        });
        assert.equal(detail304.status, 304);
        assert.equal(detail304.text, '');
        assert.equal(detail304.headers.get('etag'), '"uth-2018-2d1ba71e46ea"');
        assertPublicCacheHeaders(detail304.headers);

        const headDetail304 = await request('/api/public/articles/phuong-phap-giao-duc', {
          method: 'HEAD',
          headers: { 'If-None-Match': '"uth-2018-2d1ba71e46ea"' },
        });
        assert.equal(headDetail304.status, 304);
        assert.equal(headDetail304.text, '');
        assert.equal(headDetail304.headers.get('etag'), '"uth-2018-2d1ba71e46ea"');
        assertPublicCacheHeaders(headDetail304.headers);

        const cats = await request('/api/categories');
        assert.equal(cats.status, 200);
        const catEtag = cats.headers.get('etag');
        assert.ok(catEtag && catEtag.startsWith('"') && !catEtag.startsWith('W/'));
        assertPublicCacheHeaders(cats.headers);
        const cats304 = await request('/api/categories', { headers: { 'If-None-Match': catEtag } });
        assert.equal(cats304.status, 304);
        assert.equal(cats304.text, '');
        assert.equal(cats304.headers.get('etag'), catEtag);
        assertPublicCacheHeaders(cats304.headers);

        const headCats304 = await request('/api/categories', {
          method: 'HEAD',
          headers: { 'If-None-Match': catEtag },
        });
        assert.equal(headCats304.status, 304);
        assert.equal(headCats304.text, '');
        assert.equal(headCats304.headers.get('etag'), catEtag);
        assertPublicCacheHeaders(headCats304.headers);
      },
    );

    await t.test(
      'T2-F3-01 & T2-F3-02 & T2-F3-03: RFC 9110 weak/multi/wildcard/stale If-None-Match',
      async () => {
        const first = await request('/api/public/articles');
        const etag = first.headers.get('etag');
        assert.ok(etag);

        const weak = await request('/api/public/articles', {
          headers: { 'If-None-Match': `W/${etag}` },
        });
        assert.equal(weak.status, 304);
        assert.equal(weak.text, '');

        const multi = await request('/api/public/articles', {
          headers: { 'If-None-Match': `"nope", ${etag}` },
        });
        assert.equal(multi.status, 304);

        const wildList = await request('/api/public/articles', {
          headers: { 'If-None-Match': '*' },
        });
        assert.equal(wildList.status, 304);

        const wildSlug = await request('/api/public/articles/phuong-phap-giao-duc', {
          headers: { 'If-None-Match': '*' },
        });
        assert.equal(wildSlug.status, 304);

        const wildMissing = await request('/api/public/articles/khong-ton-tai-999', {
          headers: { 'If-None-Match': '*' },
        });
        assert.equal(wildMissing.status, 404);

        const stale = await request('/api/public/articles', {
          headers: { 'If-None-Match': '"stale-etag"' },
        });
        assert.equal(stale.status, 200);
        assert.ok(Array.isArray(stale.data));

        const staleCat = await request('/api/categories', {
          headers: { 'If-None-Match': '"stale-etag"' },
        });
        assert.equal(staleCat.status, 200);
        assert.ok(Array.isArray(staleCat.data));
      },
    );

    await t.test(
      'T2-F3-04 & T2-F3-05: Query-distinct ETags and private endpoint no-store isolation',
      async () => {
        const r1 = await request('/api/public/articles?category=notices');
        const r2 = await request('/api/public/articles?category=union');
        const r3 = await request('/api/public/articles?q=UTH');
        const e1 = r1.headers.get('etag');
        const e2 = r2.headers.get('etag');
        const e3 = r3.headers.get('etag');
        assert.ok(e1 && e2 && e3);
        assert.notEqual(e1, e2);
        assert.notEqual(e1, e3);
        const cross = await request('/api/public/articles?category=union', {
          headers: { 'If-None-Match': e1 },
        });
        assert.equal(cross.status, 200);

        for (const path of [
          '/api/editorial',
          '/api/history',
          '/api/history/uth-2018-2d1ba71e46ea',
          '/api/ops/metrics',
        ]) {
          const res = await request(path, { cookie: cookies.editor });
          assert.equal(res.status, 200, `${path} failed`);
          assert.equal(res.headers.get('cache-control'), 'no-store');
          assert.equal(res.headers.get('etag'), null);
        }
      },
    );

    // =========================================================================
    // F4 Tier 1 & Tier 2
    // =========================================================================
    await t.test('T1-F4-01..05: HEAD empty bodies and security headers across routes', async () => {
      const hg = await request('/health');
      assert.equal(hg.status, 200);
      assert.deepEqual(hg.data, { status: 'ok' });
      assert.ok(hg.headers.get('x-request-id'));

      for (const [path, cookie] of [
        ['/health', undefined],
        ['/api/public/articles/phuong-phap-giao-duc', undefined],
        ['/api/categories', undefined],
        ['/api/config', undefined],
        ['/api/auth/me', undefined],
        ['/api/editorial', cookies.editor],
        ['/api/history/uth-2018-2d1ba71e46ea', cookies.editor],
      ]) {
        const hr = await request(path, { method: 'HEAD', cookie });
        assert.equal(hr.status, 200, `HEAD ${path} returned ${hr.status}`);
        assert.equal(hr.text, '', `HEAD ${path} must have empty body`);
        assert.ok(hr.headers.get('x-request-id'));
        if (path.startsWith('/api/editorial') || path.startsWith('/api/history')) {
          assert.equal(hr.headers.get('cache-control'), 'no-store');
        }
      }

      for (const path of ['/', '/api/public/articles', '/api/config']) {
        const res = await request(path);
        assert.equal(res.status, 200);
        assertSecurityHeaders(res.headers);
      }
    });

    await t.test(
      'T2-F4-01 & T2-F4-02: 405 method enforcement on read routes & /api/versions/:id',
      async () => {
        const upMedia = await request('/api/uploads', {
          method: 'POST',
          rawBody: VALID_PNG,
          cookie: cookies.author,
        });
        assert.equal(upMedia.status, 201);

        for (const path of [
          '/health',
          '/api/config',
          '/api/auth/me',
          '/api/public/articles',
          '/api/public/articles/phuong-phap-giao-duc',
          '/api/editorial',
          '/api/history',
          '/api/history/uth-2018-2d1ba71e46ea',
          '/api/ops/metrics',
          upMedia.data.url,
        ]) {
          for (const method of ['POST', 'DELETE', 'PATCH']) {
            const res = await request(path, {
              method,
              body: method === 'POST' ? {} : undefined,
              cookie: cookies.editor,
            });
            assertErrorPayload(res, 405);
          }
        }
        assertErrorPayload(
          await request('/api/categories', { method: 'DELETE', cookie: cookies.editor }),
          405,
        );

        const { res: d } = await createDraft(cookies.author);
        const vid = d.data.version_id;
        const postVer = await request(`/api/versions/${vid}`, {
          method: 'POST',
          body: { title: 'x', summary: 'y', body: 'z', category_id: 'uth-news' },
          cookie: cookies.author,
        });
        assertErrorPayload(postVer, 405);

        const getVer = await request(`/api/versions/${vid}`, {
          method: 'GET',
          cookie: cookies.author,
        });
        assertErrorPayload(getVer, 405);

        const putArt = await request('/api/articles', {
          method: 'PUT',
          body: { title: 'x', summary: 'y', body: 'z', category_id: 'uth-news' },
          cookie: cookies.author,
        });
        assert.ok(putArt.status === 404 || putArt.status === 405);
      },
    );

    await t.test(
      'T2-F4-03 & T2-F4-04 & T2-F4-05: X-Request-ID parity, EISDIR/traversal 404, vercel.json parity',
      async () => {
        for (const path of [
          '/assets/',
          '/styles/',
          '/../backend/server.mjs',
          '/storage/private/admin-login.txt',
        ]) {
          const res = await request(path);
          assert.ok(res.status === 403 || res.status === 404, `${path} -> ${res.status}`);
          assert.notEqual(res.status, 500);
          assert.ok(res.headers.get('x-request-id'));
        }

        const vercel = JSON.parse(
          await readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
        );
        const headerMap = Object.fromEntries(
          vercel.headers[0].headers.map((h) => [h.key.toLowerCase(), h.value]),
        );
        assert.equal(headerMap['x-frame-options'], 'DENY');
        assert.equal(headerMap['x-content-type-options'], 'nosniff');
        assert.equal(headerMap['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.ok(headerMap['content-security-policy']);
      },
    );

    // =========================================================================
    // F5 Tier 1 & Tier 2 (401/403/CSRF)
    // =========================================================================
    await t.test(
      'T1-F5-01..03: Auth me, author create/edit/submit, editor approve/publish/category/metrics',
      async () => {
        const me = await request('/api/auth/me', { cookie: cookies.editor });
        assert.equal(me.status, 200);
        assert.equal(me.data.user.role, 'editor');

        const { res: d1 } = await createDraft(cookies.author);
        assert.equal(d1.status, 201);
        const vid = d1.data.version_id;
        assert.equal(
          (
            await request(`/api/versions/${vid}`, {
              method: 'PUT',
              body: {
                title: 'Author Updated Draft',
                summary: 'Summary updated cleanly',
                body: 'Body content updated',
                category_id: 'uth-news',
              },
              cookie: cookies.author,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request(`/api/versions/${vid}/submit`, {
              method: 'POST',
              body: {},
              cookie: cookies.author,
            })
          ).status,
          200,
        );
        const edList = await request('/api/editorial', { cookie: cookies.author });
        assert.equal(edList.status, 200);
        assert.ok(edList.data.every((v) => v.author_id === users.author.id));

        assert.equal(
          (
            await request(`/api/versions/${vid}/approve`, {
              method: 'POST',
              body: {},
              cookie: cookies.editor,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request(`/api/versions/${vid}/publish`, {
              method: 'POST',
              body: {},
              cookie: cookies.editor,
            })
          ).status,
          200,
        );
        const newCat = await request('/api/categories', {
          method: 'POST',
          body: { name: `Chuyên mục ${randomUUID().slice(0, 6)}` },
          cookie: cookies.editor,
        });
        assert.equal(newCat.status, 201);
        const metrics = await request('/api/ops/metrics', { cookie: cookies.editor });
        assert.equal(metrics.status, 200);
        assert.ok(typeof metrics.data.originRequests === 'number');
      },
    );

    await t.test(
      'T2-F5-01 & T2-F5-02 & T2-F5-04: Complete 401, 403 (reader/author/cross-author), and CSRF matrix',
      async () => {
        const { res: authorDraft } = await createDraft(cookies.author);
        const vId = authorDraft.data.version_id;

        // 401 matrix
        for (const [method, path, body] of [
          ['GET', '/api/editorial', undefined],
          ['GET', '/api/history', undefined],
          ['GET', '/api/history/uth-2018-2d1ba71e46ea', undefined],
          [
            'POST',
            '/api/articles',
            { title: 'x', summary: 'y', body: 'z', category_id: 'uth-news' },
          ],
          [
            'POST',
            `/api/versions/${vId}/schedule`,
            { scheduled_at: new Date(Date.now() + 60000).toISOString() },
          ],
          ['POST', '/api/ops/scheduler/run', {}],
          ['GET', '/api/ops/metrics', undefined],
        ]) {
          assertErrorPayload(await request(path, { method, body }), 401);
        }

        // Reader 403 matrix
        for (const [method, path, body] of [
          ['GET', '/api/editorial', undefined],
          ['GET', '/api/history', undefined],
          ['GET', '/api/history/uth-2018-2d1ba71e46ea', undefined],
          [
            'POST',
            '/api/articles',
            { title: 'x', summary: 'y', body: 'z', category_id: 'uth-news' },
          ],
          ['POST', `/api/versions/${vId}/submit`, {}],
          ['POST', `/api/versions/${vId}/approve`, {}],
          [
            'POST',
            `/api/versions/${vId}/schedule`,
            { scheduled_at: new Date(Date.now() + 60000).toISOString() },
          ],
          ['POST', `/api/versions/${vId}/publish`, {}],
          ['POST', '/api/categories', { name: 'Forbidden Cat' }],
          ['POST', '/api/ops/scheduler/run', {}],
          ['GET', '/api/ops/metrics', undefined],
        ]) {
          assertErrorPayload(await request(path, { method, body, cookie: cookies.reader }), 403);
        }

        // Author 403 matrix (editor endpoints + cross-author ownership)
        for (const [method, path, body] of [
          ['POST', `/api/versions/${vId}/approve`, {}],
          ['POST', `/api/versions/${vId}/reject`, {}],
          [
            'POST',
            `/api/versions/${vId}/schedule`,
            { scheduled_at: new Date(Date.now() + 60000).toISOString() },
          ],
          ['POST', `/api/versions/${vId}/unschedule`, {}],
          ['POST', `/api/versions/${vId}/publish`, {}],
          ['POST', '/api/categories', { name: 'Author Cat' }],
          [
            'POST',
            '/api/users',
            { email: 'x@test.invalid', name: 'X', role: 'reader', password: randomUUID() },
          ],
          ['POST', '/api/ops/scheduler/run', {}],
          ['GET', '/api/ops/metrics', undefined],
        ]) {
          assertErrorPayload(await request(path, { method, body, cookie: cookies.author }), 403);
        }
        assertErrorPayload(
          await request(`/api/versions/${vId}`, {
            method: 'PUT',
            body: { title: 'Hijack', summary: 'Hijack', body: 'Hijack', category_id: 'uth-news' },
            cookie: cookies.author2,
          }),
          403,
        );
        assertErrorPayload(
          await request(`/api/versions/${vId}/submit`, {
            method: 'POST',
            body: {},
            cookie: cookies.author2,
          }),
          403,
        );

        // CSRF checks
        assertErrorPayload(
          await request('/api/articles', {
            method: 'POST',
            body: { title: 'No CSRF', summary: 'S', body: 'B', category_id: 'uth-news' },
            headers: { omitClientHeader: '1' },
            cookie: cookies.author,
          }),
          403,
        );
        assertErrorPayload(
          await request(`/api/versions/${vId}/schedule`, {
            method: 'POST',
            body: { scheduled_at: new Date(Date.now() + 60000).toISOString() },
            headers: { Origin: 'https://evil.invalid' },
            cookie: cookies.editor,
          }),
          403,
        );
      },
    );

    // =========================================================================
    // F6 Tier 1 & Tier 2
    // =========================================================================
    await t.test(
      'T1-F6-01..03: Draft/rejected category_id edit & private PNG /media/* upload',
      async () => {
        const { res: d, payload } = await createDraft(cookies.author, { category_id: 'uth-news' });
        const vid = d.data.version_id;
        const aid = d.data.id;

        const upd = await request(`/api/versions/${vid}`, {
          method: 'PUT',
          body: { ...payload, category_id: 'education' },
          cookie: cookies.author,
        });
        assert.equal(upd.status, 200);
        const list1 = await request('/api/editorial', { cookie: cookies.author });
        const row1 = list1.data.find((x) => x.id === vid);
        assert.equal(row1.category_id, 'education');
        assert.equal(row1.category_name, 'Đào tạo');
        const [artRow] = await db.all('SELECT category_id FROM articles WHERE id=$1', [aid]);
        assert.equal(artRow.category_id, 'education');

        await request(`/api/versions/${vid}/submit`, {
          method: 'POST',
          body: {},
          cookie: cookies.author,
        });
        await request(`/api/versions/${vid}/reject`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        const updRej = await request(`/api/versions/${vid}`, {
          method: 'PUT',
          body: { ...payload, category_id: 'notices' },
          cookie: cookies.author,
        });
        assert.equal(updRej.status, 200);
        const row2 = (await request('/api/editorial', { cookie: cookies.author })).data.find(
          (x) => x.id === vid,
        );
        assert.equal(row2.status, 'draft');
        assert.equal(row2.category_id, 'notices');

        const up = await request('/api/uploads', {
          method: 'POST',
          rawBody: VALID_PNG,
          cookie: cookies.author,
        });
        assert.equal(up.status, 201);
        assert.match(up.data.url, /^\/media\/[a-f0-9-]+\.png$/);
        const attach = await request(`/api/versions/${vid}`, {
          method: 'PUT',
          body: { ...payload, category_id: 'notices', image: up.data.url },
          cookie: cookies.author,
        });
        assert.equal(attach.status, 200);
        const mediaRes = await request(up.data.url, { cookie: cookies.author });
        assert.equal(mediaRes.status, 200);
        assert.equal(mediaRes.headers.get('cache-control'), 'no-store');
      },
    );

    await t.test(
      'T2-F6-01..05: Trimming, length/category/image validation, image clearing, locked 409',
      async () => {
        const up = await request('/api/uploads', {
          method: 'POST',
          rawBody: VALID_PNG,
          cookie: cookies.author,
        });
        const { res: d } = await createDraft(cookies.author, { image: up.data.url });
        const vid = d.data.version_id;

        // T2-F6-01: Trimming (including padded boundary limits 180 / 500 / 50000)
        const trimRes = await request(`/api/versions/${vid}`, {
          method: 'PUT',
          body: {
            title: '  Tiêu đề mới  ',
            summary: '  Tóm tắt  ',
            body: '  Nội dung  ',
            category_id: '  notices  ',
          },
          cookie: cookies.author,
        });
        assert.equal(trimRes.status, 200);
        const edited = (await request('/api/editorial', { cookie: cookies.author })).data.find(
          (x) => x.id === vid,
        );
        assert.equal(edited.title, 'Tiêu đề mới');
        assert.equal(edited.summary, 'Tóm tắt');
        assert.equal(edited.body, 'Nội dung');
        assert.equal(edited.category_id, 'notices');

        const maxTitle = 'a'.repeat(180);
        const maxSummary = 'b'.repeat(500);
        const maxBody = 'c'.repeat(50000);
        const paddedBoundaryRes = await request(`/api/versions/${vid}`, {
          method: 'PUT',
          body: {
            title: `  ${maxTitle}  `,
            summary: `  ${maxSummary}  `,
            body: `  ${maxBody}  `,
            category_id: '  notices  ',
          },
          cookie: cookies.author,
        });
        assert.equal(
          paddedBoundaryRes.status,
          200,
          `Padded boundary PUT must succeed after trimming: ${paddedBoundaryRes.text}`,
        );
        const editedBoundary = (
          await request('/api/editorial', { cookie: cookies.author })
        ).data.find((x) => x.id === vid);
        assert.equal(editedBoundary.title.length, 180);
        assert.equal(editedBoundary.title, maxTitle);
        assert.equal(editedBoundary.summary.length, 500);
        assert.equal(editedBoundary.summary, maxSummary);
        assert.equal(editedBoundary.body.length, 50000);
        assert.equal(editedBoundary.body, maxBody);

        // T2-F6-02: Whitespace-only & overrun validation after trim
        for (const bad of [
          { title: '   ', summary: 'S', body: 'B', category_id: 'notices' },
          { title: 'T', summary: '   ', body: 'B', category_id: 'notices' },
          { title: 'T', summary: 'S', body: '   ', category_id: 'notices' },
          { title: 'a'.repeat(181), summary: 'S', body: 'B', category_id: 'notices' },
          { title: `  ${'a'.repeat(181)}  `, summary: 'S', body: 'B', category_id: 'notices' },
          { title: 'T', summary: 'a'.repeat(501), body: 'B', category_id: 'notices' },
          { title: 'T', summary: `  ${'b'.repeat(501)}  `, body: 'B', category_id: 'notices' },
          { title: 'T', summary: 'S', body: 'a'.repeat(50001), category_id: 'notices' },
          { title: 'T', summary: 'S', body: `  ${'c'.repeat(50001)}  `, category_id: 'notices' },
        ]) {
          assertErrorPayload(
            await request(`/api/versions/${vid}`, {
              method: 'PUT',
              body: bad,
              cookie: cookies.author,
            }),
            400,
          );
        }

        // T2-F6-03: Bad category_id & bad image URLs
        for (const bad of [
          { title: 'T', summary: 'S', body: 'B', category_id: 'unknown-cat' },
          {
            title: 'T',
            summary: 'S',
            body: 'B',
            category_id: 'notices',
            image: 'javascript:alert(1)',
          },
          {
            title: 'T',
            summary: 'S',
            body: 'B',
            category_id: 'notices',
            image: 'https://external.invalid/x.png',
          },
        ]) {
          assertErrorPayload(
            await request(`/api/versions/${vid}`, {
              method: 'PUT',
              body: bad,
              cookie: cookies.author,
            }),
            400,
          );
        }

        // T2-F6-04: Explicit image clearing
        const cleared = await request(`/api/versions/${vid}`, {
          method: 'PUT',
          body: { title: 'Cleared', summary: 'S', body: 'B', category_id: 'notices', image: '' },
          cookie: cookies.author,
        });
        assert.equal(cleared.status, 200);
        const afterClear = (await request('/api/editorial', { cookie: cookies.author })).data.find(
          (x) => x.id === vid,
        );
        assert.equal(afterClear.image, '');

        // T2-F6-05: Locked statuses (submitted, approved, scheduled) return 409
        await request(`/api/versions/${vid}/submit`, {
          method: 'POST',
          body: {},
          cookie: cookies.author,
        });
        assertErrorPayload(
          await request(`/api/versions/${vid}`, {
            method: 'PUT',
            body: { title: 'X', summary: 'S', body: 'B', category_id: 'notices' },
            cookie: cookies.author,
          }),
          409,
        );
        await request(`/api/versions/${vid}/approve`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assertErrorPayload(
          await request(`/api/versions/${vid}`, {
            method: 'PUT',
            body: { title: 'X', summary: 'S', body: 'B', category_id: 'notices' },
            cookie: cookies.editor,
          }),
          409,
        );
        await request(`/api/versions/${vid}/schedule`, {
          method: 'POST',
          body: { scheduled_at: new Date(Date.now() + 60000).toISOString() },
          cookie: cookies.editor,
        });
        assertErrorPayload(
          await request(`/api/versions/${vid}`, {
            method: 'PUT',
            body: { title: 'X', summary: 'S', body: 'B', category_id: 'notices' },
            cookie: cookies.editor,
          }),
          409,
        );
      },
    );

    // =========================================================================
    // F7 Tier 1 & Tier 2
    // =========================================================================
    await t.test(
      'T1-F7-01..03,05 & T2-F7-01..04: Superseded versions, history retention, single active published',
      async () => {
        const { res: d, payload } = await createDraft(cookies.author, {
          title: 'Revision Base v1',
        });
        const v1 = d.data.version_id;
        const artId = d.data.id;
        await publishDraft(v1);

        // T1-F7-03: revising published v1 creates draft v2 without mutating live public v1
        const rev2 = await request(`/api/versions/${v1}`, {
          method: 'PUT',
          body: { ...payload, title: 'Revision v2 Draft' },
          cookie: cookies.author,
        });
        assert.equal(rev2.status, 200);
        const v2 = rev2.data.version_id;
        assert.notEqual(v2, v1);

        const [slugRow] = await db.all('SELECT slug FROM articles WHERE id=$1', [artId]);
        const live1 = await request(`/api/public/articles/${slugRow.slug}`);
        assert.equal(live1.data.title, 'Revision Base v1');

        // T2-F7-02: GET /api/editorial has both v1 (published, published_version===v1) and v2 (draft, published_version===v1), never duplicates v1
        const edBefore = (await request('/api/editorial', { cookie: cookies.editor })).data.filter(
          (x) => x.article_id === artId,
        );
        assert.equal(edBefore.length, 2);
        const edV1 = edBefore.find((x) => x.id === v1);
        const edV2 = edBefore.find((x) => x.id === v2);
        assert.equal(edV1.status, 'published');
        assert.equal(edV1.published_version, v1);
        assert.equal(edV2.status, 'draft');
        assert.equal(edV2.published_version, v1);

        // Publish v2
        await publishDraft(v2);

        // T1-F7-01: v1 is superseded in DB and excluded from /api/editorial
        const edAfterV2 = (await request('/api/editorial', { cookie: cookies.editor })).data.filter(
          (x) => x.article_id === artId,
        );
        assert.equal(edAfterV2.length, 1);
        assert.equal(edAfterV2[0].id, v2);
        assert.equal(edAfterV2[0].status, 'published');
        const [dbV1] = await db.all('SELECT status FROM article_versions WHERE id=$1', [v1]);
        assert.equal(dbV1.status, 'superseded');

        // T2-F7-03: PUT on superseded v1 returns 409
        assertErrorPayload(
          await request(`/api/versions/${v1}`, {
            method: 'PUT',
            body: { ...payload, title: 'Edit Superseded' },
            cookie: cookies.editor,
          }),
          409,
        );

        // T2-F7-01: Revise v2 -> v3 -> publish v3
        const rev3 = await request(`/api/versions/${v2}`, {
          method: 'PUT',
          body: { ...payload, title: 'Revision v3' },
          cookie: cookies.editor,
        });
        const v3 = rev3.data.version_id;
        await publishDraft(v3);
        const versionsInDb = await db.all(
          'SELECT id, status FROM article_versions WHERE article_id=$1',
          [artId],
        );
        assert.equal(versionsInDb.filter((x) => x.status === 'published').length, 1);
        assert.equal(versionsInDb.filter((x) => x.status === 'superseded').length, 2);
        const edAfterV3 = (await request('/api/editorial', { cookie: cookies.editor })).data.filter(
          (x) => x.article_id === artId,
        );
        assert.equal(edAfterV3.length, 1);
        assert.equal(edAfterV3[0].id, v3);

        // T1-F7-02 & T2-F7-04: /api/history & /api/history/:v1 snapshot + draft 404 + URIError 400
        const hist = await request('/api/history', { cookie: cookies.editor });
        assert.ok(hist.data.some((p) => p.version_id === v1));
        assert.ok(hist.data.some((p) => p.version_id === v2));
        assert.ok(hist.data.some((p) => p.version_id === v3));
        const snapV1 = await request(`/api/history/${v1}`, { cookie: cookies.editor });
        assert.equal(snapV1.status, 200);
        assert.equal(snapV1.data.title, 'Revision Base v1');

        const { res: draftOnly } = await createDraft(cookies.author);
        assertErrorPayload(
          await request(`/api/history/${draftOnly.data.version_id}`, { cookie: cookies.author }),
          404,
        );
        assertErrorPayload(await request('/api/history/%E0%A4%A', { cookie: cookies.editor }), 400);

        // T1-F7-05: Every published article in DB has COUNT(*)=1 status='published' matching published_version
        const badPublished = await db.all(
          `SELECT a.id FROM articles a
         WHERE a.published_version IS NOT NULL
         AND (
           (SELECT COUNT(*) FROM article_versions v WHERE v.article_id=a.id AND v.status='published') != 1
           OR NOT EXISTS (SELECT 1 FROM article_versions v WHERE v.id=a.published_version AND v.status='published')
         )`,
        );
        assert.equal(badPublished.length, 0);
      },
    );

    // =========================================================================
    // F8 Tier 1 & Tier 2
    // =========================================================================
    await t.test(
      'T1-F8-01..05 & T2-F8-01..05: Scheduled publication lifecycle & boundary guards',
      async () => {
        const { res: d1 } = await createDraft(cookies.author, { title: 'Scheduled Lifecycle 1' });
        const v1 = d1.data.version_id;
        const a1 = d1.data.id;

        // T2-F8-02 & T2-F8-03: wrong status for schedule / unschedule -> 409
        assertErrorPayload(
          await request(`/api/versions/${v1}/schedule`, {
            method: 'POST',
            body: { scheduled_at: new Date(Date.now() + 60000).toISOString() },
            cookie: cookies.editor,
          }),
          409,
        );
        assertErrorPayload(
          await request(`/api/versions/${v1}/unschedule`, {
            method: 'POST',
            body: {},
            cookie: cookies.editor,
          }),
          409,
        );

        await request(`/api/versions/${v1}/submit`, {
          method: 'POST',
          body: {},
          cookie: cookies.author,
        });
        assertErrorPayload(
          await request(`/api/versions/${v1}/schedule`, {
            method: 'POST',
            body: { scheduled_at: new Date(Date.now() + 60000).toISOString() },
            cookie: cookies.editor,
          }),
          409,
        );
        await request(`/api/versions/${v1}/approve`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assertErrorPayload(
          await request(`/api/versions/${v1}/unschedule`, {
            method: 'POST',
            body: {},
            cookie: cookies.editor,
          }),
          409,
        );

        // T2-F8-01: invalid/past/missing scheduled_at -> 400
        for (const badBody of [
          {},
          { scheduled_at: 'not-a-date' },
          { scheduled_at: new Date(Date.now() - 60000).toISOString() },
          { scheduled_at: new Date(Date.now() - 1).toISOString() },
        ]) {
          assertErrorPayload(
            await request(`/api/versions/${v1}/schedule`, {
              method: 'POST',
              body: badBody,
              cookie: cookies.editor,
            }),
            400,
          );
        }

        // T1-F8-01: schedule valid future (+60s)
        const t1 = new Date(Date.now() + 60000).toISOString();
        const s1 = await request(`/api/versions/${v1}/schedule`, {
          method: 'POST',
          body: { scheduled_at: t1 },
          cookie: cookies.editor,
        });
        assert.equal(s1.status, 200);
        assert.equal(s1.data.ok, true);
        assert.equal(s1.data.version_id, v1);
        assert.equal(s1.data.status, 'scheduled');
        assert.equal(s1.data.scheduled_at, t1);
        const [dbS1] = await db.all(
          'SELECT status, scheduled_at, scheduled_by FROM article_versions WHERE id=$1',
          [v1],
        );
        assert.equal(dbS1.status, 'scheduled');
        assert.equal(dbS1.scheduled_at, t1);
        assert.equal(dbS1.scheduled_by, users.editor.id);
        const pubCheck = await request('/api/public/articles');
        assert.equal(
          pubCheck.data.some((x) => x.version_id === v1),
          false,
        );

        // T1-F8-02: reschedule (+120s)
        const t2 = new Date(Date.now() + 120000).toISOString();
        const s2 = await request(`/api/versions/${v1}/schedule`, {
          method: 'POST',
          body: { scheduled_at: t2 },
          cookie: cookies.editor,
        });
        assert.equal(s2.status, 200);
        assert.equal(s2.data.scheduled_at, t2);
        assert.equal(s2.data.status, 'scheduled');

        // T2-F8-05: scheduler/run when scheduled_at is in future (+120s) and another approved version exists -> count 0
        const { res: dApproved } = await createDraft(cookies.author, {
          title: 'Approved Not Scheduled',
        });
        const vApp = dApproved.data.version_id;
        await request(`/api/versions/${vApp}/submit`, {
          method: 'POST',
          body: {},
          cookie: cookies.author,
        });
        await request(`/api/versions/${vApp}/approve`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        const earlyRun = await request('/api/ops/scheduler/run', {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assert.equal(earlyRun.status, 200);
        assert.equal(earlyRun.data.count, 0);
        assert.deepEqual(earlyRun.data.published, []);

        // T1-F8-03: unschedule
        const un = await request(`/api/versions/${v1}/unschedule`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assert.equal(un.status, 200);
        assert.equal(un.data.status, 'approved');
        const [dbUn] = await db.all(
          'SELECT status, scheduled_at, scheduled_by FROM article_versions WHERE id=$1',
          [v1],
        );
        assert.equal(dbUn.status, 'approved');
        assert.equal(dbUn.scheduled_at, null);
        assert.equal(dbUn.scheduled_by, null);

        // T2-F8-04: reject scheduled clears scheduled_at & scheduled_by
        await request(`/api/versions/${v1}/schedule`, {
          method: 'POST',
          body: { scheduled_at: new Date(Date.now() + 60000).toISOString() },
          cookie: cookies.editor,
        });
        const rej = await request(`/api/versions/${v1}/reject`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assert.equal(rej.status, 200);
        const [dbRej] = await db.all(
          'SELECT status, scheduled_at, scheduled_by FROM article_versions WHERE id=$1',
          [v1],
        );
        assert.equal(dbRej.status, 'rejected');
        assert.equal(dbRej.scheduled_at, null);
        assert.equal(dbRej.scheduled_by, null);

        // T1-F8-04: schedule due soon -> wait -> ops/scheduler/run
        await request(`/api/versions/${v1}/submit`, {
          method: 'POST',
          body: {},
          cookie: cookies.author,
        });
        await request(`/api/versions/${v1}/approve`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        const dueTime = new Date(Date.now() + 1500).toISOString();
        assert.equal(
          (
            await request(`/api/versions/${v1}/schedule`, {
              method: 'POST',
              body: { scheduled_at: dueTime },
              cookie: cookies.editor,
            })
          ).status,
          200,
        );
        await delay(1650);
        const runDue = await request('/api/ops/scheduler/run', {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assert.equal(runDue.status, 200);
        assert.equal(runDue.data.count, 1);
        assert.ok(runDue.data.published.includes(v1));
        const pubs1 = await db.all('SELECT * FROM publications WHERE version_id=$1', [v1]);
        assert.equal(pubs1.length, 1);
        assert.ok((await request('/api/public/articles')).data.some((x) => x.version_id === v1));

        // T1-F8-05: direct publish on scheduled before due time
        assert.equal(
          (
            await request(`/api/versions/${vApp}/schedule`, {
              method: 'POST',
              body: { scheduled_at: new Date(Date.now() + 60000).toISOString() },
              cookie: cookies.editor,
            })
          ).status,
          200,
        );
        const directPub = await request(`/api/versions/${vApp}/publish`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assert.equal(directPub.status, 200);
        const [dbApp] = await db.all(
          'SELECT status, scheduled_at FROM article_versions WHERE id=$1',
          [vApp],
        );
        assert.equal(dbApp.status, 'published');
        assert.equal(dbApp.scheduled_at, null);
        const auditRows = await db.all('SELECT action FROM audit_events WHERE article_id=$1', [a1]);
        assert.ok(auditRows.some((r) => r.action === 'schedule'));
        assert.ok(auditRows.some((r) => r.action === 'unschedule'));
      },
    );

    // =========================================================================
    // F1 Tier 2 (Vietnamese diacritic case folding, NFD vs NFC, wildcard escaping, SQLi)
    // =========================================================================
    await t.test(
      'T2-F1-01..05: LIKE wildcard escaping, Vietnamese case/NFD, empty/missing, SQLi',
      async () => {
        const { res: dWild } = await createDraft(cookies.author, {
          title: 'Tỷ lệ đạt 100% và điểm_chuẩn\\2026',
          summary: 'Thông tin chính thức về ký tự đặc biệt trong tìm kiếm.',
        });
        await publishDraft(dWild.data.version_id);

        const { res: dUpper } = await createDraft(cookies.author, {
          title: 'ĐẠI HỌC Á CHÂU ÔN TẬP',
          summary: 'Bài kiểm tra chữ hoa tiếng Việt.',
        });
        await publishDraft(dUpper.data.version_id);

        const { res: dLower } = await createDraft(cookies.author, {
          title: 'đại học á châu ôn tập',
          summary: 'Bài kiểm tra chữ thường tiếng Việt.',
        });
        await publishDraft(dLower.data.version_id);

        // T2-F1-01: literal %, _, \
        for (const ch of ['%', '_', '\\']) {
          const r = await request(`/api/public/articles?q=${encodeURIComponent(ch)}`);
          assert.equal(r.status, 200);
          assert.ok(
            r.data.some((x) => x.id === dWild.data.id),
            `Query "${ch}" must match special-character article`,
          );
          assert.ok(
            r.data.every((x) => `${x.title} ${x.summary}`.includes(ch)),
            `Query "${ch}" leaked non-matching articles`,
          );
          if (!process.env.TEST_DATABASE_URL) {
            assert.equal(r.data.length, 1, `Query "${ch}" leaked ${r.data.length} results`);
          }
        }

        // T2-F1-02: Vietnamese diacritics case matrix
        for (const [qLow, qUp] of [
          ['đ', 'Đ'],
          ['á', 'Á'],
          ['ô', 'Ô'],
        ]) {
          const rLow = await request(`/api/public/articles?q=${encodeURIComponent(qLow)}`);
          const rUp = await request(`/api/public/articles?q=${encodeURIComponent(qUp)}`);
          assert.equal(rLow.status, 200);
          assert.equal(rUp.status, 200);
          if (supportsViLower) {
            assert.ok(
              rLow.data.some((x) => x.id === dUpper.data.id),
              `${qLow} must match uppercase Đ/Á/Ô`,
            );
          }
          assert.ok(
            rUp.data.some((x) => x.id === dLower.data.id),
            `${qUp} must match lowercase đ/á/ô`,
          );
        }

        // T2-F1-03: NFD vs NFC
        const nfc = await request(`/api/public/articles?q=${encodeURIComponent('Đào tạo')}`);
        const nfd = await request(
          `/api/public/articles?q=${encodeURIComponent('Đa\u0300o ta\u0323o')}`,
        );
        assert.equal(nfc.status, 200);
        assert.equal(nfd.status, 200);
        assert.deepEqual(
          nfd.data.map((x) => x.id),
          nfc.data.map((x) => x.id),
        );

        // T2-F1-04: unknown category & whitespace-only q
        const unknownCat = await request('/api/public/articles?category=nonexistent-cat');
        assert.equal(unknownCat.status, 200);
        assert.deepEqual(unknownCat.data, []);

        const allRes = await request('/api/public/articles');
        const wsRes = await request(`/api/public/articles?q=${encodeURIComponent('   ')}`);
        assert.equal(wsRes.status, 200);
        assert.equal(wsRes.data.length, allRes.data.length);

        // T2-F1-05: SQL injection payloads
        assert.deepEqual(
          (await request(`/api/public/articles?q=${encodeURIComponent("' OR 1=1 --")}`)).data,
          [],
        );
        assert.deepEqual(
          (await request(`/api/public/articles?category=${encodeURIComponent("' OR '1'='1")}`))
            .data,
          [],
        );
      },
    );

    // =========================================================================
    // Tier 3 Pairwise API Cases (T3-01, T3-02, T3-03 API, T3-04, T3-06, T3-07, T3-08, T3-11)
    // =========================================================================
    await t.test(
      'T3-01: Schedule -> reject -> revise -> approve -> reschedule -> scheduler/run invalidates ETag',
      async () => {
        const before = await request('/api/public/articles');
        const eBefore = before.headers.get('etag');
        assert.equal(
          (await request('/api/public/articles', { headers: { 'If-None-Match': eBefore } })).status,
          304,
        );

        const { res: d, payload } = await createDraft(cookies.author, { title: 'T3-01 Initial' });
        const v1 = d.data.version_id;
        await request(`/api/versions/${v1}/submit`, {
          method: 'POST',
          body: {},
          cookie: cookies.author,
        });
        await request(`/api/versions/${v1}/approve`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        await request(`/api/versions/${v1}/schedule`, {
          method: 'POST',
          body: { scheduled_at: new Date(Date.now() + 60000).toISOString() },
          cookie: cookies.editor,
        });
        await request(`/api/versions/${v1}/reject`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        await request(`/api/versions/${v1}`, {
          method: 'PUT',
          body: { ...payload, title: 'T3-01 Revised' },
          cookie: cookies.author,
        });
        await request(`/api/versions/${v1}/submit`, {
          method: 'POST',
          body: {},
          cookie: cookies.author,
        });
        await request(`/api/versions/${v1}/approve`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        await request(`/api/versions/${v1}/schedule`, {
          method: 'POST',
          body: { scheduled_at: new Date(Date.now() + 1500).toISOString() },
          cookie: cookies.editor,
        });
        await delay(1650);
        const runRes = await request('/api/ops/scheduler/run', {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assert.equal(runRes.status, 200);
        assert.ok(runRes.data.published.includes(v1));

        const after = await request('/api/public/articles', {
          headers: { 'If-None-Match': eBefore },
        });
        assert.equal(after.status, 200);
        assert.notEqual(after.headers.get('etag'), eBefore);
        assert.equal(
          (await db.all('SELECT * FROM publications WHERE version_id=$1', [v1])).length,
          1,
        );
        const [row] = await db.all('SELECT scheduled_at FROM article_versions WHERE id=$1', [v1]);
        assert.equal(row.scheduled_at, null);
      },
    );

    await t.test(
      'T3-02 & CH-G1: Deferred live category change on published revision and PUT /api/versions/:v2 until publish',
      async () => {
        const { res: d, payload } = await createDraft(cookies.author, {
          title: 'T3-02 Category Deferred',
          category_id: 'uth-news',
        });
        const v1 = d.data.version_id;
        const aid = d.data.id;
        await publishDraft(v1);
        const [artRow] = await db.all('SELECT slug FROM articles WHERE id=$1', [aid]);

        const eduBefore = await request('/api/public/articles?category=education');
        const etagEdu = eduBefore.headers.get('etag');
        assert.equal(
          eduBefore.data.some((x) => x.id === aid),
          false,
        );

        const rev = await request(`/api/versions/${v1}`, {
          method: 'PUT',
          body: { ...payload, title: 'T3-02 Moved to Education', category_id: 'education' },
          cookie: cookies.author,
        });
        const v2 = rev.data.version_id;
        assert.equal(
          (
            await request('/api/public/articles?category=education', {
              headers: { 'If-None-Match': etagEdu },
            })
          ).status,
          304,
        );

        // CH-G1 (Candidate B): PUT /api/versions/:v2 changing category_id to a 3rd category ('notices')
        const rev2 = await request(`/api/versions/${v2}`, {
          method: 'PUT',
          body: { ...payload, title: 'T3-02 Moved to Notices', category_id: 'notices' },
          cookie: cookies.author,
        });
        assert.equal(rev2.status, 200);
        assert.equal(
          (await request(`/api/public/articles/${artRow.slug}`)).data.category_id,
          'uth-news',
        );
        assert.equal(
          (
            await request('/api/public/articles?category=education', {
              headers: { 'If-None-Match': etagEdu },
            })
          ).status,
          304,
        );
        const noticesBefore = await request('/api/public/articles?category=notices');
        assert.equal(
          noticesBefore.data.some((x) => x.id === aid),
          false,
        );
        const edWhileDraft = await request('/api/editorial', { cookie: cookies.author });
        assert.equal(edWhileDraft.data.find((x) => x.id === v2)?.category_id, 'notices');

        await publishDraft(v2);
        const noticesAfter = await request('/api/public/articles?category=notices');
        assert.equal(noticesAfter.status, 200);
        assert.ok(noticesAfter.data.some((x) => x.id === aid));
        assert.equal(
          (await request(`/api/public/articles/${artRow.slug}`)).data.category_id,
          'notices',
        );
        const newsAfter = await request('/api/public/articles?category=uth-news');
        assert.equal(
          newsAfter.data.some((x) => x.id === aid),
          false,
        );
        const eduAfter = await request('/api/public/articles?category=education');
        assert.equal(
          eduAfter.data.some((x) => x.id === aid),
          false,
        );
        const [dbV1] = await db.all('SELECT status FROM article_versions WHERE id=$1', [v1]);
        assert.equal(dbV1.status, 'superseded');
      },
    );

    await t.test(
      'T3-03 (API) & CH-B3: Private /media/* access (403 unattached, 200 owner, 403 other author) -> 200 no-store upon publish',
      async () => {
        const up = await request('/api/uploads', {
          method: 'POST',
          rawBody: VALID_PNG,
          cookie: cookies.author,
        });
        assert.equal(up.status, 201);
        // CH-B3: unattached upload returns 403 even to uploader author
        assertErrorPayload(await request(up.data.url, { cookie: cookies.author }), 403);
        const { res: d } = await createDraft(cookies.author, { image: up.data.url });
        assert.equal((await request(up.data.url)).status, 401);
        assert.equal((await request(up.data.url, { cookie: cookies.reader })).status, 403);
        assert.equal((await request(up.data.url, { cookie: cookies.author2 })).status, 403);
        assert.equal((await request(up.data.url, { cookie: cookies.author })).status, 200);
        assert.equal((await request(up.data.url, { cookie: cookies.editor })).status, 200);
        await publishDraft(d.data.version_id);
        const pubImg = await request(up.data.url);
        assert.equal(pubImg.status, 200);
        assert.equal(pubImg.headers.get('cache-control'), 'no-store');
      },
    );

    await t.test(
      'T3-04: HEAD vs GET ETag/header parity on Vietnamese query & slug + 400 URIError',
      async () => {
        const qPath = `/api/public/articles?q=${encodeURIComponent('Đào tạo')}`;
        const gList = await request(qPath);
        const hList = await request(qPath, { method: 'HEAD' });
        assert.equal(hList.status, 200);
        assert.equal(hList.text, '');
        assert.equal(hList.headers.get('etag'), gList.headers.get('etag'));
        assert.equal(hList.headers.get('x-frame-options'), 'DENY');

        const sPath = '/api/public/articles/phuong-phap-giao-duc';
        const gSlug = await request(sPath);
        const hSlug = await request(sPath, { method: 'HEAD' });
        assert.equal(hSlug.status, 200);
        assert.equal(hSlug.text, '');
        assert.equal(hSlug.headers.get('etag'), gSlug.headers.get('etag'));

        assertErrorPayload(await request('/api/public/articles/%E0%A4%A'), 400);
      },
    );

    await t.test(
      'T3-06: Scheduling and unscheduling never leak or bust public ETag early',
      async () => {
        const { res: d } = await createDraft(cookies.author, { title: 'T3-06 Future Scheduled' });
        const vid = d.data.version_id;
        await request(`/api/versions/${vid}/submit`, {
          method: 'POST',
          body: {},
          cookie: cookies.author,
        });
        await request(`/api/versions/${vid}/approve`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });

        const baseFeed = await request('/api/public/articles');
        const etag = baseFeed.headers.get('etag');

        await request(`/api/versions/${vid}/schedule`, {
          method: 'POST',
          body: { scheduled_at: new Date(Date.now() + 60000).toISOString() },
          cookie: cookies.editor,
        });
        assert.equal(
          (await request('/api/public/articles', { headers: { 'If-None-Match': etag } })).status,
          304,
        );

        await request(`/api/versions/${vid}/unschedule`, {
          method: 'POST',
          body: {},
          cookie: cookies.editor,
        });
        assert.equal(
          (await request('/api/public/articles', { headers: { 'If-None-Match': etag } })).status,
          304,
        );
      },
    );

    await t.test(
      'T3-07: HEAD /api/history/:v1 RBAC (reader 403, owner author 200, other author 403, editor 200) & POST 405',
      async () => {
        const { res: d, payload } = await createDraft(cookies.author, {
          title: 'T3-07 History Head v1',
        });
        const v1 = d.data.version_id;
        await publishDraft(v1);
        const rev = await request(`/api/versions/${v1}`, {
          method: 'PUT',
          body: { ...payload, title: 'T3-07 History Head v2' },
          cookie: cookies.author,
        });
        await publishDraft(rev.data.version_id);

        assert.equal(
          (await request(`/api/history/${v1}`, { method: 'HEAD', cookie: cookies.reader })).status,
          403,
        );
        assert.equal(
          (await request(`/api/history/${v1}`, { method: 'HEAD', cookie: cookies.author2 })).status,
          403,
        );

        const hOwn = await request(`/api/history/${v1}`, {
          method: 'HEAD',
          cookie: cookies.author,
        });
        assert.equal(hOwn.status, 200);
        assert.equal(hOwn.text, '');
        assert.equal(hOwn.headers.get('cache-control'), 'no-store');

        const hEd = await request(`/api/history/${v1}`, { method: 'HEAD', cookie: cookies.editor });
        assert.equal(hEd.status, 200);
        assert.equal(hEd.text, '');

        assertErrorPayload(
          await request(`/api/history/${v1}`, { method: 'POST', body: {}, cookie: cookies.editor }),
          405,
        );
      },
    );

    await t.test(
      'T3-08: Untrimmed Vietnamese diacritics + 100% literal search after publish',
      async () => {
        const { res: d, payload } = await createDraft(cookies.author, {
          title: '  Đề án Ánh sáng Ôn tập 100%  ',
          summary: '  Tóm tắt đề án thử nghiệm.  ',
        });
        const vid = d.data.version_id;
        await request(`/api/versions/${vid}`, {
          method: 'PUT',
          body: { ...payload, title: '  Đề án Ánh sáng Ôn tập 100%  ' },
          cookie: cookies.author,
        });
        await publishDraft(vid);

        for (const q of ['đề án', 'ÁNH', '100%']) {
          const res = await request(`/api/public/articles?q=${encodeURIComponent(q)}`);
          assert.equal(res.status, 200);
          const matches = res.data.filter((x) => x.id === d.data.id);
          assert.equal(matches.length, 1, `Query ${q} should match published article`);
          assert.equal(matches[0].title, 'Đề án Ánh sáng Ôn tập 100%');
          assert.ok(
            res.data.every((x) =>
              `${x.title} ${x.summary} ${x.body}`
                .toLocaleLowerCase('vi')
                .includes(q.toLocaleLowerCase('vi')),
            ),
            `Query ${q} returned non-matching article`,
          );
        }
      },
    );

    await t.test(
      'T3-11 & Tier 4 Scenario 4 (Concurrency): Concurrent scheduler/run + publish produces exactly 1 publication row',
      async () => {
        const { res: dA } = await createDraft(cookies.author, { title: 'Concurrent Due A' });
        const { res: dB } = await createDraft(cookies.author, { title: 'Concurrent Due B' });
        const vA = dA.data.version_id;
        const vB = dB.data.version_id;
        for (const vid of [vA, vB]) {
          await request(`/api/versions/${vid}/submit`, {
            method: 'POST',
            body: {},
            cookie: cookies.author,
          });
          await request(`/api/versions/${vid}/approve`, {
            method: 'POST',
            body: {},
            cookie: cookies.editor,
          });
          await request(`/api/versions/${vid}/schedule`, {
            method: 'POST',
            body: { scheduled_at: new Date(Date.now() + 1500).toISOString() },
            cookie: cookies.editor,
          });
        }
        await delay(1650);

        const results = await Promise.all([
          request('/api/ops/scheduler/run', { method: 'POST', body: {}, cookie: cookies.editor }),
          request('/api/ops/scheduler/run', { method: 'POST', body: {}, cookie: cookies.editor }),
          request('/api/ops/scheduler/run', { method: 'POST', body: {}, cookie: cookies.editor }),
          request(`/api/versions/${vA}/publish`, {
            method: 'POST',
            body: {},
            cookie: cookies.editor,
          }),
          request(`/api/versions/${vA}/publish`, {
            method: 'POST',
            body: {},
            cookie: cookies.editor,
          }),
        ]);
        const reqIds = new Set();
        for (const r of results) {
          assert.equal(r.status, 200, `Concurrent request failed with ${r.status}: ${r.text}`);
          reqIds.add(r.headers.get('x-request-id'));
        }
        assert.equal(
          reqIds.size,
          results.length,
          'Each concurrent response must have a unique X-Request-ID',
        );

        for (const [vid, aid] of [
          [vA, dA.data.id],
          [vB, dB.data.id],
        ]) {
          const pubs = await db.all('SELECT * FROM publications WHERE version_id=$1', [vid]);
          assert.equal(pubs.length, 1, `Expected exactly 1 publication row for ${vid}`);
          const [art] = await db.all('SELECT published_version FROM articles WHERE id=$1', [aid]);
          assert.equal(art.published_version, vid);
          const [ver] = await db.all(
            'SELECT status, scheduled_at FROM article_versions WHERE id=$1',
            [vid],
          );
          assert.equal(ver.status, 'published');
          assert.equal(ver.scheduled_at, null);
        }
      },
    );
  } finally {
    await srv.cleanup();
  }
});

test('Auth Logout & Login Rate Limit / Malformed JSON / Payload Limit (T1-F5-04, T2-F5-05)', async (t) => {
  const srv = await spawnIsolatedServer({ seedSource: false, seedUsers: true });
  const { request, users } = srv;
  try {
    await t.test('T1-F5-04: Logout clears session cookie and revokes access', async () => {
      const { cookie } = await srv.login(users.editor.email);
      assert.equal((await request('/api/editorial', { cookie })).status, 200);
      const out = await request('/api/auth/logout', { method: 'POST', body: {}, cookie });
      assert.equal(out.status, 200);
      const me = await request('/api/auth/me', { cookie });
      assert.equal(me.status, 200);
      assert.equal(me.data.user, null);
      assertErrorPayload(await request('/api/editorial', { cookie }), 401);
    });

    await t.test(
      'T2-F5-05: Malformed JSON -> 400, oversized body -> 413, repeated bad logins -> 429',
      async () => {
        const badJson = await request('/api/auth/login', {
          method: 'POST',
          rawBody: '{',
          headers: { 'Content-Type': 'application/json' },
        });
        assertErrorPayload(badJson, 400);

        const bigBody = await request('/api/auth/login', {
          method: 'POST',
          rawBody: 'a'.repeat(100050),
          headers: { 'Content-Type': 'application/json' },
        });
        assertErrorPayload(bigBody, 413);

        let hit429 = false;
        for (let i = 0; i < 12; i++) {
          const res = await request('/api/auth/login', {
            method: 'POST',
            body: { email: users.reader.email, password: 'wrong-password-1234' },
          });
          if (res.status === 429) {
            assertErrorPayload(res, 429);
            hit429 = true;
            break;
          }
          assert.equal(res.status, 401);
        }
        assert.ok(hit429, 'Expected 429 rate limit after repeated failed login attempts');
      },
    );
  } finally {
    await srv.cleanup();
  }
});

async function startPublicReadOnlyServer() {
  if (process.env.TEST_DATABASE_URL && process.env.TEST_DB_SSL === 'true') {
    return spawnIsolatedServer({
      seedSource: true,
      seedUsers: true,
      extraEnv: {
        NODE_ENV: 'production',
        VERCEL: '1',
        PUBLIC_READ_ONLY: 'true',
        APP_ORIGIN: 'https://campus.uth.invalid',
        DB_SSL: process.env.TEST_DB_SSL || 'false',
      },
    });
  }

  const temp = await mkdtemp(join(tmpdir(), 'uth-upgrades-ro-'));
  const sqlitePath = join(temp, 'ro-test.db');
  const uploadPath = join(temp, 'uploads');

  const prevSqlite = process.env.SQLITE_PATH;
  const prevUpload = process.env.UPLOAD_PATH;
  const prevDbUrl = process.env.DATABASE_URL;
  const prevAppOrigin = process.env.APP_ORIGIN;

  process.env.SQLITE_PATH = sqlitePath;
  process.env.UPLOAD_PATH = uploadPath;
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    delete process.env.DATABASE_URL;
  }
  process.env.APP_ORIGIN = 'https://campus.uth.invalid';

  let db = null;
  let server = null;
  const runTag = randomUUID().slice(0, 8);
  const editorEmail = `editor-ro-${runTag}@test.invalid`;

  const cleanup = async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (db) await db.close();
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    if (prevUpload === undefined) delete process.env.UPLOAD_PATH;
    else process.env.UPLOAD_PATH = prevUpload;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    if (prevAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = prevAppOrigin;
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    db = await connect();
    await migrate(db);
    const snapshot = await readReviewedSource();
    await restoreReviewedSource(db, snapshot);
    await db.run(
      'INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING',
      [`u-editor-ro-${runTag}`, editorEmail, 'RO Editor', 'editor', hashPassword(randomUUID())],
    );

    const handler = createRequestHandler({
      db,
      production: true,
      publicReadOnly: true,
      uploadBucket: '',
    });
    server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const request = async (path, { method = 'GET', body, rawBody, headers = {}, cookie } = {}) => {
      const reqHeaders = { ...headers };
      if (cookie) reqHeaders.cookie = cookie;
      let payload;
      if (rawBody !== undefined) {
        payload = rawBody;
      } else if (body !== undefined) {
        reqHeaders['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + path, { method, headers: reqHeaders, body: payload });
      const text = await res.text();
      let data = null;
      const ctype = res.headers.get('content-type') || '';
      if (text.length > 0 && ctype.includes('application/json')) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      return { status: res.status, headers: res.headers, text, data };
    };

    return {
      users: { editor: { email: editorEmail } },
      request,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

test('PUBLIC_READ_ONLY Mode (T1-F5-05, T2-F5-03, T3-05, Scenario 4 Read-Only Drill)', async (t) => {
  const srv = await startPublicReadOnlyServer();
  const { request, users } = srv;
  try {
    await t.test(
      'T1-F5-05: PUBLIC_READ_ONLY public GET routes return 200 and authAvailable=false',
      async () => {
        const h = await request('/health');
        assert.equal(h.status, 200);
        const cfg = await request('/api/config');
        assert.equal(cfg.status, 200);
        assert.equal(cfg.data.authAvailable, false);
        assert.equal(cfg.data.localAuth, false);
        const pub = await request('/api/public/articles');
        assert.equal(pub.status, 200);
        assert.ok(pub.headers.get('etag'));
        assertPublicCacheHeaders(pub.headers);
        const mediaPrivate = await request('/media/00000000-0000-4000-8000-000000000001.png');
        assertErrorPayload(mediaPrivate, 401);
      },
    );

    await t.test(
      'T2-F5-03 & T3-05: All mutations return 503 no-store without Set-Cookie, private GETs 401',
      async () => {
        const forgedCookie = 'campus_session=forged-session-token';
        const mutHeaders = { Origin: 'https://campus.uth.invalid' };
        for (const [method, path, body] of [
          ['POST', '/api/auth/login', { email: users.editor.email, password: 'x' }],
          [
            'POST',
            '/api/articles',
            { title: 'x', summary: 'y', body: 'z', category_id: 'uth-news' },
          ],
          [
            'PUT',
            '/api/versions/x',
            { title: 'x', summary: 'y', body: 'z', category_id: 'uth-news' },
          ],
          [
            'POST',
            '/api/versions/x/schedule',
            { scheduled_at: new Date(Date.now() + 60000).toISOString() },
          ],
          ['POST', '/api/versions/x/unschedule', {}],
          ['POST', '/api/versions/x/publish', {}],
          ['POST', '/api/ops/scheduler/run', {}],
          ['POST', '/api/uploads', {}],
          ['POST', '/api/categories', { name: 'x' }],
        ]) {
          const res = await request(path, {
            method,
            body,
            headers: mutHeaders,
            cookie: forgedCookie,
          });
          assertErrorPayload(res, 503);
          assert.equal(res.headers.get('set-cookie'), null);
        }

        for (const path of ['/api/editorial', '/api/history', '/api/ops/metrics']) {
          assertErrorPayload(await request(path, { cookie: forgedCookie }), 401);
        }

        const me = await request('/api/auth/me', { cookie: forgedCookie });
        assert.equal(me.status, 200);
        assert.equal(me.data.user, null);
      },
    );
  } finally {
    await srv.cleanup();
  }
});

test('Tier 5 Adversarial Hardening: JSON null/non-object 400s, logout cookie boundary, local POST /api/users, uploads & background scheduler (CH-B1, CH-B2, CH-G3, CH-G4)', async (t) => {
  await t.test(
    'CH-B1 & CH-B2 & CH-G3 & CH-G4 (uploads): strict JSON object validation, origin drill guard, cookie boundary, user creation, upload formats/limits',
    async () => {
      const srv = await spawnIsolatedServer({ seedSource: false, seedUsers: true });
      const { request, users } = srv;
      try {
        const rLogin = await srv.login(users.reader.email);
        const aLogin = await srv.login(users.author.email);
        const eLogin = await srv.login(users.editor.email);

        const draftRes = await request('/api/articles', {
          method: 'POST',
          body: {
            title: 'Tier 5 draft',
            summary: 'Summary for Tier 5 draft',
            body: 'Body for Tier 5 draft',
            category_id: 'uth-news',
          },
          cookie: aLogin.cookie,
        });
        assert.equal(draftRes.status, 201);
        const draftVid = draftRes.data.version_id;

        const schedTarget = await request('/api/articles', {
          method: 'POST',
          body: {
            title: 'Tier 5 sched target',
            summary: 'Summary for schedule target',
            body: 'Body for schedule target',
            category_id: 'uth-news',
          },
          cookie: aLogin.cookie,
        });
        const approvedVid = schedTarget.data.version_id;
        assert.equal(
          (
            await request(`/api/versions/${approvedVid}/submit`, {
              method: 'POST',
              body: {},
              cookie: aLogin.cookie,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request(`/api/versions/${approvedVid}/approve`, {
              method: 'POST',
              body: {},
              cookie: eLogin.cookie,
            })
          ).status,
          200,
        );

        // CH-B1: null, [], "str", 123, true across all 8 JSON endpoints must return 400 (never 500 or 200/401)
        const nonObjectBodies = ['null', '[]', '"str"', '123', 'true'];
        const jsonEndpoints = [
          { path: '/api/auth/login', method: 'POST', cookie: undefined },
          { path: '/api/auth/password', method: 'POST', cookie: rLogin.cookie },
          { path: '/api/categories', method: 'POST', cookie: eLogin.cookie },
          { path: '/api/users', method: 'POST', cookie: eLogin.cookie },
          { path: '/api/ops/origin', method: 'POST', cookie: eLogin.cookie },
          { path: '/api/articles', method: 'POST', cookie: aLogin.cookie },
          { path: `/api/versions/${draftVid}`, method: 'PUT', cookie: aLogin.cookie },
          { path: `/api/versions/${approvedVid}/schedule`, method: 'POST', cookie: eLogin.cookie },
        ];
        for (const ep of jsonEndpoints) {
          for (const rawBody of nonObjectBodies) {
            const res = await request(ep.path, {
              method: ep.method,
              rawBody,
              headers: { 'Content-Type': 'application/json' },
              cookie: ep.cookie,
            });
            assertErrorPayload(res, 400);
          }
        }

        // CH-B1: /api/ops/origin rejects non-boolean available without resetting active 503 drill
        const downRes = await request('/api/ops/origin', {
          method: 'POST',
          body: { available: false },
          cookie: eLogin.cookie,
        });
        assert.equal(downRes.status, 200);
        assert.equal(downRes.data.originAvailable, false);
        assert.equal((await request('/api/public/articles')).status, 503);

        for (const badOriginBody of [{ available: 'false' }, { available: 0 }, {}]) {
          assertErrorPayload(
            await request('/api/ops/origin', {
              method: 'POST',
              body: badOriginBody,
              cookie: eLogin.cookie,
            }),
            400,
          );
        }
        assert.equal((await request('/api/public/articles')).status, 503);

        const upRes = await request('/api/ops/origin', {
          method: 'POST',
          body: { available: true },
          cookie: eLogin.cookie,
        });
        assert.equal(upRes.status, 200);
        assert.equal(upRes.data.originAvailable, true);
        assert.equal((await request('/api/public/articles')).status, 200);

        // CH-B2: decoy_*_campus_session cookie before real campus_session must still revoke real session
        const decoyLogout = await request('/api/auth/logout', {
          method: 'POST',
          body: {},
          cookie: `decoy_campus_session=fake123; ${aLogin.cookie}`,
        });
        assert.equal(decoyLogout.status, 200);
        const meAfterLogout = await request('/api/auth/me', { cookie: aLogin.cookie });
        assert.equal(meAfterLogout.status, 200);
        assert.equal(meAfterLogout.data.user, null);
        assertErrorPayload(await request('/api/editorial', { cookie: aLogin.cookie }), 401);

        // CH-G3: local SQLite POST /api/users (201 + login, 409 duplicate, 400 invalid fields)
        const newUserEmail = `NewAuthor-${randomUUID().slice(0, 6)}@UTH.Invalid`;
        const newUserPass = 'ValidPassphrase#2026!';
        assertErrorPayload(
          await request('/api/users', {
            method: 'POST',
            body: {
              email: newUserEmail,
              name: 'Reader Forbidden',
              role: 'author',
              password: newUserPass,
            },
            cookie: rLogin.cookie,
          }),
          403,
        );
        const createdUser = await request('/api/users', {
          method: 'POST',
          body: {
            email: `  ${newUserEmail}  `,
            name: '  Tác giả Tier 5  ',
            role: 'author',
            password: newUserPass,
          },
          cookie: eLogin.cookie,
        });
        assert.equal(createdUser.status, 201);
        assert.deepEqual(createdUser.data, { ok: true });

        const loginNewUser = await request('/api/auth/login', {
          method: 'POST',
          body: { email: newUserEmail.toLowerCase(), password: newUserPass },
        });
        assert.equal(loginNewUser.status, 200);
        assert.equal(loginNewUser.data.role, 'author');
        assert.equal(loginNewUser.data.name, 'Tác giả Tier 5');
        const newAuthorCookie = loginNewUser.headers.get('set-cookie').split(';')[0];

        assertErrorPayload(
          await request('/api/users', {
            method: 'POST',
            body: {
              email: newUserEmail.toUpperCase(),
              name: 'Dup User',
              role: 'author',
              password: newUserPass,
            },
            cookie: eLogin.cookie,
          }),
          409,
        );
        for (const badUser of [
          { email: 'not-an-email', name: 'A', role: 'author', password: newUserPass },
          { email: 'ok@uth.invalid', name: '   ', role: 'author', password: newUserPass },
          { email: 'ok@uth.invalid', name: 'A', role: 'superadmin', password: newUserPass },
          { email: 'ok@uth.invalid', name: 'A', role: 'author', password: 'short' },
        ]) {
          assertErrorPayload(
            await request('/api/users', { method: 'POST', body: badUser, cookie: eLogin.cookie }),
            400,
          );
        }

        // CH-G4 (uploads): JPEG, WebP, 0-byte (400), >5MB (413)
        const validJpeg = Buffer.from([
          0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
        ]);
        const upJpg = await request('/api/uploads', {
          method: 'POST',
          rawBody: validJpeg,
          cookie: newAuthorCookie,
        });
        assert.equal(upJpg.status, 201);
        assert.match(upJpg.data.url, /^\/media\/[a-f0-9-]+\.jpg$/);
        const getJpg = await request(upJpg.data.url, { cookie: eLogin.cookie });
        assert.equal(getJpg.status, 200);
        assert.equal(getJpg.headers.get('content-type'), 'image/jpeg');

        const validWebp = Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8 \x0e\x00\x00\x00', 'latin1');
        const upWebp = await request('/api/uploads', {
          method: 'POST',
          rawBody: validWebp,
          cookie: newAuthorCookie,
        });
        assert.equal(upWebp.status, 201);
        assert.match(upWebp.data.url, /^\/media\/[a-f0-9-]+\.webp$/);
        const getWebp = await request(upWebp.data.url, { cookie: eLogin.cookie });
        assert.equal(getWebp.status, 200);
        assert.equal(getWebp.headers.get('content-type'), 'image/webp');

        assertErrorPayload(
          await request('/api/uploads', {
            method: 'POST',
            rawBody: Buffer.alloc(0),
            cookie: newAuthorCookie,
          }),
          400,
        );
        assertErrorPayload(
          await request('/api/uploads', {
            method: 'POST',
            rawBody: Buffer.alloc(5 * 1024 * 1024 + 1, 0x41),
            cookie: newAuthorCookie,
          }),
          413,
        );
      } finally {
        await srv.cleanup();
      }
    },
  );

  await t.test(
    'CH-G4 (background scheduler): SCHEDULER_INTERVAL_MS auto-publishes due scheduled article',
    async () => {
      const srv = await spawnIsolatedServer({
        seedSource: false,
        seedUsers: true,
        extraEnv: { SCHEDULER_INTERVAL_MS: '150' },
      });
      const { request, db, users } = srv;
      try {
        const aLogin = await srv.login(users.author.email);
        const eLogin = await srv.login(users.editor.email);

        const created = await request('/api/articles', {
          method: 'POST',
          body: {
            title: 'Auto-published by standalone scheduler',
            summary: 'Background scheduler summary',
            body: 'Background scheduler body',
            category_id: 'uth-news',
          },
          cookie: aLogin.cookie,
        });
        assert.equal(created.status, 201);
        const vid = created.data.version_id;

        assert.equal(
          (
            await request(`/api/versions/${vid}/submit`, {
              method: 'POST',
              body: {},
              cookie: aLogin.cookie,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request(`/api/versions/${vid}/approve`, {
              method: 'POST',
              body: {},
              cookie: eLogin.cookie,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request(`/api/versions/${vid}/schedule`, {
              method: 'POST',
              body: { scheduled_at: new Date(Date.now() + 400).toISOString() },
              cookie: eLogin.cookie,
            })
          ).status,
          200,
        );

        let published = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const pubRes = await request('/api/public/articles');
          if (pubRes.data.some((a) => a.version_id === vid)) {
            published = true;
            break;
          }
          await delay(100);
        }
        assert.equal(published, true, 'Standalone scheduler must auto-publish due version');
        const pubs = await db.all('SELECT * FROM publications WHERE version_id=$1', [vid]);
        assert.equal(pubs.length, 1);
        const [ver] = await db.all(
          'SELECT status, scheduled_at FROM article_versions WHERE id=$1',
          [vid],
        );
        assert.equal(ver.status, 'published');
        assert.equal(ver.scheduled_at, null);
      } finally {
        await srv.cleanup();
      }
    },
  );
});
