import { fail } from '../core/errors.js';
import { baseUrlOf, localeOf } from '../core/http.js';
import { normalizeUuid, uuidv7 } from '../core/ids.js';
import { cleanName, randomToken } from '../core/text.js';
import { Validator } from '../core/validator.js';
import { presentGroup } from '../presenters.js';
import { PERMISSIONS } from './chats.js';

export function extractInviteCode(link) {
  const match = /(?:^|\/join\/)([A-Za-z0-9_-]{8,32})\/?$/.exec(String(link).trim());
  return match ? match[1] : null;
}

/**
 * Гурӯҳҳо (13, 21): ҳамаи ихтиёрот дар сервер санҷида мешаванд.
 * :id дар роҳ — ID-и чати гурӯҳӣ (conversations.id). Ғайриаъзо → 404.
 */
export class Groups {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get db() {
    return this.ctx.db;
  }

  findByConversation(conversationId, q = this.db) {
    return q.one('SELECT * FROM chat_groups WHERE conversation_id = $1', [conversationId]);
  }

  async updateGroup(groupId, fields, q = this.db) {
    const allowed = ['name', 'description', 'avatar_media_id', 'invite_code', 'owner_id'];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const sets = entries.map(([key], i) => `${key} = $${i + 2}`);
    await q.exec(`UPDATE chat_groups SET ${sets.join(', ')} WHERE id = $1`, [groupId, ...entries.map(([, v]) => v)]);
  }

  inviteLink(request, code) {
    return `${baseUrlOf(request, this.ctx.config)}/join/${code}`;
  }

  /** Гурӯҳи нав (POST /chats type=group). Аъзоёни нодуруст/блокшуда нодида гирифта мешаванд. */
  async create(ownerId, name, memberIds) {
    if (!name) throw fail.field('name', 'required');
    const valid = [];
    for (const userId of memberIds) {
      if (userId === ownerId || valid.includes(userId)) continue;
      if (!(await this.ctx.users.findActive(userId))) continue;
      if (await this.ctx.safety.isBlockedEither(ownerId, userId)) continue;
      valid.push(userId);
    }
    const conversationId = await this.db.tx(async (tx) => {
      const id = uuidv7();
      await tx.exec("INSERT INTO conversations (id, type, created_by) VALUES ($1, 'group', $2)", [id, ownerId]);
      await tx.exec('INSERT INTO chat_groups (id, conversation_id, name, owner_id) VALUES ($1, $2, $3, $4)', [
        uuidv7(),
        id,
        name,
        ownerId,
      ]);
      await this.ctx.chats.addMember(id, ownerId, 'owner', tx);
      for (const userId of valid) await this.ctx.chats.addMember(id, userId, 'member', tx);
      await this.ctx.bus.publish({ t: 'chat', c: id }, tx);
      return id;
    });
    this.ctx.log?.info({ conversation_id: conversationId, members: valid.length + 1 }, 'group_created');
    return conversationId;
  }

  /** [group, membership] ё 404. */
  async context(rawId, userId) {
    const conversationId = normalizeUuid(rawId);
    const member = conversationId ? await this.ctx.chats.membership(conversationId, userId) : null;
    if (!member || member.type !== 'group') throw fail.notFound();
    const group = await this.findByConversation(conversationId);
    if (!group) throw fail.notFound();
    return [group, member];
  }

  static requirePermission(member, permission) {
    if (!member[permission]) throw fail.groupPermission();
  }

  async present(group, userId, request) {
    const conversationId = group.conversation_id;
    const member = await this.ctx.chats.membership(conversationId, userId);
    const count = await this.ctx.chats.countMembers(conversationId);
    return presentGroup(group, member, count, group.invite_code ? this.inviteLink(request, group.invite_code) : null);
  }

  /** GET /groups/:id */
  async show(request) {
    const [group] = await this.context(request.params.id, request.user.id);
    return { group: await this.present(group, request.user.id, request) };
  }

  /** PATCH /groups/:id — name, description, avatar_media_id ("" — нест кардан). */
  async update(request) {
    const me = request.user.id;
    const [group, member] = await this.context(request.params.id, me);
    Groups.requirePermission(member, 'can_edit_info');

    const v = Validator.of(request.body);
    const fields = {};
    if (v.has('name')) {
      const name = v.string('name', { required: true, min: 1, max: 64 });
      if (name !== null) fields.name = cleanName(name);
    }
    if (v.has('description')) fields.description = v.string('description', { max: 300, multiline: true }) ?? '';
    let avatarId = null;
    if (v.present('avatar_media_id')) {
      const raw = v.raw('avatar_media_id');
      if (raw === null || raw === '') fields.avatar_media_id = null;
      else avatarId = v.uuid('avatar_media_id');
    }
    v.validate();

    if (avatarId) {
      const media = await this.ctx.media.requireUsable(avatarId, me, 'image');
      if (media.owner_id !== me) throw fail.field('avatar_media_id', 'unsupported');
      fields.avatar_media_id = avatarId;
    }
    if (Object.keys(fields).length) {
      await this.db.tx(async (tx) => {
        await this.updateGroup(group.id, fields, tx);
        await this.ctx.bus.publish({ t: 'chat', c: group.conversation_id }, tx);
      });
    }
    return { group: await this.present((await this.findByConversation(group.conversation_id)) ?? group, me, request) };
  }

