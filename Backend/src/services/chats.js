import { ApiError, fail } from '../core/errors.js';
import { localeOf } from '../core/http.js';
import { normalizeUuid, uuidv7 } from '../core/ids.js';
import { cleanName, length, likeEscape } from '../core/text.js';
import { Validator, queryBool, queryInt, queryNullableInt } from '../core/validator.js';
import { isUniqueViolation } from '../db/pool.js';
import { presentConversation, presentMessage, presentPermissions } from '../presenters.js';
import { iso } from './users.js';

export const MESSAGE_TYPES = ['text', 'image', 'video', 'document', 'voice'];
export const MAX_MESSAGE_LENGTH = 4096;

export const MESSAGE_SELECT = `SELECT m.id, m.conversation_id, m.seq, m.sender_id, m.client_message_id, m.type, m.body,
    m.reply_to_id, m.created_at, m.updated_at, m.edited_at, m.deleted_at,
    f.id AS att_id, f.kind AS att_kind, f.original_name AS att_name, f.mime_type AS att_mime,
    f.size_bytes AS att_size, f.has_thumb AS att_has_thumb, f.duration_seconds AS att_duration,
    f.width AS att_width, f.height AS att_height,
    r.id AS reply_id, r.sender_id AS reply_sender_id, r.type AS reply_type, r.body AS reply_body,
    r.deleted_at AS reply_deleted_at, rf.original_name AS reply_file_name
  FROM messages m
  LEFT JOIN message_attachments a ON a.message_id = m.id AND a.position = 0
  LEFT JOIN media_files f ON f.id = a.media_id
  LEFT JOIN messages r ON r.id = m.reply_to_id
  LEFT JOIN message_attachments ra ON ra.message_id = r.id AND ra.position = 0
  LEFT JOIN media_files rf ON rf.id = ra.media_id`;

const CHAT_SELECT = `SELECT c.id, c.type, c.created_by, c.last_seq, c.last_message_id, c.last_message_at, c.created_at,
    c.updated_at, m.role, m.is_pinned, m.pinned_at, m.is_muted, m.is_archived, m.draft, m.unread_count,
    m.mention_count, m.last_read_seq, m.joined_at,
    g.id AS group_id, g.name AS group_name, g.avatar_media_id AS group_avatar_media_id,
    st.member_count, st.others_read_seq, st.others_delivered_seq, st.peer_id,
    lm.seq AS lm_seq, lm.sender_id AS lm_sender_id, lm.type AS lm_type, lm.body AS lm_body,
    lm.created_at AS lm_created_at, lf.original_name AS lm_file_name
  FROM conversation_members m
  JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
  LEFT JOIN chat_groups g ON g.conversation_id = c.id
  LEFT JOIN LATERAL (
    SELECT count(*) + 1 AS member_count,
           min(o.last_read_seq) AS others_read_seq,
           min(o.last_delivered_seq) AS others_delivered_seq,
           CASE WHEN c.type = 'private' THEN (array_agg(o.user_id))[1] END AS peer_id
    FROM conversation_members o
    WHERE o.conversation_id = c.id AND o.user_id <> m.user_id
  ) st ON true
  LEFT JOIN messages lm ON lm.id = c.last_message_id AND lm.deleted_at IS NULL
  LEFT JOIN message_attachments la ON la.message_id = lm.id AND la.position = 0
  LEFT JOIN media_files lf ON lf.id = la.media_id`;

export const ROLE_PERMISSIONS = {
  owner: { can_add_members: true, can_edit_info: true, can_send_messages: true, can_remove_members: true },
  admin: { can_add_members: true, can_edit_info: true, can_send_messages: true, can_remove_members: true },
  member: { can_add_members: true, can_edit_info: false, can_send_messages: true, can_remove_members: false },
};
export const PERMISSIONS = ['can_add_members', 'can_edit_info', 'can_send_messages', 'can_remove_members'];

export function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** @username-ҳо дар матн (ба ҳарфи хурд, бе такрор). */
export function mentionedUsernames(body) {
  const found = new Set();
  for (const match of String(body).matchAll(/(?<![\p{L}\p{N}_@])@([a-z0-9_]{3,30})(?![a-z0-9_])/giu)) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
}

const NO_RECEIPTS = { read: 0, delivered: 0, others: 0, receipts: false };

