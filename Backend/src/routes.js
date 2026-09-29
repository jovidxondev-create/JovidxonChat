import { ApiError, fail } from './core/errors.js';
import { localeOf, ok } from './core/http.js';
import { t } from './core/i18n.js';
import { pendingMigrations } from './db/migrate.js';

/**
 * Ҷадвали ягонаи роҳҳои API (21). Ҳар роҳ бо нобаёнӣ auth мехоҳад (secure by default);
 * auth: false танҳо барои health, воридшавӣ, WebSocket, саҳифаи даъват ва воридшавии админ.
 */
export function registerRoutes(app, ctx) {
  const c = ctx;

  /**
   * opts: auth (true | false | 'admin'), rate — номҳои bucket, raw — ҷавобро худи handler мефиристад,
   * maintenance — дар реҷаи хизматӣ ҳам кор кунад.
   */
  function route(method, url, handler, opts = {}) {
    const { auth = true, rate = [], raw = false, maintenance = false } = opts;
    app.route({
      method,
      url,
      config: { auth, maintenance },
      preHandler: async (request) => {
        if (!maintenance && c.settings.get('maintenance_mode') && auth !== 'admin' && auth !== 'admin-public') {
          throw new ApiError('MAINTENANCE', { headers: { 'Retry-After': '60' } });
        }
        if (auth === true) {
          await c.auth.authenticate(request);
          await c.limiter.hitFor('user_api', request);
        } else if (auth === 'admin') {
          await c.admin.authenticate(request);
        } else {
          await c.limiter.hitFor('public_ip', request);
        }
        for (const name of rate) await c.limiter.hitFor(name, request);
      },
      handler: async (request, reply) => {
        const result = await handler(request, reply);
        if (raw) return reply;
        return ok(result);
      },
    });
  }

  // ------------------------------------------------------------ система (39)

  app.get('/api/v1/health', async () =>
    ok({ status: 'ok', service: 'jovidxonchat', version: c.config.version, time: new Date().toISOString() }),
  );

  app.get('/api/v1/health/ready', async (request, reply) => {
    const checks = { database: false, schema: false, realtime: c.bus.connected };
    try {
      await c.db.value('SELECT 1');
      checks.database = true;
      checks.schema = (await pendingMigrations(c.db)).length === 0;
    } catch {
      // checks false
    }
    const ready = checks.database && checks.schema;
    reply.code(ready ? 200 : 503);
    if (!ready) reply.header('Retry-After', '30');
    return { success: ready, message: ready ? 'OK' : 'MAINTENANCE', data: { status: ready ? 'ready' : 'not_ready', checks }, errors: [] };
  });

  app.get('/join/:code', async (request, reply) => {
    const code = String(request.params.code ?? '');
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(code)) throw fail.notFound();
    const locale = localeOf(request);
    const escape = (s) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const title = escape(t('invite_title', locale));
    const body = escape(t('invite_body', locale));
    reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .header('X-Robots-Tag', 'noindex');
    return `<!doctype html><html lang="${locale === 'ru' ? 'ru' : 'tg'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>JovidxonChat — ${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;
background:linear-gradient(135deg,#1b2a4e,#5b3f8c);color:#fff;padding:16px;box-sizing:border-box}
.card{max-width:420px;width:100%;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:24px;
padding:28px;text-align:center;backdrop-filter:blur(12px)}h1{font-size:22px;margin:0 0 12px}p{opacity:.9;line-height:1.5}
code{display:block;font-size:20px;letter-spacing:1px;margin-top:16px;padding:12px;border-radius:12px;background:rgba(0,0,0,.25);
word-break:break-all;user-select:all}</style></head>
<body><main class="card"><h1>JovidxonChat · ${title}</h1><p>${body}</p><code>${escape(code)}</code></main></body></html>`;
  });

  // ------------------------------------------------------------ WebSocket (32)

  app.get('/api/v1/ws', { websocket: true }, (socket, request) => c.hub.handle(socket, request));

  // ------------------------------------------------------------ воридшавӣ (05, 06, 18)

  route('POST', '/api/v1/auth/request-otp', (r) => c.auth.requestOtp(r), { auth: false, rate: ['otp_request_ip'] });
  route('POST', '/api/v1/auth/resend-otp', (r) => c.auth.requestOtp(r), { auth: false, rate: ['otp_request_ip'] });
  route('POST', '/api/v1/auth/verify-otp', (r) => c.auth.verifyOtp(r), { auth: false, rate: ['otp_verify_ip'] });
  route('POST', '/api/v1/auth/google', (r) => c.auth.googleSignIn(r), { auth: false, rate: ['google_ip'] });
  route('POST', '/api/v1/auth/refresh', (r) => c.auth.refresh(r), { auth: false, rate: ['refresh_ip'] });
  route('POST', '/api/v1/auth/logout', (r) => c.auth.logout(r));
  route('POST', '/api/v1/auth/logout-all', (r) => c.auth.logoutOthers(r));
  route('POST', '/api/v1/auth/socket-token', (r) => c.auth.socketToken(r), { rate: ['socket_token'] });

  // ------------------------------------------------------------ ман (07, 17, 18)

  route('GET', '/api/v1/me', (r) => c.account.me(r));
  route('PATCH', '/api/v1/me', (r) => c.account.update(r), { rate: ['profile_update'] });
  route('DELETE', '/api/v1/me', (r) => c.account.deleteAccount(r), { rate: ['account_delete'] });
  route('POST', '/api/v1/me/avatar', (r) => c.media.uploadAvatar(r), { rate: ['upload'] });
  route('DELETE', '/api/v1/me/avatar', (r) => c.account.deleteAvatar(r));
  route('GET', '/api/v1/me/settings', (r) => c.account.settings(r));
  route('PATCH', '/api/v1/me/settings', (r) => c.account.updateSettings(r));
  route('GET', '/api/v1/me/sessions', (r) => c.account.sessions(r));
  route('DELETE', '/api/v1/me/sessions/:id', (r) => c.account.revokeSession(r));

  // ------------------------------------------------------------ корбарон ва ҷустуҷӯ (14)

  route('GET', '/api/v1/users/:id', (r) => c.account.user(r));
  route('GET', '/api/v1/search/users', (r) => c.account.searchUsers(r), { rate: ['search'] });
  route('GET', '/api/v1/search/messages', (r) => c.chats.search(r), { rate: ['search'] });

  // ------------------------------------------------------------ чатҳо ва паёмҳо (08, 09, 10, 32, 33)

  route('GET', '/api/v1/chats', (r) => c.chats.list(r));
  route('POST', '/api/v1/chats', (r) => c.chats.open(r), { rate: ['chat_create'] });
  route('GET', '/api/v1/chats/:id', (r) => c.chats.show(r));
  route('PATCH', '/api/v1/chats/:id', (r) => c.chats.update(r));
  route('GET', '/api/v1/chats/:id/members', (r) => c.chats.membersRoute(r));
  route('POST', '/api/v1/chats/:id/typing', (r) => c.chats.typing(r), { rate: ['typing'] });
  route('GET', '/api/v1/chats/:id/messages', (r) => c.chats.listMessages(r));
  route('POST', '/api/v1/chats/:id/messages', (r) => c.chats.sendMessage(r), { rate: ['send_message'] });
  route('PATCH', '/api/v1/messages/:id', (r) => c.chats.editMessage(r));
  route('DELETE', '/api/v1/messages/:id', (r) => c.chats.deleteMessage(r));
  route('POST', '/api/v1/messages/:id/read', (r) => c.chats.markReadRoute(r));
  route('GET', '/api/v1/sync', (r) => c.chats.sync(r));

  // ------------------------------------------------------------ медиа (11, 12, 34)

  route('POST', '/api/v1/media', (r) => c.media.upload(r), { rate: ['upload'] });
  route('GET', '/api/v1/media/:id', (r, reply) => c.media.serve(r, reply, false), { raw: true });
  route('GET', '/api/v1/media/:id/thumb', (r, reply) => c.media.serve(r, reply, true), { raw: true });
  route('DELETE', '/api/v1/media/:id', (r) => c.media.destroy(r));

  // ------------------------------------------------------------ гурӯҳҳо (13)

  route('POST', '/api/v1/groups/join', (r) => c.groups.join(r), { rate: ['group_join'] });
  route('GET', '/api/v1/groups/:id', (r) => c.groups.show(r));
  route('PATCH', '/api/v1/groups/:id', (r) => c.groups.update(r));
  route('DELETE', '/api/v1/groups/:id', (r) => c.groups.remove(r));
  route('GET', '/api/v1/groups/:id/members', (r) => c.groups.members(r));
  route('POST', '/api/v1/groups/:id/members', (r) => c.groups.addMembers(r));
  route('DELETE', '/api/v1/groups/:id/members/:userId', (r) => c.groups.removeMember(r));
  route('POST', '/api/v1/groups/:id/members/:userId/role', (r) => c.groups.setRole(r));
  route('PATCH', '/api/v1/groups/:id/members/:userId/permissions', (r) => c.groups.setPermissions(r));
  route('POST', '/api/v1/groups/:id/leave', (r) => c.groups.leave(r));
  route('POST', '/api/v1/groups/:id/invite', (r) => c.groups.enableInvite(r));
  route('DELETE', '/api/v1/groups/:id/invite', (r) => c.groups.revokeInvite(r));

  // ------------------------------------------------------------ stories (36)

  route('GET', '/api/v1/stories', (r) => c.stories.feed(r));
  route('POST', '/api/v1/stories', (r) => c.stories.create(r), { rate: ['story_create'] });
  route('DELETE', '/api/v1/stories/:id', (r) => c.stories.remove(r));
  route('POST', '/api/v1/stories/:id/view', (r) => c.stories.view(r));
  route('GET', '/api/v1/stories/:id/viewers', (r) => c.stories.viewers(r));
  route('POST', '/api/v1/stories/:id/reply', (r) => c.stories.reply(r), { rate: ['send_message'] });

  // ------------------------------------------------------------ амният (18)

  route('GET', '/api/v1/blocks', (r) => c.safety.blocked(r));
  route('POST', '/api/v1/blocks', (r) => c.safety.block(r), { rate: ['block'] });
  route('DELETE', '/api/v1/blocks/:userId', (r) => c.safety.unblock(r));
  route('POST', '/api/v1/reports', (r) => c.safety.report(r), { rate: ['report'] });

  // ------------------------------------------------------------ дастгоҳҳо / push (15, 35)

  route('POST', '/api/v1/devices', (r) => c.push.register(r));
  route('DELETE', '/api/v1/devices/:deviceId', (r) => c.push.unregister(r));

  // ------------------------------------------------------------ зангҳо (16)

  route('GET', '/api/v1/calls/config', (r) => c.calls.config(r));
  route('GET', '/api/v1/calls', (r) => c.calls.history(r));
  route('POST', '/api/v1/calls', (r) => c.calls.start(r), { rate: ['call_create'] });
  route('GET', '/api/v1/calls/:id', (r) => c.calls.show(r));
  route('POST', '/api/v1/calls/:id/accept', (r) => c.calls.accept(r));
  route('POST', '/api/v1/calls/:id/decline', (r) => c.calls.decline(r));
  route('POST', '/api/v1/calls/:id/end', (r) => c.calls.end(r));
  route('POST', '/api/v1/calls/:id/signals', (r) => c.calls.signal(r), { rate: ['call_signal'] });
  route('GET', '/api/v1/calls/:id/signals', (r) => c.calls.signals(r), { rate: ['call_signal'] });

  // ------------------------------------------------------------ панели админ (19, 40)

  const A = '/api/v1/admin';
  const admin = { auth: 'admin', maintenance: true };
  const adminPublic = { auth: 'admin-public', maintenance: true };
  route('GET', `${A}/setup`, () => c.admin.setupStatus(), adminPublic);
  route('POST', `${A}/setup`, (r, reply) => c.admin.setup(r, reply), adminPublic);
  route('POST', `${A}/auth/login`, (r, reply) => c.admin.login(r, reply), adminPublic);
  route('POST', `${A}/auth/logout`, (r, reply) => c.admin.logout(r, reply), admin);
  route('GET', `${A}/auth/me`, (r) => c.admin.me(r), admin);
  route('POST', `${A}/me/password`, (r) => c.admin.changePassword(r), admin);
  route('POST', `${A}/me/totp/setup`, (r) => c.admin.totpSetup(r), admin);
  route('POST', `${A}/me/totp/enable`, (r) => c.admin.totpEnable(r), admin);
  route('POST', `${A}/me/totp/disable`, (r) => c.admin.totpDisable(r), admin);
  route('GET', `${A}/stats`, (r) => c.admin.stats(r), admin);
  route('GET', `${A}/stats/daily`, (r) => c.admin.daily(r), admin);
  route('GET', `${A}/users`, (r) => c.admin.users(r), admin);
  route('GET', `${A}/users/:id`, (r) => c.admin.userDetail(r), admin);
  route('POST', `${A}/users/:id/suspend`, (r) => c.admin.suspend(r), admin);
  route('POST', `${A}/users/:id/unsuspend`, (r) => c.admin.unsuspend(r), admin);
  route('POST', `${A}/users/:id/logout`, (r) => c.admin.logoutUser(r), admin);
  route('DELETE', `${A}/users/:id`, (r) => c.admin.deleteUser(r), admin);
  route('GET', `${A}/groups`, (r) => c.admin.groupsList(r), admin);
  route('GET', `${A}/groups/:id`, (r) => c.admin.groupDetail(r), admin);
  route('DELETE', `${A}/groups/:id`, (r) => c.admin.deleteGroup(r), admin);
  route('GET', `${A}/reports`, (r) => c.admin.reports(r), admin);
  route('GET', `${A}/reports/:id`, (r) => c.admin.reportDetail(r), admin);
  route('PATCH', `${A}/reports/:id`, (r) => c.admin.resolveReport(r), admin);
  route('GET', `${A}/sms`, (r) => c.admin.smsLogs(r), admin);
  route('POST', `${A}/sms/test`, (r) => c.admin.smsTest(r), admin);
  route('GET', `${A}/settings`, (r) => c.admin.settingsList(r), admin);
  route('PATCH', `${A}/settings`, (r) => c.admin.updateSettings(r), admin);
  route('GET', `${A}/admins`, (r) => c.admin.admins(r), admin);
  route('POST', `${A}/admins`, (r) => c.admin.createAdmin(r), admin);
  route('PATCH', `${A}/admins/:id`, (r) => c.admin.updateAdmin(r), admin);
  route('DELETE', `${A}/admins/:id`, (r) => c.admin.deleteAdmin(r), admin);
  route('GET', `${A}/audit`, (r) => c.admin.auditLog(r), admin);
  route('GET', `${A}/system`, (r) => c.admin.system(r), admin);
  route(
    'GET',
    `${A}/media/:id`,
    (r, reply) => {
      c.admin.require(r, 'users.view');
      return c.media.serve(r, reply, false, (media) => c.media.canAdminView(media));
    },
    { ...admin, raw: true },
  );
  route(
    'GET',
    `${A}/media/:id/thumb`,
    (r, reply) => {
      c.admin.require(r, 'users.view');
      return c.media.serve(r, reply, true, (media) => c.media.canAdminView(media));
    },
    { ...admin, raw: true },
  );
}
