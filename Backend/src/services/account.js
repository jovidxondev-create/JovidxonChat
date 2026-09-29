import { ApiError, fail } from '../core/errors.js';
import { localeOf } from '../core/http.js';
import { normalizeUuid } from '../core/ids.js';
import { cleanName, length, normalizePhone } from '../core/text.js';
import { Validator, queryInt } from '../core/validator.js';
import { isUniqueViolation } from '../db/pool.js';
import { presentSession, presentSettings } from '../presenters.js';
import { Users } from './users.js';

/** Номҳои корбарии хидматӣ, ки ба корбарон дода намешаванд. */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'jovidxon', 'jovidxonchat', 'moderator',
  'security', 'official', 'api', 'null', 'undefined', 'deleted', 'team', 'service', 'info', 'contact',
]);

function usernameTaken() {
  return new ApiError('USERNAME_TAKEN', {
    errors: [{ field: 'username', code: 'USERNAME_TAKEN', message_key: 'error_username_taken' }],
  });
}

/** Ҳисоби корбар (07, 14, 17, 18): профил, танзимот, сессияҳо, ҷустуҷӯ, нест кардани ҳисоб. */
export class Account {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get db() {
    return this.ctx.db;
  }

  /** GET /me */
  me(request) {
    return { user: Users.presentSelf(request.user, localeOf(request)) };
  }

  /** PATCH /me {display_name?, username?, about?} */
  async update(request) {
    const me = request.user.id;
    const v = Validator.of(request.body);
    const fields = {};
    if (v.has('display_name')) {
      const name = v.string('display_name', { required: true, min: 1, max: 64 });
      if (name !== null) {
        const clean = cleanName(name);
        if (clean === '') v.fail('display_name', 'required');
        else fields.display_name = clean;
      }
    }
    if (v.present('username')) {
      const raw = v.raw('username');
      if (raw === null || raw === '') {
        fields.username = null;
      } else {
        const username = v.string('username', { min: 3, max: 30, pattern: /^[a-zA-Z0-9_]+$/ });
        if (username !== null) fields.username = username.toLowerCase();
      }
    }
    if (v.has('about')) {
      const about = v.string('about', { max: 140 });
      if (about !== null) fields.about = about;
    }
    v.validate();

    if (fields.username) {
      const owner = await this.ctx.users.findByUsername(fields.username);
      if (RESERVED_USERNAMES.has(fields.username) || (owner && owner.id !== me)) throw usernameTaken();
    }
    try {
      await this.ctx.users.update(me, fields);
    } catch (error) {
      if (isUniqueViolation(error)) throw usernameTaken();
      throw error;
    }
    return { user: Users.presentSelf(await this.ctx.users.find(me), localeOf(request)) };
  }

  /** DELETE /me/avatar */
  async deleteAvatar(request) {
    await this.ctx.users.update(request.user.id, { avatar_media_id: null });
    return { deleted: true };
  }

  /** GET /me/settings */
  async settings(request) {
    return { settings: presentSettings(await this.ctx.users.settings(request.user.id)) };
  }

  /** PATCH /me/settings — ҳар майдон ихтиёрӣ. */
  async updateSettings(request) {
    const v = Validator.of(request.body);
    const fields = {};
    const language = v.enum('language', ['tk', 'ru']);
    if (language) fields.language = language;
    const theme = v.enum('theme', ['system', 'light', 'dark']);
    if (theme) fields.theme = theme;
    for (const name of ['privacy_last_seen', 'privacy_avatar', 'privacy_about']) {
      const value = v.enum(name, ['everyone', 'contacts', 'nobody']);
      if (value) fields[name] = value;
    }
    for (const name of ['read_receipts', 'notify_messages', 'notify_groups', 'notify_calls', 'notify_preview']) {
      const value = v.bool(name);
      if (value !== null) fields[name] = value;
    }
    v.validate();
    await this.ctx.users.updateSettings(request.user.id, fields);
    return { updated: true, settings: presentSettings(await this.ctx.users.settings(request.user.id)) };
  }

  /** GET /me/sessions */
  async sessions(request) {
    const rows = await this.db.many(
      `SELECT id, device_id, device_name, platform, app_version, auth_method, created_at, last_active_at
       FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND refresh_expires_at > now()
       ORDER BY last_active_at DESC LIMIT 100`,
      [request.user.id],
    );
    return { sessions: rows.map((row) => presentSession(row, request.session.id)) };
  }

