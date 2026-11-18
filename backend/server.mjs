import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, migrate } from './db.mjs';
import { hashPassword, verifyPassword } from './passwords.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production';
const publicReadOnly =
  production && process.env.VERCEL === '1' && process.env.PUBLIC_READ_ONLY === 'true';
if (
  production &&
  (!process.env.APP_ORIGIN?.startsWith('https://') || process.env.DB_SSL !== 'true')
)
  throw new Error('Production requires HTTPS APP_ORIGIN and verified database TLS');
if (
  production &&
  !publicReadOnly &&
  (!process.env.COGNITO_ISSUER ||
    !process.env.COGNITO_CLIENT_ID ||
    !process.env.COGNITO_DOMAIN ||
    !process.env.APP_ORIGIN ||
    process.env.DB_SSL !== 'true' ||
    !process.env.UPLOAD_BUCKET)
)
  throw new Error('Production requires Cognito, APP_ORIGIN, verified database TLS and private S3');
const uploadDirectory = resolve(process.env.UPLOAD_PATH || resolve(root, 'storage/data/uploads'));

let dbPromise;
function getDb() {
  return (dbPromise ??= connect()
    .then(async (conn) => {
      try {
        await migrate(conn);
        return conn;
      } catch (err) {
        await conn.close?.().catch(() => {});
        throw err;
      }
    })
    .catch((err) => {
      dbPromise = null;
      throw err;
    }));
}

const attempts = new Map(),
  cognitoProfiles = new Map(),
  COGNITO_CACHE_TTL_MS = 5 * 60 * 1000,
  metrics = {
    originRequests: 0,
    publicReads: 0,
    startedAt: new Date().toISOString(),
  };
let originAvailable = true;

let defaultJwtVerify, defaultJwks, defaultJwksIssuer;
async function getDefaultVerifier(issuer) {
  if (!defaultJwtVerify) {
    const jose = await import('jose');
    defaultJwtVerify = jose.jwtVerify;
  }
  if (issuer && (!defaultJwks || defaultJwksIssuer !== issuer)) {
    const jose = await import('jose');
    defaultJwks = jose.createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    defaultJwksIssuer = issuer;
  }
  return { jwtVerify: defaultJwtVerify, jwks: defaultJwks };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cleanDisplayName(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed && !UUID_RE.test(trimmed) ? trimmed : '';
}

function setCachedProfile(cache, sub, name, nowFn, ttlMs) {
  const now = nowFn();
  if (cache.size > 1000) {
    for (const [key, entry] of cache) {
      if (entry.until <= now) cache.delete(key);
    }
    while (cache.size > 1000) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(sub, { name, until: now + ttlMs });
}

export async function resolveCognitoName(payload, bearer, deps = {}) {
  const groups = payload?.['cognito:groups'] || [];
  const role = groups.includes('editor')
    ? 'editor'
    : groups.includes('author')
      ? 'author'
      : 'reader';
  const fallbackName =
    role === 'editor' ? 'Biên tập viên' : role === 'author' ? 'Tác giả' : 'Bạn đọc';

  const claimName = cleanDisplayName(payload?.name);
  if (claimName) return claimName;

  const cache = deps.cognitoProfiles || cognitoProfiles;
  const nowFn = deps.now || Date.now;
  const ttlMs = deps.cacheTtlMs ?? COGNITO_CACHE_TTL_MS;
  const sub = payload?.sub;
  if (sub) {
    const cached = cache.get(sub);
    if (cached && cached.until > nowFn()) return cached.name;
  }

  const cognitoDomain = deps.cognitoDomain ?? process.env.COGNITO_DOMAIN;
  const fetchImpl = deps.fetchImpl || fetch;
  let userInfoEmail = '';
  if (cognitoDomain && bearer) {
    try {
      const response = await fetchImpl(`${cognitoDomain}/oauth2/userInfo`, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const info = await response.json();
        const userInfoName = cleanDisplayName(info?.name);
        userInfoEmail = cleanDisplayName(info?.email);
        if (userInfoName) {
          if (sub) setCachedProfile(cache, sub, userInfoName, nowFn, ttlMs);
          return userInfoName;
        }
      }
    } catch {}
  }

  const cognitoIssuer = deps.cognitoIssuer ?? process.env.COGNITO_ISSUER;
  let adminEmail = '';
  if (cognitoIssuer && (payload?.username || sub)) {
    try {
      const { CognitoIdentityProviderClient, AdminGetUserCommand } =
        await import('@aws-sdk/client-cognito-identity-provider');
      const client = deps.cognitoClient || new CognitoIdentityProviderClient({});
      const result = await client.send(
        new AdminGetUserCommand({
          UserPoolId: cognitoIssuer.split('/').at(-1),
          Username: payload.username || sub,
        }),
      );
      const attrs = result?.UserAttributes || [];
      const adminName = cleanDisplayName(attrs.find((a) => a.Name === 'name')?.Value);
      adminEmail = cleanDisplayName(attrs.find((a) => a.Name === 'email')?.Value);
      if (adminName) {
        if (sub) setCachedProfile(cache, sub, adminName, nowFn, ttlMs);
        return adminName;
      }
    } catch {}
  }

  return (
    userInfoEmail ||
    cleanDisplayName(payload?.email) ||
    adminEmail ||
    cleanDisplayName(payload?.username) ||
    fallbackName
  );
}

const pubQuery = `SELECT a.id,a.slug,a.author_id,a.author_name,a.category_id,a.source_url,v.id AS version_id,v.title,v.summary,v.body,v.image,v.updated_at,c.name AS category_name,c.color,p.published_at,d.url AS document_url,d.title AS document_title FROM articles a JOIN article_versions v ON v.id=a.published_version JOIN categories c ON c.id=a.category_id JOIN publications p ON p.version_id=v.id LEFT JOIN source_documents d ON d.version_id=v.id`;
function fail(code, message) {
  throw Object.assign(new Error(message), { status: code });
}
async function jsonBody(req, max = 100000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) fail(413, 'Dữ liệu quá lớn');
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail(400, 'JSON không hợp lệ');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    fail(400, 'JSON không hợp lệ');
  return parsed;
}
function sessionToken(req) {
  return req.headers.cookie
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('campus_session='))
    ?.slice(15);
}

