import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect, migrate } from '../backend/db.mjs';
test('verified UTH source snapshot restores repeatably without creating accounts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'uth-source-'));
  process.env.SQLITE_PATH = join(temp, 'source.db');
  delete process.env.DATABASE_URL;
  let db;
  try {
    for (let i = 0; i < 2; i++)
      await promisify(execFile)(process.execPath, ['scripts/data/restore-source.mjs'], {
        env: process.env,
      });
    db = await connect();
    assert.equal((await db.all('SELECT COUNT(*) AS n FROM articles'))[0].n, 30);
    assert.equal((await db.all('SELECT COUNT(*) AS n FROM categories'))[0].n, 5);
    assert.equal((await db.all('SELECT COUNT(*) AS n FROM publications'))[0].n, 30);
    assert.equal((await db.all('SELECT COUNT(*) AS n FROM users'))[0].n, 0);
    assert.equal((await db.all('SELECT COUNT(*) AS n FROM source_documents'))[0].n, 20);
    assert.equal(
      (await db.all("SELECT COUNT(*) AS n FROM article_versions WHERE status='published'"))[0].n,
      30,
    );
    assert.equal(
      (await db.all('SELECT COUNT(*) AS n FROM article_versions WHERE category_id IS NULL'))[0].n,
      0,
    );
    assert.equal(
      (
        await db.all(
          "SELECT COUNT(*) AS n FROM article_versions v JOIN articles a ON a.id=v.article_id WHERE v.status='published' AND v.id!=a.published_version",
        )
      )[0].n,
      0,
    );
    const snapshot = JSON.parse(await readFile('database/sources/uth.json', 'utf8'));
    for (const record of snapshot.records) {
      assert.equal(new URL(record.source_url).hostname, 'congdoan.ut.edu.vn');
      if (record.image) await access(`frontend${record.image}`);
      const [version] = await db.all('SELECT summary,body FROM article_versions WHERE id=$1', [
        record.version_id,
      ]);
      assert.ok(version.body.length > 300);
      assert.ok(version.summary.length > 50);
      assert.doesNotMatch(version.body, /Xem toàn bộ nội dung tại liên kết/);
      assert.equal(version.body, record.body);
    }
  } finally {
    await db?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('CH-G2: populated pre-003 SQLite DB migrates cleanly with superseded demotion, category_id backfill & 0 FK errors', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'uth-pre003-'));
  const prevSqlite = process.env.SQLITE_PATH;
  const prevDbUrl = process.env.DATABASE_URL;
  const dbPath = join(temp, 'legacy.db');
  process.env.SQLITE_PATH = dbPath;
  delete process.env.DATABASE_URL;
  let db;
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys=ON;');
    raw.exec(await readFile('database/migrations/001_initial.sql', 'utf8'));
    raw.exec(await readFile('database/migrations/002_source_documents.sql', 'utf8'));
    raw
      .prepare('INSERT INTO categories(id,name,color) VALUES(?,?,?)')
      .run('c1', 'Tin UTH', '#018486');
    raw
      .prepare(
        'INSERT INTO articles(id,slug,author_id,author_name,category_id,created_at,published_version,source_url) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        'a1',
        'bai-legacy',
        'u1',
        'Legacy Author',
        'c1',
        '2025-01-01T00:00:00Z',
        'v2',
        'https://congdoan.ut.edu.vn/legacy',
      );
    const insVer = raw.prepare(
      'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    );
    insVer.run(
      'v1',
      'a1',
      'Legacy v1',
      'Summary v1',
      'Body v1',
      '',
      'published',
      '2025-01-01T00:00:00Z',
      '2025-01-01T00:00:00Z',
    );
    insVer.run(
      'v2',
      'a1',
      'Legacy v2',
      'Summary v2',
      'Body v2',
      '',
      'published',
      '2025-01-02T00:00:00Z',
      '2025-01-02T00:00:00Z',
    );
    const insPub = raw.prepare(
      'INSERT INTO publications(id,article_id,version_id,editor_id,published_at) VALUES(?,?,?,?,?)',
    );
    insPub.run('p1', 'a1', 'v1', 'e1', '2025-01-01T00:00:00Z');
    insPub.run('p2', 'a1', 'v2', 'e1', '2025-01-02T00:00:00Z');
    raw
      .prepare('INSERT INTO source_documents(version_id,url,title) VALUES(?,?,?)')
      .run('v2', 'https://congdoan.ut.edu.vn/doc.pdf', 'Doc PDF');
    raw.close();

    db = await connect();
    await migrate(db);
    await migrate(db);

    const rows = await db.all(
      'SELECT id, status, category_id, scheduled_at, scheduled_by FROM article_versions ORDER BY id',
    );
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        {
          id: 'v1',
          status: 'superseded',
          category_id: 'c1',
          scheduled_at: null,
          scheduled_by: null,
        },
        {
          id: 'v2',
          status: 'published',
          category_id: 'c1',
          scheduled_at: null,
          scheduled_by: null,
        },
      ],
    );
    assert.equal((await db.all('PRAGMA foreign_key_check')).length, 0);
    assert.equal(
      (await db.all('SELECT version_id, url FROM source_documents WHERE version_id=$1', ['v2']))[0]
        .url,
      'https://congdoan.ut.edu.vn/doc.pdf',
    );
  } finally {
    await db?.close();
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    await rm(temp, { recursive: true, force: true });
  }
});