  /** DELETE /groups/:id — танҳо соҳиб. */
  async remove(request) {
    const [group, member] = await this.context(request.params.id, request.user.id);
    if (member.role !== 'owner') throw fail.groupPermission();
    await this.deleteGroup(group);
    return { deleted: true, removed: true };
  }

  async deleteGroup(group, q = null) {
    const run = async (tx) => {
      const members = await this.ctx.chats.memberIds(group.conversation_id, tx);
      await this.updateGroup(group.id, { invite_code: null }, tx);
      await this.ctx.chats.softDelete(group.conversation_id, tx);
      await this.ctx.bus.publish({ t: 'chat_removed', c: group.conversation_id, u: members }, tx);
    };
    if (q) await run(q);
    else await this.db.tx(run);
    this.ctx.log?.info({ conversation_id: group.conversation_id }, 'group_deleted');
  }

  /** GET /groups/:id/members */
  async members(request) {
    const [group] = await this.context(request.params.id, request.user.id);
    return { members: await this.ctx.chats.presentMembers(group.conversation_id, request.user.id, localeOf(request)) };
  }

  /** POST /groups/:id/members {user_ids[]} */
  async addMembers(request) {
    const me = request.user.id;
    const [group, member] = await this.context(request.params.id, me);
    Groups.requirePermission(member, 'can_add_members');
    const v = Validator.of(request.body);
    const userIds = v.uuidList('user_ids', { max: 100, required: true });
    v.validate();

    const conversationId = group.conversation_id;
    const max = this.ctx.settings.get('group_max_members');
    const added = [];
    await this.db.tx(async (tx) => {
      let count = await this.ctx.chats.countMembers(conversationId, tx);
      for (const userId of userIds) {
        if (userId === me || count >= max) continue;
        if (await this.ctx.chats.membership(conversationId, userId, tx)) continue;
        if (!(await this.ctx.users.findActive(userId, tx))) continue;
        if (await this.ctx.safety.isBlockedEither(me, userId, tx)) continue;
        await this.ctx.chats.addMember(conversationId, userId, 'member', tx);
        added.push(userId);
        count++;
      }
      if (added.length) await this.ctx.bus.publish({ t: 'chat', c: conversationId }, tx);
    });
    return { group: await this.present(group, me, request), added };
  }

  /** DELETE /groups/:id/members/:userId — худ → баромадан. */
  async removeMember(request) {
    const me = request.user.id;
    const [group, member] = await this.context(request.params.id, me);
    const targetId = normalizeUuid(request.params.userId);
    if (!targetId) throw fail.notFound();
    if (targetId === me) {
      await this.leaveGroup(group.conversation_id, me);
      return { removed: true };
    }
    Groups.requirePermission(member, 'can_remove_members');
    const target = await this.ctx.chats.membership(group.conversation_id, targetId);
    if (!target) throw fail.notFound();
    if (target.role === 'owner' || (target.role === 'admin' && member.role !== 'owner')) throw fail.groupPermission();

    await this.db.tx(async (tx) => {
      await this.ctx.chats.removeMember(group.conversation_id, targetId, tx);
      await this.ctx.bus.publish({ t: 'chat', c: group.conversation_id }, tx);
      await this.ctx.bus.publish({ t: 'chat_removed', c: group.conversation_id, u: [targetId] }, tx);
    });
    return { removed: true };
  }

  /** POST /groups/:id/members/:userId/role {role: admin|member} — танҳо соҳиб. */
  async setRole(request) {
    const me = request.user.id;
    const [group, member] = await this.context(request.params.id, me);
    if (member.role !== 'owner') throw fail.groupPermission();
    const v = Validator.of(request.body);
    const role = v.enum('role', ['admin', 'member'], { required: true });
    v.validate();
    const targetId = normalizeUuid(request.params.userId);
    const target = targetId ? await this.ctx.chats.membership(group.conversation_id, targetId) : null;
    if (!target) throw fail.notFound();
    if (target.role === 'owner') throw fail.field('user_id', 'self');
    await this.ctx.chats.setRole(group.conversation_id, targetId, role);
    await this.ctx.bus.publish({ t: 'chat', c: group.conversation_id });
    return { members: await this.ctx.chats.presentMembers(group.conversation_id, me, localeOf(request)) };
  }

