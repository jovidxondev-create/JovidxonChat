import { randomBytes } from 'node:crypto';
import { fail } from '../core/errors.js';
import { localeOf } from '../core/http.js';
import { normalizeUuid, uuidv7 } from '../core/ids.js';
import { Validator } from '../core/validator.js';
import { presentStory } from '../presenters.js';
import { MAX_MESSAGE_LENGTH } from './chats.js';
import { Users, iso } from './users.js';

/**
 * Статус / Stories (36): 24 соат, privacy, блок, тамошобинон (танҳо муаллиф), ҷавоб → чати хусусӣ.
 * Лента: stories-и худам + ҳамсуҳбатони чатҳои хусусӣ.
 */
export class Stories {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get db() {
    return this.ctx.db;
  }

  /** Муаллиф ҳамеша; блок — ҳеҷ гоҳ; everyone; contacts — касоне, ки муаллиф ба онҳо навиштааст. */
  async canView(story, viewerId) {
    if (story.user_id === viewerId) return true;
    if (await this.ctx.safety.isBlockedEither(story.user_id, viewerId)) return false;
    if (story.privacy === 'everyone') return true;
    if (story.privacy === 'contacts') return this.ctx.safety.isContact(story.user_id, viewerId);
    return false;
  }

  findLive(id) {
    return this.db.one(
      `SELECT s.*, (SELECT count(*) FROM story_views v WHERE v.story_id = s.id) AS views_count
       FROM stories s WHERE s.id = $1 AND s.deleted_at IS NULL AND s.expires_at > now()`,
      [id],
    );
  }

  /** GET /stories — тартиб: ман → надида → дида. */
  async feed(request) {
    const me = request.user.id;
    const authorIds = [...new Set([me, ...(await this.ctx.chats.privatePeers(me))])];
    const rows = await this.db.many(
      `SELECT s.*, (SELECT count(*) FROM story_views v WHERE v.story_id = s.id) AS views_count,
              EXISTS (SELECT 1 FROM story_views w WHERE w.story_id = s.id AND w.viewer_id = $1) AS is_viewed
       FROM stories s
       WHERE s.user_id = ANY($2::uuid[]) AND s.deleted_at IS NULL AND s.expires_at > now()
       ORDER BY s.created_at ASC LIMIT 500`,
      [me, authorIds],
    );
    const relations = await this.ctx.users.relationsMany([me], authorIds);
    const visible = rows.filter((row) => {
      if (row.user_id === me) return true;
      const key = `${me}|${row.user_id}`;
      if (relations.blockedBy.has(key) || relations.blocking.has(key)) return false;
      if (row.privacy === 'everyone') return true;
      if (row.privacy === 'contacts') return relations.contacts.has(key);
      return false;
    });
    const authors = await this.ctx.users.present(visible.map((r) => r.user_id), me, localeOf(request));

    const groups = new Map();
    for (const row of visible) {
      const group = groups.get(row.user_id) ?? { rows: [], latest: 0, unseen: false };
      group.rows.push(row);
      group.latest = Math.max(group.latest, new Date(row.created_at).getTime());
      group.unseen ||= !row.is_viewed;
      groups.set(row.user_id, group);
    }
    const order = [...groups.keys()].sort((a, b) => {
      if (a === me || b === me) return a === me ? -1 : 1;
      if (groups.get(a).unseen !== groups.get(b).unseen) return groups.get(a).unseen ? -1 : 1;
      return groups.get(b).latest - groups.get(a).latest;
    });
    const stories = [];
    for (const author of order) {
      if (!authors.has(author)) continue;
      for (const row of groups.get(author).rows) stories.push(presentStory(row, authors.get(author), me));
    }
    return { stories };
  }

  /** POST /stories {media_id?, caption, privacy} */
  async create(request) {
    const me = request.user.id;
    const v = Validator.of(request.body);
    const mediaId = v.uuid('media_id');
    const caption = v.string('caption', { max: 700, multiline: true }) ?? '';
    const privacy = v.enum('privacy', ['everyone', 'contacts', 'nobody']) ?? 'everyone';
    v.validate();

    let type = 'text';
    if (mediaId) {
      const media = await this.ctx.media.requireUsable(mediaId, me, null);
      if (media.owner_id !== me || !['image', 'video'].includes(media.kind)) throw fail.field('media_id', 'unsupported');
      type = media.kind;
    } else if (caption === '') {
      throw fail.field('caption', 'required');
    }
    const id = uuidv7();
    await this.db.exec(
      `INSERT INTO stories (id, user_id, type, media_id, caption, privacy, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))`,
      [id, me, type, mediaId, caption, privacy, this.ctx.settings.get('story_ttl_hours')],
    );
    const row = await this.findLive(id);
    row.is_viewed = true;
    return { story: presentStory(row, Users.presentSelf(request.user, localeOf(request)), me) };
  }

  /** DELETE /stories/:id — танҳо муаллиф. */
  async remove(request) {
    const id = normalizeUuid(request.params.id);
    const story = id ? await this.findLive(id) : null;
    if (!story || story.user_id !== request.user.id) throw fail.notFound();
    await this.db.exec('UPDATE stories SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [story.id]);
    return { deleted: true };
  }

  /** POST /stories/:id/view — идемпотент; муаллиф сабт намешавад. */
  async view(request) {
    const me = request.user.id;
    const id = normalizeUuid(request.params.id);
    const story = id ? await this.findLive(id) : null;
    if (!story || !(await this.canView(story, me))) throw fail.notFound();
    if (story.user_id !== me) {
      await this.db.exec('INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [story.id, me]);
    }
    return { viewed: true };
  }

  /** GET /stories/:id/viewers — танҳо муаллиф. */
  async viewers(request) {
    const me = request.user.id;
    const id = normalizeUuid(request.params.id);
    const story = id ? await this.findLive(id) : null;
    if (!story || story.user_id !== me) throw fail.notFound();
    const rows = await this.db.many(
      'SELECT viewer_id, viewed_at FROM story_views WHERE story_id = $1 ORDER BY viewed_at DESC LIMIT 1000',
      [story.id],
    );
    const users = await this.ctx.users.present(rows.map((r) => r.viewer_id), me, localeOf(request));
    const viewers = rows.filter((r) => users.has(r.viewer_id)).map((r) => ({ user: users.get(r.viewer_id), viewed_at: iso(r.viewed_at) }));
    return { viewers, views_count: viewers.length };
  }

  /** POST /stories/:id/reply {body, client_message_id?} → паём дар чати хусусӣ. */
  async reply(request) {
    const me = request.user.id;
    const id = normalizeUuid(request.params.id);
    const story = id ? await this.findLive(id) : null;
    if (!story || story.user_id === me || !(await this.canView(story, me))) throw fail.notFound();

    const v = Validator.of(request.body);
    const body = v.string('body', { required: true, min: 1, max: MAX_MESSAGE_LENGTH, multiline: true });
    const clientId =
      v.string('client_message_id', { min: 8, max: 64, pattern: /^[A-Za-z0-9._:-]+$/ }) || `story-${randomBytes(12).toString('hex')}`;
    v.validate();

    if (!(await this.ctx.users.findActive(story.user_id))) throw fail.notFound();
    const existing = await this.ctx.chats.findPrivate(me, story.user_id);
    const conversationId = existing ? existing.id : await this.ctx.chats.createPrivate(me, story.user_id);
    const result = await this.ctx.chats.sendAs(me, conversationId, clientId, 'text', body, null, null);
    return {
      chat_id: conversationId,
      message: await this.ctx.chats.presentOne(result.row, me, localeOf(request)),
      duplicate: result.duplicate,
    };
  }
}
