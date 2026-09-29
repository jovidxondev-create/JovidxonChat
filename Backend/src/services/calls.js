import crypto from 'node:crypto';
import { ApiError, fail } from '../core/errors.js';
import { localeOf } from '../core/http.js';
import { normalizeUuid, uuidv7 } from '../core/ids.js';
import { Validator, queryInt } from '../core/validator.js';
import { presentCall } from '../presenters.js';
import { iso } from './users.js';

const RING_TIMEOUT = 45;
const SIGNAL_KINDS = ['offer', 'answer', 'ice', 'renegotiate', 'hangup'];

/**
 * Зангҳо (16): сервер танҳо signaling ва ҳолатро идора мекунад; аудио/видео — WebRTC (P2P ё TURN).
 * Ҳолатҳо: ringing → accepted → ended | declined | missed | cancelled.
 * Сигналҳо фавран тавассути WebSocket мерасанд; REST (polling) ҳамчун захира мемонад.
 */
export class Calls {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get db() {
    return this.ctx.db;
  }

  find(id) {
    return this.db.one('SELECT c.*, EXTRACT(EPOCH FROM (now() - c.created_at))::int AS age_seconds FROM calls c WHERE c.id = $1', [id]);
  }

  async present(callId, me, locale) {
    const call = await this.find(callId);
    if (!call) throw fail.notFound();
    const peerId = call.caller_id === me ? call.callee_id : call.caller_id;
    return presentCall(call, me, await this.ctx.users.present([peerId], me, locale));
  }

  expireRinging(timeoutSeconds, limit = 200) {
    return this.db.exec(
      `UPDATE calls SET status = 'missed', end_reason = 'timeout', ended_at = now()
       WHERE id IN (SELECT id FROM calls WHERE status = 'ringing'
                    AND created_at < now() - make_interval(secs => $1) LIMIT $2)`,
      [timeoutSeconds, limit],
    );
  }

  expireStale(limit = 200) {
    return this.db.exec(
      `UPDATE calls SET status = 'ended', end_reason = 'stale', ended_at = now(),
         duration_seconds = EXTRACT(EPOCH FROM (now() - answered_at))::int
       WHERE id IN (SELECT id FROM calls WHERE status = 'accepted' AND answered_at < now() - interval '6 hours' LIMIT $1)`,
      [limit],
    );
  }

  async finish(callId, status, reason) {
    const row = await this.db.one(
      `UPDATE calls SET status = $2, end_reason = $3, ended_at = now(),
         duration_seconds = CASE WHEN answered_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - answered_at))::int END
       WHERE id = $1 AND status IN ('ringing', 'accepted') RETURNING id`,
      [callId, status, reason],
    );
    if (row) await this.ctx.bus.publish({ t: 'call', k: 'updated', id: callId });
    return Boolean(row);
  }

