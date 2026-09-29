import { uuidv7 } from '../core/ids.js';
import { t } from '../core/i18n.js';
import { likeEscape, maskPhone } from '../core/text.js';

export const ONLINE_TTL_SECONDS = 60;

export function iso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mediaUrl(mediaId) {
  return `/api/v1/media/${mediaId}`;
}

export function thumbUrl(mediaId) {
  return `/api/v1/media/${mediaId}/thumb`;
}

function allows(setting, isContact) {
  if (setting === 'everyone' || setting === undefined || setting === null) return true;
  if (setting === 'contacts') return isContact;
  return false;
}

export function presenceOf(lastSeenAt, now = Date.now()) {
  if (!lastSeenAt) return 'offline';
  const ts = lastSeenAt instanceof Date ? lastSeenAt.getTime() : Date.parse(lastSeenAt);
  return now - ts <= ONLINE_TTL_SECONDS * 1000 ? 'online' : 'offline';
}

const USER_COLUMNS = `u.id, u.phone, u.username, u.display_name, u.about, u.avatar_media_id, u.status,
  u.last_seen_at, u.created_at, s.privacy_last_seen, s.privacy_avatar, s.privacy_about, s.read_receipts`;

/**
 * Корбарон ва намоиши онҳо бо privacy (17, 18): last seen, расм ва about мувофиқи танзимот,
 * блок ва "контактҳо". Барои рӯйхатҳо — ду дархост барои ҳама (бе N+1).
 */
export class Users {
  constructor({ db }) {
    this.db = db;
  }

  find(id, q = this.db) {
    return q.one('SELECT * FROM users WHERE id = $1', [id]);
  }

  findActive(id, q = this.db) {
    return q.one("SELECT * FROM users WHERE id = $1 AND status = 'active'", [id]);
  }

  findByPhone(phone, q = this.db) {
    return q.one('SELECT * FROM users WHERE phone = $1', [phone]);
  }

  findByUsername(username, q = this.db) {
    return q.one('SELECT * FROM users WHERE username = $1', [String(username).toLowerCase()]);
  }

  async create({ phone = null, displayName, language = 'tk' }, q = this.db) {
    const id = uuidv7();
    const run = async (tx) => {
      await tx.exec('INSERT INTO users (id, phone, display_name) VALUES ($1, $2, $3)', [id, phone, displayName.slice(0, 64)]);
      await tx.exec('INSERT INTO user_settings (user_id, language) VALUES ($1, $2)', [id, language === 'ru' ? 'ru' : 'tk']);
      return tx.one('SELECT * FROM users WHERE id = $1', [id]);
    };
    return q.inTx ? run(q) : this.db.tx(run);
  }

