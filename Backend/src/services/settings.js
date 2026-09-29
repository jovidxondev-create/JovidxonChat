import { fail, fieldError } from '../core/errors.js';
import { seal, unseal } from '../core/crypto.js';
import { normalizePhone } from '../core/text.js';

/**
 * Танзимоти барнома дар база (app_settings), ки аз панели админ иваз мешаванд.
 * Қимати самаранок = база → env (config.defaults) → пешфарзи ин ҷо.
 * Қиматҳои махфӣ (калиди SMS, парол, FCM) рамзгузорӣ шуда нигоҳ дошта мешаванд ва ҳеҷ гоҳ
 * пурра ба панел бармегарданд.
 */
export const SETTING_DEFS = {
  registration_enabled: { type: 'bool', group: 'general', fallback: true },
  maintenance_mode: { type: 'bool', group: 'general', fallback: false },

  sms_driver: { type: 'enum', group: 'sms', values: ['alif', 'smsgate', 'log', 'null'], fallback: 'log' },
  sms_fallback_driver: { type: 'enum', group: 'sms', values: ['', 'alif', 'smsgate'], fallback: '' },
  sms_alif_url: { type: 'url', group: 'sms', fallback: 'https://sms2.aliftech.net/api/v1/sms' },
  sms_alif_api_key: { type: 'string', group: 'sms', secret: true, max: 256, fallback: '' },
  sms_alif_sender: { type: 'string', group: 'sms', max: 32, fallback: '' },
  sms_alif_type: { type: 'int', group: 'sms', min: 0, max: 10, fallback: 1 },
  sms_gate_url: { type: 'url', group: 'sms', fallback: 'https://api.sms-gate.app/3rdparty/v1/messages' },
  sms_gate_user: { type: 'string', group: 'sms', max: 128, fallback: '' },
  sms_gate_password: { type: 'string', group: 'sms', secret: true, max: 256, fallback: '' },
  sms_gate_device_id: { type: 'string', group: 'sms', max: 128, fallback: '' },
  sms_gate_sim_number: { type: 'int', group: 'sms', min: 0, max: 4, fallback: 0 },
  otp_test_numbers: { type: 'string', group: 'sms', secret: true, max: 2000, fallback: '', check: checkTestNumbers },

  google_client_ids: { type: 'list', group: 'auth', max: 10, fallback: [] },

  media_max_image_mb: { type: 'int', group: 'media', min: 1, max: 200, fallback: 30 },
  media_max_video_mb: { type: 'int', group: 'media', min: 1, max: 1024, fallback: 100 },
  media_max_voice_mb: { type: 'int', group: 'media', min: 1, max: 200, fallback: 16 },
  media_max_document_mb: { type: 'int', group: 'media', min: 1, max: 1024, fallback: 100 },
  media_user_quota_mb: { type: 'int', group: 'media', min: 0, max: 1_000_000, fallback: 0 },

  message_edit_window_hours: { type: 'int', group: 'chat', min: 0, max: 8760, fallback: 48 },
  group_max_members: { type: 'int', group: 'chat', min: 2, max: 100_000, fallback: 1000 },
  story_ttl_hours: { type: 'int', group: 'chat', min: 1, max: 168, fallback: 24 },

  calls_enabled: { type: 'bool', group: 'calls', fallback: true },
  calls_stun_urls: { type: 'list', group: 'calls', max: 10, fallback: ['stun:stun.l.google.com:19302'] },
  calls_turn_urls: { type: 'list', group: 'calls', max: 10, fallback: [] },
  calls_turn_secret: { type: 'string', group: 'calls', secret: true, max: 256, fallback: '' },
  calls_turn_username: { type: 'string', group: 'calls', max: 256, fallback: '' },
  calls_turn_credential: { type: 'string', group: 'calls', secret: true, max: 256, fallback: '' },
  // Cloudflare Realtime TURN: калидҳои муваққатӣ дар сервер сохта мешаванд (1000 GB/моҳ ройгон).
  calls_turn_cf_key_id: { type: 'string', group: 'calls', max: 200, fallback: '' },
  calls_turn_cf_api_token: { type: 'string', group: 'calls', secret: true, max: 500, fallback: '' },

  fcm_service_account: { type: 'json', group: 'push', secret: true, max: 20_000, fallback: '', check: checkServiceAccount },
};

