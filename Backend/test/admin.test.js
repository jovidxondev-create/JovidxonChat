import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { totpCode } from '../src/core/crypto.js';
import { createTestEnv } from './support/env.js';

let env;
before(async () => {
  env = await createTestEnv('admin');
});
after(async () => {
  await env?.close();
});

/** Сессияи админ: cookie + CSRF. */
function adminClient() {
  const state = { cookie: null, csrf: null };
  const call = async (method, url, body) => {
    const res = await env.app.inject({
      method,
      url: `/api/v1/admin${url}`,
      headers: {
        ...(state.cookie ? { cookie: state.cookie } : {}),
        ...(state.csrf && method !== 'GET' ? { 'x-csrf-token': state.csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      state.cookie = first.split(';')[0];
    }
    const json = res.json();
    if (json?.data?.csrf_token) state.csrf = json.data.csrf_token;
    return { status: res.statusCode, body: json, headers: res.headers };
  };
  return { state, call };
}

describe('admin panel', () => {
  test('setup requires the code, creates super_admin once, cookie is HttpOnly/Strict', async () => {
    const admin = adminClient();
    const status = await admin.call('GET', '/setup');
    assert.deepEqual(status.body.data, { needs_setup: true });
    const bad = await admin.call('POST', '/setup', { setup_code: 'WRONG', username: 'boss', password: 'Very-Strong-Pass-1' });
    assert.equal(bad.status, 422);
    const weak = await admin.call('POST', '/setup', { setup_code: 'SETUP-CODE-TEST', username: 'boss', password: 'short' });
    assert.equal(weak.status, 422);
    const ok = await admin.call('POST', '/setup', { setup_code: 'SETUP-CODE-TEST', username: 'Boss', password: 'Very-Strong-Pass-1', display_name: 'Сардор' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.admin.role, 'super_admin');
    assert.equal(ok.body.data.admin.username, 'boss');
    const cookie = String(ok.headers['set-cookie']);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/v1\/admin/);
    const again = await adminClient().call('POST', '/setup', { setup_code: 'SETUP-CODE-TEST', username: 'boss2', password: 'Very-Strong-Pass-2' });
    assert.equal(again.status, 409);
    // Пароль дар база танҳо ҳамчун hash.
    const hash = await env.db.value("SELECT password_hash FROM admin_users WHERE username = 'boss'");
    assert.match(hash, /^scrypt\$/);
    assert.ok(!hash.includes('Very-Strong'));
  });

  test('login, CSRF protection, lockout after 5 failures', async () => {
    const admin = adminClient();
    const wrong = await admin.call('POST', '/auth/login', { username: 'boss', password: 'nope-nope-nope' });
    assert.equal(wrong.status, 401);
    const ok = await admin.call('POST', '/auth/login', { username: 'BOSS', password: 'Very-Strong-Pass-1' });
    assert.equal(ok.status, 200);
    assert.ok(admin.state.csrf);
    const me = await admin.call('GET', '/auth/me');
    assert.equal(me.body.data.admin.username, 'boss');
    assert.ok(me.body.data.admin.permissions.includes('settings.manage'));

    // Бе CSRF — рад.
    const noCsrf = await env.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: { cookie: admin.state.cookie, 'content-type': 'application/json' }, payload: '{"settings":{}}' });
    assert.equal(noCsrf.statusCode, 403);
    // Бе cookie — 401.
    assert.equal((await adminClient().call('GET', '/stats')).status, 401);

    // Корбари API-и оддӣ ба админ дастрасӣ надорад.
    const user = await env.login();
    const asUser = await env.api('GET', '/api/v1/admin/stats', { token: user.token });
    assert.equal(asUser.status, 401);

    // Қулф.
    await env.db.exec("INSERT INTO admin_users (id, username, password_hash, role) VALUES (gen_random_uuid(), 'victim', 'x', 'support')");
    const attacker = adminClient();
    for (let i = 0; i < 5; i++) await attacker.call('POST', '/auth/login', { username: 'victim', password: 'guess-guess-1' });
    const locked = await attacker.call('POST', '/auth/login', { username: 'victim', password: 'guess-guess-1' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.message, 'ADMIN_LOCKED');
  });

  test('roles: support can view but cannot moderate; settings; audit', async () => {
    const boss = adminClient();
    await boss.call('POST', '/auth/login', { username: 'boss', password: 'Very-Strong-Pass-1' });
    const created = await boss.call('POST', '/admins', { username: 'helper', password: 'Support-Pass-123', role: 'support' });
    assert.equal(created.status, 200);
    assert.ok(!created.body.data.admin.permissions.includes('users.moderate'));

    const target = await env.user('moderated_user');
    const support = adminClient();
    await support.call('POST', '/auth/login', { username: 'helper', password: 'Support-Pass-123' });
    const list = await support.call('GET', `/users?q=${target.user.username}`);
    assert.equal(list.body.data.items[0].id, target.user.id);
    assert.match(list.body.data.items[0].phone, /\*/, 'support sees masked phone');
    const denied = await support.call('POST', `/users/${target.user.id}/suspend`, { reason: 'spam spam' });
    assert.equal(denied.status, 403);
    assert.equal((await support.call('GET', '/settings')).status, 403);
    assert.equal((await support.call('GET', '/audit')).status, 403);

    const full = await boss.call('GET', `/users?q=${encodeURIComponent(target.phone)}`);
    assert.equal(full.body.data.items[0].phone, target.phone);

    // Танзимот: махфиҳо пӯшида, аудит бе қимат.
    const set = await boss.call('PATCH', '/settings', {
      settings: { sms_alif_api_key: 'secret-key-1234567890abcd', sms_alif_sender: 'Olami Ashyo', registration_enabled: true },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const settings = await boss.call('GET', '/settings');
    const key = settings.body.data.settings.find((s) => s.key === 'sms_alif_api_key');
    assert.equal(key.value, '••••abcd');
    assert.equal(key.source, 'db');
    const raw = await env.db.value("SELECT value FROM app_settings WHERE key = 'sms_alif_api_key'");
    assert.match(raw, /^v1\./, 'secret is encrypted at rest');
    assert.equal(env.ctx.settings.get('sms_alif_api_key'), 'secret-key-1234567890abcd');
    const invalid = await boss.call('PATCH', '/settings', { settings: { sms_driver: 'carrier-pigeon' } });
    assert.equal(invalid.status, 422);
    const audit = await boss.call('GET', '/audit?action=settings');
    assert.deepEqual(audit.body.data.items[0].details, { keys: ['sms_alif_api_key', 'sms_alif_sender', 'registration_enabled'] });
    assert.ok(!JSON.stringify(audit.body).includes('secret-key'));
  });

  test('suspend closes the user socket immediately; reports with delete_message', async () => {
    const boss = adminClient();
    await boss.call('POST', '/auth/login', { username: 'boss', password: 'Very-Strong-Pass-1' });
    const bad = await env.user('spammer_one');
    const victim = await env.user('victim_one');
    const chat = await env.openChat(bad, victim);
    const msg = (await env.send(bad, chat.id, 'SPAM купед!')).body.data.message;
    const report = await env.api('POST', '/api/v1/reports', { token: victim.token, body: { message_id: msg.id, reason: 'spam' } });

    const reports = await boss.call('GET', '/reports?status=open');
    const item = reports.body.data.items.find((r) => r.id === report.body.data.id);
    assert.equal(item.target_user_id, bad.user.id);
    const detail = await boss.call('GET', `/reports/${item.id}`);
    assert.equal(detail.body.data.message.body, 'SPAM купед!');

    const ws = await env.socket(bad);
    const resolved = await boss.call('PATCH', `/reports/${item.id}`, { status: 'resolved', note: 'тасдиқ шуд', action: 'delete_message' });
    assert.equal(resolved.status, 200);
    const view = await env.api('GET', `/api/v1/chats/${chat.id}/messages`, { token: victim.token });
    assert.equal(view.body.data.messages[0].is_deleted, true);

    const suspended = await boss.call('POST', `/users/${bad.user.id}/suspend`, { reason: 'spam campaign' });
    assert.equal(suspended.status, 200);
    const closed = await ws.closed;
    assert.ok([4001, 4003].includes(closed.code));
    assert.equal((await env.api('GET', '/api/v1/me', { token: bad.token })).status, 401);
    // Рақами блокшуда OTP гирифта метавонад (мавҷудияти ҳисоб ошкор намешавад), аммо ворид шуда наметавонад.
    await env.db.exec("UPDATE otp_codes SET created_at = created_at - interval '2 minutes' WHERE phone = $1", [bad.phone]);
    const login = await env.api('POST', '/api/v1/auth/request-otp', { body: { phone: bad.phone } });
    assert.equal(login.status, 200);

    const unsuspend = await boss.call('POST', `/users/${bad.user.id}/unsuspend`);
    assert.equal(unsuspend.status, 200);
    const detailUser = await boss.call('GET', `/users/${bad.user.id}`);
    assert.equal(detailUser.body.data.user.status, 'active');
    assert.ok(detailUser.body.data.stats.reports_against >= 1);
  });

  test('stats, daily chart, system, TOTP enable + login requires code', async () => {
    const boss = adminClient();
    await boss.call('POST', '/auth/login', { username: 'boss', password: 'Very-Strong-Pass-1' });
    const u1 = await env.user('stats_one');
    const u2 = await env.user('stats_two');
    await env.send(u1, (await env.openChat(u1, u2)).id, 'омор');
    const stats = await boss.call('GET', '/stats');
    assert.equal(stats.status, 200);
    assert.ok(stats.body.data.users.total >= 3);
    assert.ok(stats.body.data.messages.total >= 1);
    assert.ok(stats.body.data.database.size_bytes > 0);
    const daily = await boss.call('GET', '/stats/daily?days=7');
    assert.equal(daily.body.data.days.length, 7);
    const system = await boss.call('GET', '/system');
    assert.deepEqual(system.body.data.database.pending_migrations, []);
    assert.equal(system.body.data.realtime.listener, true);

    const setup = await boss.call('POST', '/me/totp/setup');
    assert.match(setup.body.data.otpauth_url, /^otpauth:\/\/totp\/JovidxonChat%3Aboss\?secret=/);
    const code = totpCode(setup.body.data.secret, Math.floor(Date.now() / 30000));
    assert.equal((await boss.call('POST', '/me/totp/enable', { code })).status, 200);

    const next = adminClient();
    const needCode = await next.call('POST', '/auth/login', { username: 'boss', password: 'Very-Strong-Pass-1' });
    assert.equal(needCode.status, 401);
    assert.equal(needCode.body.message, 'ADMIN_TOTP_REQUIRED');
    // Ҳамон рамз дубора истифода намешавад (replay).
    const replay = await next.call('POST', '/auth/login', { username: 'boss', password: 'Very-Strong-Pass-1', totp_code: code });
    assert.equal(replay.status, 401);
    await env.db.exec("UPDATE admin_users SET totp_last_counter = totp_last_counter - 5 WHERE username = 'boss'");
    const withCode = await next.call('POST', '/auth/login', { username: 'boss', password: 'Very-Strong-Pass-1', totp_code: code });
    assert.equal(withCode.status, 200);
    assert.equal((await next.call('POST', '/me/totp/disable', { password: 'Very-Strong-Pass-1' })).status, 200);
  });

  test('maintenance mode blocks the app API but not health or admin', async () => {
    const boss = adminClient();
    await boss.call('POST', '/auth/login', { username: 'boss', password: 'Very-Strong-Pass-1' });
    const user = await env.login();
    await boss.call('PATCH', '/settings', { settings: { maintenance_mode: true } });
    const blocked = await env.api('GET', '/api/v1/me', { token: user.token });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.message, 'MAINTENANCE');
    assert.equal((await env.api('GET', '/api/v1/health')).status, 200);
    assert.equal((await boss.call('GET', '/stats')).status, 200);
    await boss.call('PATCH', '/settings', { settings: { maintenance_mode: false } });
    assert.equal((await env.api('GET', '/api/v1/me', { token: user.token })).status, 200);
  });

  test('ADMIN_RESET env restores access once (no shell on the free Render plan)', async () => {
    await env.db.exec("UPDATE admin_users SET locked_until = now() + interval '1 hour', totp_enabled = true WHERE username = 'boss'");
    env.ctx.config.adminReset = 'boss:Recovered-Pass-2026';
    try {
      assert.equal(await env.ctx.admin.applyReset(), true);
      assert.equal(await env.ctx.admin.applyReset(), false, 'second boot does not reset again');
      const admin = adminClient();
      const ok = await admin.call('POST', '/auth/login', { username: 'boss', password: 'Recovered-Pass-2026' });
      assert.equal(ok.status, 200);
      const audit = await admin.call('GET', '/audit?action=admin.password_reset_env');
      assert.equal(audit.body.data.items.length, 1);
    } finally {
      env.ctx.config.adminReset = '';
      const hash = await (await import('../src/core/crypto.js')).hashPassword('Very-Strong-Pass-1');
      await env.db.exec("UPDATE admin_users SET password_hash = $1 WHERE username = 'boss'", [hash]);
    }
  });

  test('last super admin cannot be removed or demoted', async () => {
    const boss = adminClient();
    await boss.call('POST', '/auth/login', { username: 'boss', password: 'Very-Strong-Pass-1' });
    const me = await boss.call('GET', '/auth/me');
    const demote = await boss.call('PATCH', `/admins/${me.body.data.admin.id}`, { role: 'support' });
    assert.equal(demote.status, 422);
    const self = await boss.call('DELETE', `/admins/${me.body.data.admin.id}`);
    assert.equal(self.status, 422);
    const out = await boss.call('POST', '/auth/logout');
    assert.equal(out.status, 200);
    assert.equal((await boss.call('GET', '/stats')).status, 401);
  });
});