  /** PATCH /groups/:id/members/:userId/permissions {can_*: bool} — танҳо соҳиб. */
  async setPermissions(request) {
    const me = request.user.id;
    const [group, member] = await this.context(request.params.id, me);
    if (member.role !== 'owner') throw fail.groupPermission();
    const v = Validator.of(request.body);
    const permissions = {};
    for (const name of PERMISSIONS) {
      const value = v.bool(name);
      if (value !== null) permissions[name] = value;
    }
    if (Object.keys(permissions).length === 0 && v.passes()) v.fail('permissions', 'required');
    v.validate();
    const targetId = normalizeUuid(request.params.userId);
    const target = targetId ? await this.ctx.chats.membership(group.conversation_id, targetId) : null;
    if (!target) throw fail.notFound();
    if (target.role === 'owner') throw fail.field('user_id', 'self');
    await this.ctx.chats.setPermissions(group.conversation_id, targetId, permissions);
    await this.ctx.bus.publish({ t: 'chat', c: group.conversation_id });
    return { members: await this.ctx.chats.presentMembers(group.conversation_id, me, localeOf(request)) };
  }

  /** POST /groups/:id/leave */
  async leave(request) {
    const [group] = await this.context(request.params.id, request.user.id);
    return this.leaveGroup(group.conversation_id, request.user.id);
  }

  /** Баромадан; соҳиб → моликият ба admin/узви кӯҳнатарин; охирин узв → гурӯҳ нест. */
  async leaveGroup(conversationId, userId) {
    const [group] = await this.context(conversationId, userId);
    return this.db.tx(async (tx) => {
      if ((await this.ctx.chats.countMembers(conversationId, tx)) <= 1) {
        await this.ctx.chats.removeMember(conversationId, userId, tx);
        await this.updateGroup(group.id, { invite_code: null }, tx);
        await this.ctx.chats.softDelete(conversationId, tx);
        await this.ctx.bus.publish({ t: 'chat_removed', c: conversationId, u: [userId] }, tx);
        return { left: true, deleted: true };
      }
      if (group.owner_id === userId) {
        const next = await tx.value(
          `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2
           ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at, user_id LIMIT 1`,
          [conversationId, userId],
        );
        if (next) {
          await this.updateGroup(group.id, { owner_id: next }, tx);
          await this.ctx.chats.setRole(conversationId, next, 'owner', tx);
        }
      }
      await this.ctx.chats.removeMember(conversationId, userId, tx);
      await this.ctx.bus.publish({ t: 'chat', c: conversationId }, tx);
      await this.ctx.bus.publish({ t: 'chat_removed', c: conversationId, u: [userId] }, tx);
      return { left: true, deleted: false };
    });
  }

  /** POST /groups/:id/invite */
  async enableInvite(request) {
    const [group, member] = await this.context(request.params.id, request.user.id);
    Groups.requirePermission(member, 'can_edit_info');
    let code = group.invite_code;
    if (!code) {
      code = randomToken(22);
      await this.updateGroup(group.id, { invite_code: code });
    }
    return { invite_link: this.inviteLink(request, code) };
  }

  /** DELETE /groups/:id/invite */
  async revokeInvite(request) {
    const [group, member] = await this.context(request.params.id, request.user.id);
    Groups.requirePermission(member, 'can_edit_info');
    await this.updateGroup(group.id, { invite_code: null });
    return { revoked: true };
  }

  /** POST /groups/join {invite_link} — пурра ё танҳо рамз. */
  async join(request) {
    const me = request.user.id;
    const v = Validator.of(request.body);
    const link = v.string('invite_link', { required: true, min: 8, max: 300 });
    v.validate();
    const code = extractInviteCode(link);
    const group = code
      ? await this.db.one(
          `SELECT g.* FROM chat_groups g JOIN conversations c ON c.id = g.conversation_id AND c.deleted_at IS NULL
           WHERE g.invite_code = $1`,
          [code],
        )
      : null;
    if (!group) throw fail.notFound();
    const conversationId = group.conversation_id;
    if (!(await this.ctx.chats.membership(conversationId, me))) {
      if ((await this.ctx.chats.countMembers(conversationId)) >= this.ctx.settings.get('group_max_members')) {
        throw fail.groupPermission();
      }
      await this.ctx.chats.addMember(conversationId, me, 'member');
      await this.ctx.bus.publish({ t: 'chat', c: conversationId });
      this.ctx.log?.info({ conversation_id: conversationId }, 'group_joined_by_invite');
    }
    return { group: await this.present(group, me, request) };
  }
}
