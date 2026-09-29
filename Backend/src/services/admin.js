import crypto from 'node:crypto';
import os from 'node:os';
import { ApiError, fail } from '../core/errors.js';
import {
  hashPassword,
  hmacHex,
  newTotpSecret,
  safeEqual,
  seal,
  unseal,
  verifyPassword,
  verifyTotp,
} from '../core/crypto.js';
import { normalizeUuid, uuidv7 } from '../core/ids.js';
import { cleanName, likeEscape, maskPhone, normalizePhone, randomToken } from '../core/text.js';
import { Validator, queryInt } from '../core/validator.js';
import { pendingMigrations } from '../db/migrate.js';
import { isUniqueViolation } from '../db/pool.js';
import { messagePreview } from '../presenters.js';
import { Settings } from './settings.js';
import { iso } from './users.js';

export const ADMIN_COOKIE = 'jc_admin';
const IDLE_MINUTES = 30;
const ABSOLUTE_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const ROLE_RANK = { support: 1, moderator: 2, super_admin: 3 };

/** Ҳуқуқҳо (19, 40): support — дидан; moderator — блок/шикоят; super_admin — ҳама. */
export const ADMIN_PERMISSIONS = {
  'dashboard.view': 'support',
  'users.view': 'support',
  'users.phone': 'moderator',
  'users.moderate': 'moderator',
  'users.delete': 'super_admin',
  'groups.view': 'support',
  'groups.delete': 'moderator',
  'reports.view': 'support',
  'reports.resolve': 'moderator',
  'sms.view': 'moderator',
  'sms.test': 'super_admin',
  'settings.manage': 'super_admin',
  'admins.manage': 'super_admin',
  'audit.view': 'super_admin',
  'system.view': 'support',
};

export function can(admin, permission) {
  const required = ADMIN_PERMISSIONS[permission];
  return Boolean(required && admin && ROLE_RANK[admin.role] >= ROLE_RANK[required]);
}

function presentAdmin(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    totp_enabled: Boolean(row.totp_enabled),
    disabled: Boolean(row.disabled_at),
    last_login_at: iso(row.last_login_at),
    created_at: iso(row.created_at),
    permissions: Object.keys(ADMIN_PERMISSIONS).filter((p) => can(row, p)),
  };
}

function pageOf(query) {
  const page = queryInt(query, 'page', 1, 1, 100_000);
  const perPage = queryInt(query, 'per_page', 25, 1, 100);
  return { page, perPage, offset: (page - 1) * perPage };
}

function checkPassword(v, field, username) {
  const password = v.string(field, { required: true, min: 10, max: 128, trim: false });
  if (password && username && password.toLowerCase().includes(username.toLowerCase())) v.fail(field, 'format');
  return password;
}

/**
 * Панели админ (19, 40): воридшавӣ бо парол (+ TOTP ихтиёрӣ), сессия дар cookie-и HttpOnly/SameSite=Strict,
 * CSRF-токен, ролҳо, аудити ҳар амал. Пароли админ танҳо ҳамчун hash (scrypt) дар база.
 */
export class Admin {
  constructor(ctx) {
    this.ctx = ctx;
    this.setupCodeHash = null;
  }

  get db() {
    return this.ctx.db;
  }

  // ================================================================ setup (админи аввал)

  async needsSetup() {
    return (await this.db.value('SELECT count(*) FROM admin_users')) === 0;
  }

  /** Ҳангоми оғоз: агар админ набошад ва ADMIN_SETUP_CODE дода нашуда бошад — рамз дар лог. */
  async prepareSetup() {
    if (!(await this.needsSetup())) return null;
    if (this.ctx.config.adminSetupCode) {
      this.ctx.log?.warn('admin_setup_required: open /admin and enter ADMIN_SETUP_CODE from the Render environment');
      return null;
    }
    const code = `${randomToken(4, '23456789ABCDEFGHJKLMNPQRSTUVWXYZ')}-${randomToken(4, '23456789ABCDEFGHJKLMNPQRSTUVWXYZ')}-${randomToken(4, '23456789ABCDEFGHJKLMNPQRSTUVWXYZ')}`;
    this.setupCodeHash = hmacHex(this.ctx.keys.admin, `setup|${code}`);
    this.ctx.log?.warn({ setup_code: code }, 'admin_setup_required: open /admin and enter this setup code');
    return code;
  }

