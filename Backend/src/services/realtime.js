import pg from 'pg';
import { ApiError } from '../core/errors.js';
import { normalizeLocale } from '../core/i18n.js';
import { isUuid } from '../core/ids.js';
import { presentCall, presentMessage } from '../presenters.js';
import { Calls } from './calls.js';
import { iso } from './users.js';

const CHANNEL = 'jovidxon_events';
const TYPING_TTL_MS = 6000;
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 25_000;
const MAX_SUBSCRIPTIONS = 300;
const NO_RECEIPTS = { read: 0, delivered: 0, others: 0, receipts: false };

/**
 * Шинаи ҳодисаҳо байни instance-ҳо: PostgreSQL LISTEN/NOTIFY.
 * NOTIFY дар транзаксия танҳо баъди COMMIT мерасад — ҳодиса барои амали баргашта намеравад.
 */
export class Bus {
  constructor({ db, log }) {
    this.db = db;
    this.log = log;
    this.handlers = [];
    this.client = null;
    this.stopped = false;
    this.connected = false;
    this.attempt = 0;
    this.timer = null;
  }

  on(handler) {
    this.handlers.push(handler);
  }

  async publish(event, q = this.db) {
    const text = JSON.stringify(event);
    if (Buffer.byteLength(text) > 7900) {
      this.log?.error({ type: event.t }, 'bus_event_too_large');
      return;
    }
    await q.query('SELECT pg_notify($1, $2)', [CHANNEL, text]);
  }

  dispatch(event) {
    for (const handler of this.handlers) {
      Promise.resolve()
        .then(() => handler(event))
        .catch((error) => this.log?.warn({ type: event?.t, err: { message: error?.message } }, 'bus_handler_failed'));
    }
  }

  async start() {
    await this.connect();
  }

  async connect() {
    const { connectionString, ssl } = this.db.pool.options;
    const client = new pg.Client({ connectionString, ssl, application_name: 'jovidxonchat-listener' });
    client.on('notification', (message) => {
      try {
        this.dispatch(JSON.parse(message.payload));
      } catch {
        // payload-и вайрон — нодида
      }
    });
    client.on('error', (error) => {
      this.log?.warn({ err: { message: error.message } }, 'bus_listener_error');
      this.scheduleReconnect(client);
    });
    client.on('end', () => this.scheduleReconnect(client));
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.client = client;
    this.connected = true;
    this.attempt = 0;
  }

  scheduleReconnect(client) {
    if (this.stopped || (client && this.client !== client && this.client !== null)) return;
    if (this.timer) return;
    this.connected = false;
    if (this.client) {
      this.client.removeAllListeners('end');
      this.client.end().catch(() => {});
      this.client = null;
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.connect();
        this.log?.info('bus_listener_reconnected');
        // Дар вақти қатъ ҳодисаҳо гум шуда метавонистанд — клиентҳо аз нав синхрон кунанд.
        this.dispatch({ t: 'resync' });
      } catch {
        this.scheduleReconnect(null);
      }
    }, delay);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.client) {
      this.client.removeAllListeners('end');
      await this.client.end().catch(() => {});
    }
  }
}

/**
 * WebSocket (32): /api/v1/ws. Протокол JSON {v: 1, type, data}.
 * Client → server: auth {token}, ping, typing {conversation_id, state}, presence.subscribe {user_ids},
 *                  delivered {conversation_id, seq}, call.signal {call_id, kind, payload}.
 * Server → client: ready, pong, message.created|updated|deleted, receipt, typing, presence,
 *                  chat.updated, chat.removed, call.incoming, call.updated, call.signal, resync, error.
 */
