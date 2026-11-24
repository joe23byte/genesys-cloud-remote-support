import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });

const DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Format: scrypt:N:r:p:<salt base64url>:<hash base64url> (no "$", so it survives .env and docker-compose files). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('Password must be at least 10 characters long');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, DEFAULTS.keylen, { N: DEFAULTS.N, r: DEFAULTS.r, p: DEFAULTS.p });
  return `scrypt:${DEFAULTS.N}:${DEFAULTS.r}:${DEFAULTS.p}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

export interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

export function parsePasswordHash(value: string): ParsedHash | null {
  const m = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{32,})$/.exec(value);
  if (!m) return null;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  if (N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  return { N, r, p, salt: Buffer.from(m[4]!, 'base64url'), key: Buffer.from(m[5]!, 'base64url') };
}

export async function verifyPassword(password: string, parsed: ParsedHash): Promise<boolean> {
  const key = await scrypt(password, parsed.salt, parsed.key.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: 128 * parsed.N * parsed.r * 2,
  });
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}