  /**
   * ADMIN_RESET="username:password" (env): пароли админро иваз, қулф ва 2FA-ро пок мекунад ва ҳамаи
   * сессияҳояшро бекор мекунад. Барои вақте ки пароль фаромӯш шудааст ва Shell нест.
   */
  async applyReset() {
    const raw = this.ctx.config.adminReset;
    if (!raw) return false;
    const index = raw.indexOf(':');
    const username = index > 0 ? raw.slice(0, index).trim().toLowerCase() : '';
    const password = index > 0 ? raw.slice(index + 1) : '';
    if (!username || password.length < 10) {
      this.ctx.log?.error('admin_reset_invalid: use ADMIN_RESET=username:password (password ≥ 10 chars)');
      return false;
    }
    const admin = await this.db.one('SELECT id, password_changed_at FROM admin_users WHERE username = $1', [username]);
    if (!admin) {
      this.ctx.log?.error({ username }, 'admin_reset_unknown_user');
      return false;
    }
    // Як бор: агар ҳамин пароль аллакай гузошта шуда бошад, дубора иваз намекунем.
    const row = await this.db.one('SELECT password_hash FROM admin_users WHERE id = $1', [admin.id]);
    if (await verifyPassword(password, row.password_hash)) {
      this.ctx.log?.warn('admin_reset_already_applied: remove ADMIN_RESET from the environment');
      return false;
    }
    await this.db.exec(
      `UPDATE admin_users SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL,
         totp_enabled = false, totp_secret = NULL, totp_last_counter = NULL, disabled_at = NULL WHERE id = $1`,
      [admin.id, await hashPassword(password)],
    );
    await this.db.exec('UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [admin.id]);
    await this.audit({ id: admin.id, username: 'env' }, null, 'admin.password_reset_env', `admin:${admin.id}`);
    this.ctx.log?.warn({ username }, 'admin_reset_applied: now remove ADMIN_RESET from the environment');
    return true;
  }

  setupCodeValid(code) {
    const given = String(code ?? '').trim();
    if (!given) return false;
    if (this.ctx.config.adminSetupCode) return safeEqual(given, this.ctx.config.adminSetupCode);
    return this.setupCodeHash !== null && safeEqual(hmacHex(this.ctx.keys.admin, `setup|${given.toUpperCase()}`), this.setupCodeHash);
  }

  async setupStatus() {
    return { needs_setup: await this.needsSetup() };
  }

  async setup(request, reply) {
    await this.ctx.limiter.hit('admin_setup_ip', `ip:${request.ip}`);
    const v = Validator.of(request.body);
    const code = v.string('setup_code', { required: true, max: 200 });
    const username = v.string('username', { required: true, min: 3, max: 40, pattern: /^[a-zA-Z0-9_.-]+$/ });
    const displayName = v.string('display_name', { max: 80 }) ?? '';
    const password = checkPassword(v, 'password', username);
    v.validate();
    if (!(await this.needsSetup())) throw new ApiError('ADMIN_SETUP_DONE');
    if (!this.setupCodeValid(code)) {
      this.ctx.log?.warn({ ip: request.ip }, 'admin_setup_bad_code');
      throw fail.field('setup_code', 'format');
    }
    const id = uuidv7();
    await this.db.exec(
      "INSERT INTO admin_users (id, username, password_hash, role, display_name) VALUES ($1, $2, $3, 'super_admin', $4)",
      [id, username.toLowerCase(), await hashPassword(password), cleanName(displayName) || username],
    );
    this.setupCodeHash = null;
    await this.audit({ id, username }, request, 'admin.setup', `admin:${id}`);
    const admin = await this.db.one('SELECT * FROM admin_users WHERE id = $1', [id]);
    return this.startSession(admin, request, reply);
  }

  // ================================================================ сессия

  tokenHash(token) {
    return hmacHex(this.ctx.keys.admin, `session|${token}`);
  }

  csrfFor(token) {
    return hmacHex(this.ctx.keys.admin, `csrf|${token}`).slice(0, 48);
  }

  cookieOptions() {
    return {
      path: '/api/v1/admin',
      httpOnly: true,
      secure: this.ctx.config.isProduction,
      sameSite: 'strict',
      maxAge: ABSOLUTE_HOURS * 3600,
    };
  }

  async startSession(admin, request, reply) {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.db.exec(
      `INSERT INTO admin_sessions (id, admin_id, token_hash, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
      [uuidv7(), admin.id, this.tokenHash(token), request.ip, String(request.headers['user-agent'] ?? '').slice(0, 255), ABSOLUTE_HOURS],
    );
    reply.setCookie(ADMIN_COOKIE, token, this.cookieOptions());
    return { admin: presentAdmin(admin), csrf_token: this.csrfFor(token) };
  }

  /** preHandler барои /api/v1/admin/* (ба ҷуз setup/login). */
  async authenticate(request) {
    const token = request.cookies?.[ADMIN_COOKIE];
    if (!token || token.length > 100) throw new ApiError('AUTH_UNAUTHORIZED');
    const row = await this.db.one(
      `SELECT s.id AS session_id, s.last_seen_at AS session_seen, a.*
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND s.last_seen_at > now() - make_interval(mins => $2) AND a.disabled_at IS NULL`,
      [this.tokenHash(token), IDLE_MINUTES],
    );
    if (!row) throw new ApiError('AUTH_UNAUTHORIZED');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !safeEqual(csrf, this.csrfFor(token))) throw fail.forbidden('error_csrf');
    }
    const { session_id: sessionId, session_seen: seen, ...admin } = row;
    request.admin = admin;
    request.adminSession = { id: sessionId, token };
    if (Date.now() - new Date(seen).getTime() > 60_000) {
      this.db.exec('UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1', [sessionId]).catch(() => {});
    }
    await this.ctx.limiter.hit('admin_api', `a:${admin.id}`);
  }

  require(request, permission) {
    if (!can(request.admin, permission)) throw fail.forbidden();
  }

  async audit(admin, request, action, target = null, details = null) {
    await this.db
      .exec('INSERT INTO admin_audit_logs (admin_id, actor, action, target, details, ip) VALUES ($1, $2, $3, $4, $5, $6)', [
        admin?.id ?? null,
        admin?.username ?? 'system',
        action,
        target,
        details ? JSON.stringify(details) : null,
        request?.ip ?? null,
      ])
      .catch((error) => this.ctx.log?.error({ err: { message: error.message } }, 'audit_failed'));
  }

  async login(request, reply) {
    await this.ctx.limiter.hit('admin_login_ip', `ip:${request.ip}`);
    const v = Validator.of(request.body);
    const username = v.string('username', { required: true, max: 40 });
    const password = v.string('password', { required: true, max: 128, trim: false });
    const totp = v.string('totp_code', { max: 10 });
    v.validate();

    const admin = await this.db.one('SELECT * FROM admin_users WHERE username = $1', [username.toLowerCase()]);
    const invalid = () => new ApiError('AUTH_UNAUTHORIZED', { messageKey: 'error_admin_credentials' });
    if (!admin || admin.disabled_at) {
      await verifyPassword(password, null);
      throw invalid();
    }
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      const retry = Math.ceil((new Date(admin.locked_until).getTime() - Date.now()) / 1000);
      throw new ApiError('ADMIN_LOCKED', { headers: { 'Retry-After': String(retry) } });
    }
    const failed = async () => {
      const row = await this.db.one(
        `UPDATE admin_users SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE id = $1 RETURNING failed_attempts`,
        [admin.id, MAX_FAILED, LOCK_MINUTES],
      );
      if (row.failed_attempts >= MAX_FAILED) {
        await this.db.exec('UPDATE admin_users SET failed_attempts = 0 WHERE id = $1', [admin.id]);
        await this.audit(admin, request, 'admin.locked');
      }
      this.ctx.log?.warn({ admin_id: admin.id }, 'admin_login_failed');
    };
    if (!(await verifyPassword(password, admin.password_hash))) {
      await failed();
      throw invalid();
    }
    if (admin.totp_enabled) {
      if (!totp) throw new ApiError('ADMIN_TOTP_REQUIRED');
      const secret = unseal(this.ctx.keys.settings, admin.totp_secret);
      const counter = secret ? verifyTotp(secret, totp) : null;
      if (counter === null || (admin.totp_last_counter !== null && counter <= Number(admin.totp_last_counter))) {
        await failed();
        throw new ApiError('AUTH_UNAUTHORIZED', { messageKey: 'error_admin_totp' });
      }
      await this.db.exec('UPDATE admin_users SET totp_last_counter = $2 WHERE id = $1', [admin.id, counter]);
    }
    await this.db.exec('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [admin.id]);
    await this.audit(admin, request, 'admin.login');
    return this.startSession(admin, request, reply);
  }

  async logout(request, reply) {
    await this.db.exec('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1', [request.adminSession.id]);
    reply.clearCookie(ADMIN_COOKIE, { path: '/api/v1/admin' });
    return { logged_out: true };
  }

  me(request) {
    return { admin: presentAdmin(request.admin), csrf_token: this.csrfFor(request.adminSession.token) };
  }

  async changePassword(request) {
    const v = Validator.of(request.body);
    const current = v.string('current_password', { required: true, max: 128, trim: false });
    const next = checkPassword(v, 'new_password', request.admin.username);
    v.validate();
    if (!(await verifyPassword(current, request.admin.password_hash))) throw fail.field('current_password', 'format');
    await this.db.exec('UPDATE admin_users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [
      request.admin.id,
      await hashPassword(next),
    ]);
    await this.db.exec('UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL', [
      request.admin.id,
      request.adminSession.id,
    ]);
    await this.audit(request.admin, request, 'admin.password_changed');
    return { updated: true };
  }

  async totpSetup(request) {
    const secret = newTotpSecret();
    await this.db.exec('UPDATE admin_users SET totp_secret = $2, totp_enabled = false WHERE id = $1', [
      request.admin.id,
      seal(this.ctx.keys.settings, secret),
    ]);
    const label = encodeURIComponent(`JovidxonChat:${request.admin.username}`);
    return { secret, otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=JovidxonChat&algorithm=SHA1&digits=6&period=30` };
  }

  async totpEnable(request) {
    const v = Validator.of(request.body);
    const code = v.string('code', { required: true, pattern: /^\d{6}$/ });
    v.validate();
    const row = await this.db.one('SELECT totp_secret FROM admin_users WHERE id = $1', [request.admin.id]);
    const secret = row?.totp_secret ? unseal(this.ctx.keys.settings, row.totp_secret) : null;
    const counter = secret ? verifyTotp(secret, code) : null;
    if (counter === null) throw fail.field('code', 'format');
    await this.db.exec('UPDATE admin_users SET totp_enabled = true, totp_last_counter = $2 WHERE id = $1', [request.admin.id, counter]);
    await this.audit(request.admin, request, 'admin.totp_enabled');
    return { enabled: true };
  }

  async totpDisable(request) {
    const v = Validator.of(request.body);
    const password = v.string('password', { required: true, max: 128, trim: false });
    v.validate();
    if (!(await verifyPassword(password, request.admin.password_hash))) throw fail.field('password', 'format');
    await this.db.exec('UPDATE admin_users SET totp_enabled = false, totp_secret = NULL, totp_last_counter = NULL WHERE id = $1', [
      request.admin.id,
    ]);
    await this.audit(request.admin, request, 'admin.totp_disabled');
    return { enabled: false };
  }

  // ================================================================ dashboard

  async stats(request) {
    this.require(request, 'dashboard.view');
    const [users, messages, chats, media, reports, sms, push, misc] = await Promise.all([
      this.db.one(`SELECT count(*) FILTER (WHERE status <> 'deleted') AS total,
          count(*) FILTER (WHERE status = 'active' AND last_seen_at > now() - interval '24 hours') AS active_24h,
          count(*) FILTER (WHERE status = 'active' AND last_seen_at > now() - interval '7 days') AS active_7d,
          count(*) FILTER (WHERE created_at > date_trunc('day', now())) AS new_today,
          count(*) FILTER (WHERE status = 'suspended') AS suspended,
          count(*) FILTER (WHERE status = 'deleted') AS deleted
        FROM users`),
      this.db.one(`SELECT count(*) AS total,
          count(*) FILTER (WHERE created_at > date_trunc('day', now())) AS today,
          count(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d
        FROM messages WHERE deleted_at IS NULL`),
      this.db.one(`SELECT count(*) FILTER (WHERE type = 'private') AS private, count(*) FILTER (WHERE type = 'group') AS groups
        FROM conversations WHERE deleted_at IS NULL`),
      this.db.many(`SELECT kind, count(*) AS count, COALESCE(sum(size_bytes), 0) AS bytes
        FROM media_files WHERE deleted_at IS NULL AND status = 'ready' GROUP BY kind`),
      this.db.one(`SELECT count(*) FILTER (WHERE status = 'open') AS open, count(*) FILTER (WHERE status = 'in_review') AS in_review FROM reports`),
      this.db.one(`SELECT count(*) FILTER (WHERE status = 'sent' AND created_at > date_trunc('day', now())) AS sent_today,
          count(*) FILTER (WHERE status = 'failed' AND created_at > date_trunc('day', now())) AS failed_today,
          count(*) FILTER (WHERE status = 'sent' AND created_at > now() - interval '30 days') AS sent_30d,
          count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '30 days') AS failed_30d
        FROM sms_logs`),
      this.db.one(`SELECT (SELECT count(*) FROM devices WHERE fcm_token IS NOT NULL) AS devices,
          count(*) FILTER (WHERE status = 'sent' AND created_at > date_trunc('day', now())) AS sent_today,
          count(*) FILTER (WHERE status = 'failed' AND created_at > date_trunc('day', now())) AS failed_today
        FROM push_outbox`),
      this.db.one(`SELECT (SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND refresh_expires_at > now()) AS sessions,
          (SELECT count(*) FROM stories WHERE deleted_at IS NULL AND expires_at > now()) AS stories,
          (SELECT count(*) FROM calls WHERE created_at > date_trunc('day', now())) AS calls_today,
          pg_database_size(current_database()) AS db_bytes`),
    ]);
    const byKind = Object.fromEntries(media.map((m) => [m.kind, { count: Number(m.count), bytes: Number(m.bytes) }]));
    return {
      users,
      messages,
      chats,
      media: {
        count: media.reduce((sum, m) => sum + Number(m.count), 0),
        bytes: media.reduce((sum, m) => sum + Number(m.bytes), 0),
        by_kind: byKind,
      },
      reports,
      sms,
      push: { ...push, enabled: this.ctx.push.enabled() },
      sessions: { active: misc.sessions },
      stories: { live: misc.stories },
      calls: { today: misc.calls_today },
      database: { size_bytes: Number(misc.db_bytes) },
      realtime: { connections: this.ctx.hub.connectionCount(), listener: this.ctx.bus.connected },
    };
  }

  async daily(request) {
    this.require(request, 'dashboard.view');
    const days = queryInt(request.query, 'days', 14, 1, 90);
    const rows = await this.db.many(
      `SELECT d::date AS day,
         (SELECT count(*) FROM messages m WHERE m.created_at >= d AND m.created_at < d + interval '1 day') AS messages,
         (SELECT count(*) FROM users u WHERE u.created_at >= d AND u.created_at < d + interval '1 day') AS new_users,
         (SELECT count(DISTINCT m.sender_id) FROM messages m WHERE m.created_at >= d AND m.created_at < d + interval '1 day') AS active_senders
       FROM generate_series(date_trunc('day', now()) - make_interval(days => $1 - 1), date_trunc('day', now()), interval '1 day') d
       ORDER BY d`,
      [days],
    );
    return { days: rows.map((r) => ({ ...r, day: iso(r.day)?.slice(0, 10) })) };
  }

  // ================================================================ корбарон

  presentUserRow(row, request) {
    return {
      id: row.id,
      display_name: row.status === 'deleted' ? '' : row.display_name,
      username: row.username,
      phone: can(request.admin, 'users.phone') ? row.phone : maskPhone(row.phone),
      status: row.status,
      status_reason: row.status_reason,
      avatar_media_id: row.avatar_media_id,
      created_at: iso(row.created_at),
      last_seen_at: iso(row.last_seen_at),
      messages_count: row.messages_count !== undefined ? Number(row.messages_count) : undefined,
    };
  }

  async users(request) {
    this.require(request, 'users.view');
    const { page, perPage, offset } = pageOf(request.query);
    const q = String(request.query.q ?? '').trim();
    const status = ['active', 'suspended', 'deleted'].includes(request.query.status) ? request.query.status : null;
    const where = [];
    const params = [];
    if (status) {
      params.push(status);
      where.push(`u.status = $${params.length}`);
    }
    if (q) {
      const id = normalizeUuid(q);
      const phone = normalizePhone(q);
      if (id) {
        params.push(id);
        where.push(`u.id = $${params.length}`);
      } else if (phone) {
        params.push(phone);
        where.push(`u.phone = $${params.length}`);
      } else if (/^\+?\d{3,}$/.test(q) && can(request.admin, 'users.phone')) {
        params.push(`%${q.replace(/\D/g, '')}%`);
        where.push(`u.phone LIKE $${params.length}`);
      } else {
        params.push(`%${likeEscape(q.toLowerCase().replace(/^@/, ''))}%`);
        where.push(`(lower(u.display_name) LIKE $${params.length} OR u.username LIKE $${params.length})`);
      }
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.value(`SELECT count(*) FROM users u ${filter}`, params);
    const rows = await this.db.many(
      `SELECT u.*, (SELECT count(*) FROM messages m WHERE m.sender_id = u.id) AS messages_count
       FROM users u ${filter} ORDER BY u.created_at DESC LIMIT ${perPage} OFFSET ${offset}`,
      params,
    );
    return { items: rows.map((row) => this.presentUserRow(row, request)), total, page, per_page: perPage };
  }

  async userDetail(request) {
    this.require(request, 'users.view');
    const id = normalizeUuid(request.params.id);
    const user = id ? await this.db.one('SELECT * FROM users WHERE id = $1', [id]) : null;
    if (!user) throw fail.notFound();
    const [sessions, devices, stats, oauth] = await Promise.all([
      this.db.many(
        `SELECT id, device_name, platform, app_version, auth_method, ip, created_at, last_active_at, revoked_at, revoke_reason
         FROM sessions WHERE user_id = $1 ORDER BY last_active_at DESC LIMIT 30`,
        [id],
      ),
      this.db.many(
        'SELECT device_id, device_name, platform, app_version, locale, (fcm_token IS NOT NULL) AS push, last_active_at FROM devices WHERE user_id = $1',
        [id],
      ),
      this.db.one(
        `SELECT (SELECT count(*) FROM messages WHERE sender_id = $1) AS messages,
           (SELECT count(*) FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
              WHERE cm.user_id = $1 AND c.type = 'group' AND c.deleted_at IS NULL) AS groups,
           (SELECT count(*) FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
              WHERE cm.user_id = $1 AND c.type = 'private' AND c.deleted_at IS NULL) AS chats,
           (SELECT COALESCE(sum(size_bytes), 0) FROM media_files WHERE owner_id = $1 AND deleted_at IS NULL) AS media_bytes,
           (SELECT count(*) FROM reports WHERE target_user_id = $1) AS reports_against,
           (SELECT count(*) FROM reports WHERE reporter_id = $1) AS reports_by,
           (SELECT count(*) FROM blocks WHERE blocked_id = $1) AS blocked_by`,
        [id],
      ),
      this.db.many('SELECT provider, email, created_at, last_login_at FROM oauth_accounts WHERE user_id = $1', [id]),
    ]);
    const showPhone = can(request.admin, 'users.phone');
    return {
      user: this.presentUserRow(user, request),
      sessions: sessions.map((s) => ({
        ...s,
        ip: showPhone ? s.ip : null,
        created_at: iso(s.created_at),
        last_active_at: iso(s.last_active_at),
        revoked_at: iso(s.revoked_at),
      })),
      devices: devices.map((d) => ({ ...d, last_active_at: iso(d.last_active_at) })),
      stats,
      oauth: oauth.map((o) => ({
        provider: o.provider,
        email: showPhone ? o.email : o.email ? `${o.email.slice(0, 1)}***${o.email.slice(o.email.indexOf('@'))}` : null,
        created_at: iso(o.created_at),
        last_login_at: iso(o.last_login_at),
      })),
    };
  }

  async suspend(request) {
    this.require(request, 'users.moderate');
    const id = normalizeUuid(request.params.id);
    const v = Validator.of(request.body);
    const reason = v.string('reason', { required: true, min: 3, max: 200 });
    v.validate();
    const user = id ? await this.db.one("SELECT * FROM users WHERE id = $1 AND status = 'active'", [id]) : null;
    if (!user) throw fail.notFound();
    await this.db.tx(async (tx) => {
      await tx.exec("UPDATE users SET status = 'suspended', status_reason = $2, updated_at = now() WHERE id = $1", [id, reason]);
      await this.ctx.auth.revokeAllExcept(id, null, 'suspended', tx);
      await this.ctx.bus.publish({ t: 'user_suspended', user_id: id }, tx);
    });
    await this.audit(request.admin, request, 'user.suspend', `user:${id}`, { reason });
    return { suspended: true };
  }

  async unsuspend(request) {
    this.require(request, 'users.moderate');
    const id = normalizeUuid(request.params.id);
    const changed = id
      ? await this.db.exec("UPDATE users SET status = 'active', status_reason = NULL, updated_at = now() WHERE id = $1 AND status = 'suspended'", [id])
      : 0;
    if (!changed) throw fail.notFound();
    await this.audit(request.admin, request, 'user.unsuspend', `user:${id}`);
    return { suspended: false };
  }

  async logoutUser(request) {
    this.require(request, 'users.moderate');
    const id = normalizeUuid(request.params.id);
    if (!id || !(await this.db.one('SELECT id FROM users WHERE id = $1', [id]))) throw fail.notFound();
    const rows = await this.ctx.auth.revokeAllExcept(id, null, 'admin_logout');
    await this.audit(request.admin, request, 'user.logout_all', `user:${id}`, { sessions: rows.length });
    return { revoked_sessions: rows.length };
  }

  async deleteUser(request) {
    this.require(request, 'users.delete');
    const id = normalizeUuid(request.params.id);
    const v = Validator.of(request.body);
    const reason = v.string('reason', { required: true, min: 3, max: 200 });
    const confirm = v.string('confirm', { required: true, max: 100 });
    v.validate();
    const user = id ? await this.db.one("SELECT * FROM users WHERE id = $1 AND status <> 'deleted'", [id]) : null;
    if (!user) throw fail.notFound();
    const expected = user.username || user.display_name;
    if (confirm !== expected && confirm !== user.id) throw fail.field('confirm', 'format');
    await this.ctx.account.deleteUserData(user);
    await this.audit(request.admin, request, 'user.delete', `user:${id}`, { reason });
    return { deleted: true };
  }

  // ================================================================ гурӯҳҳо

  async groupsList(request) {
    this.require(request, 'groups.view');
    const { page, perPage, offset } = pageOf(request.query);
    const q = String(request.query.q ?? '').trim();
    const params = [];
    let filter = '';
    if (q) {
      params.push(`%${likeEscape(q.toLowerCase())}%`);
      filter = `WHERE lower(g.name) LIKE $1`;
    }
    const total = await this.db.value(`SELECT count(*) FROM chat_groups g ${filter}`, params);
    const rows = await this.db.many(
      `SELECT g.conversation_id AS id, g.name, g.description, g.created_at, c.deleted_at, c.last_message_at,
         o.id AS owner_id, o.display_name AS owner_name,
         (SELECT count(*) FROM conversation_members cm WHERE cm.conversation_id = g.conversation_id) AS member_count,
         c.last_seq AS messages_count
       FROM chat_groups g JOIN conversations c ON c.id = g.conversation_id
       LEFT JOIN users o ON o.id = g.owner_id
       ${filter} ORDER BY g.created_at DESC LIMIT ${perPage} OFFSET ${offset}`,
      params,
    );
    return {
      items: rows.map((r) => ({
        ...r,
        created_at: iso(r.created_at),
        deleted_at: iso(r.deleted_at),
        last_message_at: iso(r.last_message_at),
      })),
      total,
      page,
      per_page: perPage,
    };
  }

  async groupDetail(request) {
    this.require(request, 'groups.view');
    const id = normalizeUuid(request.params.id);
    const group = id ? await this.db.one('SELECT g.*, c.deleted_at, c.last_seq FROM chat_groups g JOIN conversations c ON c.id = g.conversation_id WHERE g.conversation_id = $1', [id]) : null;
    if (!group) throw fail.notFound();
    const members = await this.db.many(
      `SELECT u.id, u.display_name, u.username, u.status, cm.role, cm.joined_at
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = $1
       ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cm.joined_at LIMIT 300`,
      [id],
    );
    return {
      group: {
        id: group.conversation_id,
        name: group.name,
        description: group.description,
        owner_id: group.owner_id,
        avatar_media_id: group.avatar_media_id,
        has_invite: Boolean(group.invite_code),
        messages_count: Number(group.last_seq),
        created_at: iso(group.created_at),
        deleted_at: iso(group.deleted_at),
      },
      members: members.map((m) => ({ ...m, joined_at: iso(m.joined_at) })),
    };
  }

  async deleteGroup(request) {
    this.require(request, 'groups.delete');
    const id = normalizeUuid(request.params.id);
    const v = Validator.of(request.body);
    const reason = v.string('reason', { required: true, min: 3, max: 200 });
    v.validate();
    const group = id
      ? await this.db.one('SELECT g.* FROM chat_groups g JOIN conversations c ON c.id = g.conversation_id AND c.deleted_at IS NULL WHERE g.conversation_id = $1', [id])
      : null;
    if (!group) throw fail.notFound();
    await this.ctx.groups.deleteGroup(group);
    await this.audit(request.admin, request, 'group.delete', `group:${id}`, { reason });
    return { deleted: true };
  }

  // ================================================================ шикоятҳо

  async reports(request) {
    this.require(request, 'reports.view');
    const { page, perPage, offset } = pageOf(request.query);
    const status = ['open', 'in_review', 'resolved', 'rejected'].includes(request.query.status) ? request.query.status : null;
    const params = status ? [status] : [];
    const filter = status ? 'WHERE r.status = $1' : '';
    const total = await this.db.value(`SELECT count(*) FROM reports r ${filter}`, params);
    const rows = await this.db.many(
      `SELECT r.id, r.reason, r.comment, r.status, r.created_at, r.updated_at, r.target_message_id,
         rp.id AS reporter_id, rp.display_name AS reporter_name,
         tu.id AS target_user_id, tu.display_name AS target_name, tu.status AS target_status,
         (SELECT count(*) FROM reports x WHERE x.target_user_id = r.target_user_id) AS target_reports
       FROM reports r
       JOIN users rp ON rp.id = r.reporter_id
       LEFT JOIN users tu ON tu.id = r.target_user_id
       ${filter} ORDER BY r.created_at DESC LIMIT ${perPage} OFFSET ${offset}`,
      params,
    );
    return {
      items: rows.map((r) => ({ ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) })),
      total,
      page,
      per_page: perPage,
    };
  }

  async reportDetail(request) {
    this.require(request, 'reports.view');
    const id = normalizeUuid(request.params.id);
    const report = id ? await this.db.one('SELECT * FROM reports WHERE id = $1', [id]) : null;
    if (!report) throw fail.notFound();
    let message = null;
    if (report.target_message_id) {
      // Танҳо паёми шикоятшуда (бо розигии шикояткунанда) — на тамоми чат.
      const row = await this.ctx.chats.findMessage(report.target_message_id);
      if (row) {
        message = {
          id: row.id,
          type: row.type,
          body: row.deleted_at ? '' : row.body,
          preview: messagePreview(row.type, row.body, row.att_name),
          is_deleted: Boolean(row.deleted_at),
          created_at: iso(row.created_at),
          attachment: row.att_id ? { id: row.att_id, kind: row.att_kind, mime_type: row.att_mime, size_bytes: Number(row.att_size) } : null,
        };
      }
    }
    const users = await this.db.many('SELECT * FROM users WHERE id = ANY($1::uuid[])', [[report.reporter_id, report.target_user_id].filter(Boolean)]);
    const byId = new Map(users.map((u) => [u.id, this.presentUserRow(u, request)]));
    return {
      report: {
        ...report,
        created_at: iso(report.created_at),
        updated_at: iso(report.updated_at),
        resolved_at: iso(report.resolved_at),
      },
      reporter: byId.get(report.reporter_id) ?? null,
      target: report.target_user_id ? (byId.get(report.target_user_id) ?? null) : null,
      message,
    };
  }

  async resolveReport(request) {
    this.require(request, 'reports.resolve');
    const id = normalizeUuid(request.params.id);
    const v = Validator.of(request.body);
    const status = v.enum('status', ['open', 'in_review', 'resolved', 'rejected'], { required: true });
    const note = v.string('note', { max: 500, multiline: true });
    const action = v.enum('action', ['none', 'delete_message', 'suspend_user']) ?? 'none';
    v.validate();
    const report = id ? await this.db.one('SELECT * FROM reports WHERE id = $1', [id]) : null;
    if (!report) throw fail.notFound();

    if (action === 'delete_message' && report.target_message_id) {
      const row = await this.ctx.chats.findMessage(report.target_message_id);
      if (row && !row.deleted_at) {
        await this.db.tx(async (tx) => {
          await tx.exec("UPDATE messages SET body = '', deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [row.id]);
          await tx.exec('DELETE FROM message_attachments WHERE message_id = $1', [row.id]);
          await this.ctx.bus.publish({ t: 'msg', k: 'deleted', c: row.conversation_id, m: row.id }, tx);
        });
      }
    }
    if (action === 'suspend_user' && report.target_user_id) {
      if (!can(request.admin, 'users.moderate')) throw fail.forbidden();
      await this.db.tx(async (tx) => {
        const changed = await tx.exec(
          "UPDATE users SET status = 'suspended', status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'active'",
          [report.target_user_id, `report:${report.id}`],
        );
        if (changed) {
          await this.ctx.auth.revokeAllExcept(report.target_user_id, null, 'suspended', tx);
          await this.ctx.bus.publish({ t: 'user_suspended', user_id: report.target_user_id }, tx);
        }
      });
    }
    const final = status === 'resolved' || status === 'rejected';
    await this.db.exec(
      `UPDATE reports SET status = $2, resolution_note = COALESCE($3, resolution_note),
         resolved_by = CASE WHEN $4 THEN $5::uuid ELSE resolved_by END,
         resolved_at = CASE WHEN $4 THEN now() ELSE resolved_at END
       WHERE id = $1`,
      [id, status, note || null, final, request.admin.id],
    );
    await this.audit(request.admin, request, 'report.update', `report:${id}`, { status, action });
    return { updated: true };
  }

  // ================================================================ SMS

  async smsLogs(request) {
    this.require(request, 'sms.view');
    const { page, perPage, offset } = pageOf(request.query);
    const status = ['sent', 'failed'].includes(request.query.status) ? request.query.status : null;
    const params = status ? [status] : [];
    const filter = status ? 'WHERE status = $1' : '';
    const total = await this.db.value(`SELECT count(*) FROM sms_logs ${filter}`, params);
    const rows = await this.db.many(`SELECT * FROM sms_logs ${filter} ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${offset}`, params);
    const summary = await this.db.many(
      `SELECT driver, status, count(*) AS count FROM sms_logs WHERE created_at > now() - interval '30 days' GROUP BY driver, status`,
    );
    return {
      items: rows.map((r) => ({ ...r, created_at: iso(r.created_at) })),
      total,
      page,
      per_page: perPage,
      summary,
      driver: this.ctx.settings.get('sms_driver'),
      fallback_driver: this.ctx.settings.get('sms_fallback_driver'),
    };
  }

  async smsTest(request) {
    this.require(request, 'sms.test');
    await this.ctx.limiter.hit('sms_test', `a:${request.admin.id}`);
    const v = Validator.of(request.body);
    const phone = v.phone('phone');
    v.validate();
    const result = await this.ctx.sms.send(phone, 'JovidxonChat: SMS test OK.', 'admin_test');
    await this.audit(request.admin, request, 'sms.test', maskPhone(phone), { ok: result.ok, driver: result.driver, error: result.error });
    return { ok: result.ok, driver: result.driver, error: result.error };
  }

  // ================================================================ танзимот

  settingsList(request) {
    this.require(request, 'settings.manage');
    return { settings: this.ctx.settings.describe() };
  }

  async updateSettings(request) {
    this.require(request, 'settings.manage');
    const changes = request.body?.settings;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw fail.field('settings', 'format');
    const keys = await this.ctx.settings.update(changes, request.admin.id);
    await this.audit(request.admin, request, 'settings.update', null, { keys: Settings.keysOf(changes) });
    return { updated: keys, settings: this.ctx.settings.describe() };
  }

  // ================================================================ админҳо

  async admins(request) {
    this.require(request, 'admins.manage');
    const rows = await this.db.many('SELECT * FROM admin_users ORDER BY created_at');
    return { items: rows.map(presentAdmin) };
  }

  async createAdmin(request) {
    this.require(request, 'admins.manage');
    const v = Validator.of(request.body);
    const username = v.string('username', { required: true, min: 3, max: 40, pattern: /^[a-zA-Z0-9_.-]+$/ });
    const role = v.enum('role', ['super_admin', 'moderator', 'support'], { required: true });
    const displayName = v.string('display_name', { max: 80 }) ?? '';
    const password = checkPassword(v, 'password', username);
    v.validate();
    const id = uuidv7();
    try {
      await this.db.exec(
        'INSERT INTO admin_users (id, username, password_hash, role, display_name, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, username.toLowerCase(), await hashPassword(password), role, cleanName(displayName) || username, request.admin.id],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw fail.field('username', 'unsupported');
      throw error;
    }
    await this.audit(request.admin, request, 'admin.create', `admin:${id}`, { username, role });
    return { admin: presentAdmin(await this.db.one('SELECT * FROM admin_users WHERE id = $1', [id])) };
  }

  async superAdminsLeft(exceptId) {
    return this.db.value(
      "SELECT count(*) FROM admin_users WHERE role = 'super_admin' AND disabled_at IS NULL AND id <> $1",
      [exceptId],
    );
  }

  async updateAdmin(request) {
    this.require(request, 'admins.manage');
    const id = normalizeUuid(request.params.id);
    const target = id ? await this.db.one('SELECT * FROM admin_users WHERE id = $1', [id]) : null;
    if (!target) throw fail.notFound();
    const v = Validator.of(request.body);
    const role = v.enum('role', ['super_admin', 'moderator', 'support']);
    const displayName = v.string('display_name', { max: 80 });
    const disabled = v.bool('disabled');
    const password = v.has('password') ? checkPassword(v, 'password', target.username) : null;
    v.validate();

    const demoting = (role && role !== 'super_admin') || disabled === true;
    if (target.role === 'super_admin' && demoting && (await this.superAdminsLeft(target.id)) === 0) {
      throw fail.field('role', 'self');
    }
    const sets = [];
    const params = [id];
    if (role) {
      params.push(role);
      sets.push(`role = $${params.length}`);
    }
    if (displayName !== null) {
      params.push(cleanName(displayName) || target.username);
      sets.push(`display_name = $${params.length}`);
    }
    if (disabled !== null) sets.push(`disabled_at = ${disabled ? 'now()' : 'NULL'}`);
    if (password) {
      params.push(await hashPassword(password));
      sets.push(`password_hash = $${params.length}`, 'password_changed_at = now()', 'failed_attempts = 0', 'locked_until = NULL');
    }
    if (sets.length) await this.db.exec(`UPDATE admin_users SET ${sets.join(', ')} WHERE id = $1`, params);
    if (disabled || password) {
      await this.db.exec('UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL AND id <> $2', [
        id,
        request.adminSession.id,
      ]);
    }
    await this.audit(request.admin, request, 'admin.update', `admin:${id}`, {
      role: role ?? undefined,
      disabled: disabled ?? undefined,
      password_reset: Boolean(password),
    });
    return { admin: presentAdmin(await this.db.one('SELECT * FROM admin_users WHERE id = $1', [id])) };
  }

  async deleteAdmin(request) {
    this.require(request, 'admins.manage');
    const id = normalizeUuid(request.params.id);
    const target = id ? await this.db.one('SELECT * FROM admin_users WHERE id = $1', [id]) : null;
    if (!target) throw fail.notFound();
    if (target.id === request.admin.id) throw fail.field('id', 'self');
    if (target.role === 'super_admin' && (await this.superAdminsLeft(target.id)) === 0) throw fail.field('id', 'self');
    await this.db.exec('DELETE FROM admin_users WHERE id = $1', [id]);
    await this.audit(request.admin, request, 'admin.delete', `admin:${id}`, { username: target.username });
    return { deleted: true };
  }

  // ================================================================ аудит ва система

  async auditLog(request) {
    this.require(request, 'audit.view');
    const { page, perPage, offset } = pageOf(request.query);
    const where = [];
    const params = [];
    const adminId = normalizeUuid(String(request.query.admin_id ?? ''));
    if (adminId) {
      params.push(adminId);
      where.push(`admin_id = $${params.length}`);
    }
    if (request.query.action && /^[a-z._]{2,60}$/.test(String(request.query.action))) {
      params.push(`${request.query.action}%`);
      where.push(`action LIKE $${params.length}`);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.value(`SELECT count(*) FROM admin_audit_logs ${filter}`, params);
    const rows = await this.db.many(
      `SELECT * FROM admin_audit_logs ${filter} ORDER BY id DESC LIMIT ${perPage} OFFSET ${offset}`,
      params,
    );
    return { items: rows.map((r) => ({ ...r, id: Number(r.id), created_at: iso(r.created_at) })), total, page, per_page: perPage };
  }

  async system(request) {
    this.require(request, 'system.view');
    const [dbInfo, lastRun] = await Promise.all([
      this.db.one("SELECT version() AS version, pg_database_size(current_database()) AS size_bytes, now() AS now"),
      this.db.one("SELECT value, updated_at FROM app_state WHERE name = 'maintenance_last_run'"),
    ]);
    const memory = process.memoryUsage();
    return {
      version: this.ctx.config.version,
      node: process.version,
      env: this.ctx.config.env,
      instance_id: this.ctx.config.instanceId,
      uptime_seconds: Math.round(process.uptime()),
      memory: { rss: memory.rss, heap_used: memory.heapUsed },
      host: { platform: os.platform(), cpus: os.availableParallelism?.() ?? os.cpus().length },
      database: {
        version: String(dbInfo.version).split(' on ')[0],
        size_bytes: Number(dbInfo.size_bytes),
        pending_migrations: await pendingMigrations(this.db),
        time: iso(dbInfo.now),
      },
      realtime: { connections: this.ctx.hub.connectionCount(), listener: this.ctx.bus.connected },
      // ok: false — IP-и мизоҷ нодуруст муайян мешавад (TRUST_PROXY-ро санҷед).
      proxy: this.ctx.diagnostics.forwarding
        ? { ...this.ctx.diagnostics.forwarding, at: iso(new Date(this.ctx.diagnostics.forwarding.at)) }
        : null,
      maintenance: lastRun ? { last_run: iso(lastRun.updated_at), results: JSON.parse(lastRun.value) } : null,
      features: {
        sms_driver: this.ctx.settings.get('sms_driver'),
        push_enabled: this.ctx.push.enabled(),
        google_configured: this.ctx.settings.get('google_client_ids').length > 0,
        calls_enabled: this.ctx.settings.get('calls_enabled'),
        maintenance_mode: this.ctx.settings.get('maintenance_mode'),
        registration_enabled: this.ctx.settings.get('registration_enabled'),
      },
    };
  }
}
