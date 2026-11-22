import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const sqliteMigrateHook = Symbol('sqliteMigrateHook');

export async function connect() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const connection = new URL(process.env.DATABASE_URL);
    // pg URL SSL options override the explicit TLS object; keep certificate verification authoritative.
    if (process.env.DB_SSL === 'true')
      for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'])
        connection.searchParams.delete(key);
    const pool = new pg.Pool({
      connectionString: connection.toString(),
      max: process.env.VERCEL === '1' ? 3 : 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: process.env.VERCEL === '1' ? 5000 : 30000,
      statement_timeout: 10000,
      ssl:
        process.env.DB_SSL === 'true'
          ? {
              rejectUnauthorized: true,
              ca:
                process.env.VERCEL === '1'
                  ? undefined
                  : (await import('node:fs')).readFileSync(
                      new URL('../infra/aws/rds-ca.pem', import.meta.url),
                      'utf8',
                    ),
            }
          : undefined,
    });
    return {
      dialect: 'postgres',
      all: async (sql, args = []) => (await pool.query(sql, args)).rows,
      run: async (sql, args = []) => pool.query(sql, args),
      close: () => pool.end(),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await fn({
            all: async (q, a = []) => (await client.query(q, a)).rows,
            run: (q, a = []) => client.query(q, a),
          });
          await client.query('COMMIT');
          return value;
        } catch (e) {
          try {
            await client.query('ROLLBACK');
          } catch {}
          throw e;
        } finally {
          client.release();
        }
      },
    };
  }
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1')
    throw new Error('DATABASE_URL is required in production');
  const file = process.env.SQLITE_PATH || 'storage/data/campus.db';
  mkdirSync(dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  sqlite.function('lower', { deterministic: true }, (v) =>
    v == null ? null : String(v).normalize('NFC').toLocaleLowerCase('vi'),
  );
  const convert = (q, a) => {
    const values = [];
    return [
      q.replace(/\$(\d+)/g, (_, n) => {
        values.push(a[Number(n) - 1]);
        return '?';
      }),
      values,
    ];
  };
  const db = {
    all: async (q, a = []) => {
      const [s, v] = convert(q, a);
      return sqlite.prepare(s).all(...v);
    },
    run: async (q, a = []) => {
      const [s, v] = convert(q, a);
      return sqlite.prepare(s).run(...v);
    },
    close: async () => sqlite.close(),
  };
  // SQLite has one connection: serialize all transactions, including requests outside them.
  let tail = Promise.resolve();
  const locked = (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  return {
    dialect: 'sqlite',
    all: (q, a) => locked(() => db.all(q, a)),
    run: (q, a) => locked(() => db.run(q, a)),
    close: () => locked(() => db.close()),
    [sqliteMigrateHook]: (fn) => locked(() => fn(sqlite)),
    transaction: (fn) =>
      locked(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(db);
          sqlite.exec('COMMIT');
          return result;
        } catch (e) {
          try {
            sqlite.exec('ROLLBACK');
          } catch {}
          throw e;
        }
      }),
  };
}

