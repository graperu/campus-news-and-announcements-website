import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from '../backend/db.mjs';
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
