import crypto from 'node:crypto';
import { ApiError } from '../core/errors.js';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Тафтиши Google ID token дар сервер (06): имзои RS256 бо калидҳои ҷамъиятии Google (JWKS,
 * бо кэш аз рӯи Cache-Control), iss, aud (Web client ID), мӯҳлат ва sub.
 */
export class GoogleVerifier {
  constructor({ log }) {
    this.log = log;
    this.keys = new Map();
    this.expiresAt = 0;
    this.lastForcedFetch = 0;
    this.fetching = null;
  }

  /** Барои тестҳо: JWKS-и сохта. */
  setKeysForTesting(jwks, ttlMs = 3_600_000) {
    this.keys = GoogleVerifier.parseJwks(jwks);
    this.expiresAt = Date.now() + ttlMs;
  }

  static parseJwks(jwks) {
    const map = new Map();
    for (const jwk of jwks?.keys ?? []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.n || !jwk.e) continue;
      try {
        map.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch {
        // калиди вайрон — нодида
      }
    }
    return map;
  }

  async fetchKeys() {
    this.fetching ??= (async () => {
      try {
        const response = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
        if (response.status !== 200) throw new Error(`http_${response.status}`);
        const keys = GoogleVerifier.parseJwks(await response.json());
        if (keys.size === 0) throw new Error('empty_jwks');
        const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '');
        const seconds = Math.min(86_400, Math.max(300, maxAge ? Number(maxAge[1]) : 3600));
        this.keys = keys;
        this.expiresAt = Date.now() + seconds * 1000;
      } catch (error) {
        this.log?.error({ error: String(error?.message ?? error) }, 'google_jwks_fetch_failed');
        throw new ApiError('AUTH_GOOGLE_INVALID', { messageKey: 'error_google_failed', status: 503 });
      } finally {
        this.fetching = null;
      }
    })();
    return this.fetching;
  }

  async keyFor(kid) {
    if (Date.now() >= this.expiresAt || this.keys.size === 0) await this.fetchKeys();
    let key = this.keys.get(kid);
    // Google калидҳоро иваз мекунад: kid-и нав → як бор (на зудтар аз 1 дақиқа) аз нав гирифтан.
    if (!key && Date.now() - this.lastForcedFetch > 60_000) {
      this.lastForcedFetch = Date.now();
      await this.fetchKeys();
      key = this.keys.get(kid);
    }
    return key ?? null;
  }

  async verify(idToken, audiences) {
    const parts = String(idToken).split('.');
    if (parts.length !== 3 || idToken.length > 8192) throw new ApiError('AUTH_GOOGLE_INVALID');
    const [header64, payload64, signature64] = parts;
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(header64, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8'));
    } catch {
      throw new ApiError('AUTH_GOOGLE_INVALID');
    }
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !claims || typeof claims !== 'object') {
      throw new ApiError('AUTH_GOOGLE_INVALID');
    }

    const key = await this.keyFor(header.kid);
    if (!key) {
      this.log?.warn('google_unknown_kid');
      throw new ApiError('AUTH_GOOGLE_INVALID');
    }
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${header64}.${payload64}`), key, Buffer.from(signature64, 'base64url'));
    if (!valid) {
      this.log?.warn('google_bad_signature');
      throw new ApiError('AUTH_GOOGLE_INVALID');
    }

    const now = Math.floor(Date.now() / 1000);
    const aud = claims.aud;
    const audienceOk = typeof aud === 'string' ? audiences.includes(aud) : Array.isArray(aud) && aud.some((a) => audiences.includes(a));
    if (
      !ISSUERS.includes(String(claims.iss ?? '')) ||
      !audienceOk ||
      typeof claims.exp !== 'number' ||
      claims.exp < now - 60 ||
      (typeof claims.iat === 'number' && claims.iat > now + 300) ||
      typeof claims.sub !== 'string' ||
      claims.sub === '' ||
      claims.sub.length > 191
    ) {
      this.log?.warn('google_claims_rejected');
      throw new ApiError('AUTH_GOOGLE_INVALID');
    }
    return claims;
  }
}
