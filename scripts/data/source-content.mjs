import { readFile } from 'node:fs/promises';

export async function readReviewedSource() {
  const snapshot = JSON.parse(
    await readFile(new URL('../../database/sources/uth.json', import.meta.url), 'utf8'),
  );
  if (snapshot.source !== 'https://congdoan.ut.edu.vn/')
    throw new Error('Unexpected source snapshot');
  for (const record of snapshot.records) {
    if (
      typeof record.summary !== 'string' ||
      record.summary.trim().length < 50 ||
      typeof record.body !== 'string' ||
      record.body.trim().length < 240 ||
      /Bài viết được dẫn nguồn|Xem toàn bộ nội dung tại liên kết/.test(record.body)
    )
      throw new Error(`Missing reviewed content for ${record.id}`);
    const source = new URL(record.source_url);
    if (
      source.protocol !== 'https:' ||
      source.hostname !== 'congdoan.ut.edu.vn' ||
      !/^[a-f0-9]{64}$/.test(record.source_content_hash)
    )
      throw new Error(`Invalid provenance for ${record.id}`);
    if (record.source_document_url) {
      const file = new URL(record.source_document_url);
      if (
        file.protocol !== 'https:' ||
        file.hostname !== 'congdoan.ut.edu.vn' ||
        !file.pathname.toLowerCase().endsWith('.pdf')
      )
        throw new Error(`Invalid source document for ${record.id}`);
    }
  }
  return snapshot;
}

export async function restoreReviewedSource(db, snapshot) {
  let activated = 0;
  await db.transaction(async (tx) => {
    for (const c of snapshot.categories)
      await tx.run(
        'INSERT INTO categories(id,name,color) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
        [c.id, c.name, c.color],
      );
    for (const a of snapshot.records) {
      const [before] = await tx.all(
        'SELECT author_id,published_version FROM articles WHERE id=$1',
        [a.id],
      );
      if (before && before.author_id !== a.author_id)
        throw new Error(`Source identity conflict: ${a.id}`);
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
      if (a.source_document_url)
        await tx.run(
          'INSERT INTO source_documents(version_id,url,title) VALUES($1,$2,$3) ON CONFLICT(version_id) DO NOTHING',
          [a.version_id, a.source_document_url, a.title],
        );
      await tx.run(
        'INSERT INTO publications(id,article_id,version_id,editor_id,published_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(version_id) DO NOTHING',
        [a.publication_id, a.id, a.version_id, a.editor_id, a.published_at],
      );
      // Upgrade only the known metadata-only versions; preserve any editorial publication.
      const previous = a.replaces_versions || [];
      if (!before?.published_version || previous.includes(before.published_version)) {
        await tx.run(
          'UPDATE articles SET published_version=$1 WHERE id=$2 AND (published_version IS NULL' +
            (previous.length
              ? ` OR published_version IN (${previous.map((_, i) => '$' + (i + 3)).join(',')})`
              : '') +
            ')',
          [a.version_id, a.id, ...previous],
        );
        activated++;
      }
    }
  });
  return {
    records: snapshot.records.length,
    activated,
    documents: snapshot.records.filter((a) => a.source_document_url).length,
  };
}