  /** GET /calls/config — STUN/TURN барои WebRTC; TURN бо credential-и муваққатӣ (coturn use-auth-secret) ё собит. */
  config(request) {
    const settings = this.ctx.settings;
    const servers = [];
    const stun = settings.get('calls_stun_urls');
    if (stun.length) servers.push({ urls: stun });
    const turn = settings.get('calls_turn_urls');
    if (turn.length) {
      const secret = settings.get('calls_turn_secret');
      if (secret) {
        const ttl = 3600;
        const username = `${Math.floor(Date.now() / 1000) + ttl}:${request.user.id}`;
        servers.push({ urls: turn, username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64'), ttl });
      } else if (settings.get('calls_turn_username')) {
        servers.push({ urls: turn, username: settings.get('calls_turn_username'), credential: settings.get('calls_turn_credential') });
      }
    }
    return { ice_servers: servers, ring_timeout: RING_TIMEOUT, enabled: settings.get('calls_enabled') };
  }

  /** POST /calls {user_id, type: voice|video} */
  async start(request) {
    const me = request.user.id;
    if (!this.ctx.settings.get('calls_enabled')) throw new ApiError('CALL_UNAVAILABLE');
    const v = Validator.of(request.body);
    const calleeId = v.uuid('user_id', { required: true });
    const type = v.enum('type', ['voice', 'video']) ?? 'voice';
    v.validate();
    if (calleeId === me) throw fail.field('user_id', 'self');
    if (!(await this.ctx.users.findActive(calleeId))) throw fail.notFound();
    if (await this.ctx.safety.isBlockedEither(me, calleeId)) throw new ApiError('USER_BLOCKED');
    await this.expireRinging(RING_TIMEOUT, 100);
    const busy = await this.db.value(
      `SELECT 1 FROM calls WHERE (caller_id = ANY($1::uuid[]) OR callee_id = ANY($1::uuid[]))
         AND status IN ('ringing', 'accepted') AND created_at > now() - interval '6 hours' LIMIT 1`,
      [[me, calleeId]],
    );
    if (busy) throw new ApiError('CALL_UNAVAILABLE');

    const conversation = await this.ctx.chats.findPrivate(me, calleeId);
    const id = uuidv7();
    await this.db.tx(async (tx) => {
      await tx.exec(
        "INSERT INTO calls (id, caller_id, callee_id, conversation_id, type, status) VALUES ($1, $2, $3, $4, $5, 'ringing')",
        [id, me, calleeId, conversation?.id ?? null, type],
      );
      await this.ctx.bus.publish({ t: 'call', k: 'incoming', id }, tx);
    });
    this.ctx.push
      .notifyCall(calleeId, id, me, request.user.display_name ?? '', type)
      .catch((error) => this.ctx.log?.warn({ err: { message: error.message } }, 'push_call_failed'));
    return { call: await this.present(id, me, localeOf(request)) };
  }

  /** GET /calls — таърих */
  async history(request) {
    const me = request.user.id;
    await this.expireRinging(RING_TIMEOUT, 100);
    const rows = await this.db.many(
      `SELECT c.*, EXTRACT(EPOCH FROM (now() - c.created_at))::int AS age_seconds FROM calls c
       WHERE c.caller_id = $1 OR c.callee_id = $1 ORDER BY c.created_at DESC LIMIT $2`,
      [me, queryInt(request.query, 'limit', 50, 1, 100)],
    );
    const users = await this.ctx.users.present(
      rows.map((r) => (r.caller_id === me ? r.callee_id : r.caller_id)),
      me,
      localeOf(request),
    );
    return { calls: rows.map((row) => presentCall(row, me, users)) };
  }

  async participantCall(rawId, me) {
    const id = normalizeUuid(rawId);
    let call = id ? await this.find(id) : null;
    if (!call || (call.caller_id !== me && call.callee_id !== me)) throw fail.notFound();
    if (call.status === 'ringing' && call.age_seconds > RING_TIMEOUT) {
      await this.finish(call.id, 'missed', 'timeout');
      call = (await this.find(call.id)) ?? call;
    }
    return call;
  }

  /** GET /calls/:id */
  async show(request) {
    const call = await this.participantCall(request.params.id, request.user.id);
    return { call: await this.present(call.id, request.user.id, localeOf(request)) };
  }

  /** POST /calls/:id/accept — танҳо қабулкунанда. */
  async accept(request) {
    const me = request.user.id;
    const call = await this.participantCall(request.params.id, me);
    if (call.callee_id !== me) throw new ApiError('CALL_UNAVAILABLE');
    const accepted = await this.db.exec(
      "UPDATE calls SET status = 'accepted', answered_at = now() WHERE id = $1 AND status = 'ringing'",
      [call.id],
    );
    if (!accepted) throw new ApiError('CALL_UNAVAILABLE');
    await this.ctx.bus.publish({ t: 'call', k: 'updated', id: call.id });
    return { call: await this.present(call.id, me, localeOf(request)) };
  }

  /** POST /calls/:id/decline */
  async decline(request) {
    const me = request.user.id;
    const call = await this.participantCall(request.params.id, me);
    if (call.callee_id !== me || call.status !== 'ringing') throw new ApiError('CALL_UNAVAILABLE');
    await this.finish(call.id, 'declined', 'declined');
    return { call: await this.present(call.id, me, localeOf(request)) };
  }

  /** POST /calls/:id/end */
  async end(request) {
    const me = request.user.id;
    const call = await this.participantCall(request.params.id, me);
    const status = call.status === 'ringing' ? (call.caller_id === me ? 'cancelled' : 'declined') : 'ended';
    await this.finish(call.id, status, 'hangup');
    return { call: await this.present(call.id, me, localeOf(request)) };
  }

  /** Сигнали WebRTC аз REST ё WebSocket. */
  async addSignal(me, rawCallId, kind, payload) {
    const call = await this.participantCall(rawCallId, me);
    if (!['ringing', 'accepted'].includes(call.status)) throw new ApiError('CALL_UNAVAILABLE');
    if (!SIGNAL_KINDS.includes(kind)) throw fail.field('kind', 'unsupported');
    const encoded = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
    if (!encoded || encoded === 'null' || Buffer.byteLength(encoded) > 65_536) throw fail.field('payload', 'length');
    const recipient = call.caller_id === me ? call.callee_id : call.caller_id;
    const signalId = await this.db.tx(async (tx) => {
      const id = await tx.value(
        'INSERT INTO call_signals (call_id, sender_id, recipient_id, kind, payload) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [call.id, me, recipient, kind, encoded],
      );
      await this.ctx.bus.publish({ t: 'call_signal', id: call.id, sid: id, to: recipient }, tx);
      return id;
    });
    return { signal_id: signalId, call };
  }

  /** POST /calls/:id/signals {kind, payload} */
  async signal(request) {
    const v = Validator.of(request.body);
    const kind = v.enum('kind', SIGNAL_KINDS, { required: true });
    v.validate();
    const result = await this.addSignal(request.user.id, request.params.id, kind, request.body?.payload);
    return { signal_id: result.signal_id };
  }

  static presentSignal(row) {
    let payload = row.payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // сатри хом
    }
    return { id: Number(row.id), sender_id: row.sender_id, kind: row.kind, payload, created_at: iso(row.created_at) };
  }

  /** GET /calls/:id/signals?after= — polling-и сигналҳо барои ман (захираи WebSocket). */
  async signals(request) {
    const me = request.user.id;
    const call = await this.participantCall(request.params.id, me);
    const rows = await this.db.many(
      `SELECT id, sender_id, kind, payload, created_at FROM call_signals
       WHERE call_id = $1 AND recipient_id = $2 AND id > $3 ORDER BY id ASC LIMIT 100`,
      [call.id, me, queryInt(request.query, 'after', 0, 0, Number.MAX_SAFE_INTEGER)],
    );
    return { signals: rows.map(Calls.presentSignal), call: await this.present(call.id, me, localeOf(request)) };
  }
}