/**
 * Чатҳо ва паёмҳо (08, 09, 10, 32): рӯйхат, кушодан, танзимоти шахсӣ, аъзоён, typing,
 * паёмҳо бо seq ва idempotency, таҳрир, нест кардан, «хонда шуд», ҷустуҷӯ, sync.
 * Ҳар тағйир ҳодисаи realtime (WebSocket) мефиристад.
 */
export class Chats {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get db() {
    return this.ctx.db;
  }

  // ================================================================ аъзогӣ

  membership(conversationId, userId, q = this.db) {
    return q.one(
      `SELECT m.*, c.type, c.last_seq, c.last_message_id, c.created_by, c.pair_key
       FROM conversation_members m
       JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
       WHERE m.conversation_id = $1 AND m.user_id = $2`,
      [conversationId, userId],
    );
  }

  async requireMember(conversationId, userId) {
    const id = normalizeUuid(conversationId);
    const membership = id ? await this.membership(id, userId) : null;
    if (!membership) throw fail.notFound();
    return membership;
  }

  memberIds(conversationId, q = this.db) {
    return q.column('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [conversationId]);
  }

  countMembers(conversationId, q = this.db) {
    return q.value('SELECT count(*) FROM conversation_members WHERE conversation_id = $1', [conversationId]);
  }

  peerId(conversationId, userId, q = this.db) {
    return q.value('SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2 LIMIT 1', [
      conversationId,
      userId,
    ]);
  }

  findPrivate(a, b, q = this.db) {
    return q.one('SELECT * FROM conversations WHERE pair_key = $1 AND deleted_at IS NULL', [pairKey(a, b)]);
  }

  /** Чати хусусӣ; ҳангоми race (UNIQUE pair_key) мавҷударо бармегардонад. */
  async createPrivate(creator, peer) {
    const id = uuidv7();
    try {
      await this.db.tx(async (tx) => {
        await tx.exec("INSERT INTO conversations (id, type, pair_key, created_by) VALUES ($1, 'private', $2, $3)", [
          id,
          pairKey(creator, peer),
          creator,
        ]);
        for (const userId of [creator, peer]) {
          await tx.exec("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')", [id, userId]);
        }
      });
      return id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.value('SELECT id FROM conversations WHERE pair_key = $1', [pairKey(creator, peer)]);
      if (!existing) throw error;
      return existing;
    }
  }

  async addMember(conversationId, userId, role, q = this.db) {
    const p = ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.member;
    await q.exec(
      `INSERT INTO conversation_members (conversation_id, user_id, role, can_add_members, can_edit_info, can_send_messages,
                                         can_remove_members, last_read_seq, last_delivered_seq)
       SELECT $1, $2, $3, $4, $5, $6, $7, c.last_seq, c.last_seq FROM conversations c WHERE c.id = $1
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, userId, role, p.can_add_members, p.can_edit_info, p.can_send_messages, p.can_remove_members],
    );
  }

  removeMember(conversationId, userId, q = this.db) {
    return q.exec('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
  }

  setRole(conversationId, userId, role, q = this.db) {
    const p = ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.member;
    return q.exec(
      `UPDATE conversation_members SET role = $3, can_add_members = $4, can_edit_info = $5, can_send_messages = $6,
         can_remove_members = $7 WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId, role, p.can_add_members, p.can_edit_info, p.can_send_messages, p.can_remove_members],
    );
  }

  async setPermissions(conversationId, userId, permissions, q = this.db) {
    const entries = Object.entries(permissions).filter(([name]) => PERMISSIONS.includes(name));
    if (entries.length === 0) return;
    const sets = entries.map(([name], i) => `${name} = $${i + 3}`);
    await q.exec(`UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id = $1 AND user_id = $2`, [
      conversationId,
      userId,
      ...entries.map(([, value]) => Boolean(value)),
    ]);
  }

  /** owner → admin → member, баъд аз рӯи вақти пайвастшавӣ. */
  members(conversationId, limit = 5000) {
    return this.db.many(
      `SELECT user_id, role, can_add_members, can_edit_info, can_send_messages, can_remove_members, joined_at
       FROM conversation_members WHERE conversation_id = $1
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at, user_id
       LIMIT $2`,
      [conversationId, limit],
    );
  }