export async function migrate(db) {
  const { readFile } = await import('node:fs/promises');
  const dialect = db.dialect || (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
  const execSql = async (tx, raw) => {
    for (const statement of raw
      .split(';')
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean))
      await tx.run(statement);
  };
  const baseSql = (
    await Promise.all(
      ['001_initial.sql', '002_source_documents.sql'].map((name) =>
        readFile(new URL(`../database/migrations/${name}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n');
  await db.transaction(async (tx) => {
    if (dialect === 'postgres') await tx.all('SELECT pg_advisory_xact_lock(437021)');
    await execSql(tx, baseSql);
  });
  if (dialect === 'sqlite' && db[sqliteMigrateHook]) {
    await db[sqliteMigrateHook]((sqlite) => {
      const row = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='article_versions'")
        .get();
      const cols = new Set(
        sqlite
          .prepare('PRAGMA table_info(article_versions)')
          .all()
          .map((c) => c.name),
      );
      const needsUpgrade =
        !row?.sql?.includes("'scheduled'") ||
        !row?.sql?.includes("'superseded'") ||
        !cols.has('category_id') ||
        !cols.has('scheduled_at') ||
        !cols.has('scheduled_by');
      if (!needsUpgrade) return;
      const catExpr = cols.has('category_id')
        ? 'COALESCE(v.category_id, (SELECT a.category_id FROM articles a WHERE a.id=v.article_id))'
        : '(SELECT a.category_id FROM articles a WHERE a.id=v.article_id)';
      const schedAtExpr = cols.has('scheduled_at') ? 'v.scheduled_at' : 'NULL';
      const schedByExpr = cols.has('scheduled_by') ? 'v.scheduled_by' : 'NULL';
      sqlite.exec('PRAGMA foreign_keys=OFF;');
      try {
        sqlite.exec('BEGIN IMMEDIATE;');
        sqlite.exec(`
          CREATE TABLE article_versions_new (
            id TEXT PRIMARY KEY,
            article_id TEXT NOT NULL REFERENCES articles(id),
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            body TEXT NOT NULL,
            image TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('draft','submitted','approved','scheduled','published','rejected','superseded')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            category_id TEXT REFERENCES categories(id),
            scheduled_at TEXT,
            scheduled_by TEXT
          );
          INSERT INTO article_versions_new(id,article_id,title,summary,body,image,status,created_at,updated_at,category_id,scheduled_at,scheduled_by)
          SELECT v.id,v.article_id,v.title,v.summary,v.body,v.image,v.status,v.created_at,v.updated_at,${catExpr},${schedAtExpr},${schedByExpr}
          FROM article_versions v;
          DROP TABLE article_versions;
          ALTER TABLE article_versions_new RENAME TO article_versions;
          CREATE INDEX IF NOT EXISTS idx_versions_article ON article_versions(article_id);
          CREATE INDEX IF NOT EXISTS idx_versions_status ON article_versions(status, updated_at);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_identity ON article_versions(id, article_id);
          CREATE INDEX IF NOT EXISTS idx_versions_scheduled ON article_versions(status, scheduled_at);
        `);
        const fkErrors = sqlite.prepare('PRAGMA foreign_key_check').all();
        if (fkErrors.length)
          throw new Error(`Foreign key check failed after migration: ${JSON.stringify(fkErrors)}`);
        sqlite.exec('COMMIT;');
      } catch (e) {
        try {
          sqlite.exec('ROLLBACK;');
        } catch {}
        throw e;
      } finally {
        sqlite.exec('PRAGMA foreign_keys=ON;');
      }
    });
  }
  const upgradeSql = await readFile(
    new URL('../database/migrations/003_editorial_upgrades.sql', import.meta.url),
    'utf8',
  );
  await db.transaction(async (tx) => {
    if (dialect === 'postgres') {
      await tx.all('SELECT pg_advisory_xact_lock(437021)');
      await tx.run(
        'ALTER TABLE article_versions ADD COLUMN IF NOT EXISTS category_id TEXT REFERENCES categories(id)',
      );
      await tx.run('ALTER TABLE article_versions ADD COLUMN IF NOT EXISTS scheduled_at TEXT');
      await tx.run('ALTER TABLE article_versions ADD COLUMN IF NOT EXISTS scheduled_by TEXT');
      const checks = await tx.all(
        "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='article_versions'::regclass AND contype='c'",
      );
      const hasExpandedStatus = checks.some(
        (c) => c.def.includes("'scheduled'") && c.def.includes("'superseded'"),
      );
      if (!hasExpandedStatus) {
        for (const c of checks) {
          if (c.def.includes('status'))
            await tx.run(
              `ALTER TABLE article_versions DROP CONSTRAINT IF EXISTS "${c.conname.replace(/"/g, '""')}"`,
            );
        }
        await tx.run(
          "ALTER TABLE article_versions ADD CONSTRAINT article_versions_status_check CHECK (status IN ('draft','submitted','approved','scheduled','published','rejected','superseded'))",
        );
      }
      const constraints = await tx.all(
        "SELECT conname FROM pg_constraint WHERE conrelid IN ('articles'::regclass,'publications'::regclass)",
      );
      if (!constraints.some((c) => c.conname === 'fk_published_version'))
        await tx.run(
          'ALTER TABLE articles ADD CONSTRAINT fk_published_version FOREIGN KEY(published_version,id) REFERENCES article_versions(id,article_id) DEFERRABLE INITIALLY DEFERRED',
        );
      if (!constraints.some((c) => c.conname === 'fk_publication_article_version'))
        await tx.run(
          'ALTER TABLE publications ADD CONSTRAINT fk_publication_article_version FOREIGN KEY(version_id,article_id) REFERENCES article_versions(id,article_id) DEFERRABLE INITIALLY DEFERRED',
        );
    }
    await execSql(tx, upgradeSql);
  });
}
