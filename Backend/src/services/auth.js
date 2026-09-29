import crypto from 'node:crypto';
import { ApiError } from '../core/errors.js';
import { hmacHex, jwtDecode, jwtEncode, randomHex, safeEqual } from '../core/crypto.js';
import { appVersionOf, baseUrlOf, bearerToken, deviceIdOf, localeOf, userAgentOf } from '../core/http.js';
import { DEFAULT_NAME_RE, t } from '../core/i18n.js';
import { isUuid, uuidv7 } from '../core/ids.js';
import { cleanName, maskPhone } from '../core/text.js';
import { Validator } from '../core/validator.js';
import { Users } from './users.js';

const ACCESS_TTL = 900;
const REFRESH_TTL = 30 * 86400;
const REFRESH_GRACE = 30;
const OTP_TTL = 300;
const OTP_COOLDOWN = 60;
const OTP_MAX_ATTEMPTS = 5;
const SOCKET_TOKEN_TTL = 60;

/** "JovidxonChat/1.0 (Samsung SM-A515F; Android 14)" → "Samsung SM-A515F (Android 14)" */
export function deviceNameFromUserAgent(userAgent) {
  const match = /\(([^;()]{1,80});\s*Android\s+([0-9.]{1,10})\)/.exec(userAgent ?? '');
  return match ? `${match[1].trim()} (Android ${match[2]})` : null;
}

/** Маълумоти дастгоҳ аз бадан ё сарлавҳаҳо (31). */
export function clientOf(v, request) {
  let deviceName = v.string('device_name', { min: 1, max: 100 });
  if (!deviceName) deviceName = deviceNameFromUserAgent(userAgentOf(request));
  return {
    device_id: v.string('device_id', { min: 4, max: 64, pattern: /^[A-Za-z0-9._:-]+$/ }) || deviceIdOf(request),
    device_name: deviceName ? cleanName(deviceName) : null,
    platform: v.enum('platform', ['android', 'ios', 'web']) ?? 'android',
    app_version: v.string('app_version', { min: 1, max: 32, pattern: /^[A-Za-z0-9._+-]+$/ }) || appVersionOf(request),
    locale: v.enum('locale', ['tk', 'ru']) ?? localeOf(request),
    fcm_token: v.string('fcm_token', { min: 20, max: 512, pattern: /^[A-Za-z0-9:_\-.]+$/ }) || null,
  };
}

/** Профили нимтамом (ном — пешфарз, username нест) → Android ба экрани профил мебарад. */
export function profileIncomplete(user) {
  return !user.username && DEFAULT_NAME_RE.test(user.display_name ?? '');
}

/**
 * Воридшавӣ (05, 06, 18): телефон + OTP, Google, refresh-и ротатсияшаванда бо муайянкунии дуздӣ,
 * logout, токени WebSocket ва authentication-и ҳар дархост.
 */
export class Auth {
  constructor({ db, keys, config, settings, users, devices, sms, limiter, google, bus, log }) {
    Object.assign(this, { db, keys, config, settings, users, devices, sms, limiter, google, bus, log });
    this.touched = new Map();
  }

  // ------------------------------------------------------------------ токенҳо

  refreshToken(sessionId, generation, salt) {
    const mac = crypto.createHmac('sha256', this.keys.refresh).update(`rt1|${sessionId}|${generation}|${salt}`).digest('base64url');
    return `rt1.${sessionId}.${generation}.${mac}`;
  }

  static parseRefreshToken(token) {
    const match = /^rt1\.([0-9a-f-]{36})\.(\d{1,9})\.[A-Za-z0-9_-]{43}$/.exec(String(token ?? ''));
    if (!match || !isUuid(match[1])) return null;
    return { sessionId: match[1], generation: Number(match[2]) };
  }

