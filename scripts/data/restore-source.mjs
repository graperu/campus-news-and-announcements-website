import { readFile } from 'node:fs/promises';
import { connect, migrate } from '../../backend/db.mjs';
const snapshot = JSON.parse(
  await readFile(new URL('../../database/sources/uth.json', import.meta.url), 'utf8'),
);
if (snapshot.source !== 'https://congdoan.ut.edu.vn/')
  throw new Error('Unexpected source snapshot');
const db = await connect();
try {
  await migrate(db);
  await db.transaction(async (tx) => {
    for (const c of snapshot.categories)
      await tx.run(
        'INSERT INTO categories(id,name,color) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
        [c.id, c.name, c.color],
      );
    for (const a of snapshot.records) {
      await tx.run(
        'INSERT INTO articles(id,slug,author_id,author_name,category_id,created_at,source_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
        [a.id, a.slug, a.author_id, a.author_name, a.category_id, a.created_at, a.source_url],
      );
      await tx.run(
        'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING',
        [
          a.version_id,
          a.id,
          a.title,
          a.summary,
          a.body,
          a.image,
          'published',
          a.created_at,
          a.updated_at,
        ],
      );
      await tx.run(
        'INSERT INTO publications(id,article_id,version_id,editor_id,published_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(version_id) DO NOTHING',
        [a.publication_id, a.id, a.version_id, a.editor_id, a.published_at],
      );
      await tx.run(
        'UPDATE articles SET published_version=$1 WHERE id=$2 AND published_version IS NULL',
        [a.version_id, a.id],
      );
    }
  });
  console.log(
    `Restored ${snapshot.records.length} verified source records from ${snapshot.retrievedAt}; no accounts created.`,
  );
} finally {
  await db.close();
}