  async presentMembers(conversationId, me, locale) {
    const rows = await this.members(conversationId);
    const users = await this.ctx.users.present(rows.map((r) => r.user_id), me, locale);
    return rows
      .filter((row) => users.has(row.user_id))
      .map((row) => ({
        user: users.get(row.user_id),
        role: row.role,
        permissions: presentPermissions(row),
        is_me: row.user_id === me,
        joined_at: iso(row.joined_at),
      }));
  }

  /** Ҳамсуҳбатони чатҳои хусусии фаъол (барои лентаи stories). */
  privatePeers(userId) {
    return this.db.column(
      `SELECT p.user_id FROM conversation_members m
       JOIN conversations c ON c.id = m.conversation_id AND c.type = 'private' AND c.deleted_at IS NULL
                            AND c.last_message_id IS NOT NULL
       JOIN conversation_members p ON p.conversation_id = c.id AND p.user_id <> m.user_id
       WHERE m.user_id = $1`,
      [userId],
    );
  }

  groupConversationIds(userId) {
    return this.db.column(
      `SELECT m.conversation_id FROM conversation_members m
       JOIN conversations c ON c.id = m.conversation_id AND c.type = 'group' AND c.deleted_at IS NULL
       WHERE m.user_id = $1`,
      [userId],
    );
  }

