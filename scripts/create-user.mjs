import { randomUUID } from 'node:crypto';
import { connect, migrate } from '../backend/db.mjs';
import { hashPassword } from '../backend/passwords.mjs';
const {
  USER_EMAIL: email,
  USER_NAME: name,
  USER_PASSWORD: password,
  USER_ROLE: role = 'editor',
} = process.env;
if (!email || !name || !password || !['reader', 'author', 'editor'].includes(role))
  throw new Error(
    'Set USER_EMAIL, USER_NAME, USER_PASSWORD (12+ characters), USER_ROLE. No default accounts.',
  );
const db = await connect();
try {
  await migrate(db);
  await db.run('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [
    randomUUID(),
    email.toLowerCase().trim(),
    name,
    role,
    hashPassword(password),
  ]);
  console.log('Account created.');
} finally {
  await db.close();
}
