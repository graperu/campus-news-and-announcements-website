-- Editorial upgrades: scheduled publication index, version-level category backfill,
-- and idempotent demotion of superseded published versions.
-- Schema changes for article_versions (status CHECK expansion + category_id,
-- scheduled_at, scheduled_by columns) are applied dialect-safely in backend/db.mjs.
CREATE INDEX IF NOT EXISTS idx_versions_scheduled ON article_versions(status, scheduled_at);

UPDATE article_versions
SET category_id = (SELECT a.category_id FROM articles a WHERE a.id = article_versions.article_id)
WHERE category_id IS NULL;

UPDATE article_versions
SET status = 'superseded'
WHERE status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM articles a
    WHERE a.id = article_versions.article_id
      AND a.published_version = article_versions.id
  );