  softDelete(conversationId, q = this.db) {
    return q.exec('UPDATE conversations SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [conversationId]);
  }

  // ================================================================ рӯйхати чатҳо

  listForUser(userId, includeArchived, limit) {
    return this.db.many(
      `${CHAT_SELECT}
       WHERE m.user_id = $1 ${includeArchived ? '' : 'AND NOT m.is_archived'}
         AND (c.type = 'group' OR c.last_message_id IS NOT NULL OR c.created_by = m.user_id)
       ORDER BY m.is_pinned DESC, m.pinned_at DESC NULLS LAST, COALESCE(c.last_message_at, c.created_at) DESC
       LIMIT $2`,
      [userId, limit],
    );
  }

  rowForUser(conversationId, userId) {
    return this.db.one(`${CHAT_SELECT} WHERE m.user_id = $1 AND c.id = $2`, [userId, conversationId]);
  }

  changedSince(userId, since, limit) {
    return this.db.many(
      `${CHAT_SELECT}
       WHERE m.user_id = $1
         AND (c.updated_at > $2 OR m.updated_at > $2 OR c.last_message_at > $2
              OR EXISTS (SELECT 1 FROM chat_groups gg WHERE gg.conversation_id = c.id AND gg.updated_at > $2))
       ORDER BY c.updated_at ASC LIMIT $3`,
      [userId, since, limit],
    );
  }

  async presentChats(rows, me, locale) {
    const peerIds = rows.map((r) => r.peer_id).filter(Boolean);
    const userIds = [...peerIds, ...rows.map((r) => r.lm_sender_id).filter(Boolean)];
    const users = await this.ctx.users.present(userIds, me, locale);
    const raw = await this.ctx.users.rows([...peerIds, me]);
    const myReceipts = raw.get(me)?.read_receipts ?? true;
    return rows.map((row) => {
      const peerReceipts = row.peer_id ? (raw.get(row.peer_id)?.read_receipts ?? true) : true;
      const typing = this.ctx.hub.isTyping(row.id, me);
      return presentConversation(row, me, users, myReceipts !== false && peerReceipts !== false, typing);
    });
  }

  async presentChat(conversationId, me, locale) {
    const row = await this.rowForUser(conversationId, me);
    if (!row) throw fail.notFound();
    return (await this.presentChats([row], me, locale))[0];
  }

  /** GET /chats */
  async list(request) {
    const me = request.user.id;
    await this.markDeliveredAll(me);
    const rows = await this.listForUser(me, queryBool(request.query, 'include_archived'), 500);
    return { chats: await this.presentChats(rows, me, localeOf(request)) };
  }

  /** GET /chats/:id */
  async show(request) {
    const membership = await this.requireMember(request.params.id, request.user.id);
    return { chat: await this.presentChat(membership.conversation_id, request.user.id, localeOf(request)) };
  }

  /** POST /chats — {type: private, user_id} ё {type: group, name, member_ids[]} */
  async open(request) {
    const me = request.user.id;
    const v = Validator.of(request.body);
    const type = v.enum('type', ['private', 'group']) ?? 'private';

    if (type === 'group') {
      const name = v.string('name', { required: true, min: 1, max: 64 });
      const memberIds = v.uuidList('member_ids', { max: Math.max(1, this.ctx.settings.get('group_max_members') - 1) });
      v.validate();
      await this.ctx.limiter.hit('group_create', `u:${me}`);
      const conversationId = await this.ctx.groups.create(me, cleanName(name), memberIds);
      return { chat: await this.presentChat(conversationId, me, localeOf(request)) };
    }

    const peerId = v.uuid('user_id', { required: true });
    v.validate();
    if (peerId === me) throw fail.field('user_id', 'self');
    if (!(await this.ctx.users.findActive(peerId))) throw fail.notFound();

    let conversationId;
    const existing = await this.findPrivate(me, peerId);
    if (existing) {
      conversationId = existing.id;
    } else {
      if (await this.ctx.safety.isBlockedEither(me, peerId)) throw new ApiError('USER_BLOCKED');
      conversationId = await this.createPrivate(me, peerId);
    }
    return { chat: await this.presentChat(conversationId, me, localeOf(request)) };
  }

  /** PATCH /chats/:id — pin/mute/archive/draft (танҳо барои худ). */
  async update(request) {
    const me = request.user.id;
    const membership = await this.requireMember(request.params.id, me);
    const conversationId = membership.conversation_id;
    const v = Validator.of(request.body);
    const sets = [];
    const params = [conversationId, me];
    for (const flag of ['is_muted', 'is_archived']) {
      const value = v.bool(flag);
      if (value !== null) {
        params.push(value);
        sets.push(`${flag} = $${params.length}`);
      }
    }
    const pinned = v.bool('is_pinned');
    if (pinned !== null) {
      params.push(pinned);
      sets.push(`is_pinned = $${params.length}`, `pinned_at = ${pinned ? 'now()' : 'NULL'}`);
    }
    if (v.present('draft')) {
      const draft = v.string('draft', { max: MAX_MESSAGE_LENGTH, multiline: true, trim: false }) ?? '';
      params.push(draft === '' ? null : draft);
      sets.push(`draft = $${params.length}`);
    }
    v.validate();
    if (sets.length) {
      await this.db.exec(`UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id = $1 AND user_id = $2`, params);
      await this.ctx.bus.publish({ t: 'chat', c: conversationId, u: [me] });
    }
    return { chat: await this.presentChat(conversationId, me, localeOf(request)) };
  }

  /** GET /chats/:id/members */
  async membersRoute(request) {
    const membership = await this.requireMember(request.params.id, request.user.id);
    return { members: await this.presentMembers(membership.conversation_id, request.user.id, localeOf(request)) };
  }

  /** POST /chats/:id/typing {state: start|stop} — ҳолати муваққатӣ (TTL 6 с), дар база нигоҳ дошта намешавад. */
  async typing(request) {
    const me = request.user.id;
    const membership = await this.requireMember(request.params.id, me);
    const v = Validator.of(request.body);
    const state = v.enum('state', ['start', 'stop']) ?? 'start';
    v.validate();
    await this.ctx.hub.publishTyping(membership.conversation_id, me, state);
    return { typing: state === 'start' };
  }

  // ================================================================ «расонида шуд» / «хонда шуд»

  /** ✓✓: вақте ки корбар рӯйхати чатҳоро мегирад — ҳамаи чатҳо то last_seq. */
  async markDeliveredAll(userId) {
    const changed = await this.db.column(
      `UPDATE conversation_members cm SET last_delivered_seq = c.last_seq
       FROM conversations c
       WHERE c.id = cm.conversation_id AND cm.user_id = $1 AND cm.last_delivered_seq < c.last_seq
       RETURNING cm.conversation_id`,
      [userId],
    );
    for (const conversationId of changed) await this.ctx.bus.publish({ t: 'receipt', c: conversationId });
  }

  async markDelivered(conversationId, userId, seq) {
    const changed = await this.db.exec(
      `UPDATE conversation_members SET last_delivered_seq = LEAST($3, (SELECT last_seq FROM conversations WHERE id = $1))
       WHERE conversation_id = $1 AND user_id = $2 AND last_delivered_seq < $3`,
      [conversationId, userId, seq],
    );
    if (changed) await this.ctx.bus.publish({ t: 'receipt', c: conversationId });
  }

  async markRead(conversationId, userId, seq) {
    const row = await this.db.one(
      `UPDATE conversation_members cm
       SET last_read_seq = GREATEST(cm.last_read_seq, $3),
           last_delivered_seq = GREATEST(cm.last_delivered_seq, $3),
           unread_count = (SELECT count(*) FROM messages msg
                           WHERE msg.conversation_id = cm.conversation_id AND msg.seq > GREATEST(cm.last_read_seq, $3)
                             AND msg.sender_id <> cm.user_id AND msg.deleted_at IS NULL),
           mention_count = CASE WHEN (SELECT count(*) FROM messages msg
                                      WHERE msg.conversation_id = cm.conversation_id AND msg.seq > GREATEST(cm.last_read_seq, $3)
                                        AND msg.sender_id <> cm.user_id AND msg.deleted_at IS NULL) = 0
                                THEN 0 ELSE cm.mention_count END
       WHERE cm.conversation_id = $1 AND cm.user_id = $2
       RETURNING last_read_seq, unread_count`,
      [conversationId, userId, seq],
    );
    await this.ctx.bus.publish({ t: 'receipt', c: conversationId });
    await this.ctx.bus.publish({ t: 'chat', c: conversationId, u: [userId] });
    return row;
  }

  /**
   * Ҳадди ақали дигар аъзоён: {read, delivered, others, receipts}. Дар чати хусусӣ «хонда шуд»
   * танҳо агар ҳарду тараф read_receipts дошта бошанд.
   */
  async receipts(conversationId, type, me, q = this.db) {
    const row = await q.one(
      `SELECT min(o.last_read_seq) AS read_seq, min(o.last_delivered_seq) AS delivered_seq, count(*) AS others,
              bool_and(COALESCE(os.read_receipts, true)) AS others_receipts,
              COALESCE((SELECT read_receipts FROM user_settings WHERE user_id = $2), true) AS my_receipts
       FROM conversation_members o LEFT JOIN user_settings os ON os.user_id = o.user_id
       WHERE o.conversation_id = $1 AND o.user_id <> $2`,
      [conversationId, me],
    );
    return {
      read: Number(row?.read_seq ?? 0),
      delivered: Number(row?.delivered_seq ?? 0),
      others: Number(row?.others ?? 0),
      receipts: type === 'group' ? true : row?.my_receipts !== false && row?.others_receipts !== false,
    };
  }

  // ================================================================ паёмҳо

  findMessage(id, q = this.db) {
    return q.one(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
  }

  findByClientId(senderId, clientMessageId, q = this.db) {
    return q.one(`${MESSAGE_SELECT} WHERE m.sender_id = $1 AND m.client_message_id = $2`, [senderId, clientMessageId]);
  }

  /** Саҳифабандӣ аз рӯи seq; натиҷа ҳамеша аз кӯҳна ба нав. */
  async page(conversationId, beforeSeq, afterSeq, limit) {
    if (afterSeq !== null) {
      return this.db.many(`${MESSAGE_SELECT} WHERE m.conversation_id = $1 AND m.seq > $2 ORDER BY m.seq ASC LIMIT $3`, [
        conversationId,
        afterSeq,
        limit,
      ]);
    }
    const rows =
      beforeSeq !== null
        ? await this.db.many(`${MESSAGE_SELECT} WHERE m.conversation_id = $1 AND m.seq < $2 ORDER BY m.seq DESC LIMIT $3`, [
            conversationId,
            beforeSeq,
            limit,
          ])
        : await this.db.many(`${MESSAGE_SELECT} WHERE m.conversation_id = $1 ORDER BY m.seq DESC LIMIT $2`, [conversationId, limit]);
    return rows.reverse();
  }

  async presentMessages(rows, me, locale, receipts) {
    const ids = [];
    for (const row of rows) {
      ids.push(row.sender_id);
      if (row.reply_sender_id) ids.push(row.reply_sender_id);
    }
    const users = await this.ctx.users.present(ids, me, locale);
    return rows.map((row) => presentMessage(row, me, users, receipts));
  }

  async presentOne(row, me, locale) {
    const membership = await this.membership(row.conversation_id, me);
    const receipts = membership ? await this.receipts(row.conversation_id, membership.type, me) : NO_RECEIPTS;
    return (await this.presentMessages([row], me, locale, receipts))[0];
  }

  /** GET /chats/:id/messages?before_seq=&after_seq=&limit= */
  async listMessages(request) {
    const me = request.user.id;
    const membership = await this.requireMember(request.params.id, me);
    const conversationId = membership.conversation_id;
    const rows = await this.page(
      conversationId,
      queryNullableInt(request.query, 'before_seq'),
      queryNullableInt(request.query, 'after_seq'),
      queryInt(request.query, 'limit', 50, 1, 100),
    );
    const maxSeq = Number(membership.last_seq);
    if (maxSeq > Number(membership.last_delivered_seq)) await this.markDelivered(conversationId, me, maxSeq);
    const receipts = await this.receipts(conversationId, membership.type, me);
    return { messages: await this.presentMessages(rows, me, localeOf(request), receipts), max_seq: maxSeq };
  }

  /** POST /chats/:id/messages */
  async sendMessage(request) {
    const me = request.user.id;
    const conversationId = normalizeUuid(request.params.id);
    if (!conversationId) throw fail.notFound();
    const v = Validator.of(request.body);
    const clientId = v.string('client_message_id', { required: true, min: 8, max: 64, pattern: /^[A-Za-z0-9._:-]+$/ });
    const type = v.enum('type', MESSAGE_TYPES) ?? 'text';
    const body = v.string('body', { max: MAX_MESSAGE_LENGTH, multiline: true }) ?? '';
    const mediaId = v.uuid('media_id');
    const replyToId = v.uuid('reply_to_id');
    v.validate();

    const result = await this.sendAs(me, conversationId, clientId, type, body, mediaId, replyToId);
    return { message: await this.presentOne(result.row, me, localeOf(request)), duplicate: result.duplicate };
  }

  /** Мантиқи умумии фиристодан (API, ҷавоб ба story). */
  async sendAs(me, conversationId, clientId, type, body, mediaId, replyToId) {
    if (type === 'text' && body === '') throw fail.field('body', 'required');
    if (type !== 'text' && !mediaId) throw fail.field('media_id', 'required');
    if (type === 'text' && mediaId) throw fail.field('media_id', 'unsupported');

    const membership = await this.membership(conversationId, me);
    if (!membership) throw fail.notFound();

    const existing = await this.findByClientId(me, clientId);
    if (existing) return { row: existing, duplicate: true };

    const isGroup = membership.type === 'group';
    let peerId = null;
    if (isGroup) {
      if (!membership.can_send_messages) throw fail.groupPermission();
    } else {
      peerId = await this.peerId(conversationId, me);
      if (!peerId) throw fail.notFound();
      if (await this.ctx.safety.isBlockedEither(me, peerId)) throw new ApiError('USER_BLOCKED');
      const peer = await this.ctx.users.find(peerId);
      if (!peer || peer.status === 'deleted') throw fail.forbidden();
    }

    const media = mediaId ? await this.ctx.media.requireUsable(mediaId, me, type) : null;
    if (replyToId) {
      const reply = await this.db.one('SELECT conversation_id FROM messages WHERE id = $1', [replyToId]);
      if (!reply || reply.conversation_id !== conversationId) throw fail.notFound();
    }
    const mentions =
      isGroup && body
        ? (
            await this.db.column(
              `SELECT u.id FROM conversation_members cm JOIN users u ON u.id = cm.user_id
               WHERE cm.conversation_id = $1 AND u.username = ANY($2::text[]) AND u.id <> $3`,
              [conversationId, mentionedUsernames(body), me],
            )
          )
        : [];

    let messageId;
    try {
      messageId = await this.db.tx(async (tx) => {
        const seq = await tx.value('UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq', [
          conversationId,
        ]);
        const id = uuidv7();
        await tx.exec(
          `INSERT INTO messages (id, conversation_id, seq, sender_id, client_message_id, type, body, reply_to_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, conversationId, seq, me, clientId, type, body, replyToId],
        );
        if (media) {
          await tx.exec('INSERT INTO message_attachments (message_id, position, media_id) VALUES ($1, 0, $2)', [id, media.id]);
        }
        await tx.exec('UPDATE conversations SET last_message_id = $2, last_message_at = now() WHERE id = $1', [conversationId, id]);
        // Барои дигарон: +1 нохонда; чати бе mute аз архив мебарояд.
        await tx.exec(
          `UPDATE conversation_members SET unread_count = unread_count + 1,
             is_archived = CASE WHEN is_muted THEN is_archived ELSE false END
           WHERE conversation_id = $1 AND user_id <> $2`,
          [conversationId, me],
        );
        // Фиристанда ҳамаи то ин ҷоро хондааст; draft тоза.
        await tx.exec(
          `UPDATE conversation_members SET last_read_seq = GREATEST(last_read_seq, $3),
             last_delivered_seq = GREATEST(last_delivered_seq, $3), unread_count = 0, mention_count = 0, draft = NULL
           WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, me, seq],
        );
        if (mentions.length) {
          await tx.exec(
            'UPDATE conversation_members SET mention_count = mention_count + 1 WHERE conversation_id = $1 AND user_id = ANY($2::uuid[])',
            [conversationId, mentions],
          );
        }
        await this.ctx.bus.publish({ t: 'msg', k: 'created', c: conversationId, m: id }, tx);
        await this.ctx.bus.publish({ t: 'receipt', c: conversationId }, tx);
        return id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const again = await this.findByClientId(me, clientId);
        if (again) return { row: again, duplicate: true };
      }
      throw error;
    }

    if (peerId) await this.ctx.safety.addContact(me, peerId);
    this.ctx.hub.clearTyping(conversationId, me);
    const row = await this.findMessage(messageId);
    this.ctx.push.notifyMessage(row, membership.type, mentions).catch((error) =>
      this.ctx.log?.warn({ err: { message: error.message } }, 'push_enqueue_failed'),
    );
    return { row, duplicate: false };
  }

  /** PATCH /messages/:id {body} — танҳо муаллиф, дар мӯҳлати таҳрир. */
  async editMessage(request) {
    const me = request.user.id;
    const id = normalizeUuid(request.params.id);
    const row = id ? await this.findMessage(id) : null;
    if (!row || !(await this.membership(row.conversation_id, me))) throw fail.notFound();
    if (row.sender_id !== me) throw fail.forbidden();
    if (row.deleted_at) throw fail.notFound();
    const windowHours = this.ctx.settings.get('message_edit_window_hours');
    if (windowHours > 0 && Date.now() - new Date(row.created_at).getTime() > windowHours * 3_600_000) throw fail.forbidden();

    const v = Validator.of(request.body);
    const body = v.string('body', { required: row.type === 'text', max: MAX_MESSAGE_LENGTH, multiline: true });
    v.validate();

    await this.db.tx(async (tx) => {
      await tx.exec('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1 AND deleted_at IS NULL', [id, body ?? '']);
      await this.ctx.bus.publish({ t: 'msg', k: 'updated', c: row.conversation_id, m: id }, tx);
    });
    return { message: await this.presentOne((await this.findMessage(id)) ?? row, me, localeOf(request)) };
  }

  /** DELETE /messages/:id — фиристанда; дар гурӯҳ owner/admin ҳам. */
  async deleteMessage(request) {
    const me = request.user.id;
    const id = normalizeUuid(request.params.id);
    const row = id ? await this.findMessage(id) : null;
    const membership = row ? await this.membership(row.conversation_id, me) : null;
    if (!row || !membership) throw fail.notFound();
    const isModerator = membership.type === 'group' && ['owner', 'admin'].includes(membership.role);
    if (row.sender_id !== me && !isModerator) throw fail.forbidden();

    if (!row.deleted_at) {
      await this.db.tx(async (tx) => {
        const changed = await tx.exec(
          "UPDATE messages SET body = '', deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL",
          [id, me],
        );
        await tx.exec('DELETE FROM message_attachments WHERE message_id = $1', [id]);
        if (changed) {
          await tx.exec(
            `UPDATE conversation_members SET unread_count = GREATEST(unread_count - 1, 0)
             WHERE conversation_id = $1 AND user_id <> $2 AND last_read_seq < $3`,
            [row.conversation_id, row.sender_id, row.seq],
          );
          await tx.exec(
            `UPDATE conversations c SET last_message_id = last.id, last_message_at = last.created_at
             FROM (SELECT (SELECT id FROM messages WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1) AS id,
                          (SELECT created_at FROM messages WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1) AS created_at) last
             WHERE c.id = $1 AND c.last_message_id = $2`,
            [row.conversation_id, id],
          );
          await this.ctx.bus.publish({ t: 'msg', k: 'deleted', c: row.conversation_id, m: id }, tx);
        }
      });
    }
    return { message_id: id, is_deleted: true };
  }

  /** POST /messages/:id/read — ҳамаи то ин паём хонда шуд. */
  async markReadRoute(request) {
    const me = request.user.id;
    const id = normalizeUuid(request.params.id);
    const row = id ? await this.db.one('SELECT conversation_id, seq FROM messages WHERE id = $1', [id]) : null;
    if (!row || !(await this.membership(row.conversation_id, me))) throw fail.notFound();
    const result = await this.markRead(row.conversation_id, me, Number(row.seq));
    return {
      conversation_id: row.conversation_id,
      last_read_seq: Number(result?.last_read_seq ?? 0),
      unread_count: Number(result?.unread_count ?? 0),
    };
  }

  /** GET /search/messages?q=&limit=&conversation_id= */
  async search(request) {
    const me = request.user.id;
    const query = String(request.query.q ?? '').trim();
    if (length(query) < 2 || length(query) > 100) throw fail.field('q', 'length');
    let conversationId = null;
    if (request.query.conversation_id) {
      conversationId = normalizeUuid(String(request.query.conversation_id));
      if (!conversationId || !(await this.membership(conversationId, me))) throw fail.notFound();
    }
    const limit = queryInt(request.query, 'limit', 30, 1, 50);
    const words = query
      .split(/[\s\p{P}]+/u)
      .map((word) => word.replace(/[^\p{L}\p{N}_]/gu, ''))
      .filter((word) => length(word) >= 2)
      .slice(0, 8);

    const params = [me, limit];
    let filter;
    if (words.length) {
      params.push(words.map((word) => `${word.toLowerCase()}:*`).join(' & '));
      filter = `m.body_tsv @@ to_tsquery('simple', $${params.length})`;
    } else {
      params.push(`%${likeEscape(query)}%`);
      filter = `m.body ILIKE $${params.length}`;
    }
    if (conversationId) {
      params.push(conversationId);
      filter += ` AND m.conversation_id = $${params.length}`;
    }
    const rows = await this.db.many(
      `SELECT m.id, m.conversation_id, m.seq, m.sender_id, m.type, m.body, m.created_at
       FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
       JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
       WHERE m.deleted_at IS NULL AND ${filter}
       ORDER BY m.created_at DESC LIMIT $2`,
      params,
    );
    const users = await this.ctx.users.present(rows.map((r) => r.sender_id), me, localeOf(request));
    return {
      messages: rows.map((row) => ({
        id: row.id,
        conversation_id: row.conversation_id,
        seq: Number(row.seq),
        sender_id: row.sender_id,
        sender_name: users.get(row.sender_id)?.display_name ?? '',
        type: row.type,
        body: row.body,
        created_at: iso(row.created_at),
      })),
    };
  }

  /**
   * GET /sync?since=<ISO>&limit= — тағйироти баъд аз вақт (33). server_time — курсори навбатӣ
   * (бо 10 сония такрор, то тағйироти ҳамзамон гум нашаванд; клиент аз рӯи id дубликатро мепартояд).
   */
  async sync(request) {
    const me = request.user.id;
    const raw = String(request.query.since ?? '');
    const since = raw ? new Date(raw) : null;
    if (!since || Number.isNaN(since.getTime())) throw fail.field('since', raw ? 'format' : 'required');
    const limit = queryInt(request.query, 'limit', 200, 1, 500);
    const now = await this.db.value('SELECT now()');
    const cursor = new Date(new Date(now).getTime() - 10_000);
    const locale = localeOf(request);

    const chatRows = await this.changedSince(me, since, 200);
    const rows = await this.db.many(
      `${MESSAGE_SELECT}
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
       WHERE m.updated_at > $2
       ORDER BY m.updated_at ASC, m.id ASC LIMIT $3`,
      [me, since, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const byConversation = new Map();
    for (const row of page) {
      if (!byConversation.has(row.conversation_id)) byConversation.set(row.conversation_id, []);
      byConversation.get(row.conversation_id).push(row);
    }
    const messages = [];
    for (const [conversationId, list] of byConversation) {
      const membership = await this.membership(conversationId, me);
      if (!membership) continue;
      const receipts = await this.receipts(conversationId, membership.type, me);
      messages.push(...(await this.presentMessages(list, me, locale, receipts)));
    }
    return {
      server_time: (hasMore && page.length ? new Date(page[page.length - 1].updated_at) : cursor).toISOString(),
      chats: await this.presentChats(chatRows, me, locale),
      messages,
      has_more: hasMore,
    };
  }
}