export class Hub {
  constructor(ctx) {
    this.ctx = ctx;
    this.conns = new Map();
    this.subscribers = new Map();
    this.typingMap = new Map();
    this.memberCache = new Map();
    this.pendingReceipts = new Map();
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  get db() {
    return this.ctx.db;
  }

  connectionCount() {
    let count = 0;
    for (const set of this.conns.values()) count += set.size;
    return count;
  }

  // ================================================================ typing (дар хотира)

  isTyping(conversationId, exceptUserId) {
    const map = this.typingMap.get(conversationId);
    if (!map) return false;
    const now = Date.now();
    for (const [userId, expires] of map) {
      if (userId !== exceptUserId && expires > now) return true;
    }
    return false;
  }

  setTypingLocal(conversationId, userId, state) {
    let map = this.typingMap.get(conversationId);
    if (state === 'start') {
      if (!map) this.typingMap.set(conversationId, (map = new Map()));
      map.set(userId, Date.now() + TYPING_TTL_MS);
    } else if (map) {
      map.delete(userId);
      if (map.size === 0) this.typingMap.delete(conversationId);
    }
  }

  async publishTyping(conversationId, userId, state) {
    this.setTypingLocal(conversationId, userId, state);
    await this.ctx.bus.publish({ t: 'typing', c: conversationId, u: userId, s: state });
  }

  clearTyping(conversationId, userId) {
    const map = this.typingMap.get(conversationId);
    if (map?.has(userId)) this.publishTyping(conversationId, userId, 'stop').catch(() => {});
  }

  // ================================================================ аъзоён (кэши кӯтоҳ)

  async members(conversationId, fresh = false) {
    const cached = this.memberCache.get(conversationId);
    if (!fresh && cached && cached.expires > Date.now()) return cached.ids;
    const ids = await this.ctx.chats.memberIds(conversationId);
    if (this.memberCache.size > 5000) this.memberCache.clear();
    this.memberCache.set(conversationId, { ids, expires: Date.now() + 30_000 });
    return ids;
  }

  localIds(ids) {
    return ids.filter((id) => this.conns.has(id));
  }

  localeOf(userId) {
    const first = this.conns.get(userId)?.values().next().value;
    return first?.locale ?? 'tk';
  }

  // ================================================================ пайвастҳо

  send(conn, type, data) {
    if (conn.socket.readyState !== 1) return;
    try {
      conn.socket.send(JSON.stringify({ v: 1, type, data }));
    } catch {
      // пайваст баста мешавад
    }
  }

  sendToUser(userId, type, data) {
    for (const conn of this.conns.get(userId) ?? []) this.send(conn, type, data);
  }

  handle(socket, request) {
    let conn = null;
    const limiterIdentity = `ip:${request.ip}`;
    const authTimer = setTimeout(() => socket.close(4008, 'auth_timeout'), AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    this.ctx.limiter.hit('ws_connect_ip', limiterIdentity).catch(() => socket.close(4029, 'rate_limited'));

    let queue = Promise.resolve();
    socket.on('message', (raw, isBinary) => {
      queue = queue.then(async () => {
        if (isBinary) return socket.close(1003, 'binary_not_supported');
        let message;
        try {
          message = JSON.parse(raw.toString('utf8'));
        } catch {
          return this.sendRaw(socket, 'error', { code: 'BAD_MESSAGE' });
        }
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
          return this.sendRaw(socket, 'error', { code: 'BAD_MESSAGE' });
        }
        const data = message.data && typeof message.data === 'object' ? message.data : message;
        if (!conn) {
          if (message.type !== 'auth') return socket.close(4001, 'auth_required');
          const account = await this.ctx.auth.consumeSocketToken(data.token).catch(() => null);
          if (!account) return socket.close(4001, 'unauthorized');
          clearTimeout(authTimer);
          conn = {
            socket,
            userId: account.user.id,
            sessionId: account.session.id,
            deviceId: account.session.device_id,
            locale: normalizeLocale(data.locale),
            subs: new Set(),
            alive: true,
            lastTouch: 0,
          };
          await this.add(conn);
          this.send(conn, 'ready', { user_id: conn.userId, session_id: conn.sessionId, server_time: new Date().toISOString() });
          return undefined;
        }
        try {
          await this.onClientMessage(conn, message.type, data);
        } catch (error) {
          const code = error instanceof ApiError ? error.code : 'SERVER_ERROR';
          if (!(error instanceof ApiError)) this.ctx.log?.warn({ err: { message: error?.message } }, 'ws_message_failed');
          this.send(conn, 'error', { code, ref: typeof message.id === 'string' ? message.id.slice(0, 64) : null });
        }
        return undefined;
      });
    });
    socket.on('pong', () => {
      if (conn) {
        conn.alive = true;
        this.touch(conn);
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (conn) this.remove(conn).catch(() => {});
    });
    socket.on('error', () => {});
  }

  sendRaw(socket, type, data) {
    if (socket.readyState === 1) socket.send(JSON.stringify({ v: 1, type, data }));
  }

  async add(conn) {
    let set = this.conns.get(conn.userId);
    const first = !set || set.size === 0;
    if (!set) this.conns.set(conn.userId, (set = new Set()));
    set.add(conn);
    this.touch(conn, true);
    if (first) await this.ctx.bus.publish({ t: 'presence', u: conn.userId, s: 'online' });
  }

  async remove(conn) {
    const set = this.conns.get(conn.userId);
    set?.delete(conn);
    for (const subject of conn.subs) this.subscribers.get(subject)?.delete(conn);
    if (set && set.size === 0) {
      this.conns.delete(conn.userId);
      const at = await this.db.value('UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at', [conn.userId]);
      await this.ctx.bus.publish({ t: 'presence', u: conn.userId, s: 'offline', at: iso(at) });
    }
  }

  /** last_seen ҳар 30 с — то presence дар REST низ «online» бошад. */
  touch(conn, force = false) {
    const now = Date.now();
    if (!force && now - conn.lastTouch < 30_000) return;
    conn.lastTouch = now;
    this.db.exec('UPDATE users SET last_seen_at = now() WHERE id = $1', [conn.userId]).catch(() => {});
  }

  tick() {
    for (const set of this.conns.values()) {
      for (const conn of set) {
        if (!conn.alive) {
          conn.socket.terminate?.();
          continue;
        }
        conn.alive = false;
        try {
          conn.socket.ping();
        } catch {
          // баста
        }
      }
    }
    const now = Date.now();
    for (const [conversationId, map] of this.typingMap) {
      for (const [userId, expires] of map) if (expires <= now) map.delete(userId);
      if (map.size === 0) this.typingMap.delete(conversationId);
    }
  }

  closeAll(code = 1001, reason = 'server_shutdown') {
    clearInterval(this.heartbeat);
    for (const set of this.conns.values()) for (const conn of set) conn.socket.close(code, reason);
  }

  async onClientMessage(conn, type, data) {
    switch (type) {
      case 'ping':
        this.touch(conn);
        return this.send(conn, 'pong', { server_time: new Date().toISOString() });
      case 'typing': {
        const conversationId = String(data.conversation_id ?? '').toLowerCase();
        const state = data.state === 'stop' ? 'stop' : 'start';
        if (!isUuid(conversationId)) throw new ApiError('VALIDATION_FAILED');
        await this.ctx.limiter.hit('typing', `u:${conn.userId}`);
        if (!(await this.members(conversationId)).includes(conn.userId)) throw new ApiError('NOT_FOUND');
        return this.publishTyping(conversationId, conn.userId, state);
      }
      case 'presence.subscribe': {
        const ids = Array.isArray(data.user_ids) ? data.user_ids.filter(isUuid).map((id) => id.toLowerCase()) : [];
        for (const subject of conn.subs) this.subscribers.get(subject)?.delete(conn);
        conn.subs = new Set(ids.slice(0, MAX_SUBSCRIPTIONS).filter((id) => id !== conn.userId));
        for (const subject of conn.subs) {
          if (!this.subscribers.has(subject)) this.subscribers.set(subject, new Set());
          this.subscribers.get(subject).add(conn);
        }
        const list = conn.subs.size ? await this.ctx.users.present([...conn.subs], conn.userId, conn.locale) : new Map();
        for (const user of list.values()) {
          this.send(conn, 'presence', { user_id: user.id, state: user.presence === 'online' ? 'online' : 'offline', last_seen_at: user.last_seen_at });
        }
        return undefined;
      }
      case 'delivered': {
        const conversationId = String(data.conversation_id ?? '').toLowerCase();
        const seq = Number(data.seq);
        if (!isUuid(conversationId) || !Number.isSafeInteger(seq) || seq < 0) throw new ApiError('VALIDATION_FAILED');
        if (!(await this.members(conversationId)).includes(conn.userId)) throw new ApiError('NOT_FOUND');
        return this.ctx.chats.markDelivered(conversationId, conn.userId, seq);
      }
      case 'call.signal': {
        await this.ctx.limiter.hit('call_signal', `u:${conn.userId}`);
        const kind = String(data.kind ?? '');
        const result = await this.ctx.calls.addSignal(conn.userId, data.call_id, kind, data.payload);
        return this.send(conn, 'ack', { signal_id: result.signal_id });
      }
      default:
        throw new ApiError('NOT_FOUND');
    }
  }

  // ================================================================ ҳодисаҳои шина

  async onEvent(event) {
    switch (event?.t) {
      case 'msg':
        return this.onMessage(event);
      case 'receipt':
        return this.scheduleReceipt(event.c);
      case 'typing':
        return this.onTyping(event);
      case 'presence':
        return this.onPresence(event);
      case 'chat':
        return this.onChat(event);
      case 'chat_removed':
        this.memberCache.delete(event.c);
        for (const userId of event.u ?? []) this.sendToUser(userId, 'chat.removed', { conversation_id: event.c });
        return undefined;
      case 'call':
        return this.onCall(event);
      case 'call_signal':
        return this.onCallSignal(event);
      case 'session_revoked':
        for (const conn of this.conns.get(event.user_id) ?? []) {
          if (conn.sessionId === event.session_id) conn.socket.close(4001, 'session_revoked');
        }
        return undefined;
      case 'user_suspended':
        for (const conn of this.conns.get(event.user_id) ?? []) conn.socket.close(4003, 'account_suspended');
        return undefined;
      case 'settings':
        return this.ctx.settings.load();
      case 'resync':
        for (const set of this.conns.values()) for (const conn of set) this.send(conn, 'resync', {});
        return undefined;
      default:
        return undefined;
    }
  }

  async onMessage({ k, c, m }) {
    const local = this.localIds(await this.members(c));
    if (!local.length) return;
    const row = await this.ctx.chats.findMessage(m);
    if (!row) return;
    const type = await this.db.value('SELECT type FROM conversations WHERE id = $1', [c]);
    const viewers = local.map((id) => ({ id, locale: this.localeOf(id) }));
    const userMaps = await this.ctx.users.presentForViewers([row.sender_id, row.reply_sender_id].filter(Boolean), viewers);
    for (const viewer of viewers) {
      const receipts = viewer.id === row.sender_id ? await this.ctx.chats.receipts(c, type, viewer.id) : NO_RECEIPTS;
      const message = presentMessage(row, viewer.id, userMaps.get(viewer.id), receipts);
      const data = { conversation_id: c, message };
      if (k === 'deleted') data.message_id = m;
      this.sendToUser(viewer.id, `message.${k}`, data);
    }
  }

  /** «Расонида/хонда шуд»: бисёр ҳодисаҳои як чат дар 150 мс як бор коркард мешаванд. */
  scheduleReceipt(conversationId) {
    if (this.pendingReceipts.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.pendingReceipts.delete(conversationId);
      this.onReceipt(conversationId).catch((error) => this.ctx.log?.warn({ err: { message: error?.message } }, 'receipt_event_failed'));
    }, 150);
    timer.unref?.();
    this.pendingReceipts.set(conversationId, timer);
  }

  async onReceipt(conversationId) {
    const local = this.localIds(await this.members(conversationId));
    if (!local.length) return;
    const type = await this.db.value('SELECT type FROM conversations WHERE id = $1', [conversationId]);
    for (const userId of local) {
      const r = await this.ctx.chats.receipts(conversationId, type, userId);
      this.sendToUser(userId, 'receipt', {
        conversation_id: conversationId,
        delivered_seq: Math.max(r.delivered, r.read),
        read_seq: r.receipts ? r.read : 0,
      });
    }
  }

  async onTyping({ c, u, s }) {
    this.setTypingLocal(c, u, s);
    const local = this.localIds(await this.members(c)).filter((id) => id !== u);
    for (const userId of local) this.sendToUser(userId, 'typing', { conversation_id: c, user_id: u, state: s });
  }

  async onPresence({ u, s, at }) {
    const subscribers = this.subscribers.get(u);
    if (!subscribers || subscribers.size === 0) return;
    const viewerIds = [...new Set([...subscribers].map((conn) => conn.userId))];
    const { visible } = await this.ctx.users.presenceVisibility(u, viewerIds);
    for (const conn of subscribers) {
      if (!visible.has(conn.userId)) continue;
      this.send(conn, 'presence', { user_id: u, state: s, last_seen_at: at ?? null });
    }
  }

  async onChat({ c, u }) {
    if (Array.isArray(u) && u.length) {
      for (const userId of u) this.sendToUser(userId, 'chat.updated', { conversation_id: c });
      return;
    }
    const ids = await this.members(c, true);
    for (const userId of this.localIds(ids)) this.sendToUser(userId, 'chat.updated', { conversation_id: c });
  }

  async onCall({ k, id }) {
    const call = await this.ctx.calls.find(id);
    if (!call) return;
    for (const userId of [call.caller_id, call.callee_id]) {
      if (!this.conns.has(userId)) continue;
      if (k === 'incoming' && userId === call.caller_id) continue;
      const peerId = userId === call.caller_id ? call.callee_id : call.caller_id;
      const users = await this.ctx.users.present([peerId], userId, this.localeOf(userId));
      this.sendToUser(userId, k === 'incoming' ? 'call.incoming' : 'call.updated', { call: presentCall(call, userId, users) });
    }
  }

  async onCallSignal({ id, sid, to }) {
    if (!this.conns.has(to)) return;
    const row = await this.db.one('SELECT id, sender_id, kind, payload, created_at FROM call_signals WHERE id = $1 AND call_id = $2', [sid, id]);
    if (row) this.sendToUser(to, 'call.signal', { call_id: id, signal: Calls.presentSignal(row) });
  }
}
