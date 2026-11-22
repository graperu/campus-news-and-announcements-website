import { createHash } from 'node:crypto';
import { connect, migrate } from '../../backend/db.mjs';
import { readReviewedSource, restoreReviewedSource } from './source-content.mjs';
const snapshot = await readReviewedSource();
const response = await fetch(`${snapshot.source}wp-json/wp/v2/posts?per_page=30&_embed`, {
  signal: AbortSignal.timeout(30000),
});
if (!response.ok)
  throw new Error(`Official source returned ${response.status}; no substitute content created.`);
const posts = await response.json();
if (!Array.isArray(posts) || !posts.length) throw new Error('Official source returned no posts');
const reviewed = [],
  pending = [];
for (const post of posts) {
  const record = snapshot.records.find((item) => item.id === `uth-${post.id}`);
  const digest = createHash('sha256')
    .update(post.content?.rendered || '')
    .digest('hex');
  if (
    !record ||
    record.source_content_hash !== digest ||
    record.source_url !== post.link ||
    record.source_title_hash !== createHash('sha256').update(post.title.rendered).digest('hex')
  ) {
    pending.push({ id: post.id, url: post.link });
    continue;
  }
  if (record.source_document_url) {
    const file = await fetch(record.source_document_url, { signal: AbortSignal.timeout(30000) });
    if (
      !file.ok ||
      createHash('sha256')
        .update(Buffer.from(await file.arrayBuffer()))
        .digest('hex') !== record.source_document_sha256
    ) {
      pending.push({ id: post.id, url: post.link });
      continue;
    }
  }
  reviewed.push(record);
}
if (!reviewed.length)
  throw new Error(
    'Source articles need content review before import; no empty articles were published.',
  );
const db = await connect();
try {
  await migrate(db);
  const result = await restoreReviewedSource(db, { ...snapshot, records: reviewed });
  console.log(
    `Imported ${result.records} verified articles with reviewed content. No accounts created.`,
  );
  if (pending.length) console.warn(JSON.stringify({ requiresContentReview: pending }));
} finally {
  await db.close();
}
