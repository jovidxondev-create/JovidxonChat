import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { ApiError } from './core/errors.js';
import { uuidv7 } from './core/ids.js';
import { isTrustedProxyAddress, trustProxyOption } from './core/proxy.js';
import { registerRoutes } from './routes.js';
import { createContext } from './services/index.js';

const REQUEST_ID = /^[A-Za-z0-9._:-]{6,64}$/;

const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function loggerOptions(config) {
  if (config.logLevel === 'silent') return false;
  return {
    level: config.logLevel,
    base: { service: 'jovidxonchat', instance: config.instanceId },
    // Ҳеҷ гоҳ токен, cookie, парол ё рамз дар лог (39).
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.code',
        '*.refresh_token',
        '*.id_token',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (req) => ({ method: req.method, route: req.routeOptions?.url ?? 'unknown' }),
      res: (res) => ({ status: res.statusCode }),
    },
  };
}

/**
 * Барномаи Fastify: API (/api/v1), WebSocket (/api/v1/ws), панели админ (/admin) ва саҳифаи даъват.
 * db — пайвасти PostgreSQL; барнома ҳеҷ файл дар диски сервер нигоҳ намедорад.
 */
export async function buildApp({ config, db }) {
  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: trustProxyOption(config.trustProxy),
    bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID.test(header) ? header : uuidv7();
    },
    routerOptions: { maxParamLength: 200 },
  });

  const ctx = createContext({ config, db, log: app.log });
  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateRequest('admin', null);
  app.decorateRequest('adminSession', null);

  // JSON: бадани холӣ = {} (Retrofit барои POST-и бе бадан); JSON-и вайрон → 422.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '' || body === undefined) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      done(new ApiError('VALIDATION_FAILED', { errors: [{ field: 'body', code: 'VALIDATION_FORMAT', message_key: 'error_validation_format' }] }));
    }
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 2, fields: 10, parts: 14 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    // Диагностика барои панели админ (Система): шакли занҷири прокси, на IP-ҳо. Як бор дар дақиқа.
    // Health check-ҳо (аз шабакаи дохилии Render, бе X-Forwarded-For) ба ҳисоб гирифта намешаванд.
    const now = Date.now();
    if (
      request.url.startsWith('/api/v1/') &&
      !request.url.startsWith('/api/v1/health') &&
      now - (ctx.diagnostics.forwarding?.at ?? 0) > 60_000
    ) {
      const xff = String(request.headers['x-forwarded-for'] ?? '');
      const xffEntries = xff ? xff.split(',').length : 0;
      const clientIsProxy = isTrustedProxyAddress(request.ip);
      ctx.diagnostics.forwarding = {
        at: now,
        xff_entries: xffEntries,
        peer_is_proxy: isTrustedProxyAddress(request.socket?.remoteAddress),
        cf_header: Boolean(request.headers['cf-connecting-ip']),
        client_ip_is_proxy: clientIsProxy,
        // Хато: прокси X-Forwarded-For фиристод, вале IP-и мизоҷ суроғаи прокси монд (TRUST_PROXY).
        // Пайвасти мустақим аз шабакаи дохилӣ ё компютери худ (бе XFF) хато нест.
        ok: !(xffEntries > 0 && clientIsProxy),
      };
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (config.isProduction) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const url = request.url;
    if (url.startsWith('/api/')) {
      reply.header('X-Frame-Options', 'DENY');
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    } else if (url === '/admin' || url.startsWith('/admin/')) {
      reply.header('Content-Security-Policy', ADMIN_CSP);
      reply.header('X-Frame-Options', 'DENY');
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/api/v1/health') return;
    const level = reply.statusCode >= 500 ? 'error' : 'info';
    request.log[level](
      {
        method: request.method,
        route: request.routeOptions?.url ?? 'not_found',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        user_id: request.user?.id,
        admin_id: request.admin?.id,
      },
      'request',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).headers(error.headers).send(error.toBody());
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send(new ApiError('PAYLOAD_TOO_LARGE').toBody());
    }
    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send(new ApiError('MEDIA_TOO_LARGE').toBody());
    }
    if (error.code?.startsWith?.('FST_ERR_CTP') || error.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      return reply.code(422).send(new ApiError('VALIDATION_FAILED').toBody());
    }
    if (error.statusCode === 404) {
      return reply.code(404).send(new ApiError('NOT_FOUND').toBody());
    }
    request.log.error({ err: { message: error.message, code: error.code, stack: error.stack } }, 'unhandled_error');
    return reply.code(500).send(new ApiError('SERVER_ERROR').toBody());
  });

  // Панели админ (React, admin_panel/dist) — дар ҳамон домен: cookie-и HttpOnly бе CORS.
  const adminIndex = path.join(config.adminDist, 'index.html');
  const adminBuilt = fs.existsSync(adminIndex);
  if (adminBuilt) {
    await app.register(fastifyStatic, {
      root: config.adminDist,
      prefix: '/admin/',
      index: ['index.html'],
      wildcard: true,
      cacheControl: false,
      // @fastify/static v10: аргументи аввал — reply-и Fastify.
      setHeaders: (reply, filePath) => {
        reply.header(
          'Cache-Control',
          /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }
  app.get('/admin', (request, reply) => reply.redirect('/admin/'));
  app.get('/', (request, reply) => reply.redirect('/admin/'));

  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && request.url.startsWith('/admin/')) {
      if (adminBuilt) {
        // SPA: ҳар роҳи /admin/... → index.html
        return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(fs.readFileSync(adminIndex));
      }
      return reply
        .code(503)
        .type('text/html; charset=utf-8')
        .send('<h1>JovidxonChat admin</h1><p>admin_panel is not built. Run: npm --prefix admin_panel ci && npm --prefix admin_panel run build</p>');
    }
    return reply.code(404).send(new ApiError('NOT_FOUND').toBody());
  });

  registerRoutes(app, ctx);
  return app;
}
