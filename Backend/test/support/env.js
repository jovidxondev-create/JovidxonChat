import crypto from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createDb } from '../../src/db/pool.js';

let phoneCounter = 0;

/** Рақами тасодуфии тестӣ (+99290xxxxxxx). */
export function randomPhone() {
  phoneCounter += 1;
  return `+99290${String(crypto.randomInt(0, 100000)).padStart(5, '0')}${String(phoneCounter % 100).padStart(2, '0')}`;
}

export function clientMessageId() {
  return `c-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Муҳити тест: базаи алоҳида, барнома бо config-и тестӣ, ёрирасонҳои API/WS.
 * Ҳеҷ гоҳ ба базаи воқеӣ пайваст намешавад (танҳо TEST_PG_URL аз test/run.mjs).
 */
export async function createTestEnv(name, envOverrides = {}) {
  const baseUrl = process.env.TEST_PG_URL;
  if (!baseUrl) throw new Error('TEST_PG_URL is not set — run tests with `npm test`');
  const dbName = `jt_${name.replace(/\W/g, '_')}_${crypto.randomBytes(3).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const databaseUrl = baseUrl.replace(/\/[^/]*$/, `/${dbName}`);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    APP_SECRET: 'test-secret-'.padEnd(64, 'x'),
    ADMIN_SETUP_CODE: 'SETUP-CODE-TEST',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    SMS_DRIVER: 'log',
    WORKERS: 'false',
    ADMIN_DIST: '../does-not-exist',
    ...envOverrides,
  });
  const db = createDb(config);
  const app = await buildApp({ config, db });
  const ctx = app.ctx;
  await migrate(db, app.log);
  await ctx.settings.load();
  await ctx.bus.start();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;

  const env = {
    app,
    ctx,
    db,
    config,
    port,
    async api(method, url, { token, body, headers = {}, cookies } = {}) {
      const response = await app.inject({
        method,
        url,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(cookies ? { cookie: cookies } : {}),
          ...headers,
        },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try {
        json = response.json();
      } catch {
        json = null;
      }
      return { status: response.statusCode, body: json, headers: response.headers, raw: response };
    },

    /** OTP-и драйвери log (танҳо дар тест) → {user, tokens, phone}. */
    async login(phone = randomPhone(), { deviceId = `dev-${crypto.randomBytes(4).toString('hex')}`, locale = 'tk' } = {}) {
      // Воридшавии такрории ҳамон рақам дар тест: cooldown-и 60 с-ро мегузаронем.
      await db.exec("UPDATE otp_codes SET created_at = created_at - interval '2 minutes' WHERE phone = $1", [phone]);
      const sent = await env.api('POST', '/api/v1/auth/request-otp', { body: { phone, device_id: deviceId, locale } });
      if (sent.status !== 200) throw new Error(`request-otp ${sent.status} ${JSON.stringify(sent.body)}`);
      const message = ctx.sms.outbox.findLast((m) => m.phone === phone);
      const code = /(\d{4})/.exec(message.text)[1];
      const verified = await env.api('POST', '/api/v1/auth/verify-otp', {
        body: { phone, code, device_id: deviceId, locale },
        headers: { 'user-agent': 'JovidxonChat/1.0 (Test Phone; Android 14)' },
      });
      if (verified.status !== 200) throw new Error(`verify-otp ${verified.status} ${JSON.stringify(verified.body)}`);
      return { ...verified.body.data, phone, deviceId, token: verified.body.data.tokens.access_token };
    },

    /** Корбари нав бо username (профили пурра). */
    async user(username) {
      const session = await env.login();
      if (username) {
        const res = await env.api('PATCH', '/api/v1/me', { token: session.token, body: { username, display_name: username } });
        if (res.status !== 200) throw new Error(`patch me ${res.status} ${JSON.stringify(res.body)}`);
        session.user = res.body.data.user;
      }
      return session;
    },

    async openChat(a, b) {
      const res = await env.api('POST', '/api/v1/chats', { token: a.token, body: { type: 'private', user_id: b.user.id } });
      if (res.status !== 200) throw new Error(`open chat ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.data.chat;
    },

    async send(session, chatId, body, extra = {}) {
      return env.api('POST', `/api/v1/chats/${chatId}/messages`, {
        token: session.token,
        body: { client_message_id: clientMessageId(), type: 'text', body, ...extra },
      });
    },

    /** WebSocket бо токени якдафъаина; events — ҳамаи паёмҳои гирифташуда. */
    async socket(session, locale = 'tk') {
      const tokenRes = await env.api('POST', '/api/v1/auth/socket-token', { token: session.token });
      if (tokenRes.status !== 200) throw new Error(`socket-token ${tokenRes.status}`);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
      const events = [];
      const waiters = [];
      ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        events.push(event);
        for (const waiter of [...waiters]) {
          if (waiter.match(event)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(event);
          }
        }
      });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      const client = {
        ws,
        events,
        send: (type, data) => ws.send(JSON.stringify({ type, data })),
        waitFor(match, timeoutMs = 4000) {
          const matcher = typeof match === 'string' ? (e) => e.type === match : match;
          const found = events.find(matcher);
          if (found) {
            events.splice(events.indexOf(found), 1);
            return Promise.resolve(found);
          }
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              reject(new Error(`timeout waiting for ${typeof match === 'string' ? match : 'event'}`));
            }, timeoutMs);
            const waiter = {
              match: matcher,
              resolve: (event) => {
                clearTimeout(timer);
                events.splice(events.indexOf(event), 1);
                resolve(event);
              },
            };
            waiters.push(waiter);
          });
        },
        closed: new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
        close: () => ws.close(),
      };
      client.send('auth', { token: tokenRes.body.data.token, locale });
      await client.waitFor('ready');
      return client;
    },

    async close() {
      ctx.maintenance.stop();
      ctx.hub.closeAll();
      ctx.limiter.close();
      await app.close();
      await ctx.bus.stop();
      await db.close();
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await cleanup.end();
    },
  };
  return env;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