  /** DELETE /me/sessions/:id */
  async revokeSession(request) {
    const me = request.user.id;
    const id = normalizeUuid(request.params.id);
    const session = id
      ? await this.db.one(
          'SELECT id, user_id, device_id FROM sessions WHERE id = $1 AND revoked_at IS NULL AND refresh_expires_at > now()',
          [id],
        )
      : null;
    if (!session || session.user_id !== me) throw fail.notFound();
    await this.ctx.auth.revokeSession(session.id, 'revoked_by_user');
    if (session.device_id && session.device_id !== request.session.device_id) {
      await this.ctx.devices.clearTokenForDevice(me, session.device_id);
    }
    this.ctx.log?.info({ user_id: me, session_id: session.id }, 'session_revoked');
    return { revoked: true };
  }

  /** GET /users/:id — профили оммавӣ (бо privacy). */
  async user(request) {
    const id = normalizeUuid(request.params.id);
    const row = id ? await this.ctx.users.find(id) : null;
    if (!row || !['active', 'deleted'].includes(row.status)) throw fail.notFound();
    const user = await this.ctx.users.presentOne(id, request.user.id, localeOf(request));
    if (!user) throw fail.notFound();
    return { user };
  }

  /**
   * GET /search/users?q=&limit= — рақами пурраи E.164 (дафтарчаи телефон), username ва ном.
   * Бо рақами нопурра ҷустуҷӯ намешавад — рақамҳои бегона ошкор намешаванд.
   */
  async searchUsers(request) {
    const me = request.user.id;
    const query = String(request.query.q ?? '').trim();
    const limit = queryInt(request.query, 'limit', 20, 1, 50);
    if (length(query) < 2 || length(query) > 64) return { users: [] };

    let ids = [];
    if (/^[+\d\s\-()]{7,}$/.test(query)) {
      const phone = normalizePhone(query);
      if (phone) {
        await this.ctx.limiter.hit('search_phone', `u:${me}`);
        const user = await this.ctx.users.findByPhone(phone);
        if (user && user.status === 'active' && user.id !== me && !(await this.ctx.safety.hasBlocked(user.id, me))) ids = [user.id];
      }
    } else {
      ids = await this.ctx.users.searchIds(query, me, limit);
    }
    const users = await this.ctx.users.present(ids, me, localeOf(request));
    return { users: ids.filter((id) => users.has(id)).map((id) => users.get(id)) };
  }

  /**
   * DELETE /me — нест кардани ҳисоб (Google Play талаб мекунад). Маълумоти шахсӣ пок мешавад;
   * паёмҳои фиристода барои дигарон бо номи «Ҳисоби нестшуда» мемонанд.
   */
  async deleteAccount(request) {
    const me = request.user.id;
    const user = await this.ctx.users.find(me);
    if (!user) throw fail.notFound();
    await this.deleteUserData(user);
    this.ctx.log?.info({ user_id: me }, 'account_deleted');
    return { deleted: true };
  }

  /** Барои корбар ва барои админ (super_admin). */
  async deleteUserData(user) {
    const id = user.id;
    for (const conversationId of await this.ctx.chats.groupConversationIds(id)) {
      await this.ctx.groups.leaveGroup(conversationId, id).catch(() => {});
    }
    await this.db.tx(async (tx) => {
      await this.ctx.auth.revokeAllExcept(id, null, 'account_deleted', tx);
      await this.ctx.devices.deleteAllForUser(id, tx);
      await tx.exec('DELETE FROM oauth_accounts WHERE user_id = $1', [id]);
      await this.ctx.safety.deleteAllFor(id, tx);
      await tx.exec('UPDATE stories SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL', [id]);
      await tx.exec('DELETE FROM push_outbox WHERE user_id = $1', [id]);
      if (user.phone) await tx.exec('DELETE FROM otp_codes WHERE phone = $1', [user.phone]);
      await tx.exec('DELETE FROM story_views WHERE viewer_id = $1', [id]);
      await tx.exec('UPDATE conversation_members SET draft = NULL WHERE user_id = $1', [id]);
      await this.ctx.users.anonymize(id, tx);
    });
  }
}
