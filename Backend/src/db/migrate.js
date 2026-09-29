import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_ID = 7_270_001;

export async function migrationFiles() {
  const names = (await fs.readdir(MIGRATIONS_DIR)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { version: name.replace(/\.sql$/, ''), sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

/**
 * Миграцияҳо ҳангоми оғози сервер (Render: танҳо deploy — бе SSH).
 * Қулфи advisory: агар ду instance якбора оғоз шаванд, танҳо яке миграция мекунад.
 * Ҳар файл дар транзаксияи худ; файлҳои иҷрошуда ҳеҷ гоҳ дубора иҷро намешаванд.
 */
export async function migrate(db, log) {
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    const done = [];
    for (const file of await migrationFiles()) {
      if (applied.has(file.version)) {
        if (applied.get(file.version) !== file.checksum) {
          log?.warn({ version: file.version }, 'migration_checksum_changed');
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file.version, file.checksum]);
        await client.query('COMMIT');
        done.push(file.version);
        log?.info({ version: file.version }, 'migration_applied');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        log?.error({ version: file.version, err: { message: error.message, code: error.code } }, 'migration_failed');
        throw error;
      }
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

export async function pendingMigrations(db) {
  const exists = await db.value("SELECT to_regclass('public.schema_migrations') IS NOT NULL");
  const applied = new Set(exists ? await db.column('SELECT version FROM schema_migrations') : []);
  return (await migrationFiles()).filter((file) => !applied.has(file.version)).map((file) => file.version);
}