  async update(id, fields, q = this.db) {
    const allowed = ['display_name', 'username', 'about', 'avatar_media_id', 'phone', 'status', 'status_reason'];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return;
    const sets = entries.map(([key], i) => `${key} = $${i + 2}`);
    await q.exec(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
  }

  /** Presence (32): навиштан на зудтар аз $interval сония. */
  touchLastSeen(id, intervalSeconds = 30, q = this.db) {
    return q.exec(
      `UPDATE users SET last_seen_at = now()
       WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $2))`,
      [id, intervalSeconds],
    );
  }

  async settings(userId, q = this.db) {
    let row = await q.one('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
    if (!row) {
      await q.exec('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
      row = await q.one('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
    }
    return row;
  }

  async updateSettings(userId, fields, q = this.db) {
    const allowed = [
      'language', 'theme', 'read_receipts', 'privacy_last_seen', 'privacy_avatar', 'privacy_about',
      'notify_messages', 'notify_groups', 'notify_calls', 'notify_preview',
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return;
    await this.settings(userId, q);
    const sets = entries.map(([key], i) => `${key} = $${i + 2}`);
    await q.exec(`UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = $1`, [userId, ...entries.map(([, v]) => v)]);
  }

  /**
   * Ҷустуҷӯ (14): username бо префикс, ном бо дохилшавӣ. Бе корбарони блоккарда ва нестшуда.
   */
  async searchIds(query, viewerId, limit) {
    const q = String(query).trim().replace(/^@/, '');
    if (q === '') return [];
    const contains = `%${likeEscape(q.toLowerCase())}%`;
    if (/^[a-zA-Z0-9_]+$/.test(q)) {
      const lower = q.toLowerCase();
      const prefix = `${likeEscape(lower)}%`;
      return this.db.column(
        `SELECT u.id FROM users u
         WHERE u.status = 'active' AND u.id <> $1
           AND (u.username LIKE $2 OR lower(u.display_name) LIKE $3)
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1)
         ORDER BY (u.username = $4) DESC, (u.username LIKE $2) DESC, u.display_name ASC
         LIMIT $5`,
        [viewerId, prefix, contains, lower, limit],
      );
    }
    return this.db.column(
      `SELECT u.id FROM users u
       WHERE u.status = 'active' AND u.id <> $1 AND lower(u.display_name) LIKE $2
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1)
       ORDER BY u.display_name ASC
       LIMIT $3`,
      [viewerId, contains, limit],
    );
  }

  /** Ҳисоби нестшуда: маълумоти шахсӣ пок, паёмҳо барои дигарон мемонанд. */
  anonymize(id, q = this.db) {
    return q.exec(
      `UPDATE users SET status = 'deleted', deleted_at = now(), phone = NULL, username = NULL, display_name = '',
         about = '', avatar_media_id = NULL, last_seen_at = NULL, status_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  // ------------------------------------------------------------ намоиш (privacy)

  async rows(ids, q = this.db) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await q.many(
      `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN user_settings s ON s.user_id = u.id WHERE u.id = ANY($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Муносибатҳои subjects нисбат ба viewers (як дархост барои ҳама):
   * contacts — subject viewer-ро контакт медонад; blockedBy — subject viewer-ро блок кардааст;
   * blocking — viewer subject-ро блок кардааст. Калид: `${viewer}|${subject}`.
   */
  async relationsMany(viewerIds, subjectIds, q = this.db) {
    const viewers = [...new Set(viewerIds)];
    const subjects = [...new Set(subjectIds)];
    const result = { contacts: new Set(), blockedBy: new Set(), blocking: new Set() };
    if (viewers.length === 0 || subjects.length === 0) return result;
    const rows = await q.many(
      `SELECT 'c' AS kind, contact_id AS viewer, owner_id AS subject FROM contacts
         WHERE owner_id = ANY($2::uuid[]) AND contact_id = ANY($1::uuid[])
       UNION ALL
       SELECT 'b', blocked_id, blocker_id FROM blocks WHERE blocker_id = ANY($2::uuid[]) AND blocked_id = ANY($1::uuid[])
       UNION ALL
       SELECT 'k', blocker_id, blocked_id FROM blocks WHERE blocker_id = ANY($1::uuid[]) AND blocked_id = ANY($2::uuid[])`,
      [viewers, subjects],
    );
    for (const row of rows) {
      const key = `${row.viewer}|${row.subject}`;
      if (row.kind === 'c') result.contacts.add(key);
      else if (row.kind === 'b') result.blockedBy.add(key);
      else result.blocking.add(key);
    }
    return result;
  }

  static presentRow(row, viewerId, relations, locale) {
    const id = row.id;
    const self = id === viewerId;
    const deleted = row.status === 'deleted';
    const key = `${viewerId}|${id}`;
    const blockedByThem = relations.blockedBy.has(key);
    const isContact = relations.contacts.has(key);
    const visible = (setting) => {
      if (self) return true;
      if (deleted || blockedByThem) return false;
      return allows(setting, isContact);
    };
    const showLastSeen = visible(row.privacy_last_seen);
    const showAvatar = row.avatar_media_id && visible(row.privacy_avatar);
    return {
      id,
      display_name: deleted ? t('deleted_account', locale) : row.display_name,
      username: deleted ? null : (row.username ?? null),
      phone: self ? (row.phone ?? '') : maskPhone(row.phone),
      avatar_url: showAvatar ? mediaUrl(row.avatar_media_id) : null,
      about: visible(row.privacy_about) ? (row.about ?? '') : '',
      presence: self ? 'online' : showLastSeen ? presenceOf(row.last_seen_at) : 'offline',
      last_seen_at: showLastSeen ? iso(row.last_seen_at) : null,
      is_deleted: deleted,
      is_blocked: relations.blocking.has(key),
    };
  }

  /** Map<id, userDto> барои як тамошобин. */
  async present(ids, viewerId, locale, q = this.db) {
    const rows = await this.rows(ids, q);
    const relations = await this.relationsMany([viewerId], [...rows.keys()].filter((id) => id !== viewerId), q);
    const out = new Map();
    for (const [id, row] of rows) out.set(id, Users.presentRow(row, viewerId, relations, locale));
    return out;
  }

  async presentOne(id, viewerId, locale) {
    return (await this.present([id], viewerId, locale)).get(id) ?? null;
  }

  /** Барои ҳодисаҳои WebSocket: ҳар тамошобин — намоиши худ (Map<viewer, Map<id, dto>>). */
  async presentForViewers(ids, viewers, q = this.db) {
    const rows = await this.rows(ids, q);
    const relations = await this.relationsMany(
      viewers.map((v) => v.id),
      [...rows.keys()],
      q,
    );
    const out = new Map();
    for (const viewer of viewers) {
      const map = new Map();
      for (const [id, row] of rows) map.set(id, Users.presentRow(row, viewer.id, relations, viewer.locale));
      out.set(viewer.id, map);
    }
    return out;
  }

  /** Профили худи корбар: телефони пурра, ҳама майдонҳо. */
  static presentSelf(user, locale) {
    return Users.presentRow(
      { ...user, privacy_last_seen: 'everyone', privacy_avatar: 'everyone', privacy_about: 'everyone' },
      user.id,
      { contacts: new Set(), blockedBy: new Set(), blocking: new Set() },
      locale,
    );
  }

  /** Оё viewer расми профили owner-ро дида метавонад (барои /media). */
  async canSeeAvatar(ownerId, viewerId) {
    if (ownerId === viewerId) return true;
    const row = (await this.rows([ownerId])).get(ownerId);
    if (!row || row.status === 'deleted') return false;
    const relations = await this.relationsMany([viewerId], [ownerId]);
    if (relations.blockedBy.has(`${viewerId}|${ownerId}`)) return false;
    return allows(row.privacy_avatar, relations.contacts.has(`${viewerId}|${ownerId}`));
  }

  /** Оё viewer presence-и subject-ро дида метавонад (WebSocket presence). */
  async presenceVisibility(subjectId, viewerIds) {
    const row = (await this.rows([subjectId])).get(subjectId);
    const visible = new Set();
    if (!row || row.status !== 'active') return { row: null, visible };
    const relations = await this.relationsMany(viewerIds, [subjectId]);
    for (const viewer of viewerIds) {
      if (viewer === subjectId) continue;
      const key = `${viewer}|${subjectId}`;
      if (relations.blockedBy.has(key) || relations.blocking.has(key)) continue;
      if (allows(row.privacy_last_seen, relations.contacts.has(key))) visible.add(viewer);
    }
    return { row, visible };
  }
}
