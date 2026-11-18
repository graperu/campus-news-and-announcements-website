import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, migrate } from '../backend/db.mjs';
import { readReviewedSource, restoreReviewedSource } from '../scripts/data/source-content.mjs';

test('source content upgrades keep old snapshots and never replace an editorial publication', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'uth-source-upgrade-'));
  process.env.SQLITE_PATH = join(temp, 'source.db');
  delete process.env.DATABASE_URL;
  const db = await connect();
  try {
    await migrate(db);
    const snapshot = await readReviewedSource(),
      record = snapshot.records.find((a) => a.source_document_url);
    const legacy = {
      ...record,
      version_id: record.replaces_versions[0],
      publication_id: record.replaces_versions[0] + '-publication',
      body: 'Legacy metadata-only content.',
      summary: 'Legacy summary.',
      source_document_url: '',
      replaces_versions: [],
    };
    await restoreReviewedSource(db, { ...snapshot, records: [legacy] });
    const result = await restoreReviewedSource(db, { ...snapshot, records: [record] });
    assert.equal(result.activated, 1);
    assert.equal(
      (await db.all('SELECT published_version FROM articles WHERE id=$1', [record.id]))[0]
        .published_version,
      record.version_id,
    );
    assert.equal(
      (await db.all('SELECT body FROM article_versions WHERE id=$1', [legacy.version_id]))[0].body,
      legacy.body,
    );
    assert.equal(
      (await db.all('SELECT status FROM article_versions WHERE id=$1', [legacy.version_id]))[0]
        .status,
      'superseded',
    );
    assert.equal(
      (await db.all('SELECT url FROM source_documents WHERE version_id=$1', [record.version_id]))[0]
        .url,
      record.source_document_url,
    );
    await restoreReviewedSource(db, { ...snapshot, records: [record] });
    assert.equal((await db.all('SELECT COUNT(*) AS n FROM article_versions'))[0].n, 2);
    await db.run(
      'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        'editor-revision',
        record.id,
        'Editor revision',
        'Editor summary',
        'Editor content.',
        '',
        'published',
        record.created_at,
        record.updated_at,
      ],
    );
    await db.run(
      'INSERT INTO publications(id,article_id,version_id,editor_id,published_at) VALUES($1,$2,$3,$4,$5)',
      [
        'editor-publication',
        record.id,
        'editor-revision',
        'isolated-test-editor',
        record.published_at,
      ],
    );
    await db.run('UPDATE articles SET published_version=$1 WHERE id=$2', [
      'editor-revision',
      record.id,
    ]);
    assert.equal(
      (await restoreReviewedSource(db, { ...snapshot, records: [record] })).activated,
      0,
    );
    assert.equal(
      (await db.all('SELECT published_version FROM articles WHERE id=$1', [record.id]))[0]
        .published_version,
      'editor-revision',
    );
    assert.equal((await db.all('SELECT COUNT(*) AS n FROM article_versions'))[0].n, 3);
    assert.equal(
      (await db.all('SELECT status FROM article_versions WHERE id=$1', ['editor-revision']))[0]
        .status,
      'published',
    );
    assert.equal((await db.all('SELECT COUNT(*) AS n FROM users'))[0].n, 0);
  } finally {
    await db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
