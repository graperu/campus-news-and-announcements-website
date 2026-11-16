import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, migrate } from './db.mjs';
import { hashPassword, verifyPassword } from './passwords.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production';
if (
  production &&
  (!process.env.COGNITO_ISSUER || !process.env.COGNITO_CLIENT_ID || !process.env.UPLOAD_BUCKET)
)
  throw new Error('Production requires Cognito and a private S3 upload bucket');
const uploadDirectory = resolve(process.env.UPLOAD_PATH || resolve(root, 'data/uploads'));
const db = await connect();
await migrate(db);

const attempts = new Map(),
  metrics = {
    originRequests: 0,
    publicReads: 0,
    startedAt: new Date().toISOString(),
  };
let originAvailable = true;

let jwtVerify, jwks;
if (production) {
  const jose = await import('jose');
  jwtVerify = jose.jwtVerify;
  jwks = jose.createRemoteJWKSet(new URL(`${process.env.COGNITO_ISSUER}/.well-known/jwks.json`));
}
const pubQuery = `SELECT a.id,a.slug,a.author_id,a.author_name,a.category_id,a.source_url,v.id AS version_id,v.title,v.summary,v.body,v.image,v.updated_at,c.name AS category_name,c.color,p.published_at FROM articles a JOIN article_versions v ON v.id=a.published_version JOIN categories c ON c.id=a.category_id JOIN publications p ON p.version_id=v.id`;
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail(400, 'JSON không hợp lệ');
  }
}

