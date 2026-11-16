import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect, migrate } from '../backend/db.mjs';
import { hashPassword } from '../backend/passwords.mjs';

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
      assert.equal(
        (
          await call('/api/auth/login', 'POST', {
            email: 'reader@test.invalid',
            password: replacement,
          })
        ).status,
        200,
      );
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