function safeDecode(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes('\0')) fail(400, 'Đường dẫn không hợp lệ');
    return decoded;
  } catch (error) {
    if (error instanceof URIError) fail(400, 'Đường dẫn không hợp lệ');
    throw error;
  }
}

const strongEtag = (payload) =>
  `"${createHash('sha256').update(JSON.stringify(payload)).digest('base64url').slice(0, 27)}"`;

function etagMatches(header, currentEtag) {
  if (typeof header !== 'string' || !currentEtag) return false;
  const trimmed = header.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  const normalize = (tag) => (tag.startsWith('W/') ? tag.slice(2) : tag);
  const target = normalize(currentEtag);
  const tokens = trimmed.match(/(?:^|,)\s*(?:W\/)?"[^"]*"/g);
  if (!tokens) return false;
  return tokens.some((token) => normalize(token.replace(/^\s*,\s*/, '').trim()) === target);
}

const need = (user, roles) => {
  if (!user) fail(401, 'Bạn cần đăng nhập');
  if (!roles.includes(user.role)) fail(403, 'Bạn không có quyền thực hiện thao tác này');
};

function validateArticle(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    fail(400, 'Dữ liệu bài viết không hợp lệ');
  const cleaned = {};
  for (const [key, max] of [
    ['title', 180],
    ['summary', 500],
    ['body', 50000],
  ]) {
    if (typeof data[key] !== 'string')
      fail(400, `Trường ${key} không hợp lệ (tối đa ${max} ký tự)`);
    const trimmed = data[key].trim();
    if (!trimmed || trimmed.length > max)
      fail(400, `Trường ${key} không hợp lệ (tối đa ${max} ký tự)`);
    cleaned[key] = trimmed;
  }
  if (typeof data.category_id !== 'string' || !data.category_id.trim()) fail(400, 'Chọn danh mục');
  cleaned.category_id = data.category_id.trim();
  if (data.image !== undefined && data.image !== null) {
    if (typeof data.image !== 'string') fail(400, 'Ảnh không hợp lệ');
    const image = data.image.trim();
    if (
      image &&
      !/^\/media\/[a-f0-9-]+\.(png|jpg|webp)$/.test(image) &&
      !/^\/assets\/news\/uth-\d+\.(png|jpg|webp)$/.test(image)
    )
      fail(400, 'Ảnh không hợp lệ');
    cleaned.image = image;
  }
  return cleaned;
}

async function audit(tx, user, action, article, id) {
  await tx.run(
    'INSERT INTO audit_events(id,actor_id,action,article_id,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), user.id, action, article, id, new Date().toISOString()],
  );
}

async function publishVersion(
  tx,
  { isPostgres, versionId, expectedStatuses, fallbackActorId, preferScheduledBy, requestId, now },
) {
  const [v] = await tx.all(
    'SELECT v.*,a.author_id,a.published_version,a.category_id AS article_category_id FROM article_versions v JOIN articles a ON a.id=v.article_id WHERE v.id=$1' +
      (isPostgres ? ' FOR UPDATE OF v, a' : ''),
    [versionId],
  );
  if (!v) fail(404, 'Không tìm thấy phiên bản');
  if (v.status === 'published') {
    if (v.published_version === versionId)
      return { ok: true, version_id: versionId, article_id: v.article_id, alreadyPublished: true };
    fail(409, 'Phiên bản đã được thay thế');
  }
  if (!expectedStatuses.includes(v.status)) fail(409, 'Trạng thái bài viết không phù hợp');
  const ts = now || new Date().toISOString();
  await tx.run(
    "UPDATE article_versions SET status='published',scheduled_at=NULL,scheduled_by=NULL,updated_at=$1 WHERE id=$2 AND status=$3",
    [ts, versionId, v.status],
  );
  const [current] = await tx.all('SELECT status FROM article_versions WHERE id=$1', [versionId]);
  if (!current || current.status !== 'published') fail(409, 'Bài đã thay đổi, hãy tải lại');
  await tx.run(
    "UPDATE article_versions SET status='superseded' WHERE article_id=$1 AND id!=$2 AND status='published'",
    [v.article_id, versionId],
  );
  const actorId = preferScheduledBy
    ? v.scheduled_by || fallbackActorId || 'scheduler'
    : fallbackActorId || v.scheduled_by || 'scheduler';
  await tx.run(
    'INSERT INTO publications(id,article_id,version_id,editor_id,published_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(version_id) DO NOTHING',
    [randomUUID(), v.article_id, versionId, actorId, ts],
  );
  await tx.run('UPDATE articles SET published_version=$1,category_id=$2 WHERE id=$3', [
    versionId,
    v.category_id || v.article_category_id,
    v.article_id,
  ]);
  await audit(tx, { id: actorId }, 'publish', v.article_id, requestId);
  return { ok: true, version_id: versionId, article_id: v.article_id, alreadyPublished: false };
}

