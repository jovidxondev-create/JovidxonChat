import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createTestEnv, randomPhone } from './support/env.js';

let env;
before(async () => {
  env = await createTestEnv('auth');
});
after(async () => {
  await env?.close();
});

describe('system', () => {
  test('health and ready', async () => {
    const health = await env.api('GET', '/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.status, 'ok');
    const ready = await env.api('GET', '/api/v1/health/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body.data.checks, { database: true, schema: true, realtime: true });
  });

  test('unknown route → 404 envelope; request id echoed', async () => {
    const res = await env.api('GET', '/api/v1/nope', { headers: { 'x-request-id': 'req-123456' } });
    assert.equal(res.status, 404);
    assert.equal(res.body.message, 'NOT_FOUND');
    assert.equal(res.body.message_key, 'error_not_found');
    assert.equal(res.headers['x-request-id'], 'req-123456');
  });

  test('protected route without token → 401', async () => {
    const res = await env.api('GET', '/api/v1/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'AUTH_UNAUTHORIZED');
  });

  test('invalid JSON → 422', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/request-otp', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    assert.equal(res.statusCode, 422);
  });

  test('join page renders escaped code', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/join/AbCdEfGh1234' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /AbCdEfGh1234/);
  });
});

describe('otp', () => {
  test('validation errors', async () => {
    const res = await env.api('POST', '/api/v1/auth/request-otp', { body: { phone: '12345' } });
    assert.equal(res.status, 422);
    assert.equal(res.body.errors[0].field, 'phone');
    assert.equal(res.body.errors[0].code, 'VALIDATION_FORMAT');
  });

  test('full flow: request → cooldown → wrong code → success → new user', async () => {
    const phone = randomPhone();
    const first = await env.api('POST', '/api/v1/auth/request-otp', { body: { phone, device_id: 'dev-otp-1' } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data, { phone, expires_in: 300, resend_in: 60, is_new_user: false });
    const text = env.ctx.sms.outbox.findLast((m) => m.phone === phone).text;
    assert.match(text, /^JovidxonChat: рамзи воридшавӣ \d{4}\./);
    const code = /(\d{4})/.exec(text)[1];

    const again = await env.api('POST', '/api/v1/auth/resend-otp', { body: { phone } });
    assert.equal(again.status, 429);
    assert.equal(again.body.message, 'AUTH_OTP_COOLDOWN');
    assert.ok(Number(again.headers['retry-after']) > 0);

    const wrong = await env.api('POST', '/api/v1/auth/verify-otp', { body: { phone, code: code === '0000' ? '1111' : '0000' } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.message, 'AUTH_OTP_INVALID');

    const ok = await env.api('POST', '/api/v1/auth/verify-otp', {
      body: { phone, code, device_id: 'dev-otp-1' },
      headers: { 'user-agent': 'JovidxonChat/1.0 (Samsung SM-A515F; Android 14)' },
    });
    assert.equal(ok.status, 200);
    const data = ok.body.data;
    assert.equal(data.is_new_user, true);
    assert.equal(data.user.phone, phone);
    assert.equal(data.user.display_name, `Корбар ${phone.slice(-4)}`);
    assert.equal(data.tokens.token_type, 'Bearer');
    assert.equal(data.tokens.expires_in, 900);
    assert.match(data.tokens.refresh_token, /^rt1\./);

    // Рамз якдафъаина аст.
    const reuse = await env.api('POST', '/api/v1/auth/verify-otp', { body: { phone, code } });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.message, 'AUTH_OTP_EXPIRED');

    const sessions = await env.api('GET', '/api/v1/me/sessions', { token: data.tokens.access_token });
    assert.equal(sessions.body.data.sessions[0].device_name, 'Samsung SM-A515F (Android 14)');
    assert.equal(sessions.body.data.sessions[0].is_current, true);
  });

  test('five wrong attempts burn the code', async () => {
    const phone = randomPhone();
    await env.api('POST', '/api/v1/auth/request-otp', { body: { phone } });
    const code = /(\d{4})/.exec(env.ctx.sms.outbox.findLast((m) => m.phone === phone).text)[1];
    const wrongCode = code === '9999' ? '8888' : '9999';
    let last;
    for (let i = 0; i < 5; i++) last = await env.api('POST', '/api/v1/auth/verify-otp', { body: { phone, code: wrongCode } });
    assert.equal(last.body.message, 'AUTH_OTP_RATE_LIMITED');
    const late = await env.api('POST', '/api/v1/auth/verify-otp', { body: { phone, code } });
    assert.equal(late.status, 400);
    assert.equal(late.body.message, 'AUTH_OTP_EXPIRED');
  });

  test('test numbers from settings do not send SMS', async () => {
    const phone = randomPhone();
    await env.ctx.settings.update({ otp_test_numbers: `${phone}:4827` }, null);
    const before = env.ctx.sms.outbox.length;
    const sent = await env.api('POST', '/api/v1/auth/request-otp', { body: { phone } });
    assert.equal(sent.status, 200);
    assert.equal(env.ctx.sms.outbox.length, before);
    const ok = await env.api('POST', '/api/v1/auth/verify-otp', { body: { phone, code: '4827' } });
    assert.equal(ok.status, 200);
    await env.ctx.settings.update({ otp_test_numbers: null }, null);
  });

  test('SMS failure → 503 SMS_SEND_FAILED and fallback driver is tried', async () => {
    const calls = [];
    const failing = { name: 'alif', send: async () => (calls.push('alif'), { ok: false, error: 'http_500', retryable: false }) };
    const backup = { name: 'smsgate', send: async () => (calls.push('smsgate'), { ok: false, error: 'network', retryable: false }) };
    env.ctx.sms.useDrivers(failing, backup);
    try {
      const res = await env.api('POST', '/api/v1/auth/request-otp', { body: { phone: randomPhone() } });
      assert.equal(res.status, 503);
      assert.equal(res.body.message, 'SMS_SEND_FAILED');
      assert.equal(res.body.message_key, 'error_server');
      assert.deepEqual(calls, ['alif', 'smsgate']);
      const logs = await env.db.many("SELECT driver, status, phone_masked FROM sms_logs WHERE status = 'failed'");
      assert.ok(logs.length >= 2);
      assert.match(logs[0].phone_masked, /^\+992\*+\d{4}$/);
    } finally {
      env.ctx.sms.override = null;
    }
  });
});

describe('tokens', () => {
  test('refresh rotates; parallel reuse within grace returns same pair; old token later = theft', async () => {
    const session = await env.login();
    const first = session.tokens.refresh_token;
    const r1 = await env.api('POST', '/api/v1/auth/refresh', { body: { refresh_token: first } });
    assert.equal(r1.status, 200);
    const second = r1.body.data.tokens.refresh_token;
    assert.notEqual(second, first);
    // Дархости мувозӣ бо токени пешина (grace 30 с) — ҳамон ҷуфт.
    const r2 = await env.api('POST', '/api/v1/auth/refresh', { body: { refresh_token: first } });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.data.tokens.refresh_token, second);
    // Токени нав кор мекунад.
    const me = await env.api('GET', '/api/v1/me', { token: r1.body.data.tokens.access_token });
    assert.equal(me.status, 200);
    // Токени хеле кӯҳна (generation 0) → дуздӣ → сессия бекор.
    const r3 = await env.api('POST', '/api/v1/auth/refresh', { body: { refresh_token: first.replace(/\.1\./, '.0.') } });
    assert.equal(r3.status, 401);
  });

  test('reuse after rotation outside grace revokes the whole session', async () => {
    const session = await env.login();
    const old = session.tokens.refresh_token;
    const r1 = await env.api('POST', '/api/v1/auth/refresh', { body: { refresh_token: old } });
    const fresh = r1.body.data.tokens;
    await env.db.exec("UPDATE sessions SET rotated_at = now() - interval '2 minutes' WHERE id = $1", [fresh.session_id]);
    const stolen = await env.api('POST', '/api/v1/auth/refresh', { body: { refresh_token: old } });
    assert.equal(stolen.status, 401);
    assert.equal(stolen.body.message, 'AUTH_REFRESH_REVOKED');
    const me = await env.api('GET', '/api/v1/me', { token: fresh.access_token });
    assert.equal(me.status, 401);
    assert.equal(me.body.message, 'AUTH_REFRESH_REVOKED');
  });

  test('forged/expired access token → AUTH_TOKEN_EXPIRED', async () => {
    const res = await env.api('GET', '/api/v1/me', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc' });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'AUTH_TOKEN_EXPIRED');
  });

  test('logout and logout-all', async () => {
    const phone = randomPhone();
    const a = await env.login(phone);
    const b = await env.login(phone);
    const c = await env.login(phone);
    const all = await env.api('POST', '/api/v1/auth/logout-all', { token: a.token });
    assert.equal(all.body.data.revoked_sessions, 2);
    assert.equal((await env.api('GET', '/api/v1/me', { token: b.token })).status, 401);
    assert.equal((await env.api('GET', '/api/v1/me', { token: c.token })).status, 401);
    assert.equal((await env.api('GET', '/api/v1/me', { token: a.token })).status, 200);
    const out = await env.api('POST', '/api/v1/auth/logout', { token: a.token });
    assert.deepEqual(out.body.data, { revoked: true });
    assert.equal((await env.api('GET', '/api/v1/me', { token: a.token })).status, 401);
  });

  test('client IP comes from the proxy hop, a spoofed X-Forwarded-For prefix is ignored', async () => {
    const phone = randomPhone();
    await env.api('POST', '/api/v1/auth/request-otp', { body: { phone }, headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' } });
    const code = /(\d{4})/.exec(env.ctx.sms.outbox.findLast((m) => m.phone === phone).text)[1];
    const res = await env.api('POST', '/api/v1/auth/verify-otp', {
      body: { phone, code },
      headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' },
    });
    const ip = await env.db.value('SELECT ip FROM sessions WHERE id = $1', [res.body.data.tokens.session_id]);
    assert.equal(ip, '1.2.3.4');
    // Cloudflare-и байни мизоҷ ва Render ҳам гузаронида мешавад.
    env.ctx.diagnostics.forwarding = undefined;
    const viaCf = await env.api('POST', '/api/v1/auth/refresh', {
      body: { refresh_token: res.body.data.tokens.refresh_token },
      headers: { 'x-forwarded-for': '6.6.6.6, 5.6.7.8, 104.16.0.1' },
    });
    assert.equal(viaCf.status, 200);
    const { isTrustedProxyAddress } = await import('../src/core/proxy.js');
    assert.equal(isTrustedProxyAddress('104.16.0.1'), true);
    assert.equal(isTrustedProxyAddress('::ffff:10.1.2.3'), true);
    assert.equal(isTrustedProxyAddress('5.6.7.8'), false);
    assert.equal(env.ctx.diagnostics.forwarding.client_ip_is_proxy, false);
    assert.equal(env.ctx.diagnostics.forwarding.xff_entries, 3);
    assert.equal(env.ctx.diagnostics.forwarding.ok, true);

    // Health check (дохилӣ, бе XFF) диагностикаро иваз намекунад; пайвасти мустақими маҳаллӣ хато нест.
    env.ctx.diagnostics.forwarding = undefined;
    await env.api('GET', '/api/v1/health');
    assert.equal(env.ctx.diagnostics.forwarding, undefined);
    await env.api('GET', '/api/v1/me', { token: 'x' });
    assert.equal(env.ctx.diagnostics.forwarding.client_ip_is_proxy, true);
    assert.equal(env.ctx.diagnostics.forwarding.ok, true);

    // XFF ҳаст, вале дар он танҳо суроғаҳои дохилӣ → IP-и мизоҷ муайян нашуд → огоҳӣ дар панел.
    env.ctx.diagnostics.forwarding = undefined;
    await env.api('GET', '/api/v1/me', { token: 'x', headers: { 'x-forwarded-for': '10.0.0.5' } });
    assert.equal(env.ctx.diagnostics.forwarding.ok, false);
  });

  test('suspended account is rejected immediately', async () => {
    const s = await env.login();
    await env.db.exec("UPDATE users SET status = 'suspended' WHERE id = $1", [s.user.id]);
    const res = await env.api('GET', '/api/v1/me', { token: s.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, 'ACCOUNT_SUSPENDED');
  });
});

describe('google', () => {
  test('not configured → 503; valid token signs in; wrong audience rejected', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    env.ctx.google.setKeysForTesting({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
    const make = (claims) => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
      return `${header}.${payload}.${signature}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: 'https://accounts.google.com', aud: 'web-client.apps.googleusercontent.com', sub: '1234567890', email: 'a@b.tj', email_verified: true, name: 'Фирӯза', exp: now + 600, iat: now };

    const off = await env.api('POST', '/api/v1/auth/google', { body: { id_token: make(claims), device_id: 'dev-g-1' } });
    assert.equal(off.status, 503);
    assert.equal(off.body.message, 'AUTH_GOOGLE_NOT_CONFIGURED');

    await env.ctx.settings.update({ google_client_ids: ['web-client.apps.googleusercontent.com'] }, null);
    const res = await env.api('POST', '/api/v1/auth/google', { body: { id_token: make(claims), device_id: 'dev-g-1' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.display_name, 'Фирӯза');
    assert.equal(res.body.data.is_new_user, true);
    const again = await env.api('POST', '/api/v1/auth/google', { body: { id_token: make(claims), device_id: 'dev-g-2' } });
    assert.equal(again.body.data.user.id, res.body.data.user.id);
    assert.equal(again.body.data.is_new_user, false);

    const wrongAud = await env.api('POST', '/api/v1/auth/google', { body: { id_token: make({ ...claims, aud: 'other' }) } });
    assert.equal(wrongAud.status, 401);
    assert.equal(wrongAud.body.message, 'AUTH_GOOGLE_INVALID');
    const tampered = make(claims).replace(/\.[^.]+$/, '.AAAA');
    assert.equal((await env.api('POST', '/api/v1/auth/google', { body: { id_token: `${tampered}AAAAAAAAAAAAAAAA` } })).status, 401);
  });
});

describe('profile', () => {
  test('update profile, username rules, settings, avatar removal', async () => {
    const s = await env.login();
    const taken = await env.user('firuza_test');
    const res = await env.api('PATCH', '/api/v1/me', { token: s.token, body: { display_name: '  Ҷовидхон  ', username: 'Jovid_1', about: 'Салом' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.display_name, 'Ҷовидхон');
    assert.equal(res.body.data.user.username, 'jovid_1');
    const dup = await env.api('PATCH', '/api/v1/me', { token: s.token, body: { username: taken.user.username } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.errors[0].field, 'username');
    const reserved = await env.api('PATCH', '/api/v1/me', { token: s.token, body: { username: 'admin' } });
    assert.equal(reserved.status, 409);
    const bad = await env.api('PATCH', '/api/v1/me', { token: s.token, body: { username: 'ab' } });
    assert.equal(bad.status, 422);

    const settings = await env.api('PATCH', '/api/v1/me/settings', { token: s.token, body: { privacy_last_seen: 'nobody', read_receipts: false, language: 'ru' } });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.data.settings.privacy_last_seen, 'nobody');
    assert.equal(settings.body.data.settings.read_receipts, false);
    const get = await env.api('GET', '/api/v1/me/settings', { token: s.token });
    assert.equal(get.body.data.settings.language, 'ru');
    const badEnum = await env.api('PATCH', '/api/v1/me/settings', { token: s.token, body: { theme: 'pink' } });
    assert.equal(badEnum.status, 422);
    assert.equal(badEnum.body.errors[0].code, 'VALIDATION_UNSUPPORTED');
  });

  test('search by username, name and full phone only', async () => {
    const me = await env.login();
    const target = await env.user('searchable_user');
    const byUsername = await env.api('GET', '/api/v1/search/users?q=@searchable', { token: me.token });
    assert.ok(byUsername.body.data.users.some((u) => u.id === target.user.id));
    const byPhone = await env.api('GET', `/api/v1/search/users?q=${encodeURIComponent(target.phone)}`, { token: me.token });
    assert.equal(byPhone.body.data.users[0].id, target.user.id);
    assert.match(byPhone.body.data.users[0].phone, /\*/);
    const partial = await env.api('GET', `/api/v1/search/users?q=${encodeURIComponent(target.phone.slice(0, 8))}`, { token: me.token });
    assert.equal(partial.body.data.users.length, 0);
  });
});