  pair(userId, sessionId, generation, salt) {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: jwtEncode(
        { iss: 'jovidxonchat', sub: userId, sid: sessionId, iat: now, exp: now + ACCESS_TTL, jti: randomHex(8) },
        this.keys.access,
      ),
      refresh_token: this.refreshToken(sessionId, generation, salt),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      session_id: sessionId,
    };
  }

  async issue(userId, client, method, request) {
    const sessionId = uuidv7();
    const salt = randomHex(16);
    await this.db.exec(
      `INSERT INTO sessions (id, user_id, device_id, device_name, platform, app_version, auth_method, refresh_salt,
                             refresh_generation, refresh_expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now() + make_interval(secs => $9), $10, $11)`,
      [sessionId, userId, client.device_id, client.device_name, client.platform, client.app_version, method, salt,
        REFRESH_TTL, request.ip, userAgentOf(request)],
    );
    return this.pair(userId, sessionId, 1, salt);
  }

  async revokeSession(sessionId, reason, q = this.db) {
    const row = await q.one(
      'UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING user_id',
      [sessionId, reason],
    );
    if (row) await this.bus.publish({ t: 'session_revoked', session_id: sessionId, user_id: row.user_id }, q);
    return Boolean(row);
  }

  /** Ҳамаи сессияҳо ба ҷуз keep; бармегардонад сатрҳо (барои тоза кардани push-token). */
  async revokeAllExcept(userId, keepSessionId, reason, q = this.db) {
    const rows = await q.many(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $3
       WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)
       RETURNING id, device_id`,
      [userId, keepSessionId, reason],
    );
    for (const row of rows) await this.bus.publish({ t: 'session_revoked', session_id: row.id, user_id: userId }, q);
    return rows;
  }

  // ------------------------------------------------------------------ OTP

  otpHash(phone, code) {
    return hmacHex(this.keys.otp, `${phone}|${code}`);
  }

  async requestOtp(request) {
    const v = Validator.of(request.body);
    const phone = v.phone('phone');
    const client = clientOf(v, request);
    v.validate();

    await this.limiter.hit('otp_request_phone', `p:${phone}`);
    await this.limiter.hit('otp_request_phone_day', `p:${phone}`);
    if (client.device_id) await this.limiter.hit('otp_request_device', `d:${client.device_id}`);

    const since = await this.db.value(
      `SELECT EXTRACT(EPOCH FROM (now() - max(created_at)))::int FROM otp_codes WHERE phone = $1 AND delivery <> 'failed'`,
      [phone],
    );
    if (since !== null && since < OTP_COOLDOWN) {
      throw new ApiError('AUTH_OTP_COOLDOWN', {
        errors: [{ field: 'phone', code: 'AUTH_OTP_COOLDOWN', message_key: 'error_otp_cooldown' }],
        headers: { 'Retry-After': String(Math.max(1, OTP_COOLDOWN - since)) },
      });
    }

    const testCode = this.settings.testNumbers().get(phone) ?? null;
    const code = testCode ?? String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const id = uuidv7();
    await this.db.tx(async (tx) => {
      await tx.exec('UPDATE otp_codes SET consumed_at = now() WHERE phone = $1 AND consumed_at IS NULL', [phone]);
      await tx.exec(
        `INSERT INTO otp_codes (id, phone, code_hash, max_attempts, expires_at, ip, device_id, delivery)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6, $7, $8)`,
        [id, phone, this.otpHash(phone, code), OTP_MAX_ATTEMPTS, OTP_TTL, request.ip, client.device_id,
          testCode ? 'test' : 'pending'],
      );
    });

    if (testCode) {
      this.log?.warn({ phone: maskPhone(phone) }, 'otp_test_number');
    } else {
      const result = await this.sms.send(phone, t('otp_sms', client.locale, { code }), 'otp');
      await this.db.exec('UPDATE otp_codes SET delivery = $2 WHERE id = $1', [id, result.ok ? 'sent' : 'failed']);
      if (!result.ok) throw new ApiError('SMS_SEND_FAILED');
    }
    this.log?.info({ phone: maskPhone(phone) }, 'otp_requested');

    // is_new_user ҳамеша false: сабт будани рақам ошкор намешавад (зидди enumeration).
    return { phone, expires_in: OTP_TTL, resend_in: OTP_COOLDOWN, is_new_user: false };
  }

  async verifyOtpCode(phone, code) {
    await this.limiter.hit('otp_verify_phone', `p:${phone}`);
    const row = await this.db.one(
      `SELECT id, code_hash, attempts, max_attempts, (expires_at < now()) AS expired FROM otp_codes
       WHERE phone = $1 AND consumed_at IS NULL AND delivery <> 'failed'
       ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    if (!row) throw new ApiError('AUTH_OTP_EXPIRED');
    const consume = () => this.db.exec('UPDATE otp_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [row.id]);
    if (row.expired) {
      await consume();
      throw new ApiError('AUTH_OTP_EXPIRED');
    }
    if (row.attempts >= row.max_attempts) {
      await consume();
      throw new ApiError('AUTH_OTP_RATE_LIMITED');
    }
    if (!safeEqual(row.code_hash, this.otpHash(phone, code))) {
      const attempts = await this.db.value('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [row.id]);
      this.log?.warn({ phone: maskPhone(phone), attempt: attempts }, 'otp_failed');
      if (attempts >= row.max_attempts) {
        await consume();
        throw new ApiError('AUTH_OTP_RATE_LIMITED');
      }
      throw new ApiError('AUTH_OTP_INVALID', {
        errors: [{ field: 'code', code: 'AUTH_OTP_INVALID', message_key: 'error_otp_invalid' }],
      });
    }
    if ((await consume()) !== 1) throw new ApiError('AUTH_OTP_EXPIRED');
  }

  async verifyOtp(request) {
    const v = Validator.of(request.body);
    const phone = v.phone('phone');
    const code = v.string('code', { required: true, min: 4, max: 4, pattern: /^\d{4}$/ });
    const client = clientOf(v, request);
    v.validate();

    await this.verifyOtpCode(phone, code);

    let isNew = false;
    let user = await this.users.findByPhone(phone);
    if (!user) {
      if (!this.settings.get('registration_enabled')) throw new ApiError('REGISTRATION_CLOSED');
      try {
        user = await this.users.create({
          phone,
          displayName: t('default_name', client.locale, { suffix: phone.slice(-4) }),
          language: client.locale,
        });
        isNew = true;
      } catch (error) {
        if (error?.code !== '23505') throw error;
        user = await this.users.findByPhone(phone);
        if (!user) throw error;
      }
    }
    return this.completeSignIn(user, client, 'otp', isNew, request);
  }

  // ------------------------------------------------------------------ Google

  async googleSignIn(request) {
    const v = Validator.of(request.body);
    const idToken = v.string('id_token', {
      required: true,
      min: 20,
      max: 8192,
      pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    });
    const client = clientOf(v, request);
    v.validate();

    const audiences = this.settings.get('google_client_ids');
    if (!audiences || audiences.length === 0) throw new ApiError('AUTH_GOOGLE_NOT_CONFIGURED');

    const claims = await this.google.verify(idToken, audiences);
    const subject = claims.sub;
    const email = typeof claims.email === 'string' ? claims.email.slice(0, 191) : null;
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';

    let isNew = false;
    let link = await this.db.one("SELECT * FROM oauth_accounts WHERE provider = 'google' AND subject = $1", [subject]);
    let user = link ? await this.users.find(link.user_id) : null;
    if (!user) {
      if (!this.settings.get('registration_enabled')) throw new ApiError('REGISTRATION_CLOSED');
      let name = cleanName(typeof claims.name === 'string' ? claims.name : '').slice(0, 64);
      if (!name) name = t('default_name', client.locale, { suffix: String(crypto.randomInt(1000, 10000)) });
      try {
        user = await this.db.tx(async (tx) => {
          const created = await this.users.create({ displayName: name, language: client.locale }, tx);
          await tx.exec(
            `INSERT INTO oauth_accounts (id, user_id, provider, subject, email, email_verified, last_login_at)
             VALUES ($1, $2, 'google', $3, $4, $5, now())`,
            [uuidv7(), created.id, subject, email, emailVerified],
          );
          return created;
        });
        isNew = true;
      } catch (error) {
        if (error?.code !== '23505') throw error;
        // Дархости мувозӣ аллакай пайваст кард — ҳисоби ҳозираро истифода мебарем.
        link = await this.db.one("SELECT * FROM oauth_accounts WHERE provider = 'google' AND subject = $1", [subject]);
        user = link ? await this.users.find(link.user_id) : null;
        if (!user) throw error;
      }
    } else {
      await this.db.exec('UPDATE oauth_accounts SET last_login_at = now(), email = COALESCE($2, email) WHERE id = $1', [link.id, email]);
    }
    return this.completeSignIn(user, client, 'google', isNew, request);
  }

  async completeSignIn(user, client, method, isNew, request) {
    if (user.status === 'suspended') {
      this.log?.warn({ user_id: user.id }, 'login_suspended');
      throw new ApiError('ACCOUNT_SUSPENDED');
    }
    if (user.status !== 'active') throw new ApiError('AUTH_REFRESH_REVOKED');

    if (client.device_id) {
      await this.devices.upsert(user.id, client.device_id, client, client.fcm_token);
    }
    const tokens = await this.issue(user.id, client, method, request);
    await this.db.exec('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
    this.log?.info({ user_id: user.id, method, is_new: isNew }, 'login');

    const fresh = (await this.users.find(user.id)) ?? user;
    return {
      user: Users.presentSelf(fresh, client.locale),
      tokens,
      is_new_user: isNew || profileIncomplete(fresh),
    };
  }

  // ------------------------------------------------------------------ refresh / logout

  async refresh(request) {
    const v = Validator.of(request.body);
    const token = v.string('refresh_token', { required: true, min: 20, max: 512 });
    v.validate();

    const parsed = Auth.parseRefreshToken(token);
    if (!parsed) throw new ApiError('AUTH_REFRESH_REVOKED');
    const session = await this.db.one(
      `SELECT s.*, (s.refresh_expires_at < now()) AS expired,
              EXTRACT(EPOCH FROM (now() - s.rotated_at))::int AS rotated_ago
       FROM sessions s WHERE s.id = $1`,
      [parsed.sessionId],
    );
    if (!session || !safeEqual(this.refreshToken(session.id, parsed.generation, session.refresh_salt), token)) {
      this.log?.warn('refresh_invalid');
      throw new ApiError('AUTH_REFRESH_REVOKED');
    }
    if (session.revoked_at) throw new ApiError('AUTH_REFRESH_REVOKED');
    if (session.expired) {
      await this.revokeSession(session.id, 'expired');
      throw new ApiError('AUTH_REFRESH_REVOKED');
    }

    const current = session.refresh_generation;
    let tokens = null;
    if (parsed.generation === current) {
      const rotated = await this.db.exec(
        `UPDATE sessions SET refresh_generation = refresh_generation + 1, rotated_at = now(), last_active_at = now(),
           refresh_expires_at = now() + make_interval(secs => $3), app_version = COALESCE($4, app_version)
         WHERE id = $1 AND refresh_generation = $2 AND revoked_at IS NULL`,
        [session.id, current, REFRESH_TTL, appVersionOf(request)],
      );
      if (rotated === 1) {
        tokens = this.pair(session.user_id, session.id, current + 1, session.refresh_salt);
      } else {
        // Дархости мувозӣ пеш гузашт — ҳамон натиҷаро медиҳем.
        const again = await this.db.one('SELECT refresh_generation, revoked_at FROM sessions WHERE id = $1', [session.id]);
        if (again && !again.revoked_at && again.refresh_generation === current + 1) {
          tokens = this.pair(session.user_id, session.id, current + 1, session.refresh_salt);
        }
      }
    } else if (parsed.generation === current - 1 && session.rotated_ago !== null && session.rotated_ago <= REFRESH_GRACE) {
      tokens = this.pair(session.user_id, session.id, current, session.refresh_salt);
    }

    if (!tokens) {
      // Токени кӯҳна дубора истифода шуд — эҳтимоли дуздӣ: тамоми сессия бекор.
      await this.revokeSession(session.id, 'refresh_reuse');
      this.log?.warn({ user_id: session.user_id, session_id: session.id }, 'refresh_reuse_detected');
      throw new ApiError('AUTH_REFRESH_REVOKED');
    }

    const user = await this.users.find(session.user_id);
    if (!user || user.status === 'deleted') {
      await this.revokeSession(session.id, 'user_missing');
      throw new ApiError('AUTH_REFRESH_REVOKED');
    }
    if (user.status === 'suspended') {
      await this.revokeSession(session.id, 'suspended');
      throw new ApiError('ACCOUNT_SUSPENDED');
    }
    return { tokens };
  }

  async logout(request) {
    await this.revokeSession(request.session.id, 'logout');
    await this.devices.clearTokenForDevice(request.user.id, request.session.device_id);
    this.log?.info({ user_id: request.user.id }, 'logout');
    return { revoked: true };
  }

  /** Ҳамаи дастгоҳҳо, ба ҷуз ҳозира. */
  async logoutOthers(request) {
    const rows = await this.revokeAllExcept(request.user.id, request.session.id, 'logout_all');
    for (const row of rows) {
      if (row.device_id && row.device_id !== request.session.device_id) {
        await this.devices.clearTokenForDevice(request.user.id, row.device_id);
      }
    }
    this.log?.info({ user_id: request.user.id, count: rows.length }, 'logout_all');
    return { revoked_sessions: rows.length };
  }

  // ------------------------------------------------------------------ WebSocket

  /** Токени якдафъаинаи 60-сонияӣ барои WebSocket (32): токени HTTP дар WS истифода намешавад. */
  async socketToken(request) {
    const token = randomHex(32);
    await this.db.exec(
      `INSERT INTO socket_tokens (token_hash, user_id, session_id, device_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [hmacHex(this.keys.socket, token), request.user.id, request.session.id, request.session.device_id ?? null, SOCKET_TOKEN_TTL],
    );
    const base = baseUrlOf(request, this.config);
    return { token, expires_in: SOCKET_TOKEN_TTL, url: `${base.replace(/^http/, 'ws')}/api/v1/ws` };
  }

  /** Токени WS-ро як бор истифода мебарад → {user, session} ё null. */
  async consumeSocketToken(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const row = await this.db.one(
      `DELETE FROM socket_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id, session_id, device_id`,
      [hmacHex(this.keys.socket, token)],
    );
    if (!row) return null;
    const account = await this.db.one(
      `SELECT u.id, u.status, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.refresh_expires_at > now()`,
      [row.session_id, row.user_id],
    );
    if (!account || account.status !== 'active') return null;
    return { user: account, session: { id: row.session_id, device_id: row.device_id } };
  }

  // ------------------------------------------------------------------ authentication

  /** JWT → сессияи фаъол → корбари фаъол. Revoke ва suspend фавран амал мекунанд. */
  async authenticate(request) {
    const token = bearerToken(request);
    if (!token) throw new ApiError('AUTH_UNAUTHORIZED');
    const claims = jwtDecode(token, this.keys.access);
    if (!claims || claims.iss !== 'jovidxonchat' || !isUuid(claims.sub) || !isUuid(claims.sid)) {
      throw new ApiError('AUTH_TOKEN_EXPIRED');
    }
    const row = await this.db.one(
      `SELECT u.*, s.id AS s_id, s.device_id AS s_device_id, s.user_id AS s_user_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.revoked_at IS NULL AND s.refresh_expires_at > now()`,
      [claims.sid],
    );
    if (!row || row.s_user_id !== claims.sub || row.status === 'deleted') throw new ApiError('AUTH_REFRESH_REVOKED');
    if (row.status === 'suspended') throw new ApiError('ACCOUNT_SUSPENDED');

    const { s_id: sessionId, s_device_id: deviceId, s_user_id: _ignored, ...user } = row;
    request.user = user;
    request.session = { id: sessionId, device_id: deviceId };
    this.touch(user.id, sessionId);
  }

  /** last_seen ва last_active — на зиёда аз як бор дар 30 с (бе интизории ҷавоб). */
  touch(userId, sessionId) {
    const now = Date.now();
    const last = this.touched.get(sessionId) ?? 0;
    if (now - last < 30_000) return;
    this.touched.set(sessionId, now);
    if (this.touched.size > 50_000) this.touched.clear();
    this.db
      .query(
        `WITH u AS (UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING 1)
         UPDATE sessions SET last_active_at = now() WHERE id = $2`,
        [userId, sessionId],
      )
      .catch(() => {});
  }
}
