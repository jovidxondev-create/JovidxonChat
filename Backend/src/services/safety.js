import { fail } from '../core/errors.js';
import { localeOf } from '../core/http.js';
import { normalizeUuid, uuidv7 } from '../core/ids.js';
import { Validator } from '../core/validator.js';

/** Блок, контакт ва шикоят (14, 18, 19). */
export class Safety {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get db() {
    return this.ctx.db;
  }

  async isBlockedEither(a, b, q = this.db) {
    return (
      (await q.value(
        'SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1',
        [a, b],
      )) !== null
    );
  }

  async hasBlocked(blocker, blocked) {
    return (await this.db.value('SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [blocker, blocked])) !== null;
  }

  addContact(owner, contact, source = 'chat') {
    if (owner === contact) return Promise.resolve();
    return this.db.exec(
      'INSERT INTO contacts (owner_id, contact_id, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [owner, contact, source],
    );
  }

  async isContact(owner, viewer) {
    return (await this.db.value('SELECT 1 FROM contacts WHERE owner_id = $1 AND contact_id = $2', [owner, viewer])) !== null;
  }

  /** GET /blocks */
  async blocked(request) {
    const me = request.user.id;
    const ids = await this.db.column('SELECT blocked_id FROM blocks WHERE blocker_id = $1 ORDER BY created_at DESC LIMIT 1000', [me]);
    const users = await this.ctx.users.present(ids, me, localeOf(request));
    return { blocked: ids.filter((id) => users.has(id)).map((id) => users.get(id)) };
  }

  /** POST /blocks {user_id} */
  async block(request) {
    const me = request.user.id;
    const v = Validator.of(request.body);
    const userId = v.uuid('user_id', { required: true });
    v.validate();
    if (userId === me) throw fail.field('user_id', 'self');
    if (!(await this.ctx.users.find(userId))) throw fail.notFound();
    await this.db.exec('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, userId]);
    this.ctx.log?.info({ user_id: me }, 'user_blocked');
    return { blocked: true };
  }

  /** DELETE /blocks/:userId */
  async unblock(request) {
    const userId = normalizeUuid(request.params.userId);
    if (userId) await this.db.exec('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [request.user.id, userId]);
    return { unblocked: true };
  }

  /** POST /reports {user_id?, message_id?, reason, comment?} */
  async report(request) {
    const me = request.user.id;
    const v = Validator.of(request.body);
    let userId = v.uuid('user_id');
    const messageId = v.uuid('message_id');
    const reason = v.enum('reason', ['spam', 'abuse', 'scam', 'other']) ?? 'other';
    const comment = v.string('comment', { max: 500, multiline: true });
    if (!userId && !messageId && v.passes()) v.fail('user_id', 'required');
    v.validate();

    let conversationId = null;
    if (messageId) {
      const message = await this.db.one('SELECT sender_id, conversation_id FROM messages WHERE id = $1', [messageId]);
      if (!message || !(await this.ctx.chats.membership(message.conversation_id, me))) throw fail.notFound();
      userId = message.sender_id;
      conversationId = message.conversation_id;
    }
    if (userId === me) throw fail.field('user_id', 'self');
    if (userId && !(await this.ctx.users.find(userId))) throw fail.notFound();

    const existing = await this.db.value(
      `SELECT id FROM reports WHERE reporter_id = $1 AND status = 'open' AND created_at > now() - interval '1 day'
         AND target_user_id IS NOT DISTINCT FROM $2 AND target_message_id IS NOT DISTINCT FROM $3 LIMIT 1`,
      [me, userId, messageId],
    );
    if (existing) return { reported: true, id: existing };

    const id = uuidv7();
    await this.db.exec(
      `INSERT INTO reports (id, reporter_id, target_user_id, target_message_id, target_conversation_id, reason, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, me, userId, messageId, conversationId, reason, comment || null],
    );
    this.ctx.log?.info({ report_id: id, reason }, 'report_created');
    return { reported: true, id };
  }

  async deleteAllFor(userId, q = this.db) {
    await q.exec('DELETE FROM contacts WHERE owner_id = $1 OR contact_id = $1', [userId]);
    await q.exec('DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
  }
}
