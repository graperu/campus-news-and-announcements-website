import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
          await client.query('ROLLBACK');
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
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
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
    all: (q, a) => locked(() => db.all(q, a)),
    run: (q, a) => locked(() => db.run(q, a)),
    close: () => locked(() => db.close()),
    transaction: (fn) =>
      locked(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(db);
          sqlite.exec('COMMIT');
          return result;
        } catch (e) {
          sqlite.exec('ROLLBACK');
          throw e;
        }
      }),
  };
}

export async function migrate(db) {
  const { readFile } = await import('node:fs/promises');
  const sql = (
    await Promise.all(
      ['001_initial.sql', '002_source_documents.sql'].map((name) =>
        readFile(new URL(`../database/migrations/${name}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n');
  await db.transaction(async (tx) => {
    if (process.env.DATABASE_URL) await tx.all('SELECT pg_advisory_xact_lock(437021)');
    for (const statement of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await tx.run(statement);
    if (process.env.DATABASE_URL) {
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
  });
}
