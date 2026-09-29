import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/** Калидҳои ҷудо аз як APP_SECRET (HKDF-SHA256) — ҳар вазифа калиди худро дорад. */
export class Keys {
  constructor(appSecret) {
    const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', appSecret, Buffer.alloc(0), info, 32));
    this.access = derive('jovidxon-access-v1');
    this.refresh = derive('jovidxon-refresh-v1');
    this.otp = derive('jovidxon-otp-v1');
    this.settings = derive('jovidxon-settings-v1');
    this.admin = derive('jovidxon-admin-v1');
    this.limiter = derive('jovidxon-ratelimit-v1');
    this.socket = derive('jovidxon-socket-v1');
  }
}

export function hmacHex(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------- JWT (HS256)

export function jwtEncode(claims, key) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Имзо ва мӯҳлатро месанҷад; нодуруст → null. */
export function jwtDecode(token, key, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  if (!safeEqual(expected, signature)) return null;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (head?.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    if (typeof claims.exp !== 'number' || claims.exp < now) return null;
    return claims;
  } catch {
    return null;
  }
}

// ------------------------------------------------- AES-256-GCM (танзимоти махфӣ, TOTP)

export function seal(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${data.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

/** Рамзкушоӣ; калиди дигар ё маълумоти вайрон → null. */
export function unseal(key, sealed) {
  if (typeof sealed !== 'string') return null;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- Паролҳо (scrypt)

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password).normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${Buffer.from(hash).toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Барои вақти баробар ҳатто бе ҳисоб.
    await scrypt('x', 'salt', 16, { N: 1024, r: 8, p: 1 });
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, Buffer.from(actual));
}

// --------------------------------------------------------------- TOTP (RFC 6238)

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** ±1 қадам (30 с) барои фарқи соат. Бармегардонад counter-и мувофиқ ё null. */
export function verifyTotp(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code ?? ''))) return null;
  const counter = Math.floor(now / 30000);
  for (const delta of [0, -1, 1]) {
    if (safeEqual(totpCode(secret, counter + delta), code)) return counter + delta;
  }
  return null;
}
