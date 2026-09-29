const LOCK_ID = 7_270_002;
const INTERVAL_MS = 5 * 60_000;

/**
 * Корҳои хидматӣ (34, 36, 39, 42): мӯҳлати story, медиаи ятим, OTP/rate-limit/сессияҳои кӯҳна,
 * зангҳои бе ҷавоб, навбати push. Қулфи advisory — танҳо як instance дар як вақт.
 */
export class Maintenance {
  constructor(ctx) {
    this.ctx = ctx;
    this.timers = [];
    this.running = false;
  }

  get db() {
    return this.ctx.db;
  }

  start() {
    const every = (ms, fn) => {
      const timer = setInterval(() => fn().catch((error) => this.ctx.log?.warn({ err: { message: error?.message } }, 'worker_failed')), ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(INTERVAL_MS, () => this.runLocked());
    every(3000, () => this.ctx.push.flush(50));
    const first = setTimeout(() => this.runLocked().catch(() => {}), 20_000);
    first.unref?.();
    this.timers.push(first);
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  async runLocked() {
    if (this.running) return null;
    this.running = true;
    const client = await this.db.pool.connect();
    try {
      const locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID])).rows[0]?.ok;
      if (!locked) return null;
      try {
        return await this.run();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
      }
    } finally {
      client.release();
      this.running = false;
    }
  }

  async run() {
    const db = this.db;
    const retentionDays = 7;
    const tasks = {
      stories_expired: () =>
        db.exec(
          `UPDATE stories SET deleted_at = expires_at
           WHERE id IN (SELECT id FROM stories WHERE deleted_at IS NULL AND expires_at <= now() LIMIT 1000)`,
        ),
      stories_purged: () =>
        db.exec(
          `DELETE FROM stories WHERE id IN (SELECT id FROM stories WHERE deleted_at IS NOT NULL
             AND deleted_at < now() - make_interval(days => $1) LIMIT 1000)`,
          [retentionDays + 1],
        ),
      calls_missed: () => this.ctx.calls.expireRinging(60, 500),
      calls_stale: () => this.ctx.calls.expireStale(200),
      call_signals_purged: () =>
        db.exec("DELETE FROM call_signals WHERE id IN (SELECT id FROM call_signals WHERE created_at < now() - interval '1 day' LIMIT 5000)"),
      otp_purged: () =>
        db.exec("DELETE FROM otp_codes WHERE id IN (SELECT id FROM otp_codes WHERE created_at < now() - interval '1 day' LIMIT 5000)"),
      rate_limits_purged: () => db.exec('DELETE FROM rate_limits WHERE expires_at < $1', [Math.floor(Date.now() / 1000)]),
      socket_tokens_purged: () => db.exec('DELETE FROM socket_tokens WHERE expires_at < now()'),
      sessions_expired: () =>
        db.exec(
          `UPDATE sessions SET revoked_at = now(), revoke_reason = 'expired'
           WHERE id IN (SELECT id FROM sessions WHERE revoked_at IS NULL AND refresh_expires_at < now() LIMIT 2000)`,
        ),
      sessions_purged: () =>
        db.exec(
          "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE revoked_at < now() - interval '90 days' LIMIT 2000)",
        ),
      admin_sessions_purged: () => db.exec("DELETE FROM admin_sessions WHERE expires_at < now() - interval '7 days'"),
      sms_logs_purged: () =>
        db.exec("DELETE FROM sms_logs WHERE id IN (SELECT id FROM sms_logs WHERE created_at < now() - interval '180 days' LIMIT 5000)"),
      push_reset: () => db.exec("UPDATE push_outbox SET status = 'queued' WHERE status = 'sending' AND locked_at < now() - interval '5 minutes'"),
      push_purged: () =>
        db.exec("DELETE FROM push_outbox WHERE id IN (SELECT id FROM push_outbox WHERE created_at < now() - interval '7 days' LIMIT 5000)"),
      media_uploads_abandoned: () =>
        db.exec(
          "DELETE FROM media_files WHERE id IN (SELECT id FROM media_files WHERE status = 'uploading' AND created_at < now() - interval '3 hours' LIMIT 200)",
        ),
      media_orphans: () =>
        db.exec(
          `UPDATE media_files f SET deleted_at = now()
           WHERE f.id IN (
             SELECT f2.id FROM media_files f2
             WHERE f2.deleted_at IS NULL AND f2.status = 'ready' AND f2.created_at < now() - interval '24 hours'
               AND NOT EXISTS (SELECT 1 FROM message_attachments a WHERE a.media_id = f2.id)
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = f2.id)
               AND NOT EXISTS (SELECT 1 FROM chat_groups g WHERE g.avatar_media_id = f2.id)
               AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.media_id = f2.id
                               AND (s.deleted_at IS NULL OR s.deleted_at > now() - make_interval(days => $1)))
             LIMIT 500)`,
          [retentionDays],
        ),
      media_purged: () =>
        db.exec(
          `DELETE FROM media_files WHERE id IN (SELECT id FROM media_files WHERE deleted_at IS NOT NULL
             AND deleted_at < now() - interval '1 hour' LIMIT 200)`,
        ),
    };

    const results = {};
    const deadline = Date.now() + 60_000;
    for (const [name, task] of Object.entries(tasks)) {
      if (Date.now() > deadline) {
        results[name] = 'skipped';
        continue;
      }
      try {
        results[name] = await task();
      } catch (error) {
        results[name] = 'error';
        this.ctx.log?.error({ task: name, err: { message: error?.message } }, 'maintenance_task_failed');
      }
    }
    await db
      .exec(
        `INSERT INTO app_state (name, value, updated_at) VALUES ('maintenance_last_run', $1, now())
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(results)],
      )
      .catch(() => {});
    const changed = Object.fromEntries(Object.entries(results).filter(([, value]) => value !== 0));
    if (Object.keys(changed).length) this.ctx.log?.info(changed, 'maintenance_run');
    return results;
  }
}
