import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { connect, migrate } from '../backend/db.mjs';
import { hashPassword } from '../backend/passwords.mjs';
import { createRequestHandler, resolveCognitoName } from '../backend/server.mjs';

// Test fixtures exist only in an isolated temporary database, never in app data.
test('editorial correctness, permissions, privacy and recovery', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'uth-test-'));
  process.env.SQLITE_PATH = join(temp, 'test.db');
  process.env.UPLOAD_PATH = join(temp, 'uploads');
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  else delete process.env.DATABASE_URL;
  const db = await connect();
  await migrate(db);
  const password = randomUUID();
  for (const role of ['reader', 'author', 'editor'])
    await db.run('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [
      `test-${role}`,
      `${role}@test.invalid`,
      role,
      role,
      hashPassword(password),
    ]);
  await db.run('INSERT INTO categories(id,name,color) VALUES($1,$2,$3)', [
    'test',
    'Test-only category',
    '#123456',
  ]);
  const child = spawn(process.execPath, ['backend/server.mjs'], {
    env: { ...process.env, PORT: '0', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let base;
  try {
    base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 15000);
      child.stdout.on('data', (b) => {
        const match = b.toString().match(/Campus News: (http:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited ${code}`));
      });
    });
    const rawCall = async (
      path,
      { method = 'GET', body, cookie, headers = {}, baseUrl = base } = {},
    ) => {
      const r = await fetch(baseUrl + path, {
        method,
        headers: {
          'X-Campus-Client': '1',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body:
          body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      return { status: r.status, text: await r.text(), headers: r.headers };
    };
    const call = async (path, method = 'GET', body, cookie) => {
      const r = await fetch(base + path, {
        method,
        headers: {
          'X-Campus-Client': '1',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, data: await r.json(), headers: r.headers };
    };
    const cookies = {};
    for (const role of ['reader', 'author', 'editor']) {
      const r = await call('/api/auth/login', 'POST', { email: `${role}@test.invalid`, password });
      assert.equal(r.status, 200);
      cookies[role] = r.headers.get('set-cookie').split(';')[0];
    }
    let version, article;
    await t.test('anonymous and reader cannot access editorial APIs', async () => {
      assert.equal((await call('/api/editorial')).status, 401);
      assert.equal((await call('/api/editorial', 'GET', undefined, cookies.reader)).status, 403);
      assert.equal(
        (await call('/api/articles', 'POST', { title: 'Forbidden' }, cookies.reader)).status,
        403,
      );
    });
    const draft = {
      title: 'Isolated integration test',
      summary: 'Private test-only summary',
      body: 'Private test-only content',
      category_id: 'test',
      image: '/assets/news/uth-2095.png',
    };
    await t.test('draft stays out of public pages and caches', async () => {
      const r = await call('/api/articles', 'POST', draft, cookies.author);
      assert.equal(r.status, 201);
      version = r.data.version_id;
      article = r.data.id;
      const list = await call('/api/public/articles');
      assert.equal(list.data.length, 0);
      const privateResponse = await call('/api/editorial', 'GET', undefined, cookies.author);
      assert.equal(privateResponse.headers.get('cache-control'), 'no-store');
      assert.ok(privateResponse.headers.get('x-request-id'));
    });
    await t.test('publish requires approval and editor role', async () => {
      assert.equal(
        (await call(`/api/versions/${version}/publish`, 'POST', {}, cookies.reader)).status,
        403,
      );
      assert.equal(
        (await call(`/api/versions/${version}/publish`, 'POST', {}, cookies.author)).status,
        403,
      );
      assert.equal(
        (await call(`/api/versions/${version}/publish`, 'POST', {}, cookies.editor)).status,
        409,
      );
      assert.equal(
        (await call(`/api/versions/${version}/submit`, 'POST', {}, cookies.author)).status,
        200,
      );
      assert.equal(
        (await call(`/api/versions/${version}/approve`, 'POST', {}, cookies.editor)).status,
        200,
      );
      assert.equal(
        (await call(`/api/versions/${version}/publish`, 'POST', {}, cookies.editor)).status,
        200,
      );
    });
    await t.test('publication is retry-safe and public cache TTL is bounded', async () => {
      await Promise.all([
        call(`/api/versions/${version}/publish`, 'POST', {}, cookies.editor),
        call(`/api/versions/${version}/publish`, 'POST', {}, cookies.editor),
      ]);
      const rows = await db.all('SELECT * FROM publications WHERE version_id=$1', [version]);
      assert.equal(rows.length, 1);
      const r = await call('/api/public/articles');
      assert.equal(r.data.length, 1);
      assert.match(r.headers.get('cache-control'), /s-maxage=30/);
      assert.equal(r.data[0].title, draft.title);
    });
    await t.test('editing published content creates a private new version', async () => {
      const r = await call(
        `/api/versions/${version}`,
        'PUT',
        { ...draft, title: 'Unapproved private revision' },
        cookies.author,
      );
      assert.equal(r.status, 200);
      assert.notEqual(r.data.version_id, version);
      assert.equal((await call('/api/public/articles')).data[0].title, draft.title);
      const original = await db.all('SELECT title,status FROM article_versions WHERE id=$1', [
        version,
      ]);
      assert.equal(original[0].status, 'published');
      assert.equal(original[0].title, draft.title);
    });
    await t.test(
      'publication snapshots require permission and retain the original version',
      async () => {
        assert.equal((await call(`/api/history/${version}`)).status, 401);
        assert.equal(
          (await call(`/api/history/${version}`, 'GET', undefined, cookies.reader)).status,
          403,
        );
        const snapshot = await call(`/api/history/${version}`, 'GET', undefined, cookies.editor);
        assert.equal(snapshot.status, 200);
        assert.equal(snapshot.data.title, draft.title);
        assert.equal(snapshot.data.id, version);
        assert.equal(snapshot.headers.get('cache-control'), 'no-store');
        const drafts = (await call('/api/editorial', 'GET', undefined, cookies.author)).data;
        assert.equal(
          (
            await call(
              `/api/history/${drafts.find((v) => v.status === 'draft').id}`,
              'GET',
              undefined,
              cookies.author,
            )
          ).status,
          404,
        );
      },
    );
    await t.test('invalid image and cross-origin mutations are rejected', async () => {
      const r = await fetch(base + '/api/uploads', {
        method: 'POST',
        headers: { cookie: cookies.author, 'X-Campus-Client': '1' },
        body: '<svg onload="alert(1)"></svg>',
      });
      assert.equal(r.status, 400);
      const cross = await fetch(base + '/api/articles', {
        method: 'POST',
        headers: {
          cookie: cookies.author,
          Origin: 'https://hostile.invalid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(draft),
      });
      assert.equal(cross.status, 403);
    });
    await t.test('private draft images cannot be read anonymously or by a reader', async () => {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2kAAAAASUVORK5CYII=',
        'base64',
      );
      const upload = await fetch(base + '/api/uploads', {
        method: 'POST',
        headers: { cookie: cookies.author, 'X-Campus-Client': '1' },
        body: png,
      });
      assert.equal(upload.status, 201);
      const { url } = await upload.json();
      const versions = await call('/api/editorial', 'GET', undefined, cookies.author);
      const revision = versions.data.find((v) => v.status === 'draft');
      assert.equal(
        (
          await call(
            `/api/versions/${revision.id}`,
            'PUT',
            { ...draft, image: url },
            cookies.author,
          )
        ).status,
        200,
      );
      assert.equal((await fetch(base + url)).status, 401);
      assert.equal((await fetch(base + url, { headers: { cookie: cookies.reader } })).status, 403);
      assert.equal((await fetch(base + url, { headers: { cookie: cookies.author } })).status, 200);
    });
    await t.test('password changes verify old password and revoke existing sessions', async () => {
      assert.equal(
        (
          await call(
            '/api/auth/password',
            'POST',
            { currentPassword: 'incorrect', newPassword: randomUUID() },
            cookies.reader,
          )
        ).status,
        400,
      );
      const replacement = randomUUID();
      assert.equal(
        (
          await call(
            '/api/auth/password',
            'POST',
            { currentPassword: password, newPassword: replacement },
            cookies.reader,
          )
        ).status,
        200,
      );
      assert.equal((await call('/api/auth/me', 'GET', undefined, cookies.reader)).data.user, null);
      assert.equal(
        (await call('/api/auth/login', 'POST', { email: 'reader@test.invalid', password })).status,
        401,
      );
      const reloginReader = await call('/api/auth/login', 'POST', {
        email: 'reader@test.invalid',
        password: replacement,
      });
      assert.equal(reloginReader.status, 200);
      cookies.reader = reloginReader.headers.get('set-cookie').split(';')[0];
    });
    await t.test('failure drill and recovery report actual responses', async () => {
      await call('/api/ops/origin', 'POST', { available: false }, cookies.editor);
      const down = await call('/api/public/articles');
      assert.equal(down.status, 503);
      assert.equal(down.headers.get('cache-control'), 'no-store');
      assert.equal((await call('/health')).status, 200);
      await call('/api/ops/origin', 'POST', { available: true }, cookies.editor);
      assert.equal((await call('/api/public/articles')).status, 200);
    });
    await t.test('logout revokes session', async () => {
      await call('/api/auth/logout', 'POST', {}, cookies.author);
      assert.equal((await call('/api/editorial', 'GET', undefined, cookies.author)).status, 401);
      const relogin = await call('/api/auth/login', 'POST', {
        email: 'author@test.invalid',
        password,
      });
      assert.equal(relogin.status, 200);
      cookies.author = relogin.headers.get('set-cookie').split(';')[0];
    });
    await t.test(
      'Bug #1: superseded published versions demoted & excluded from editorial',
      async () => {
        const editorialBefore = await call('/api/editorial', 'GET', undefined, cookies.editor);
        assert.equal(editorialBefore.status, 200);
        const rev = editorialBefore.data.find(
          (v) => v.article_id === article && v.status === 'draft',
        );
        assert.ok(rev);
        assert.equal(
          (await call(`/api/versions/${rev.id}/submit`, 'POST', {}, cookies.author)).status,
          200,
        );
        assert.equal(
          (await call(`/api/versions/${rev.id}/approve`, 'POST', {}, cookies.editor)).status,
          200,
        );
        assert.equal(
          (await call(`/api/versions/${rev.id}/publish`, 'POST', {}, cookies.editor)).status,
          200,
        );

        const dbVersions = await db.all(
          'SELECT id, status FROM article_versions WHERE article_id=$1',
          [article],
        );
        assert.equal(dbVersions.find((v) => v.id === version).status, 'superseded');
        assert.equal(dbVersions.find((v) => v.id === rev.id).status, 'published');
        const [artRow] = await db.all('SELECT published_version FROM articles WHERE id=$1', [
          article,
        ]);
        assert.equal(artRow.published_version, rev.id);

        const editorialAfter = await call('/api/editorial', 'GET', undefined, cookies.editor);
        assert.equal(
          editorialAfter.data.some((v) => v.id === version),
          false,
        );
        const activeItem = editorialAfter.data.find((v) => v.id === rev.id);
        assert.ok(activeItem);
        assert.equal(activeItem.published_version, rev.id);
        assert.equal(activeItem.category_id, 'test');

        const hist = await call('/api/history', 'GET', undefined, cookies.editor);
        assert.equal(hist.data.filter((p) => p.article_id === article).length, 2);
        assert.equal(
          (await call(`/api/history/${version}`, 'GET', undefined, cookies.editor)).status,
          200,
        );
        assert.equal(
          (
            await call(
              `/api/versions/${version}`,
              'PUT',
              { ...draft, title: 'Resurrect?' },
              cookies.editor,
            )
          ).status,
          409,
        );
        version = rev.id;
      },
    );
    await t.test('Bug #4: Vietnamese diacritics and LIKE wildcard escaping', async () => {
      const a1 = await call(
        '/api/articles',
        'POST',
        {
          title: 'Đoàn trường tổ chức Ánh sáng Ôn tập 100% _exact\\path',
          summary: 'Thông báo dành cho sinh viên tham gia',
          body: 'Nội dung chi tiết',
          category_id: 'test',
        },
        cookies.author,
      );
      const a2 = await call(
        '/api/articles',
        'POST',
        {
          title: 'Tin khác về atest 200',
          summary: 'Tóm tắt thường',
          body: 'Nội dung khác',
          category_id: 'test',
        },
        cookies.author,
      );
      for (const vid of [a1.data.version_id, a2.data.version_id]) {
        await call(`/api/versions/${vid}/submit`, 'POST', {}, cookies.author);
        await call(`/api/versions/${vid}/approve`, 'POST', {}, cookies.editor);
        await call(`/api/versions/${vid}/publish`, 'POST', {}, cookies.editor);
      }
      for (const q of ['đoàn', 'ĐOÀN', 'ánh', 'ÁNH', 'ôn', 'ÔN', '100%', '_exact', '\\path']) {
        const res = await call(`/api/public/articles?q=${encodeURIComponent(q)}`);
        assert.equal(res.status, 200, q);
        assert.equal(res.data.length, 1, `query=${q}`);
        assert.equal(res.data[0].version_id, a1.data.version_id, `query=${q}`);
      }
      const noMatch = await call(`/api/public/articles?q=${encodeURIComponent('_test')}`);
      assert.equal(noMatch.status, 200);
      assert.equal(noMatch.data.length, 0);
    });
    await t.test('Bug #5: malformed URI encoding returns 400 JSON instead of 500', async () => {
      for (const [path, method, body, cookie] of [
        ['/api/public/articles/%E0%A4%A', 'GET', undefined, undefined],
        ['/api/public/articles/%ZZ', 'GET', undefined, undefined],
        ['/api/history/%ZZ', 'GET', undefined, cookies.editor],
        ['/%E0%A4%A', 'GET', undefined, undefined],
        ['/assets/%ZZ', 'GET', undefined, undefined],
        ['/api/versions/%ZZ', 'PUT', draft, cookies.editor],
      ]) {
        const r = await rawCall(path, { method, body, cookie });
        assert.equal(r.status, 400, path);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        const parsed = JSON.parse(r.text);
        assert.ok(parsed.requestId);
      }
    });
    await t.test(
      'Bug #6 & latent: 405 methods, HEAD empty body, prefix guard, EISDIR, X-Frame-Options',
      async () => {
        const publicList = await call('/api/public/articles');
        const slug = publicList.data[0].slug;
        const vid = publicList.data[0].version_id;
        for (const [path, methods, cookie] of [
          ['/health', ['POST', 'PUT', 'DELETE'], undefined],
          ['/api/config', ['POST', 'PUT', 'DELETE'], undefined],
          ['/api/auth/me', ['POST', 'PUT', 'DELETE'], undefined],
          ['/api/categories', ['PUT', 'DELETE'], cookies.editor],
          ['/api/public/articles', ['POST', 'PUT', 'DELETE'], undefined],
          [`/api/public/articles/${slug}`, ['POST', 'PUT', 'DELETE'], undefined],
          ['/api/editorial', ['POST', 'PUT', 'DELETE'], cookies.editor],
          ['/api/history', ['POST', 'PUT', 'DELETE'], cookies.editor],
          [`/api/history/${vid}`, ['POST', 'PUT', 'DELETE'], cookies.editor],
          ['/api/ops/metrics', ['POST', 'PUT', 'DELETE'], cookies.editor],
          ['/media/00000000-0000-4000-8000-000000000000.png', ['POST', 'PUT', 'DELETE'], undefined],
          ['/', ['POST', 'PUT', 'DELETE'], undefined],
        ]) {
          for (const method of methods) {
            const r = await rawCall(path, {
              method,
              body: method === 'DELETE' ? undefined : {},
              cookie,
            });
            assert.equal(r.status, 405, `${method} ${path}`);
            assert.equal(r.headers.get('x-frame-options'), 'DENY');
          }
        }
        assert.equal(
          (
            await rawCall(`/api/versions/${vid}`, {
              method: 'POST',
              body: draft,
              cookie: cookies.editor,
            })
          ).status,
          405,
        );
        assert.equal(
          (
            await rawCall(`/api/versions/${vid}/publish`, {
              method: 'PUT',
              body: {},
              cookie: cookies.editor,
            })
          ).status,
          405,
        );
        assert.equal(
          (
            await rawCall(`/api/versions/${vid}/schedule`, {
              method: 'PUT',
              body: {},
              cookie: cookies.editor,
            })
          ).status,
          405,
        );

        const mediaKey = publicList.data.find((x) => x.image.startsWith('/media/'))?.image;
        for (const [path, cookie] of [
          ['/api/editorial', cookies.editor],
          [`/api/history/${vid}`, cookies.editor],
          ['/api/public/articles', undefined],
          [`/api/public/articles/${slug}`, undefined],
          ['/api/categories', undefined],
          ...(mediaKey ? [[mediaKey, undefined]] : []),
          ['/', undefined],
        ]) {
          const r = await rawCall(path, { method: 'HEAD', cookie });
          assert.equal(r.status, 200, `HEAD ${path}`);
          assert.equal(r.text, '', `HEAD ${path} body`);
          assert.equal(r.headers.get('x-frame-options'), 'DENY');
          assert.ok(r.headers.get('x-request-id'));
        }

        const beforeMetrics = await call('/api/ops/metrics', 'GET', undefined, cookies.editor);
        for (const badPublic of [
          '/api/public/foo',
          '/api/public/articles/',
          '/api/public/articles/a/b',
        ]) {
          const r = await rawCall(badPublic);
          assert.equal(r.status, 404, badPublic);
        }
        const afterMetrics = await call('/api/ops/metrics', 'GET', undefined, cookies.editor);
        assert.equal(afterMetrics.data.publicReads, beforeMetrics.data.publicReads);

        for (const dirPath of ['/assets/', '/js/']) {
          const r = await rawCall(dirPath);
          assert.equal(r.status, 404, dirPath);
          assert.equal(r.headers.get('cache-control'), 'no-store');
        }
      },
    );
    await t.test('Bug #7: draft category_id, trimming, image clearing & status locks', async () => {
      const cat2Res = await call(
        '/api/categories',
        'POST',
        { name: '  Danh mục mới  ' },
        cookies.editor,
      );
      assert.equal(cat2Res.status, 201);
      const cat2 = cat2Res.data.id;

      const created = await call('/api/articles', 'POST', draft, cookies.author);
      assert.equal(created.status, 201);
      const draftId = created.data.version_id;
      const artId = created.data.id;

      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2kAAAAASUVORK5CYII=',
        'base64',
      );
      const up = await fetch(base + '/api/uploads', {
        method: 'POST',
        headers: { cookie: cookies.author, 'X-Campus-Client': '1' },
        body: png,
      });
      const { url: imgUrl } = await up.json();

      // Trimmed 180-char boundary passes, 181 fails, whitespace fails
      const title180 = `  ${'A'.repeat(180)}  `;
      const updateOk = await call(
        `/api/versions/${draftId}`,
        'PUT',
        {
          title: title180,
          summary: '  Tóm tắt đã cắt khoảng trắng  ',
          body: '  Nội dung đã cắt khoảng trắng  ',
          category_id: `  ${cat2}  `,
          image: imgUrl,
        },
        cookies.author,
      );
      assert.equal(updateOk.status, 200);
      const [artAfter] = await db.all('SELECT category_id FROM articles WHERE id=$1', [artId]);
      assert.equal(artAfter.category_id, cat2);
      const [verAfter] = await db.all(
        'SELECT title,summary,body,image,category_id FROM article_versions WHERE id=$1',
        [draftId],
      );
      assert.equal(verAfter.title.length, 180);
      assert.equal(verAfter.summary, 'Tóm tắt đã cắt khoảng trắng');
      assert.equal(verAfter.image, imgUrl);
      assert.equal(verAfter.category_id, cat2);

      // Omitting image preserves existing image; image: '' clears it
      assert.equal(
        (
          await call(
            `/api/versions/${draftId}`,
            'PUT',
            { title: 'Giữ ảnh', summary: 'Tóm tắt', body: 'Nội dung', category_id: cat2 },
            cookies.author,
          )
        ).status,
        200,
      );
      assert.equal(
        (await db.all('SELECT image FROM article_versions WHERE id=$1', [draftId]))[0].image,
        imgUrl,
      );

      assert.equal(
        (
          await call(
            `/api/versions/${draftId}`,
            'PUT',
            {
              title: 'Xóa ảnh',
              summary: 'Tóm tắt',
              body: 'Nội dung',
              category_id: cat2,
              image: '',
            },
            cookies.author,
          )
        ).status,
        200,
      );
      assert.equal(
        (await db.all('SELECT image FROM article_versions WHERE id=$1', [draftId]))[0].image,
        '',
      );

      assert.equal(
        (
          await call(
            `/api/versions/${draftId}`,
            'PUT',
            {
              title: ` ${'B'.repeat(181)} `,
              summary: 'Tóm tắt',
              body: 'Nội dung',
              category_id: cat2,
            },
            cookies.author,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            `/api/versions/${draftId}`,
            'PUT',
            { title: '   ', summary: 'Tóm tắt', body: 'Nội dung', category_id: cat2 },
            cookies.author,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            `/api/versions/${draftId}`,
            'PUT',
            { title: 'Valid', summary: 'Tóm tắt', body: 'Nội dung', category_id: 'missing-cat' },
            cookies.author,
          )
        ).status,
        400,
      );

      // Published revision defers live articles.category_id until publish
      await call(`/api/versions/${draftId}/submit`, 'POST', {}, cookies.author);
      assert.equal(
        (
          await call(
            `/api/versions/${draftId}`,
            'PUT',
            { ...draft, category_id: cat2 },
            cookies.author,
          )
        ).status,
        409,
      );
      await call(`/api/versions/${draftId}/approve`, 'POST', {}, cookies.editor);
      assert.equal(
        (
          await call(
            `/api/versions/${draftId}`,
            'PUT',
            { ...draft, category_id: cat2 },
            cookies.author,
          )
        ).status,
        409,
      );
      await call(`/api/versions/${draftId}/publish`, 'POST', {}, cookies.editor);

      const pubSlug = (await call('/api/public/articles')).data.find((x) => x.id === artId).slug;
      const revRes = await call(
        `/api/versions/${draftId}`,
        'PUT',
        { ...draft, title: 'Đổi danh mục chờ xuất bản', category_id: 'test' },
        cookies.author,
      );
      assert.equal(revRes.status, 200);
      assert.equal((await call(`/api/public/articles/${pubSlug}`)).data.category_id, cat2);
      const edRows = await call('/api/editorial', 'GET', undefined, cookies.author);
      assert.equal(edRows.data.find((x) => x.id === revRes.data.version_id).category_id, 'test');
      await call(`/api/versions/${revRes.data.version_id}/submit`, 'POST', {}, cookies.author);
      await call(`/api/versions/${revRes.data.version_id}/approve`, 'POST', {}, cookies.editor);
      await call(`/api/versions/${revRes.data.version_id}/publish`, 'POST', {}, cookies.editor);
      assert.equal((await call(`/api/public/articles/${pubSlug}`)).data.category_id, 'test');
    });
    await t.test('R2: scheduled publication RBAC, lifecycle & concurrent idempotency', async () => {
      const created = await call(
        '/api/articles',
        'POST',
        { ...draft, title: 'Bài viết hẹn giờ xuất bản' },
        cookies.author,
      );
      const vid = created.data.version_id;
      const artId = created.data.id;
      const future1 = new Date(Date.now() + 60000).toISOString();
      const future2 = new Date(Date.now() + 120000).toISOString();
      const past = new Date(Date.now() - 60000).toISOString();

      // Cannot schedule before approved, or as non-editor, or with invalid/past date
      assert.equal(
        (await call(`/api/versions/${vid}/schedule`, 'POST', { scheduled_at: future1 })).status,
        401,
      );
      assert.equal(
        (
          await call(
            `/api/versions/${vid}/schedule`,
            'POST',
            { scheduled_at: future1 },
            cookies.reader,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            `/api/versions/${vid}/schedule`,
            'POST',
            { scheduled_at: future1 },
            cookies.author,
          )
        ).status,
        403,
      );
      for (const badAuthorSchedule of ['not-a-date', '2027-02-30T00:00:00Z']) {
        assert.equal(
          (
            await call(
              `/api/versions/${vid}/schedule`,
              'POST',
              { scheduled_at: badAuthorSchedule },
              cookies.author,
            )
          ).status,
          403,
        );
      }
      assert.equal(
        (
          await call(
            `/api/versions/${vid}/schedule`,
            'POST',
            { scheduled_at: future1 },
            cookies.editor,
          )
        ).status,
        409,
      );

      await call(`/api/versions/${vid}/submit`, 'POST', {}, cookies.author);
      await call(`/api/versions/${vid}/approve`, 'POST', {}, cookies.editor);
      assert.equal(
        (
          await call(
            `/api/versions/${vid}/schedule`,
            'POST',
            { scheduled_at: past },
            cookies.editor,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            `/api/versions/${vid}/schedule`,
            'POST',
            { scheduled_at: '2026-01-01T00:00:00' },
            cookies.editor,
          )
        ).status,
        400,
      );
      for (const badCalendarDate of [
        '2027-02-30T00:00:00Z',
        '2027-04-31T00:00:00Z',
        '2027-02-29T00:00:00Z',
        '2027-01-01T24:00:00Z',
        '2100-02-29T00:00:00Z',
        '2027-01-01T00:60:00Z',
        '2027-01-01T00:00:60Z',
        '2027-01-01T00:00:00+00:60',
      ]) {
        const badRes = await call(
          `/api/versions/${vid}/schedule`,
          'POST',
          { scheduled_at: badCalendarDate },
          cookies.editor,
        );
        assert.equal(badRes.status, 400, badCalendarDate);
        assert.equal(badRes.data.error, 'Thời gian hẹn giờ không hợp lệ', badCalendarDate);
      }

      const leapTzSched = await call(
        `/api/versions/${vid}/schedule`,
        'POST',
        { scheduled_at: '2028-02-29T07:00:00+07:00' },
        cookies.editor,
      );
      assert.equal(leapTzSched.status, 200);
      assert.equal(leapTzSched.data.scheduled_at, '2028-02-29T00:00:00.000Z');
      const leapUtcSched = await call(
        `/api/versions/${vid}/schedule`,
        'POST',
        { scheduled_at: '2028-02-29T00:00:00Z' },
        cookies.editor,
      );
      assert.equal(leapUtcSched.status, 200);
      assert.equal(leapUtcSched.data.scheduled_at, '2028-02-29T00:00:00.000Z');

      const sched = await call(
        `/api/versions/${vid}/schedule`,
        'POST',
        { scheduled_at: future1 },
        cookies.editor,
      );
      assert.equal(sched.status, 200);
      assert.equal(sched.data.status, 'scheduled');
      assert.equal(sched.data.scheduled_at, future1);

      // Reschedule & locked PUT
      const resched = await call(
        `/api/versions/${vid}/schedule`,
        'POST',
        { scheduled_at: future2 },
        cookies.editor,
      );
      assert.equal(resched.status, 200);
      assert.equal(resched.data.scheduled_at, future2);
      assert.equal((await call(`/api/versions/${vid}`, 'PUT', draft, cookies.editor)).status, 409);

      // Unschedule & reject clears scheduled_at
      assert.equal(
        (await call(`/api/versions/${vid}/unschedule`, 'POST', {}, cookies.author)).status,
        403,
      );
      const unsched = await call(`/api/versions/${vid}/unschedule`, 'POST', {}, cookies.editor);
      assert.equal(unsched.status, 200);
      assert.equal(unsched.data.status, 'approved');
      assert.equal(
        (await call(`/api/versions/${vid}/unschedule`, 'POST', {}, cookies.editor)).status,
        409,
      );
      const rowAfterUnsched = (
        await db.all('SELECT scheduled_at,scheduled_by FROM article_versions WHERE id=$1', [vid])
      )[0];
      assert.equal(rowAfterUnsched.scheduled_at, null);
      assert.equal(rowAfterUnsched.scheduled_by, null);

      await call(
        `/api/versions/${vid}/schedule`,
        'POST',
        { scheduled_at: future1 },
        cookies.editor,
      );
      assert.equal(
        (await call(`/api/versions/${vid}/reject`, 'POST', {}, cookies.editor)).status,
        200,
      );
      const rowAfterReject = (
        await db.all('SELECT status,scheduled_at,scheduled_by FROM article_versions WHERE id=$1', [
          vid,
        ])
      )[0];
      assert.equal(rowAfterReject.status, 'rejected');
      assert.equal(rowAfterReject.scheduled_at, null);

      // Re-approve & schedule slightly in future, run scheduler early (0), then make due & run concurrently
      await call(`/api/versions/${vid}/submit`, 'POST', {}, cookies.author);
      await call(`/api/versions/${vid}/approve`, 'POST', {}, cookies.editor);
      const nearFuture = new Date(Date.now() + 250).toISOString();
      await call(
        `/api/versions/${vid}/schedule`,
        'POST',
        { scheduled_at: nearFuture },
        cookies.editor,
      );
      assert.equal((await call('/api/ops/scheduler/run', 'POST', {}, cookies.author)).status, 403);
      const earlyRun = await call('/api/ops/scheduler/run', 'POST', {}, cookies.editor);
      assert.equal(earlyRun.data.count, 0);

      await new Promise((r) => setTimeout(r, 320));
      const [r1, r2, r3] = await Promise.all([
        call('/api/ops/scheduler/run', 'POST', {}, cookies.editor),
        call('/api/ops/scheduler/run', 'POST', {}, cookies.editor),
        call(`/api/versions/${vid}/publish`, 'POST', {}, cookies.editor),
      ]);
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(r3.status, 200);
      assert.equal(
        (await db.all('SELECT * FROM publications WHERE version_id=$1', [vid])).length,
        1,
      );
      const pubVer = (
        await db.all('SELECT status,scheduled_at,scheduled_by FROM article_versions WHERE id=$1', [
          vid,
        ])
      )[0];
      assert.equal(pubVer.status, 'published');
      assert.equal(pubVer.scheduled_at, null);
      assert.equal(
        (await db.all('SELECT published_version FROM articles WHERE id=$1', [artId]))[0]
          .published_version,
        vid,
      );
      const auditPub = await db.all(
        "SELECT request_id FROM audit_events WHERE article_id=$1 AND action='publish'",
        [artId],
      );
      assert.ok(auditPub.length >= 1 && auditPub[0].request_id);
      const nextRun = await call('/api/ops/scheduler/run', 'POST', {}, cookies.editor);
      assert.deepEqual(nextRun.data, { ok: true, count: 0, published: [] });
    });
    await t.test('R2: ETag / If-None-Match 304 and cache header isolation', async () => {
      const list = await rawCall('/api/public/articles');
      const listEtag = list.headers.get('etag');
      assert.ok(listEtag?.startsWith('"'));
      assert.equal(
        list.headers.get('cache-control'),
        'public, max-age=0, s-maxage=30, must-revalidate',
      );
      const articles = JSON.parse(list.text);
      const firstSlug = articles[0].slug;

      for (const path of [
        '/api/public/articles',
        `/api/public/articles/${firstSlug}`,
        '/api/categories',
      ]) {
        const res200 = await rawCall(path);
        const tag = res200.headers.get('etag');
        assert.ok(tag, path);
        for (const inm of [tag, `W/${tag}`, `"other", ${tag}`, '*']) {
          for (const method of ['GET', 'HEAD']) {
            const res304 = await rawCall(path, { method, headers: { 'If-None-Match': inm } });
            assert.equal(res304.status, 304, `${method} ${path} ${inm}`);
            assert.equal(res304.text, '');
            assert.equal(res304.headers.get('etag'), tag);
            assert.equal(
              res304.headers.get('cache-control'),
              'public, max-age=0, s-maxage=30, must-revalidate',
            );
            assert.equal(res304.headers.get('x-frame-options'), 'DENY');
            assert.ok(res304.headers.get('x-request-id'));
          }
        }
        const stale = await rawCall(path, { headers: { 'If-None-Match': '"stale-tag"' } });
        assert.equal(stale.status, 200);
      }

      const catBefore = (await rawCall('/api/categories')).headers.get('etag');
      await call('/api/categories', 'POST', { name: 'Danh mục ETag' }, cookies.editor);
      assert.equal(
        (await rawCall('/api/categories', { headers: { 'If-None-Match': catBefore } })).status,
        200,
      );

      // Private endpoints & 503 origin drill must never return 304 or public cache headers
      for (const [path, cookie] of [
        ['/api/editorial', cookies.editor],
        ['/api/history', cookies.editor],
        ['/api/auth/me', cookies.editor],
        ['/api/ops/metrics', cookies.editor],
      ]) {
        const r = await rawCall(path, { cookie, headers: { 'If-None-Match': '*' } });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('cache-control'), 'no-store');
      }
      await call('/api/ops/origin', 'POST', { available: false }, cookies.editor);
      const drill = await rawCall('/api/public/articles', {
        headers: { 'If-None-Match': listEtag },
      });
      assert.equal(drill.status, 503);
      assert.equal(drill.headers.get('cache-control'), 'no-store');
      await call('/api/ops/origin', 'POST', { available: true }, cookies.editor);
    });
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    await db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Bug #2: Cognito display name resolution, TTL cache, AdminGetUser, no UUID leakage & AdminCreateUser', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'uth-cognito-'));
  let db, appServer, mockServer;
  try {
    const dbPath = join(temp, 'cognito.db');
    process.env.SQLITE_PATH = dbPath;
    delete process.env.DATABASE_URL;
    db = await connect();
    await migrate(db);
    await db.run('INSERT INTO categories(id,name,color) VALUES($1,$2,$3)', [
      'cat-1',
      'Tin tức',
      '#018486',
    ]);

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    let userInfoMode = 'ok';
    let userInfoHits = 0;
    mockServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ keys: [jwk] }));
      }
      if (req.url === '/oauth2/userInfo') {
        userInfoHits++;
        if (userInfoMode === 'error') {
          res.writeHead(500);
          return res.end('error');
        }
        if (userInfoMode === 'uuid') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ name: '11111111-2222-4333-8444-555555555555' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ name: 'Trần Thị B', email: 'b@uth.invalid' }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const mockBase = `http://127.0.0.1:${mockServer.address().port}`;
    const jwks = createRemoteJWKSet(new URL(`${mockBase}/.well-known/jwks.json`));

    const sentCommands = [];
    let adminGetMode = 'ok';
    const cognitoClient = {
      send: async (cmd) => {
        sentCommands.push(cmd);
        if (cmd.constructor.name === 'AdminGetUserCommand') {
          if (adminGetMode === 'fail') throw new Error('boom');
          return {
            UserAttributes: [
              { Name: 'name', Value: 'Lê Văn C' },
              { Name: 'email', Value: 'c@uth.invalid' },
            ],
          };
        }
        return {};
      },
    };

    let fakeNow = 1_700_000_000_000;
    const cognitoProfiles = new Map();
    const handler = createRequestHandler({
      db,
      production: true,
      publicReadOnly: false,
      uploadBucket: 'test-bucket',
      jwtVerify,
      jwks,
      cognitoIssuer: mockBase,
      cognitoClientId: 'client-123',
      cognitoDomain: mockBase,
      cognitoClient,
      cognitoProfiles,
      now: () => fakeNow,
    });
    appServer = http.createServer(handler);
    await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
    const appBase = `http://127.0.0.1:${appServer.address().port}`;

    const signAccess = async (claims) =>
      new SignJWT({
        token_use: 'access',
        client_id: 'client-123',
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuer(mockBase)
        .setSubject(claims.sub)
        .setExpirationTime('1h')
        .sign(privateKey);

    // 1. Direct name claim skips userInfo & AdminGetUser
    const tokClaim = await signAccess({
      sub: 'sub-claim',
      username: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      name: 'Nguyễn Văn A',
      'cognito:groups': ['editor'],
    });
    const me1 = await (
      await fetch(`${appBase}/api/auth/me`, { headers: { Authorization: `Bearer ${tokClaim}` } })
    ).json();
    assert.equal(me1.user.name, 'Nguyễn Văn A');
    assert.equal(userInfoHits, 0);
    assert.equal(sentCommands.length, 0);

    // 2. Missing name claim -> /oauth2/userInfo + TTL cache + author_name
    const tokInfo = await signAccess({
      sub: 'sub-info',
      username: '11111111-2222-4333-8444-555555555555',
      'cognito:groups': ['editor'],
    });
    const me2 = await (
      await fetch(`${appBase}/api/auth/me`, { headers: { Authorization: `Bearer ${tokInfo}` } })
    ).json();
    assert.equal(me2.user.name, 'Trần Thị B');
    assert.equal(userInfoHits, 1);

    const artRes = await fetch(`${appBase}/api/articles`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokInfo}`,
        'Content-Type': 'application/json',
        Origin: appBase,
      },
      body: JSON.stringify({
        title: 'Bài viết Cognito',
        summary: 'Tóm tắt Cognito',
        body: 'Nội dung Cognito',
        category_id: 'cat-1',
      }),
    });
    // APP_ORIGIN isn't set so expected is http://host === appBase
    assert.equal(artRes.status, 201);
    const createdArt = await artRes.json();
    const [storedArt] = await db.all('SELECT author_name FROM articles WHERE id=$1', [
      createdArt.id,
    ]);
    assert.equal(storedArt.author_name, 'Trần Thị B');
    assert.equal(userInfoHits, 1); // Cached!

    fakeNow += 5 * 60 * 1000 + 1;
    await fetch(`${appBase}/api/auth/me`, { headers: { Authorization: `Bearer ${tokInfo}` } });
    assert.equal(userInfoHits, 2);

    // 3. /oauth2/userInfo 500 -> AdminGetUserCommand fallback
    userInfoMode = 'error';
    const tokAdmin = await signAccess({
      sub: 'sub-admin-get',
      username: '22222222-3333-4444-8555-666666666666',
      'cognito:groups': ['author'],
    });
    const me3 = await (
      await fetch(`${appBase}/api/auth/me`, { headers: { Authorization: `Bearer ${tokAdmin}` } })
    ).json();
    assert.equal(me3.user.name, 'Lê Văn C');
    assert.ok(sentCommands.some((c) => c.constructor.name === 'AdminGetUserCommand'));

    // 4. UUID username & UUID userInfo & failed AdminGetUser -> role fallback, never UUID
    userInfoMode = 'uuid';
    adminGetMode = 'fail';
    const uuidName = '33333333-4444-4555-8666-777777777777';
    const tokFallback = await signAccess({
      sub: 'sub-fallback',
      username: uuidName,
      'cognito:groups': ['editor'],
    });
    const me4 = await (
      await fetch(`${appBase}/api/auth/me`, { headers: { Authorization: `Bearer ${tokFallback}` } })
    ).json();
    assert.equal(me4.user.name, 'Biên tập viên');
    assert.notEqual(me4.user.name, uuidName);

    // 5. POST /api/users sends email_verified='true' & trimmed email/name
    const createUserRes = await fetch(`${appBase}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokClaim}`,
        'Content-Type': 'application/json',
        Origin: appBase,
      },
      body: JSON.stringify({
        email: '  NewEditor@UTH.Edu.VN  ',
        name: '  Phạm Văn D  ',
        role: 'editor',
      }),
    });
    assert.equal(createUserRes.status, 201);
    const createCmd = sentCommands.find((c) => c.constructor.name === 'AdminCreateUserCommand');
    assert.ok(createCmd);
    assert.equal(createCmd.input.Username, 'neweditor@uth.edu.vn');
    assert.deepEqual(createCmd.input.UserAttributes, [
      { Name: 'email', Value: 'neweditor@uth.edu.vn' },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: 'Phạm Văn D' },
    ]);
  } finally {
    appServer?.closeAllConnections?.();
    mockServer?.closeAllConnections?.();
    await new Promise((r) => (appServer ? appServer.close(r) : r()));
    await new Promise((r) => (mockServer ? mockServer.close(r) : r()));
    await db?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Latent fixes: PUBLIC_READ_ONLY media/scheduler, missing Host guard, SQLite migration & measure-freshness resilience', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'uth-latent-'));
  let db, roServer, localServer, mockFreshServer;
  try {
    const dbPath = join(temp, 'latent.db');
    process.env.SQLITE_PATH = dbPath;
    delete process.env.DATABASE_URL;
    db = await connect();
    await migrate(db);
    // Re-running migrate(db) on already upgraded SQLite DB is idempotent
    await migrate(db);

    // SQLite UDF & pragmas check
    assert.equal((await db.all('PRAGMA busy_timeout'))[0].timeout, 5000);
    assert.equal((await db.all("SELECT lower('ĐÀO TẠO Á Ô') AS s"))[0].s, 'đào tạo á ô');
    assert.equal((await db.all('PRAGMA foreign_key_check')).length, 0);

    // PUBLIC_READ_ONLY handler with unset uploadBucket
    const roHandler = createRequestHandler({
      db,
      production: true,
      publicReadOnly: true,
      uploadBucket: '',
    });
    roServer = http.createServer(roHandler);
    await new Promise((resolve) => roServer.listen(0, '127.0.0.1', resolve));
    const roBase = `http://127.0.0.1:${roServer.address().port}`;

    await db.run('INSERT INTO categories(id,name,color) VALUES($1,$2,$3)', ['c1', 'C1', '#018486']);
    await db.run(
      'INSERT INTO articles(id,slug,author_id,author_name,category_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      ['a1', 's1', 'u1', 'U1', 'c1', '2026-01-01T00:00:00Z'],
    );
    await db.run(
      'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at,category_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        'v1',
        'a1',
        'T',
        'S',
        'B',
        '/media/00000000-0000-4000-8000-000000000001.png',
        'published',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        'c1',
      ],
    );
    await db.run('UPDATE articles SET published_version=$1 WHERE id=$2', ['v1', 'a1']);

    const media404 = await fetch(`${roBase}/media/00000000-0000-4000-8000-000000000001.png`);
    assert.equal(media404.status, 404);
    for (const p of [
      '/api/versions/v1/schedule',
      '/api/versions/v1/unschedule',
      '/api/ops/scheduler/run',
    ]) {
      const r = await fetch(roBase + p, { method: 'POST', body: '{}' });
      assert.equal(r.status, 503);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }

    // Missing Host header guard (HTTP/1.0 request omits Host)
    const localHandler = createRequestHandler({ db, production: false, publicReadOnly: false });
    localServer = http.createServer(localHandler);
    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const port = localServer.address().port;
    const noHostStatus = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          'POST /api/articles HTTP/1.0\r\nOrigin: https://hostile.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
        );
      });
      let rawResp = '';
      sock.on('data', (chunk) => {
        rawResp += chunk.toString();
      });
      sock.on('end', () => {
        const m = rawResp.match(/^HTTP\/1\.\d (\d{3})/);
        resolve(m ? Number(m[1]) : 0);
      });
      sock.on('error', reject);
    });
    assert.equal(noHostStatus, 403);

    // measure-freshness.mjs handles non-JSON 502 response cleanly
    let count = 0;
    mockFreshServer = http.createServer((req, res) => {
      count++;
      if (count === 1) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Bad Gateway</body></html>');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version_id: 'v-ok' }));
    });
    await new Promise((resolve) => mockFreshServer.listen(0, '127.0.0.1', resolve));
    const freshUrl = `http://127.0.0.1:${mockFreshServer.address().port}/article`;
    const scriptPath = join(process.cwd(), 'scripts', 'metrics', 'measure-freshness.mjs');
    await promisify(execFile)(process.execPath, [scriptPath], {
      cwd: temp,
      env: {
        ...process.env,
        ARTICLE_URL: freshUrl,
        EXPECTED_VERSION: 'v-ok',
        PUBLISHED_AT: new Date().toISOString(),
        PUBLISH_METRICS: 'false',
      },
    });
    const report = JSON.parse(
      await readFile(join(temp, 'storage/reports/evidence/freshness.json'), 'utf8'),
    );
    assert.equal(report.passed, true);
    assert.equal(report.samples.length, 2);
    assert.equal(report.samples[0].status, 502);
    assert.ok(report.samples[0].error);
    assert.equal(report.samples[1].version, 'v-ok');
  } finally {
    roServer?.closeAllConnections?.();
    localServer?.closeAllConnections?.();
    mockFreshServer?.closeAllConnections?.();
    await new Promise((r) => (roServer ? roServer.close(r) : r()));
    await new Promise((r) => (localServer ? localServer.close(r) : r()));
    await new Promise((r) => (mockFreshServer ? mockFreshServer.close(r) : r()));
    await db?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('CH-G5: resolveCognitoName cache eviction (>1000 entries) and userInfo email-only fallback', async () => {
  const cache = new Map();
  let now = 1_700_000_000_000;
  for (let i = 0; i < 1005; i++) {
    const resolved = await resolveCognitoName(
      { sub: `sub-${i}`, username: '11111111-2222-4333-8444-555555555555' },
      'tok',
      {
        cognitoDomain: 'https://cognito.invalid',
        cognitoIssuer: '',
        cognitoProfiles: cache,
        now: () => now,
        cacheTtlMs: 60_000,
        fetchImpl: async () => ({ ok: true, json: async () => ({ name: `User ${i}` }) }),
      },
    );
    assert.equal(resolved, `User ${i}`);
  }
  assert.equal(cache.size, 1001);
  assert.equal(cache.has('sub-0'), false);
  assert.equal(cache.has('sub-1004'), true);

  // Expired entries are purged before size-based eviction when TTL passes
  now += 60_001;
  await resolveCognitoName(
    { sub: 'sub-fresh', username: '11111111-2222-4333-8444-555555555555' },
    'tok',
    {
      cognitoDomain: 'https://cognito.invalid',
      cognitoIssuer: '',
      cognitoProfiles: cache,
      now: () => now,
      cacheTtlMs: 60_000,
      fetchImpl: async () => ({ ok: true, json: async () => ({ name: 'Fresh User' }) }),
    },
  );
  assert.equal(cache.size, 1);
  assert.equal(cache.get('sub-fresh')?.name, 'Fresh User');

  // userInfo returning only email falls back to email instead of role fallback or UUID
  const emailFallback = await resolveCognitoName(
    {
      sub: 'sub-email-only',
      username: '22222222-3333-4444-8555-666666666666',
      'cognito:groups': ['author'],
    },
    'tok',
    {
      cognitoDomain: 'https://cognito.invalid',
      cognitoIssuer: '',
      cognitoProfiles: cache,
      now: () => now,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ email: 'author@uth.edu.vn' }),
      }),
    },
  );
  assert.equal(emailFallback, 'author@uth.edu.vn');
});
