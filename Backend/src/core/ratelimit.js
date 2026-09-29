import { ApiError } from './errors.js';
import { hmacHex } from './crypto.js';

/**
 * Rate limit (05, 14, 18): bucket → [max, window_seconds, error_code, key, store].
 * key: ip | user | custom. store: db — ҳисоб дар PostgreSQL (барои ҳамаи instance-ҳо ва
 * пас аз restart); memory — ҳадди умумии зуд дар хотираи ҳамин instance.
 * Калиди шахс (IP, телефон) хом нигоҳ дошта намешавад — танҳо HMAC.
 */
export const LIMITS = {
  public_ip: [120, 60, 'RATE_LIMITED', 'ip', 'memory'],
  user_api: [300, 60, 'RATE_LIMITED', 'user', 'memory'],

  otp_request_ip: [20, 3600, 'AUTH_OTP_RATE_LIMITED', 'ip', 'db'],
  otp_request_phone: [5, 3600, 'AUTH_OTP_RATE_LIMITED', 'custom', 'db'],
  otp_request_phone_day: [10, 86400, 'AUTH_OTP_RATE_LIMITED', 'custom', 'db'],
  otp_request_device: [10, 3600, 'AUTH_OTP_RATE_LIMITED', 'custom', 'db'],
  otp_verify_ip: [60, 900, 'AUTH_OTP_RATE_LIMITED', 'ip', 'db'],
  otp_verify_phone: [12, 900, 'AUTH_OTP_RATE_LIMITED', 'custom', 'db'],
  google_ip: [30, 900, 'RATE_LIMITED', 'ip', 'db'],
  refresh_ip: [60, 60, 'RATE_LIMITED', 'ip', 'memory'],
  socket_token: [60, 60, 'RATE_LIMITED', 'user', 'memory'],
  ws_connect_ip: [120, 60, 'RATE_LIMITED', 'ip', 'memory'],

  search: [60, 60, 'RATE_LIMITED', 'user', 'memory'],
  search_phone: [100, 3600, 'RATE_LIMITED', 'user', 'db'],
  send_message: [120, 60, 'RATE_LIMITED', 'user', 'memory'],
  typing: [90, 60, 'RATE_LIMITED', 'user', 'memory'],
  upload: [200, 3600, 'RATE_LIMITED', 'user', 'db'],
  chat_create: [60, 3600, 'RATE_LIMITED', 'user', 'db'],
  group_create: [20, 86400, 'RATE_LIMITED', 'user', 'db'],
  group_join: [30, 3600, 'RATE_LIMITED', 'user', 'db'],
  story_create: [30, 86400, 'RATE_LIMITED', 'user', 'db'],
  report: [10, 3600, 'RATE_LIMITED', 'user', 'db'],
  block: [30, 3600, 'RATE_LIMITED', 'user', 'db'],
  profile_update: [30, 3600, 'RATE_LIMITED', 'user', 'db'],
  account_delete: [3, 86400, 'RATE_LIMITED', 'user', 'db'],
  call_create: [30, 3600, 'RATE_LIMITED', 'user', 'db'],
  call_signal: [600, 60, 'RATE_LIMITED', 'user', 'memory'],

  admin_login_ip: [20, 900, 'RATE_LIMITED', 'ip', 'db'],
  admin_setup_ip: [10, 3600, 'RATE_LIMITED', 'ip', 'db'],
  admin_api: [600, 60, 'RATE_LIMITED', 'user', 'memory'],
  sms_test: [10, 3600, 'RATE_LIMITED', 'user', 'db'],
};

export class RateLimiter {
  constructor({ db, keys, multiplier = 1, log }) {
    this.db = db;
    this.key = keys.limiter;
    this.multiplier = Math.max(1, multiplier);
    this.log = log;
    this.memory = new Map();
    this.cleanup = setInterval(() => this.sweep(), 60_000);
    this.cleanup.unref?.();
  }

  close() {
    clearInterval(this.cleanup);
  }

  sweep(now = Math.floor(Date.now() / 1000)) {
    for (const [bucket, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(bucket);
    }
  }

  /** Барои route: калид аз рӯи тавсиф (ip ё user). */
  async hitFor(name, request) {
    const def = LIMITS[name];
    if (!def) return;
    const identity = def[3] === 'user' && request.user ? `u:${request.user.id}` : `ip:${request.ip}`;
    await this.hit(name, identity);
  }

  async hit(name, identity, cost = 1) {
    const def = LIMITS[name];
    if (!def) return;
    const [baseMax, window, code, , store] = def;
    const max = baseMax * this.multiplier;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / window) * window;
    const expiresAt = windowStart + window;
    const bucket = `${name}:${hmacHex(this.key, identity).slice(0, 40)}`;

    let hits;
    if (store === 'memory') {
      const entry = this.memory.get(bucket);
      if (!entry || entry.windowStart !== windowStart) {
        hits = cost;
        this.memory.set(bucket, { windowStart, hits, expiresAt });
      } else {
        entry.hits += cost;
        hits = entry.hits;
      }
    } else {
      hits = await this.db.value(
        `INSERT INTO rate_limits (bucket, window_start, hits, expires_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + EXCLUDED.hits
         RETURNING hits`,
        [bucket, windowStart, cost, expiresAt],
      );
    }

    if (hits > max) {
      const retryAfter = Math.max(1, expiresAt - now);
      if (hits === max + 1) this.log?.warn({ bucket: name, retry_after: retryAfter }, 'rate_limited');
      throw new ApiError(code, { headers: { 'Retry-After': String(retryAfter) } });
    }
  }
}