function checkTestNumbers(value) {
  return parseTestNumbers(value, true) !== null;
}

function checkServiceAccount(value) {
  if (value === '') return true;
  try {
    const json = JSON.parse(value);
    return typeof json.client_email === 'string' && typeof json.private_key === 'string' && typeof json.project_id === 'string';
  } catch {
    return false;
  }
}

/** "+992900000001:1234,+992900000002:5678" → Map; strict: хатои формат → null. */
export function parseTestNumbers(value, strict = false) {
  const map = new Map();
  for (const pair of String(value ?? '').split(/[,\n;]/).map((p) => p.trim()).filter(Boolean)) {
    const [rawPhone, code] = pair.split(/[:=]/, 2).map((p) => (p ?? '').trim());
    const phone = normalizePhone(rawPhone);
    if (phone && /^\d{4}$/.test(code ?? '')) {
      map.set(phone, code);
    } else if (strict) {
      return null;
    }
  }
  return map;
}

function maskSecret(value) {
  const text = String(value ?? '');
  if (text === '') return '';
  if (text.length <= 8) return '••••';
  return `••••${text.slice(-4)}`;
}

/** Service account: танҳо email-и он (барои шинохтан), на калид. */
function maskedPreview(def, value) {
  if (def.type !== 'json') return maskSecret(value);
  try {
    const email = String(JSON.parse(value).client_email ?? '');
    return email ? `${email.slice(0, 3)}…${email.slice(email.indexOf('@'))}` : '••••';
  } catch {
    return '••••';
  }
}

export class Settings {
  constructor({ db, keys, config, log }) {
    this.db = db;
    this.keys = keys;
    this.config = config;
    this.log = log;
    this.values = new Map();
    this.meta = new Map();
    this.onChange = null;
  }

  async load() {
    const rows = await this.db.many('SELECT key, value, is_secret, updated_at, updated_by FROM app_settings');
    const values = new Map();
    const meta = new Map();
    for (const row of rows) {
      const def = SETTING_DEFS[row.key];
      if (!def) continue;
      let raw = row.value;
      if (row.is_secret) {
        raw = unseal(this.keys.settings, row.value);
        if (raw === null) {
          this.log?.warn({ key: row.key }, 'setting_decrypt_failed');
          continue;
        }
      }
      try {
        values.set(row.key, JSON.parse(raw));
        meta.set(row.key, { updated_at: row.updated_at, updated_by: row.updated_by });
      } catch {
        this.log?.warn({ key: row.key }, 'setting_parse_failed');
      }
    }
    this.values = values;
    this.meta = meta;
  }

  source(key) {
    if (this.values.has(key)) return 'db';
    const envValue = this.config.defaults[key];
    if (envValue !== undefined && envValue !== '' && !(Array.isArray(envValue) && envValue.length === 0)) return 'env';
    return 'default';
  }

  get(key) {
    const def = SETTING_DEFS[key];
    if (!def) throw new Error(`unknown setting ${key}`);
    if (this.values.has(key)) return this.values.get(key);
    const envValue = this.config.defaults[key];
    if (this.source(key) === 'env') return envValue;
    return def.fallback;
  }

  testNumbers() {
    return parseTestNumbers(this.get('otp_test_numbers'));
  }

  mediaLimitBytes(kind) {
    const mb = this.get(`media_max_${kind}_mb`);
    return (Number.isFinite(mb) ? mb : 16) * 1024 * 1024;
  }

