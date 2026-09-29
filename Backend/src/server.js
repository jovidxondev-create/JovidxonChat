import { buildApp } from './app.js';
import { configProblems, loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createDb } from './db/pool.js';

/**
 * Оғози сервер (Render: `node src/server.js`): миграцияҳо → танзимот аз база → LISTEN → HTTP/WebSocket
 * → корҳои заминавӣ. SIGTERM (deploy-и нав) — қатъи мулоим: пайвастҳо баста, корҳо ба охир.
 */
async function main() {
  const config = loadConfig();
  const problems = configProblems(config);
  if (problems.length) {
    console.error(JSON.stringify({ level: 'fatal', msg: 'config_invalid', problems }));
    process.exit(1);
  }

  const db = createDb(config);
  const app = await buildApp({ config, db });
  const { ctx } = app;

  try {
    const applied = await migrate(db, app.log);
    if (applied.length) app.log.info({ applied }, 'migrations_applied');
    await ctx.settings.load();
    await ctx.bus.start();
    await ctx.admin.prepareSetup();
    await ctx.admin.applyReset();
    // Ҷустуҷӯи ном/паём бе фарқи ҳарфи калон/хурд ба locale-и база вобаста аст (Render: en_US.UTF-8).
    if (!(await db.value("SELECT lower('ҶӮҲҚҒӢ Ж') = 'ҷӯҳқғӣ ж'"))) {
      app.log.warn('database_locale_not_unicode: Cyrillic search will be case-sensitive');
    }
  } catch (error) {
    app.log.fatal({ err: { message: error.message, code: error.code } }, 'startup_failed');
    process.exit(1);
  }

  await app.listen({ host: config.host, port: config.port });
  if (config.workers) ctx.maintenance.start();
  app.log.info({ port: config.port, version: config.version }, 'server_started');

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'server_stopping');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    ctx.maintenance.stop();
    ctx.hub.closeAll(1012, 'server_restart');
    ctx.limiter.close();
    await app.close().catch(() => {});
    await ctx.bus.stop().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => app.log.error({ err: { message: String(reason?.message ?? reason) } }, 'unhandled_rejection'));
}

main();
