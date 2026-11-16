CREATE TABLE IF NOT EXISTS source_documents (
    version_id TEXT PRIMARY KEY REFERENCES article_versions(id),
    url TEXT NOT NULL,
    title TEXT NOT NULL
);
