import crypto from 'node:crypto';
import { localeOf } from '../core/http.js';
import { Validator } from '../core/validator.js';
import { clientOf } from './auth.js';
import { messagePreview } from '../presenters.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
// Занг баъди 60 с маъно надорад; паём то як рӯз интизори телефони хомӯш мемонад.
const CALL_TTL_SECONDS = 60;
const MESSAGE_TTL_SECONDS = 86_400;

/**
 * Firebase Cloud Messaging HTTP v1 бе SDK: service account (аз панели админ ё env) → OAuth2 (JWT RS256)
 * → messages:send. Токени дастрасӣ дар хотира кэш мешавад.
 */
export class FcmClient {
  constructor({ settings, log }) {
    this.settings = settings;
    this.log = log;
    this.token = null;
    this.tokenKey = null;
  }

  credentials() {
    const raw = this.settings.get('fcm_service_account');
    if (!raw) return null;
    try {
      const json = JSON.parse(raw);
      return json.client_email && json.private_key && json.project_id ? json : null;
    } catch {
      return null;
    }
  }

  configured() {
    return this.credentials() !== null;
  }

  async accessToken() {
    const creds = this.credentials();
    if (!creds) return null;
    const key = `${creds.client_email}|${creds.private_key_id ?? ''}`;
    if (this.token && this.tokenKey === key && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const now = Math.floor(Date.now() / 1000);
    const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token';
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: creds.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })).toString(
      'base64url',
    );
    let signature;
    try {
      signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), creds.private_key).toString('base64url');
    } catch {
      this.log?.error('fcm_sign_failed');
      return null;
    }
    try {
      const response = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = await response.json().catch(() => null);
      if (response.status !== 200 || typeof json?.access_token !== 'string') {
        this.log?.error({ status: response.status }, 'fcm_token_failed');
        return null;
      }
      this.token = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
      this.tokenKey = key;
      return this.token.value;
    } catch (error) {
      this.log?.error({ error: error?.name }, 'fcm_token_failed');
      return null;
    }
  }

  async send(token, data, priority, collapseKey, ttlSeconds = MESSAGE_TTL_SECONDS) {
    const accessToken = await this.accessToken();
    if (!accessToken) return { ok: false, unregistered: false, retryable: true, error: 'fcm_auth_failed' };
    const android = { priority: priority === 'high' ? 'HIGH' : 'NORMAL', ttl: `${ttlSeconds}s` };
    if (collapseKey) android.collapse_key = collapseKey;
    try {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.credentials().project_id)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, data, android } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true, unregistered: false, retryable: false, error: null };
      const body = await response.text().catch(() => '');
      if (response.status === 401) this.token = null;
      return {
        ok: false,
        unregistered: response.status === 404 || body.includes('UNREGISTERED') || (response.status === 400 && body.includes('registration token')),
        retryable: response.status === 429 || response.status >= 500 || response.status === 401,
        error: `fcm_http_${response.status}`,
      };
    } catch (error) {
      return { ok: false, unregistered: false, retryable: true, error: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  }
}

/**
 * Push (15, 35): навбат дар push_outbox → FCM. Mute ва танзимоти корбар риоя мешаванд.
 * Payload танҳо data (Android худаш notification месозад); матни паём дар лог нест.
 */
export class Push {
  constructor(ctx) {
    this.ctx = ctx;
    this.fcm = new FcmClient({ settings: ctx.settings, log: ctx.log });
  }

  get db() {
    return this.ctx.db;
  }

  enabled() {
    return this.fcm.configured();
  }

  async enqueue(userId, type, payload, collapseKey, priority) {
    return this.db.value(
      'INSERT INTO push_outbox (user_id, type, payload, collapse_key, priority) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, type, JSON.stringify(payload), collapseKey, priority],
    );
  }

  async notifyMessage(message, conversationType, mentionedIds = []) {
    if (!this.enabled() || !message) return;
    const conversationId = message.conversation_id;
    const recipients = await this.db.many(
      `SELECT cm.user_id, cm.is_muted, cm.unread_count, s.notify_messages, s.notify_groups, s.notify_preview, u.status
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       LEFT JOIN user_settings s ON s.user_id = cm.user_id
       WHERE cm.conversation_id = $1 AND cm.user_id <> $2`,
      [conversationId, message.sender_id],
    );
    const sender = await this.db.value('SELECT display_name FROM users WHERE id = $1', [message.sender_id]);
    const groupName =
      conversationType === 'group' ? ((await this.db.value('SELECT name FROM chat_groups WHERE conversation_id = $1', [conversationId])) ?? '') : '';
    const ids = [];
    for (const r of recipients) {
      const mentioned = mentionedIds.includes(r.user_id);
      const enabled = conversationType === 'group' ? r.notify_groups !== false : r.notify_messages !== false;
      if (r.status !== 'active' || !enabled || (r.is_muted && !mentioned)) continue;
      const preview = r.notify_preview !== false ? messagePreview(message.type, message.body, message.att_name) : '';
      ids.push(
        await this.enqueue(
          r.user_id,
          'message',
          {
            type: 'message',
            conversationId,
            conversationType,
            messageId: message.id,
            senderId: message.sender_id,
            senderName: sender ?? '',
            groupName,
            messageType: message.type,
            preview: [...preview].slice(0, 200).join(''),
            unreadCount: String(r.unread_count ?? 0),
            mention: mentioned ? '1' : '0',
          },
          `c:${conversationId}`,
          // HIGH: паёми чат дар Doze ҳам фавран мерасад (тавсияи FCM барои мессенҷерҳо).
          'high',
        ),
      );
    }
    if (ids.length) await this.flush(ids.length, ids);
  }

