import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION = '3.0.0';

function str(value, fallback = '') {
  const v = value === undefined || value === null ? '' : String(value).trim();
  return v === '' ? fallback : v;
}

function int(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number.parseInt(str(value), 10);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

function bool(value, fallback) {
  const v = str(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * Ба кадом проксиҳо бовар кунем (IP-и мизоҷ барои rate limit): "render" (пешфарз) — ниг. core/proxy.js.
 * true ба ҳама бовар мекунад — он гоҳ мизоҷ бо X-Forwarded-For-и қалбакӣ rate limit-ро мегузарад.
 */
function trustProxyValue(value) {
  const v = str(value).toLowerCase();
  if (v === '' || v === 'render') return 'render';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // рӯйхати IP/CIDR
}

function list(value) {
  return str(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Танзимоти муҳит. Ҳама чизи дигар (SMS, Google, лимитҳо, реҷаи хизматӣ) дар база
 * (ҷадвали app_settings) нигоҳ дошта мешавад ва аз панели админ иваз мешавад; қиматҳои
 * env танҳо ҳамчун пешфарз хизмат мекунанд.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = str(env.NODE_ENV, 'production').toLowerCase();
  const databaseUrl = str(env.DATABASE_URL);

  return {
    env: nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    version: VERSION,
    host: str(env.HOST, '0.0.0.0'),
    port: int(env.PORT, 8080, 1, 65535),
    databaseUrl,
    // Render: пайвасти дохилӣ (host бе нуқта) SSL намехоҳад; берунӣ — SSL.
    databaseSsl: str(env.DATABASE_SSL, 'auto').toLowerCase(),
    databasePoolMax: int(env.DATABASE_POOL_MAX, 10, 2, 100),
    appSecret: str(env.APP_SECRET ?? env.JWT_SECRET),
    publicUrl: str(env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL).replace(/\/+$/, ''),
    adminSetupCode: str(env.ADMIN_SETUP_CODE),
    logLevel: str(env.LOG_LEVEL, nodeEnv === 'test' ? 'silent' : 'info'),
    trustProxy: trustProxyValue(env.TRUST_PROXY),
    // Барқарорсозии пароли админ бе Shell (нақшаи ройгони Render): ADMIN_RESET="username:ПаролиНав123"
    // → ҳангоми оғоз пароли ҳамин админ иваз мешавад; баъд ин тағйирёбандаро нест кунед.
    adminReset: str(env.ADMIN_RESET),
    adminDist: path.resolve(BACKEND_ROOT, str(env.ADMIN_DIST, '../admin_panel/dist')),
    instanceId: str(env.RENDER_INSTANCE_ID, `local-${process.pid}`),
    // Корҳои заминавӣ (push, тозакунӣ). Дар тестҳо дастӣ идора мешаванд.
    workers: bool(env.WORKERS, nodeEnv !== 'test'),
    // Пешфарзҳо барои app_settings (агар дар база қимат набошад).
    defaults: {
      registration_enabled: bool(env.REGISTRATION_ENABLED, true),
      maintenance_mode: bool(env.MAINTENANCE_MODE, false),
      sms_driver: str(env.SMS_DRIVER, str(env.SMS_ALIF_API_KEY) ? 'alif' : 'log').toLowerCase(),
      sms_fallback_driver: str(env.SMS_FALLBACK_DRIVER).toLowerCase(),
      sms_alif_url: str(env.SMS_ALIF_URL, 'https://sms2.aliftech.net/api/v1/sms'),
      sms_alif_api_key: str(env.SMS_ALIF_API_KEY),
      sms_alif_sender: str(env.SMS_ALIF_SENDER),
      sms_alif_type: int(env.SMS_ALIF_TYPE, 1, 0, 10),
      sms_gate_url: str(env.SMS_GATE_URL, 'https://api.sms-gate.app/3rdparty/v1/messages'),
      sms_gate_user: str(env.SMS_GATE_USER),
      sms_gate_password: str(env.SMS_GATE_PASSWORD),
      sms_gate_device_id: str(env.SMS_GATE_DEVICE_ID),
      sms_gate_sim_number: int(env.SMS_GATE_SIM_NUMBER, 0, 0, 4),
      otp_test_numbers: str(env.OTP_TEST_NUMBERS),
      google_client_ids: list(env.GOOGLE_CLIENT_IDS ?? env.GOOGLE_CLIENT_ID),
      media_max_image_mb: int(env.MEDIA_MAX_IMAGE_MB, 30, 1, 200),
      media_max_video_mb: int(env.MEDIA_MAX_VIDEO_MB, 100, 1, 1024),
      media_max_voice_mb: int(env.MEDIA_MAX_VOICE_MB, 16, 1, 200),
      media_max_document_mb: int(env.MEDIA_MAX_DOCUMENT_MB, 100, 1, 1024),
      media_user_quota_mb: int(env.MEDIA_USER_QUOTA_MB, 0, 0, 1_000_000),
      message_edit_window_hours: int(env.MESSAGE_EDIT_WINDOW_HOURS, 48, 0, 8760),
      group_max_members: int(env.GROUP_MAX_MEMBERS, 1000, 2, 100_000),
      story_ttl_hours: int(env.STORY_TTL_HOURS, 24, 1, 168),
      calls_enabled: bool(env.CALLS_ENABLED, true),
      calls_stun_urls: list(env.STUN_URLS).length ? list(env.STUN_URLS) : ['stun:stun.l.google.com:19302'],
      calls_turn_urls: list(env.TURN_URLS),
      calls_turn_secret: str(env.TURN_SECRET),
      calls_turn_username: str(env.TURN_USERNAME),
      calls_turn_credential: str(env.TURN_CREDENTIAL),
      calls_turn_cf_key_id: str(env.CALLS_TURN_CF_KEY_ID),
      calls_turn_cf_api_token: str(env.CALLS_TURN_CF_API_TOKEN),
      fcm_service_account: str(env.FCM_SERVICE_ACCOUNT_JSON),
    },
  };
}

/** Хатоҳои танзимот, ки бе онҳо сервер набояд ба кор дарояд. */
export function configProblems(config) {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set');
  if (config.appSecret.length < 32) problems.push('APP_SECRET must be at least 32 characters');
  return problems;
}

export { BACKEND_ROOT };