let schedulerChain = Promise.resolve();
function runDueScheduler(
  db,
  { requestId = randomUUID(), actorId = 'scheduler', nowFn = Date.now } = {},
) {
  const task = schedulerChain.then(() =>
    db.transaction(async (tx) => {
      const isPostgres = db.dialect === 'postgres';
      const now = new Date(nowFn()).toISOString();
      const due = await tx.all(
        "SELECT v.id FROM article_versions v WHERE v.status='scheduled' AND v.scheduled_at IS NOT NULL AND v.scheduled_at<=$1 ORDER BY v.scheduled_at ASC" +
          (isPostgres ? ' FOR UPDATE OF v SKIP LOCKED' : ''),
        [now],
      );
      const published = [];
      for (const row of due) {
        const res = await publishVersion(tx, {
          isPostgres,
          versionId: row.id,
          expectedStatuses: ['scheduled'],
          fallbackActorId: actorId,
          preferScheduledBy: true,
          requestId,
          now,
        });
        if (!res.alreadyPublished) published.push(row.id);
      }
      return { ok: true, count: published.length, published };
    }),
  );
  schedulerChain = task.catch(() => {});
  return task;
}

export function createRequestHandler(deps = {}) {
  const isProd = deps.production ?? production;
  const isPublicReadOnly = deps.publicReadOnly ?? publicReadOnly;
  const bucket = deps.uploadBucket ?? process.env.UPLOAD_BUCKET;
  const uploadsDir = deps.uploadDirectory ?? uploadDirectory;
  const cognitoIssuer = deps.cognitoIssuer ?? process.env.COGNITO_ISSUER;
  const cognitoClientId = deps.cognitoClientId ?? process.env.COGNITO_CLIENT_ID;
  const cognitoDomain = deps.cognitoDomain ?? process.env.COGNITO_DOMAIN;
  const nowFn = deps.now || Date.now;
  const handlerProfiles = deps.cognitoProfiles || cognitoProfiles;
  const cacheTtlMs = deps.cacheTtlMs ?? COGNITO_CACHE_TTL_MS;

  async function userFor(req, db) {
    if (isProd) {
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!bearer) return null;
      try {
        let verifyFn = deps.jwtVerify;
        let jwksSet = deps.jwks;
        if (!verifyFn || !jwksSet) {
          const verifier = await getDefaultVerifier(cognitoIssuer);
          verifyFn = verifyFn || verifier.jwtVerify;
          jwksSet = jwksSet || verifier.jwks;
        }
        if (!verifyFn || !jwksSet) return null;
        const { payload } = await verifyFn(bearer, jwksSet, { issuer: cognitoIssuer });
        if (payload.token_use !== 'access' || payload.client_id !== cognitoClientId || !payload.sub)
          return null;
        const groups = payload['cognito:groups'] || [];
        const name = await resolveCognitoName(payload, bearer, {
          cognitoDomain,
          cognitoIssuer,
          fetchImpl: deps.fetchImpl,
          cognitoClient: deps.cognitoClient,
          cognitoProfiles: handlerProfiles,
          now: nowFn,
          cacheTtlMs,
        });
        return {
          id: payload.sub,
          name,
          role: groups.includes('editor')
            ? 'editor'
            : groups.includes('author')
              ? 'author'
              : 'reader',
        };
      } catch {
        return null;
      }
    }
    const token = sessionToken(req);
    if (!token) return null;
    const [user] = await db.all(
      'SELECT u.id,u.name,u.role,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',
      [createHash('sha256').update(token).digest('hex'), new Date(nowFn()).toISOString()],
    );
    return user || null;
  }

  return async function handleRequest(req, res) {
    const started = performance.now(),
      requestId = randomUUID();
    let url,
      badUrl = false;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      badUrl = true;
      url = new URL('/invalid-url', 'http://localhost');
    }
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://*.amazoncognito.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const send = (status, data) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
    };
    const sendNotModified = () => {
      res.writeHead(304);
      res.end();
    };
    const allowMethods = (...methods) => {
      if (!methods.includes(req.method)) fail(405, 'Phương thức không hỗ trợ');
    };
    res.on('finish', () => {
      if (url.pathname.startsWith('/api/'))
        console.log(
          JSON.stringify({
            requestId,
            method: req.method,
            path: url.pathname,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
          }),
        );
    });
    try {
      if (!['GET', 'HEAD', 'POST', 'PUT'].includes(req.method))
        fail(405, 'Phương thức không hỗ trợ');
      // Explicit public-only deployment while Cognito/S3 setup is pending; all writes fail closed.
      if (isPublicReadOnly && !['GET', 'HEAD'].includes(req.method))
        fail(503, 'Không gian biên tập chưa được kích hoạt.');
      if (badUrl) fail(400, 'Đường dẫn không hợp lệ');
      if (['POST', 'PUT'].includes(req.method)) {
        const expected =
          process.env.APP_ORIGIN || (req.headers.host ? `http://${req.headers.host}` : '');
        if (req.headers.origin && (!expected || req.headers.origin !== expected))
          fail(403, 'Nguồn request không hợp lệ');
        if (!req.headers.origin && req.headers['sec-fetch-site'] === 'cross-site')
          fail(403, 'Nguồn request không hợp lệ');
        if (!isProd && !req.headers.origin && req.headers['x-campus-client'] !== '1')
          fail(403, 'Thiếu xác nhận API client');
      }
      const db = deps.db || (await getDb());
      const isPostgres = db.dialect === 'postgres';
      let resolvedUser,
        userLoaded = false;
      const getUser = async () => {
        if (!userLoaded) {
          resolvedUser = isPublicReadOnly ? null : await userFor(req, db);
          userLoaded = true;
        }
        return resolvedUser;
      };
      if (url.pathname === '/health') {
        allowMethods('GET', 'HEAD');
        await db.all('SELECT 1');
        return send(200, { status: 'ok' });
      }
      if (url.pathname === '/api/config') {
        allowMethods('GET', 'HEAD');
        return send(200, {
          localAuth: !isProd,
          authAvailable: !isPublicReadOnly,
          cognitoDomain: cognitoDomain || '',
          clientId: cognitoClientId || '',
          redirectUri: process.env.APP_ORIGIN ? `${process.env.APP_ORIGIN}/` : '',
        });
      }
      if (url.pathname === '/api/auth/login') {
        allowMethods('POST');
        if (isProd) fail(404, 'Không tìm thấy');
        const ip = req.socket?.remoteAddress || 'unknown',
          now = nowFn(),
          record = attempts.get(ip);
        if (attempts.size >= 100) {
          for (const [k, v] of attempts) {
            if (v.until <= now) attempts.delete(k);
          }
          if (attempts.size > 5000) attempts.clear();
        }
        if (record && record.until > now && record.count >= 10) fail(429, 'Thử lại sau một phút');
        if (!record || record.until <= now) attempts.set(ip, { count: 1, until: now + 60000 });
        else record.count++;
        const { email, password } = await jsonBody(req);
        const [account] = await db.all('SELECT * FROM users WHERE email=$1', [
          typeof email === 'string' ? email.toLowerCase().trim() : '',
        ]);
        if (!account || !verifyPassword(password, account.password_hash))
          fail(401, 'Thông tin đăng nhập không đúng');
        const user = {
          id: account.id,
          name: account.name,
          role: account.role,
          email: account.email,
        };
        const token = randomBytes(32).toString('hex');
        await db.run('DELETE FROM sessions WHERE expires_at<$1', [new Date(now).toISOString()]);
        await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [
          createHash('sha256').update(token).digest('hex'),
          user.id,
          new Date(now + 8 * 3600000).toISOString(),
        ]);
        res.setHeader(
          'Set-Cookie',
          `campus_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
        );
        return send(200, user);
      }
      if (url.pathname === '/api/auth/me') {
        allowMethods('GET', 'HEAD');
        return send(200, { user: await getUser() });
      }
      if (url.pathname === '/api/auth/logout') {
        allowMethods('POST');
        await getUser();
        const token = sessionToken(req);
        if (token)
          await db.run('DELETE FROM sessions WHERE token_hash=$1', [
            createHash('sha256').update(token).digest('hex'),
          ]);
        res.setHeader('Set-Cookie', 'campus_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/auth/password') {
        allowMethods('POST');
        const user = await getUser();
        need(user, ['reader', 'author', 'editor']);
        const data = await jsonBody(req);
        if (typeof data.currentPassword !== 'string' || typeof data.newPassword !== 'string')
          fail(400, 'Nhập mật khẩu hiện tại và mật khẩu mới');
        if (isProd) {
          const { CognitoIdentityProviderClient, ChangePasswordCommand } =
            await import('@aws-sdk/client-cognito-identity-provider');
          const client = deps.cognitoClient || new CognitoIdentityProviderClient({});
          try {
            await client.send(
              new ChangePasswordCommand({
                AccessToken: req.headers.authorization.slice(7),
                PreviousPassword: data.currentPassword,
                ProposedPassword: data.newPassword,
              }),
            );
          } catch {
            fail(400, 'Mật khẩu hiện tại hoặc mật khẩu mới không hợp lệ');
          }
        } else {
          const [account] = await db.all('SELECT password_hash FROM users WHERE id=$1', [user.id]);
          if (!account) fail(401, 'Bạn cần đăng nhập');
          if (!verifyPassword(data.currentPassword, account.password_hash))
            fail(400, 'Mật khẩu hiện tại không đúng');
          let hash;
          try {
            hash = hashPassword(data.newPassword);
          } catch (e) {
            fail(400, e.message);
          }
          await db.transaction(async (tx) => {
            await tx.run('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
            await tx.run('DELETE FROM sessions WHERE user_id=$1', [user.id]);
          });
          res.setHeader('Set-Cookie', 'campus_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        }
        return send(200, { ok: true, reauthenticate: true });
      }
      if (url.pathname === '/api/categories') {
        if (req.method === 'POST') {
          need(await getUser(), ['editor']);
          const data = await jsonBody(req);
          const name = typeof data.name === 'string' ? data.name.trim() : '';
          if (!name || name.length > 80) fail(400, 'Tên danh mục không hợp lệ');
          const id = randomUUID();
          await db.run('INSERT INTO categories(id,name,color) VALUES($1,$2,$3)', [
            id,
            name,
            '#155b65',
          ]);
          return send(201, { id });
        }
        allowMethods('GET', 'HEAD');
        const categories = await db.all('SELECT * FROM categories ORDER BY name');
        const etag = strongEtag(categories);
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, must-revalidate');
        res.setHeader('ETag', etag);
        if (etagMatches(req.headers['if-none-match'], etag)) return sendNotModified();
        return send(200, categories);
      }
      if (url.pathname === '/api/users') {
        allowMethods('POST');
        need(await getUser(), ['editor']);
        const data = await jsonBody(req);
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          email.length > 254 ||
          !name ||
          name.length > 100 ||
          !['reader', 'author', 'editor'].includes(data.role)
        )
          fail(400, 'Thông tin tài khoản không hợp lệ');
        if (isProd) {
          const {
            CognitoIdentityProviderClient,
            AdminCreateUserCommand,
            AdminAddUserToGroupCommand,
          } = await import('@aws-sdk/client-cognito-identity-provider');
          const client = deps.cognitoClient || new CognitoIdentityProviderClient({});
          const pool = cognitoIssuer.split('/').at(-1);
          await client.send(
            new AdminCreateUserCommand({
              UserPoolId: pool,
              Username: email,
              UserAttributes: [
                { Name: 'email', Value: email },
                { Name: 'email_verified', Value: 'true' },
                { Name: 'name', Value: name },
              ],
              DesiredDeliveryMediums: ['EMAIL'],
            }),
          );
          await client.send(
            new AdminAddUserToGroupCommand({
              UserPoolId: pool,
              Username: email,
              GroupName: data.role,
            }),
          );
          return send(201, { ok: true });
        }
        let hash;
        try {
          hash = hashPassword(data.password);
        } catch (e) {
          fail(400, e.message);
        }
        await db.run('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [
          randomUUID(),
          email,
          name,
          data.role,
          hash,
        ]);
        return send(201, { ok: true });
      }
      if (url.pathname.startsWith('/api/public/')) {
        const isList = url.pathname === '/api/public/articles';
        const slugMatch = url.pathname.match(/^\/api\/public\/articles\/([^/]+)$/);
        if (!isList && !slugMatch) fail(404, 'API không tồn tại');
        allowMethods('GET', 'HEAD');
        const slug = slugMatch ? safeDecode(slugMatch[1]) : null;
        metrics.originRequests++;
        if (!originAvailable)
          return send(503, {
            error: 'Origin đang trong diễn tập sự cố',
            requestId,
          });
        metrics.publicReads++;
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, must-revalidate');
        if (isList) {
          const args = [],
            where = [];
          const category = url.searchParams.get('category'),
            rawQ = url.searchParams.get('q');
          if (category) {
            args.push(category);
            where.push(`a.category_id=$${args.length}`);
          }
          const q = rawQ ? rawQ.trim().normalize('NFC').slice(0, 100).toLocaleLowerCase('vi') : '';
          if (q) {
            args.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
            where.push(`LOWER(v.title || ' ' || v.summary) LIKE $${args.length} ESCAPE '\\'`);
          }
          const rows = await db.all(
            `${pubQuery}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY p.published_at DESC, a.id ASC LIMIT 100`,
            args,
          );
          const etag = strongEtag(rows);
          res.setHeader('ETag', etag);
          if (etagMatches(req.headers['if-none-match'], etag)) return sendNotModified();
          return send(200, rows);
        }
        const [article] = await db.all(`${pubQuery} WHERE a.slug=$1`, [slug]);
        if (!article) fail(404, 'Không tìm thấy bài viết');
        const etag = `"${article.version_id}"`;
        res.setHeader('ETag', etag);
        if (etagMatches(req.headers['if-none-match'], etag)) return sendNotModified();
        return send(200, article);
      }
      if (url.pathname === '/api/editorial') {
        allowMethods('GET', 'HEAD');
        const user = await getUser();
        need(user, ['author', 'editor']);
        const params = [];
        let filter =
          "v.status!='superseded' AND (v.status!='published' OR v.id=a.published_version)";
        if (user.role === 'author') {
          params.push(user.id);
          filter += ' AND a.author_id=$1';
        }
        return send(
          200,
          await db.all(
            `SELECT a.id,a.slug,a.author_id,a.author_name,a.published_version,v.*,COALESCE(v.category_id,a.category_id) AS category_id,c.name AS category_name FROM articles a JOIN article_versions v ON v.article_id=a.id JOIN categories c ON c.id=COALESCE(v.category_id,a.category_id) WHERE ${filter} ORDER BY v.updated_at DESC`,
            params,
          ),
        );
      }
      if (url.pathname === '/api/history') {
        allowMethods('GET', 'HEAD');
        const user = await getUser();
        need(user, ['author', 'editor']);
        return send(
          200,
          await db.all(
            `SELECT p.*,v.title,a.author_name FROM publications p JOIN article_versions v ON v.id=p.version_id JOIN articles a ON a.id=p.article_id ${user.role === 'author' ? 'WHERE a.author_id=$1' : ''} ORDER BY p.published_at DESC`,
            user.role === 'author' ? [user.id] : [],
          ),
        );
      }
      const archived = url.pathname.match(/^\/api\/history\/([^/]+)$/);
      if (archived) {
        allowMethods('GET', 'HEAD');
        const user = await getUser();
        need(user, ['author', 'editor']);
        const versionId = safeDecode(archived[1]);
        const [version] = await db.all(
          'SELECT v.*,COALESCE(v.category_id,a.category_id) AS category_id,a.author_id,a.author_name,a.slug,c.name AS category_name,p.published_at,d.url AS document_url,d.title AS document_title FROM publications p JOIN article_versions v ON v.id=p.version_id JOIN articles a ON a.id=p.article_id JOIN categories c ON c.id=COALESCE(v.category_id,a.category_id) LEFT JOIN source_documents d ON d.version_id=v.id WHERE v.id=$1',
          [versionId],
        );
        if (!version) fail(404, 'Không tìm thấy phiên bản đã xuất bản');
        if (user.role !== 'editor' && version.author_id !== user.id)
          fail(403, 'Bạn không có quyền xem phiên bản này');
        return send(200, version);
      }
      if (url.pathname === '/api/articles') {
        allowMethods('POST');
        const user = await getUser();
        need(user, ['author', 'editor']);
        const data = await jsonBody(req);
        const cleaned = validateArticle(data);
        if (!(await db.all('SELECT id FROM categories WHERE id=$1', [cleaned.category_id])).length)
          fail(400, 'Danh mục không tồn tại');
        const id = randomUUID(),
          version = randomUUID(),
          now = new Date(nowFn()).toISOString();
        await db.transaction(async (tx) => {
          await tx.run(
            'INSERT INTO articles(id,slug,author_id,author_name,category_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
            [id, `bai-viet-${id}`, user.id, user.name, cleaned.category_id, now],
          );
          await tx.run(
            'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at,category_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [
              version,
              id,
              cleaned.title,
              cleaned.summary,
              cleaned.body,
              cleaned.image || '',
              'draft',
              now,
              now,
              cleaned.category_id,
            ],
          );
          await audit(tx, user, 'create', id, requestId);
        });
        return send(201, { id, version_id: version });
      }
      const match = url.pathname.match(
        /^\/api\/versions\/([^/]+)(?:\/(submit|approve|reject|publish|schedule|unschedule))?$/,
      );
      if (match) {
        const version = safeDecode(match[1]);
        const action = match[2];
        if (!action) allowMethods('PUT');
        else allowMethods('POST');
        const user = await getUser();
        need(user, ['author', 'editor']);
        if (['approve', 'reject', 'publish', 'schedule', 'unschedule'].includes(action))
          need(user, ['editor']);
        const data = !action || action === 'schedule' ? await jsonBody(req) : null;
        const cleaned = !action ? validateArticle(data) : null;
        let scheduledAt = null;
        if (action === 'schedule') {
          const rawScheduledAt =
            typeof data?.scheduled_at === 'string' ? data.scheduled_at.trim() : '';
          const iso = rawScheduledAt.match(
            /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/i,
          );
          if (!iso) fail(400, 'Thời gian hẹn giờ không hợp lệ');
          const year = Number(iso[1]);
          const month = Number(iso[2]);
          const day = Number(iso[3]);
          const hour = Number(iso[4]);
          const minute = Number(iso[5]);
          const second = iso[6] === undefined ? 0 : Number(iso[6]);
          const fracMs = iso[7] ? Number(iso[7].slice(0, 3).padEnd(3, '0')) : 0;
          const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
          const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
            month - 1
          ];
          if (
            month < 1 ||
            month > 12 ||
            day < 1 ||
            day > daysInMonth ||
            hour > 23 ||
            minute > 59 ||
            second > 59
          )
            fail(400, 'Thời gian hẹn giờ không hợp lệ');
          let offsetMin = 0;
          if (iso[9]) {
            const tzHour = Number(iso[10]);
            const tzMin = Number(iso[11]);
            if (tzHour > 23 || tzMin > 59) fail(400, 'Thời gian hẹn giờ không hợp lệ');
            offsetMin = (iso[9] === '+' ? 1 : -1) * (tzHour * 60 + tzMin);
          }
          const baseUtc = new Date(0);
          baseUtc.setUTCFullYear(year, month - 1, day);
          baseUtc.setUTCHours(hour, minute, second, fracMs);
          const expectedMs = baseUtc.getTime() - offsetMin * 60000;
          const ms = Date.parse(rawScheduledAt);
          if (!Number.isFinite(ms) || ms !== expectedMs)
            fail(400, 'Thời gian hẹn giờ không hợp lệ');
          if (ms <= nowFn()) fail(400, 'Thời gian hẹn giờ phải ở tương lai');
          scheduledAt = new Date(ms).toISOString();
        }
        const result = await db.transaction(async (tx) => {
          if (action === 'publish') {
            need(user, ['editor']);
            const pub = await publishVersion(tx, {
              isPostgres,
              versionId: version,
              expectedStatuses: ['approved', 'scheduled'],
              fallbackActorId: user.id,
              preferScheduledBy: false,
              requestId,
              now: new Date(nowFn()).toISOString(),
            });
            return { ok: true, version_id: pub.version_id };
          }
          const [v] = await tx.all(
            'SELECT v.*,a.author_id,a.published_version FROM article_versions v JOIN articles a ON a.id=v.article_id WHERE v.id=$1' +
              (isPostgres ? ' FOR UPDATE OF v' : ''),
            [version],
          );
          if (!v) fail(404, 'Không tìm thấy phiên bản');
          if (user.role !== 'editor' && v.author_id !== user.id)
            fail(403, 'Bạn không có quyền sửa bài này');
          const now = new Date(nowFn()).toISOString();
          if (!action) {
            if (['submitted', 'approved', 'scheduled', 'superseded'].includes(v.status))
              fail(409, 'Bài đang trong quy trình duyệt');
            if (
              !(await tx.all('SELECT id FROM categories WHERE id=$1', [cleaned.category_id])).length
            )
              fail(400, 'Danh mục không tồn tại');
            const nextImage = typeof data.image === 'string' ? cleaned.image : v.image;
            // A published version is immutable. Editing creates an independent draft.
            if (v.status === 'published') {
              if (v.published_version !== version) fail(409, 'Phiên bản đã được thay thế');
              const next = randomUUID();
              await tx.run(
                'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at,category_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                [
                  next,
                  v.article_id,
                  cleaned.title,
                  cleaned.summary,
                  cleaned.body,
                  nextImage,
                  'draft',
                  now,
                  now,
                  cleaned.category_id,
                ],
              );
              await audit(tx, user, 'revise', v.article_id, requestId);
              return { version_id: next };
            }
            await tx.run(
              'UPDATE article_versions SET title=$1,summary=$2,body=$3,image=$4,category_id=$5,scheduled_at=NULL,scheduled_by=NULL,updated_at=$6,status=$7 WHERE id=$8',
              [
                cleaned.title,
                cleaned.summary,
                cleaned.body,
                nextImage,
                cleaned.category_id,
                now,
                'draft',
                version,
              ],
            );
            if (!v.published_version)
              await tx.run('UPDATE articles SET category_id=$1 WHERE id=$2', [
                cleaned.category_id,
                v.article_id,
              ]);
          } else if (action === 'schedule') {
            need(user, ['editor']);
            if (!['approved', 'scheduled'].includes(v.status))
              fail(409, 'Trạng thái bài viết không phù hợp');
            await tx.run(
              "UPDATE article_versions SET status='scheduled',scheduled_at=$1,scheduled_by=$2,updated_at=$3 WHERE id=$4 AND status=$5",
              [scheduledAt, user.id, now, version, v.status],
            );
            const [current] = await tx.all('SELECT status FROM article_versions WHERE id=$1', [
              version,
            ]);
            if (!current || current.status !== 'scheduled')
              fail(409, 'Bài đã thay đổi, hãy tải lại');
            await audit(tx, user, 'schedule', v.article_id, requestId);
            return {
              ok: true,
              version_id: version,
              status: 'scheduled',
              scheduled_at: scheduledAt,
            };
          } else if (action === 'unschedule') {
            need(user, ['editor']);
            if (v.status !== 'scheduled') fail(409, 'Trạng thái bài viết không phù hợp');
            await tx.run(
              "UPDATE article_versions SET status='approved',scheduled_at=NULL,scheduled_by=NULL,updated_at=$1 WHERE id=$2 AND status='scheduled'",
              [now, version],
            );
            const [current] = await tx.all('SELECT status FROM article_versions WHERE id=$1', [
              version,
            ]);
            if (!current || current.status !== 'approved')
              fail(409, 'Bài đã thay đổi, hãy tải lại');
            await audit(tx, user, 'unschedule', v.article_id, requestId);
            return { ok: true, version_id: version, status: 'approved' };
          } else {
            const transitions = {
              submit: [['draft', 'rejected'], 'submitted'],
              approve: [['submitted'], 'approved'],
              reject: [['submitted', 'approved', 'scheduled'], 'rejected'],
            };
            if (action !== 'submit') need(user, ['editor']);
            const [from, to] = transitions[action];
            if (!from.includes(v.status)) fail(409, 'Trạng thái bài viết không phù hợp');
            // Compare-and-set prevents concurrent state changes and duplicate publication.
            await tx.run(
              'UPDATE article_versions SET status=$1,scheduled_at=NULL,scheduled_by=NULL,updated_at=$2 WHERE id=$3 AND status=$4',
              [to, now, version, v.status],
            );
            const [current] = await tx.all('SELECT status FROM article_versions WHERE id=$1', [
              version,
            ]);
            if (!current || current.status !== to) fail(409, 'Bài đã thay đổi, hãy tải lại');
          }
          await audit(tx, user, action || 'edit', v.article_id, requestId);
          return { ok: true, version_id: version };
        });
        return send(200, result);
      }
      if (url.pathname === '/api/uploads') {
        allowMethods('POST');
        need(await getUser(), ['author', 'editor']);
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 5 * 1024 * 1024) fail(413, 'Ảnh tối đa 5 MB');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        let ext, type;
        if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          ext = 'png';
          type = 'image/png';
        } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
          ext = 'jpg';
          type = 'image/jpeg';
        } else if (
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP'
        ) {
          ext = 'webp';
          type = 'image/webp';
        } else fail(400, 'Chỉ hỗ trợ PNG, JPEG, WebP');
        const key = `${randomUUID()}.${ext}`;
        if (isProd) {
          const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
          await new S3Client({}).send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: bytes,
              ContentType: type,
            }),
          );
        } else {
          await mkdir(uploadsDir, { recursive: true });
          await writeFile(resolve(uploadsDir, key), bytes);
        }
        return send(201, { url: `/media/${key}` });
      }
      if (url.pathname.startsWith('/media/')) {
        allowMethods('GET', 'HEAD');
        const key = url.pathname.slice(7);
        if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(key)) fail(404, 'Không tìm thấy ảnh');
        const [published] = await db.all(
          'SELECT a.id FROM articles a JOIN article_versions v ON v.id=a.published_version WHERE v.image=$1',
          [url.pathname],
        );
        if (!published) {
          const user = await getUser();
          need(user, ['author', 'editor']);
          const own = await db.all(
            'SELECT a.id FROM articles a JOIN article_versions v ON v.article_id=a.id WHERE v.image=$1 AND a.author_id=$2',
            [url.pathname, user.id],
          );
          if (user.role !== 'editor' && !own.length) fail(403, 'Ảnh riêng tư');
        }
        // Uploads stay private and are never shared-cacheable, including draft images.
        if (isProd) {
          if (!bucket) fail(404, 'Không tìm thấy ảnh');
          const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
          const object = await new S3Client({}).send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
          );
          if (object.ContentType) res.setHeader('Content-Type', object.ContentType);
          if (req.method === 'HEAD') {
            if (typeof object.Body?.destroy === 'function') object.Body.destroy();
            return res.end();
          }
          return res.end(await object.Body.transformToByteArray());
        }
        const bytes = await readFile(resolve(uploadsDir, key));
        res.setHeader(
          'Content-Type',
          { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[extname(key).slice(1)],
        );
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      if (url.pathname === '/api/ops/metrics') {
        allowMethods('GET', 'HEAD');
        need(await getUser(), ['editor']);
        return send(200, { ...metrics, originAvailable });
      }
      if (url.pathname === '/api/ops/origin') {
        allowMethods('POST');
        need(await getUser(), ['editor']);
        if (isProd) fail(403, 'Dùng diễn tập hạ tầng đã lên kế hoạch trên AWS');
        const data = await jsonBody(req);
        if (typeof data.available !== 'boolean') fail(400, 'Trạng thái origin không hợp lệ');
        originAvailable = data.available;
        return send(200, { originAvailable });
      }
      if (url.pathname === '/api/ops/scheduler/run') {
        allowMethods('POST');
        const user = await getUser();
        need(user, ['editor']);
        return send(200, await runDueScheduler(db, { requestId, actorId: user.id, nowFn }));
      }
      if (url.pathname.startsWith('/api/')) fail(404, 'API không tồn tại');
      allowMethods('GET', 'HEAD');
      const path =
        url.pathname === '/' || url.pathname.startsWith('/article/')
          ? '/index.html'
          : safeDecode(url.pathname);
      const file = resolve(root, 'frontend', `.${path}`);
      if (
        !file.startsWith(resolve(root, 'frontend') + '/') &&
        !file.startsWith(resolve(root, 'frontend') + '\\')
      )
        fail(403, 'Đường dẫn không hợp lệ');
      const bytes = await readFile(file);
      res.setHeader(
        'Content-Type',
        {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
        }[extname(file).toLowerCase()] || 'application/octet-stream',
      );
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (
        error.code === '23505' ||
        (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(error.message)) ||
        error.name === 'UsernameExistsException'
      ) {
        error.status = 409;
        error.message = 'Thông tin này đã tồn tại';
      }
      const isNotFound =
        error.code === 'ENOENT' || error.code === 'EISDIR' || error.name === 'NoSuchKey';
      res.removeHeader('ETag');
      res.setHeader('Cache-Control', 'no-store');
      send(error.status || (isNotFound ? 404 : 500), {
        error: error.status
          ? error.message
          : isNotFound
            ? 'Không tìm thấy tài nguyên'
            : 'Không thể xử lý yêu cầu',
        requestId,
      });
      if (!error.status && !isNotFound)
        console.error(JSON.stringify({ requestId, error: error.name }));
    }
  };
}

export const requestHandler = createRequestHandler();

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await getDb();
  const server = http.createServer(requestHandler);
  let shuttingDown = false;
  let schedulerTimer = null;
  if (!publicReadOnly) {
    const intervalMs = Math.max(100, Number(process.env.SCHEDULER_INTERVAL_MS || 15000));
    schedulerTimer = setInterval(() => {
      if (!shuttingDown) {
        runDueScheduler(db).catch((err) =>
          console.error(JSON.stringify({ event: 'scheduler_error', error: err.message })),
        );
      }
    }, intervalMs);
    schedulerTimer.unref();
  }
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () =>
    console.log(`Campus News: http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      shuttingDown = true;
      if (schedulerTimer) clearInterval(schedulerTimer);
      server.close(async () => {
        await schedulerChain;
        await db.close();
        process.exit(0);
      });
    });
}
