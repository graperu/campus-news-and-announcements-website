// Imports verified source metadata, never fabricated articles or user accounts.
// Full source articles remain on the official publisher's website.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect, migrate } from '../backend/db.mjs';
const base = 'https://congdoan.ut.edu.vn';
const response = await fetch(`${base}/wp-json/wp/v2/posts?per_page=30&_embed`, {
  signal: AbortSignal.timeout(30000),
});
if (!response.ok)
  throw new Error(`Official source returned ${response.status}. No fallback data is generated.`);
const posts = await response.json();
if (!Array.isArray(posts) || !posts.length) throw new Error('No source articles returned');
const plain = (s) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([a-f0-9]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[lr][ds]quo;/g, '"')
    .trim();
const taxonomy = [
  ['uth-news', 'Tin UTH'],
  ['notices', 'Thông báo'],
  ['community', 'Hoạt động'],
  ['union', 'Công đoàn'],
  ['education', 'Đào tạo'],
];
const db = await connect();
let count = 0;
try {
  await migrate(db);
  for (const [id, name] of taxonomy)
    await db.run(
      'INSERT INTO categories(id,name,color) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
      [id, name, '#155b65'],
    );
  await mkdir('frontend/assets/news', { recursive: true });
  for (const post of posts) {
    const source = new URL(post.link);
    if (source.origin !== base) throw new Error('Unexpected source origin');
    const id = `uth-${post.id}`,
      version = `${id}-${createHash('sha256')
        .update(post.modified_gmt || post.date_gmt)
        .digest('hex')
        .slice(0, 12)}`;
    const title = plain(post.title.rendered),
      date = new Date(post.date_gmt + 'Z').toISOString();
    let image = '';
    const remote =
      post._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.large?.source_url ||
      post._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.medium_large?.source_url ||
      post._embedded?.['wp:featuredmedia']?.[0]?.source_url ||
      post.content?.rendered?.match(/<img[^>]+src=["']([^"']+)/i)?.[1];
    if (remote)
      try {
        const u = new URL(remote);
        if (!['congdoan.ut.edu.vn', 'ut.edu.vn', 'uth.edu.vn'].includes(u.hostname))
          throw new Error('Unapproved image host');
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        const type = r.headers.get('content-type')?.split(';')[0];
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
        if (r.ok && ext) {
          const bytes = Buffer.from(await r.arrayBuffer());
          if (bytes.length < 10 * 1024 * 1024) {
            image = `/assets/news/${id}.${ext}`;
            await writeFile(`frontend${image}`, bytes);
          }
        }
      } catch {
        console.warn(`Image unavailable for ${id}; keeping text-only card`);
      }
    const category = /thông báo|kế hoạch/i.test(title)
      ? 'notices'
      : /đào tạo|bồi dưỡng|tập huấn/i.test(title)
        ? 'education'
        : /công đoàn|đoàn viên/i.test(title)
          ? 'union'
          : /hội|hoạt động|giải|chương trình/i.test(title)
            ? 'community'
            : 'uth-news';
    await db.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO articles(id,slug,author_id,author_name,category_id,created_at,published_version,source_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET source_url=excluded.source_url',
        [
          id,
          post.slug,
          'official-source:congdoan.ut.edu.vn',
          'Công đoàn UTH',
          category,
          date,
          version,
          source.href,
        ],
      );
      const summary = 'Tin từ Công đoàn Trường Đại học Giao thông vận tải TP.HCM.';
      await tx.run(
        'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING',
        [
          version,
          id,
          title,
          summary,
          'Bài viết được dẫn nguồn từ cổng thông tin Công đoàn UTH. Xem toàn bộ nội dung tại liên kết bài gốc bên dưới.',
          image,
          'published',
          date,
          new Date(post.modified_gmt + 'Z').toISOString(),
        ],
      );
      await tx.run(
        'INSERT INTO publications(id,article_id,version_id,editor_id,published_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(version_id) DO NOTHING',
        [`${version}-publication`, id, version, 'service:official-source-import', date],
      );
      await tx.run('UPDATE articles SET published_version=$1 WHERE id=$2', [version, id]);
    });
    count++;
  }
  console.log(
    `Imported ${count} real UTH source records. Re-running does not duplicate versions. No default users created.`,
  );
} finally {
  await db.close();
}
