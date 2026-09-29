import { uuidv7 } from '../core/ids.js';

/** Дастгоҳҳо ва токенҳои FCM (15, 35). Як token — як дастгоҳ. */
export class Devices {
  constructor({ db }) {
    this.db = db;
  }

  async upsert(userId, deviceId, data, fcmToken, q = this.db) {
    const run = async (tx) => {
      if (fcmToken) {
        // Агар token ба ҳисоби дигар тааллуқ дошт, аз он ҷо хориҷ.
        await tx.exec('UPDATE devices SET fcm_token = NULL WHERE fcm_token = $1 AND NOT (user_id = $2 AND device_id = $3)', [
          fcmToken,
          userId,
          deviceId,
        ]);
      }
      await tx.exec(
        `INSERT INTO devices (id, user_id, device_id, device_name, platform, app_version, locale, fcm_token, last_active_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (user_id, device_id) DO UPDATE SET
           device_name = COALESCE(EXCLUDED.device_name, devices.device_name),
           platform = EXCLUDED.platform,
           app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
           locale = EXCLUDED.locale,
           fcm_token = COALESCE(EXCLUDED.fcm_token, devices.fcm_token),
           last_active_at = now()`,
        [uuidv7(), userId, deviceId, data.device_name ?? null, data.platform ?? 'android', data.app_version ?? null,
          data.locale === 'ru' ? 'ru' : 'tk', fcmToken || null],
      );
    };
    return q.inTx ? run(q) : this.db.tx(run);
  }

  delete(userId, deviceId) {
    return this.db.exec('DELETE FROM devices WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  }

  deleteAllForUser(userId, q = this.db) {
    return q.exec('DELETE FROM devices WHERE user_id = $1', [userId]);
  }

  clearTokenForDevice(userId, deviceId, q = this.db) {
    if (!deviceId) return Promise.resolve(0);
    return q.exec('UPDATE devices SET fcm_token = NULL WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  }

  clearToken(token) {
    return this.db.exec('UPDATE devices SET fcm_token = NULL WHERE fcm_token = $1', [token]);
  }

  /** Токенҳои дастгоҳҳое, ки сессияи фаъол доранд. */
  pushTargets(userId) {
    return this.db.many(
      `SELECT d.fcm_token, d.locale FROM devices d
       WHERE d.user_id = $1 AND d.fcm_token IS NOT NULL AND d.push_enabled
         AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = d.user_id AND s.device_id = d.device_id
                     AND s.revoked_at IS NULL AND s.refresh_expires_at > now())
       ORDER BY d.last_active_at DESC
       LIMIT 10`,
      [userId],
    );
  }
}