  /** Барои панели админ: махфиҳо пӯшида. */
  describe() {
    return Object.entries(SETTING_DEFS).map(([key, def]) => {
      const value = this.get(key);
      const isSet = !(value === '' || value === null || (Array.isArray(value) && value.length === 0));
      return {
        key,
        group: def.group,
        type: def.type,
        secret: Boolean(def.secret),
        values: def.values ?? null,
        min: def.min ?? null,
        max: def.max ?? null,
        value: def.secret ? (isSet ? maskedPreview(def, value) : '') : value,
        is_set: isSet,
        source: this.source(key),
        updated_at: this.meta.get(key)?.updated_at ?? null,
      };
    });
  }

  normalize(key, raw) {
    const def = SETTING_DEFS[key];
    switch (def.type) {
      case 'bool':
        if (typeof raw === 'boolean') return raw;
        if (raw === 'true' || raw === 1 || raw === '1') return true;
        if (raw === 'false' || raw === 0 || raw === '0') return false;
        return undefined;
      case 'int': {
        const n = typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
        if (!Number.isSafeInteger(n) || n < def.min || n > def.max) return undefined;
        return n;
      }
      case 'enum': {
        const v = String(raw ?? '').trim().toLowerCase();
        return def.values.includes(v) ? v : undefined;
      }
      case 'url': {
        const v = String(raw ?? '').trim();
        try {
          const url = new URL(v);
          return url.protocol === 'https:' || url.protocol === 'http:' ? v : undefined;
        } catch {
          return undefined;
        }
      }
      case 'list': {
        const items = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\n]/))
          .map((item) => String(item).trim())
          .filter(Boolean);
        if (items.length > def.max || items.some((item) => item.length > 512)) return undefined;
        return [...new Set(items)];
      }
      case 'json':
      case 'string': {
        const v = typeof raw === 'string' ? raw.trim() : raw === null || raw === undefined ? '' : undefined;
        if (v === undefined || v.length > def.max) return undefined;
        if (def.check && !def.check(v)) return undefined;
        return v;
      }
      default:
        return undefined;
    }
  }

  /**
   * changes: {key: value}. null — бозгашт ба env/пешфарз (сатр аз база нест мешавад).
   * Барои махфиҳо сатри холӣ ҳам ҳамин маъно дорад (қимати пӯшидаро дубора фиристодан лозим нест).
   */
  async update(changes, adminId) {
    const errors = [];
    const writes = [];
    for (const [key, raw] of Object.entries(changes ?? {})) {
      const def = SETTING_DEFS[key];
      if (!def) {
        errors.push(fieldError(key, 'unsupported'));
        continue;
      }
      if (raw === null || (def.secret && raw === '')) {
        writes.push({ key, remove: true });
        continue;
      }
      const value = this.normalize(key, raw);
      if (value === undefined) {
        errors.push(fieldError(key, 'format'));
        continue;
      }
      writes.push({ key, value, secret: Boolean(def.secret) });
    }
    if (errors.length) throw fail.validation(errors);

    await this.db.tx(async (tx) => {
      for (const w of writes) {
        if (w.remove) {
          await tx.exec('DELETE FROM app_settings WHERE key = $1', [w.key]);
          continue;
        }
        const json = JSON.stringify(w.value);
        await tx.exec(
          `INSERT INTO app_settings (key, value, is_secret, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [w.key, w.secret ? seal(this.keys.settings, json) : json, w.secret, adminId ?? null],
        );
      }
      await tx.notify('jovidxon_events', { t: 'settings' });
    });
    await this.load();
    return writes.map((w) => w.key);
  }

  /** Номҳои калидҳое, ки тағйир ёфтанд — барои аудит (бе қиматҳо). */
  static keysOf(changes) {
    return Object.keys(changes ?? {}).filter((key) => SETTING_DEFS[key]);
  }
}

export function ensureSettingsKeys(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw fail.field('settings', 'format');
  return changes;
}
