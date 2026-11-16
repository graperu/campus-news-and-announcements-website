import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256)
    throw new Error('Password must have 12-256 characters');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, hex] = (stored || '').split(':');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex'),
    actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
