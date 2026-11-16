CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('reader','author','editor')),
    password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id),
    created_at TEXT NOT NULL,
    published_version TEXT,
    source_url TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS article_versions (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    image TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','submitted','approved','published','rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publications (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id),
    version_id TEXT UNIQUE NOT NULL REFERENCES article_versions(id),
    editor_id TEXT NOT NULL,
    published_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    article_id TEXT NOT NULL REFERENCES articles(id),
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);

CREATE INDEX IF NOT EXISTS idx_articles_author ON articles(author_id);

CREATE INDEX IF NOT EXISTS idx_versions_article ON article_versions(article_id);

CREATE INDEX IF NOT EXISTS idx_versions_status ON article_versions(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_publications_article ON publications(article_id, published_at);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_article ON audit_events(article_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_identity ON article_versions(id, article_id);