async function userFor(req) {
  if (production) {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer) return null;
    try {
      const { payload } = await jwtVerify(bearer, jwks, {
        issuer: process.env.COGNITO_ISSUER,
      });
      if (payload.token_use !== 'access' || payload.client_id !== process.env.COGNITO_CLIENT_ID)
        return null;
      const groups = payload['cognito:groups'] || [];
      return {
        id: payload.sub,
        name: payload.username || 'Biên tập viên',
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
  const token = req.headers.cookie
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('campus_session='))
    ?.slice(15);
  if (!token) return null;
  const [user] = await db.all(
    'SELECT u.id,u.name,u.role,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',
    [createHash('sha256').update(token).digest('hex'), new Date().toISOString()],
  );
  return user || null;
}
const need = (user, roles) => {
  if (!user) fail(401, 'Bạn cần đăng nhập');
  if (!roles.includes(user.role)) fail(403, 'Bạn không có quyền thực hiện thao tác này');
};
function validateArticle(data) {
  for (const [key, max] of [
    ['title', 180],
    ['summary', 500],
    ['body', 50000],
  ])
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > max)
      fail(400, `Trường ${key} không hợp lệ (tối đa ${max} ký tự)`);
  if (typeof data.category_id !== 'string') fail(400, 'Chọn danh mục');
  if (
    data.image &&
    !/^\/media\/[a-f0-9-]+\.(png|jpg|webp)$/.test(data.image) &&
    !/^\/assets\/campus-[0-2]\.svg$/.test(data.image)
  )
    fail(400, 'Ảnh không hợp lệ');
}
async function audit(tx, user, action, article, id) {
  await tx.run(
    'INSERT INTO audit_events(id,actor_id,action,article_id,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), user.id, action, article, id, new Date().toISOString()],
  );
}
const server = http.createServer(async (req, res) => {
  const started = performance.now(),
    requestId = randomUUID();
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.amazoncognito.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const send = (status, data) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(data));
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
    if (!['GET', 'HEAD', 'POST', 'PUT'].includes(req.method)) fail(405, 'Phương thức không hỗ trợ');
    if (['POST', 'PUT'].includes(req.method)) {
      const expected = process.env.APP_ORIGIN || `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== expected)
        fail(403, 'Nguồn request không hợp lệ');
      if (!req.headers.origin && req.headers['sec-fetch-site'] === 'cross-site')
        fail(403, 'Nguồn request không hợp lệ');
      if (!production && !req.headers.origin && req.headers['x-campus-client'] !== '1')
        fail(403, 'Thiếu xác nhận API client');
    }
    if (url.pathname === '/health') {
      await db.all('SELECT 1');
      return send(200, { status: 'ok' });
    }
    if (url.pathname === '/api/config')
      return send(200, {
        localAuth: !production,
        cognitoDomain: process.env.COGNITO_DOMAIN || '',
        clientId: process.env.COGNITO_CLIENT_ID || '',
        redirectUri: process.env.APP_ORIGIN ? `${process.env.APP_ORIGIN}/` : '',
      });
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (production) fail(404, 'Không tìm thấy');
      const ip = req.socket.remoteAddress,
        now = Date.now(),
        record = attempts.get(ip);
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
      await db.run('DELETE FROM sessions WHERE expires_at<$1', [new Date().toISOString()]);
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
    const user = await userFor(req);
    if (url.pathname === '/api/auth/me') return send(200, { user });
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = req.headers.cookie?.match(/campus_session=([^;]+)/)?.[1];
      if (token)
        await db.run('DELETE FROM sessions WHERE token_hash=$1', [
          createHash('sha256').update(token).digest('hex'),
        ]);
      res.setHeader('Set-Cookie', 'campus_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/auth/password' && req.method === 'POST') {
      need(user, ['reader', 'author', 'editor']);
      const data = await jsonBody(req);
      if (typeof data.currentPassword !== 'string' || typeof data.newPassword !== 'string')
        fail(400, 'Nhập mật khẩu hiện tại và mật khẩu mới');
      if (production) {
        const { CognitoIdentityProviderClient, ChangePasswordCommand } =
          await import('@aws-sdk/client-cognito-identity-provider');
        try {
          await new CognitoIdentityProviderClient({}).send(
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
    if (url.pathname === '/api/categories' && req.method === 'POST') {
      need(user, ['editor']);
      const data = await jsonBody(req);
      if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80)
        fail(400, 'Tên danh mục không hợp lệ');
      const id = randomUUID();
      await db.run('INSERT INTO categories(id,name,color) VALUES($1,$2,$3)', [
        id,
        data.name.trim(),
        '#155b65',
      ]);
      return send(201, { id });
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      need(user, ['editor']);
      const data = await jsonBody(req);
      if (
        typeof data.email !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ||
        data.email.length > 254 ||
        typeof data.name !== 'string' ||
        !data.name.trim() ||
        data.name.length > 100 ||
        !['reader', 'author', 'editor'].includes(data.role)
      )
        fail(400, 'Thông tin tài khoản không hợp lệ');
      if (production) {
        const {
          CognitoIdentityProviderClient,
          AdminCreateUserCommand,
          AdminAddUserToGroupCommand,
        } = await import('@aws-sdk/client-cognito-identity-provider');
        const client = new CognitoIdentityProviderClient({});
        const pool = process.env.COGNITO_ISSUER.split('/').at(-1);
        await client.send(
          new AdminCreateUserCommand({
            UserPoolId: pool,
            Username: data.email,
            UserAttributes: [
              { Name: 'email', Value: data.email },
              { Name: 'name', Value: data.name },
            ],
            DesiredDeliveryMediums: ['EMAIL'],
          }),
        );
        await client.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: pool,
            Username: data.email,
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
        data.email.toLowerCase().trim(),
        data.name,
        data.role,
        hash,
      ]);
      return send(201, { ok: true });
    }
    if (url.pathname === '/api/categories') {
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, must-revalidate');
      return send(200, await db.all('SELECT * FROM categories ORDER BY name'));
    }
    if (url.pathname.startsWith('/api/public/')) {
      metrics.originRequests++;
      if (!originAvailable)
        return send(503, {
          error: 'Origin đang trong diễn tập sự cố',
          requestId,
        });
      metrics.publicReads++;
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, must-revalidate');
      if (url.pathname === '/api/public/articles') {
        const args = [],
          where = [];
        const category = url.searchParams.get('category'),
          q = url.searchParams.get('q');
        if (category) {
          args.push(category);
          where.push(`a.category_id=$${args.length}`);
        }
        if (q) {
          args.push(`%${q.slice(0, 100).toLowerCase()}%`);
          where.push(`LOWER(v.title || ' ' || v.summary) LIKE $${args.length}`);
        }
        return send(
          200,
          await db.all(
            `${pubQuery}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY p.published_at DESC LIMIT 100`,
            args,
          ),
        );
      }
      const slug = decodeURIComponent(url.pathname.slice('/api/public/articles/'.length));
      const [article] = await db.all(`${pubQuery} WHERE a.slug=$1`, [slug]);
      if (!article) fail(404, 'Không tìm thấy bài viết');
      res.setHeader('ETag', `"${article.version_id}"`);
      return send(200, article);
    }
    if (url.pathname === '/api/editorial' && req.method === 'GET') {
      need(user, ['author', 'editor']);
      return send(
        200,
        await db.all(
          `SELECT a.id,a.slug,a.author_id,a.author_name,a.category_id,v.*,c.name AS category_name FROM articles a JOIN article_versions v ON v.article_id=a.id JOIN categories c ON c.id=a.category_id ${user.role === 'author' ? 'WHERE a.author_id=$1' : ''} ORDER BY v.updated_at DESC`,
          user.role === 'author' ? [user.id] : [],
        ),
      );
    }
    if (url.pathname === '/api/history') {
      need(user, ['author', 'editor']);
      return send(
        200,
        await db.all(
          `SELECT p.*,v.title,a.author_name FROM publications p JOIN article_versions v ON v.id=p.version_id JOIN articles a ON a.id=p.article_id ${user.role === 'author' ? 'WHERE a.author_id=$1' : ''} ORDER BY p.published_at DESC`,
          user.role === 'author' ? [user.id] : [],
        ),
      );
    }
    if (url.pathname === '/api/articles' && req.method === 'POST') {
      need(user, ['author', 'editor']);
      const data = await jsonBody(req);
      validateArticle(data);
      if (!(await db.all('SELECT id FROM categories WHERE id=$1', [data.category_id])).length)
        fail(400, 'Danh mục không tồn tại');
      const id = randomUUID(),
        version = randomUUID(),
        now = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx.run(
          'INSERT INTO articles(id,slug,author_id,author_name,category_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [id, `bai-viet-${id}`, user.id, user.name, data.category_id, now],
        );
        await tx.run(
          'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            version,
            id,
            data.title.trim(),
            data.summary.trim(),
            data.body.trim(),
            data.image || '',
            'draft',
            now,
            now,
          ],
        );
        await audit(tx, user, 'create', id, requestId);
      });
      return send(201, { id, version_id: version });
    }
    const match = url.pathname.match(
      /^\/api\/versions\/([^/]+)(?:\/(submit|approve|reject|publish))?$/,
    );
    if (match) {
      need(user, ['author', 'editor']);
      const [, version, action] = match;
      if (!['POST', 'PUT'].includes(req.method)) fail(405, 'Phương thức không hỗ trợ');
      const data = !action ? await jsonBody(req) : null;
      if (data) validateArticle(data);
      const result = await db.transaction(async (tx) => {
        const [v] = await tx.all(
          'SELECT v.*,a.author_id FROM article_versions v JOIN articles a ON a.id=v.article_id WHERE v.id=$1' +
            (process.env.DATABASE_URL ? ' FOR UPDATE OF v' : ''),
          [version],
        );
        if (!v) fail(404, 'Không tìm thấy phiên bản');
        if (user.role !== 'editor' && v.author_id !== user.id)
          fail(403, 'Bạn không có quyền sửa bài này');
        const now = new Date().toISOString();
        if (!action) {
          if (v.status === 'submitted' || v.status === 'approved')
            fail(409, 'Bài đang trong quy trình duyệt');
          // A published version is immutable. Editing creates an independent draft.
          if (v.status === 'published') {
            const next = randomUUID();
            await tx.run(
              'INSERT INTO article_versions(id,article_id,title,summary,body,image,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                next,
                v.article_id,
                data.title,
                data.summary,
                data.body,
                data.image || v.image,
                'draft',
                now,
                now,
              ],
            );
            await audit(tx, user, 'revise', v.article_id, requestId);
            return { version_id: next };
          }
          await tx.run(
            'UPDATE article_versions SET title=$1,summary=$2,body=$3,image=$4,updated_at=$5,status=$6 WHERE id=$7',
            [data.title, data.summary, data.body, data.image || v.image, now, 'draft', version],
          );
        } else {
          const transitions = {
            submit: [['draft', 'rejected'], 'submitted'],
            approve: [['submitted'], 'approved'],
            reject: [['submitted', 'approved'], 'rejected'],
            publish: [['approved'], 'published'],
          };
          if (action !== 'submit') need(user, ['editor']);
          if (action === 'publish' && v.status === 'published')
            return { ok: true, version_id: version };
          const [from, to] = transitions[action];
          if (!from.includes(v.status)) fail(409, 'Trạng thái bài viết không phù hợp');
          // Compare-and-set prevents concurrent state changes and duplicate publication.
          await tx.run(
            'UPDATE article_versions SET status=$1,updated_at=$2 WHERE id=$3 AND status=$4',
            [to, now, version, v.status],
          );
          const [current] = await tx.all('SELECT status FROM article_versions WHERE id=$1', [
            version,
          ]);
          if (current.status !== to) fail(409, 'Bài đã thay đổi, hãy tải lại');
          if (action === 'publish') {
            await tx.run(
              'INSERT INTO publications(id,article_id,version_id,editor_id,published_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(version_id) DO NOTHING',
              [randomUUID(), v.article_id, version, user.id, now],
            );
            await tx.run('UPDATE articles SET published_version=$1 WHERE id=$2', [
              version,
              v.article_id,
            ]);
          }
        }
        await audit(tx, user, action || 'edit', v.article_id, requestId);
        return { ok: true, version_id: version };
      });
      return send(200, result);
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      need(user, ['author', 'editor']);
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
      if (production) {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        await new S3Client({}).send(
          new PutObjectCommand({
            Bucket: process.env.UPLOAD_BUCKET,
            Key: key,
            Body: bytes,
            ContentType: type,
          }),
        );
      } else {
        await mkdir(uploadDirectory, { recursive: true });
        await writeFile(resolve(uploadDirectory, key), bytes);
      }
      return send(201, { url: `/media/${key}` });
    }
    if (url.pathname.startsWith('/media/')) {
      const key = url.pathname.slice(7);
      if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(key)) fail(404, 'Không tìm thấy ảnh');
      const [published] = await db.all(
        'SELECT a.id FROM articles a JOIN article_versions v ON v.id=a.published_version WHERE v.image=$1',
        [url.pathname],
      );
      if (!published) {
        need(user, ['author', 'editor']);
        const own = await db.all(
          'SELECT a.id FROM articles a JOIN article_versions v ON v.article_id=a.id WHERE v.image=$1 AND a.author_id=$2',
          [url.pathname, user.id],
        );
        if (user.role !== 'editor' && !own.length) fail(403, 'Ảnh riêng tư');
      }
      // Uploads stay private and are never shared-cacheable, including draft images.
      if (production) {
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const object = await new S3Client({}).send(
          new GetObjectCommand({ Bucket: process.env.UPLOAD_BUCKET, Key: key }),
        );
        res.setHeader('Content-Type', object.ContentType);
        return res.end(await object.Body.transformToByteArray());
      }
      res.setHeader(
        'Content-Type',
        { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[extname(key).slice(1)],
      );
      return res.end(await readFile(resolve(uploadDirectory, key)));
    }
    if (url.pathname === '/api/ops/metrics') {
      need(user, ['editor']);
      return send(200, { ...metrics, originAvailable });
    }
    if (url.pathname === '/api/ops/origin' && req.method === 'POST') {
      need(user, ['editor']);
      if (production) fail(403, 'Dùng diễn tập hạ tầng đã lên kế hoạch trên AWS');
      originAvailable = (await jsonBody(req)).available !== false;
      return send(200, { originAvailable });
    }
    if (url.pathname.startsWith('/api/')) fail(404, 'API không tồn tại');
    const path =
      url.pathname === '/' || url.pathname.startsWith('/article/') ? '/index.html' : url.pathname;
    const file = resolve(root, 'frontend', `.${decodeURIComponent(path)}`);
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
      }[extname(file)] || 'application/octet-stream',
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
    res.setHeader('Cache-Control', 'no-store');
    send(error.status || (error.code === 'ENOENT' || error.name === 'NoSuchKey' ? 404 : 500), {
      error: error.status
        ? error.message
        : error.code === 'ENOENT'
          ? 'Không tìm thấy tài nguyên'
          : 'Không thể xử lý yêu cầu',
      requestId,
    });
    if (!error.status && error.code !== 'ENOENT')
      console.error(JSON.stringify({ requestId, error: error.name }));
  }
});
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () =>
  console.log(`Campus News: http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(async () => {
      await db.close();
      process.exit(0);
    }),
  );