  /** Занги даромадӣ — priority high (16). */
  async notifyCall(calleeId, callId, callerId, callerName, callType) {
    if (!this.enabled()) return;
    const notify = await this.db.value('SELECT notify_calls FROM user_settings WHERE user_id = $1', [calleeId]);
    if (notify === false) return;
    const id = await this.enqueue(calleeId, 'call', { type: 'call', callId, callerId, callerName, callType }, `call:${callId}`, 'high');
    await this.flush(1, [id]);
  }

  /** Занг пеш аз ҷавоб қатъ шуд — зангӯлаи қабулкунанда хомӯш (collapse бо push-и занг). */
  async notifyCallEnded(calleeId, callId) {
    if (!this.enabled()) return;
    const id = await this.enqueue(calleeId, 'call', { type: 'call_ended', callId }, `call:${callId}`, 'high');
    await this.flush(1, [id]);
  }

  /** Қисми навбат: SKIP LOCKED — якчанд instance як push-ро ду бор намефиристанд. */
  async flush(limit = 50, onlyIds = null, budgetMs = 5000) {
    if (!this.enabled()) return 0;
    const deadline = Date.now() + budgetMs;
    const items = await this.db.many(
      `UPDATE push_outbox SET status = 'sending', attempts = attempts + 1, locked_at = now()
       WHERE id IN (SELECT id FROM push_outbox
                    WHERE status = 'queued' AND available_at <= now() ${onlyIds ? 'AND id = ANY($2::bigint[])' : ''}
                    ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      onlyIds ? [limit, onlyIds] : [limit],
    );
    let sent = 0;
    for (const item of items) {
      if (Date.now() > deadline) {
        await this.db.exec("UPDATE push_outbox SET status = 'queued', attempts = attempts - 1 WHERE id = $1", [item.id]);
        continue;
      }
      const targets = await this.ctx.devices.pushTargets(item.user_id);
      if (!targets.length) {
        await this.db.exec("UPDATE push_outbox SET status = 'skipped', last_error = 'no_devices' WHERE id = $1", [item.id]);
        continue;
      }
      const data = {};
      for (const [key, value] of Object.entries(item.payload ?? {})) data[key] = typeof value === 'string' ? value : JSON.stringify(value);

      let delivered = false;
      let retry = false;
      let lastError = 'unknown';
      for (const target of targets) {
        const ttl = item.type === 'call' ? CALL_TTL_SECONDS : MESSAGE_TTL_SECONDS;
        const result = await this.fcm.send(target.fcm_token, data, item.priority, item.collapse_key, ttl);
        if (result.ok) {
          delivered = true;
          continue;
        }
        lastError = result.error;
        if (result.unregistered) await this.ctx.devices.clearToken(target.fcm_token);
        else if (result.retryable) retry = true;
      }
      if (delivered) {
        await this.db.exec("UPDATE push_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1", [item.id]);
        sent++;
      } else {
        const final = !retry || item.attempts >= 5;
        await this.db.exec(
          `UPDATE push_outbox SET status = $2, last_error = $3,
             available_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [item.id, final ? 'failed' : 'queued', lastError, Math.min(3600, 30 * 2 ** item.attempts)],
        );
        if (final) this.ctx.log?.warn({ push_id: item.id, error: lastError }, 'push_failed');
      }
    }
    return sent;
  }

  // ------------------------------------------------------------------ REST: /devices

  /** POST /devices */
  async register(request) {
    const v = Validator.of(request.body);
    const client = clientOf(v, request);
    if (!client.device_id) v.fail('device_id', 'required');
    v.validate();
    await this.ctx.devices.upsert(request.user.id, client.device_id, { ...client, locale: client.locale ?? localeOf(request) }, client.fcm_token);
    return { device_id: client.device_id, registered: true };
  }

  /** DELETE /devices/:deviceId */
  async unregister(request) {
    const deviceId = String(request.params.deviceId ?? '');
    if (/^[A-Za-z0-9._:-]{4,64}$/.test(deviceId)) await this.ctx.devices.delete(request.user.id, deviceId);
    return { unregistered: true };
  }
}
