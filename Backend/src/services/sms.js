import { uuidv7 } from '../core/ids.js';
import { maskPhone } from '../core/text.js';

const ok = (providerId = null) => ({ ok: true, providerId, error: null, retryable: false });
const failed = (error, retryable = false) => ({ ok: false, providerId: null, error, retryable });

async function post(url, { headers, body, timeoutMs }) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    const text = await response.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, error: null };
  } catch (error) {
    const name = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network';
    return { status: 0, json: null, error: `${name}${error?.cause?.code ? `_${error.cause.code}` : ''}` };
  }
}

/**
 * AlifTech SMS (https://sms2.aliftech.net): POST /api/v1/sms, сарлавҳаи X-Api-Key,
 * бадан {PhoneNumber: "992…", Text, SenderAddress, SmsType} — ҳамон API-и send_otp.php.
 */
function alifDriver(settings) {
  return {
    name: 'alif',
    async send(phone, text) {
      const apiKey = settings.get('sms_alif_api_key');
      const sender = settings.get('sms_alif_sender');
      if (!apiKey || !sender) return failed('alif_not_configured');
      const result = await post(settings.get('sms_alif_url'), {
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          PhoneNumber: phone.replace(/\D/g, ''),
          Text: text,
          SenderAddress: sender,
          SmsType: settings.get('sms_alif_type'),
        }),
        timeoutMs: 12_000,
      });
      if (result.error) return failed(result.error, true);
      if (result.status < 200 || result.status >= 300) {
        return failed(`http_${result.status}`, result.status >= 500 || result.status === 429);
      }
      const json = result.json ?? {};
      const id = ['id', 'Id', 'messageId', 'MessageId', 'smsId', 'SmsId'].map((k) => json[k]).find((v) => v !== undefined);
      return ok(id !== undefined && id !== null ? String(id) : null);
    },
  };
}

/** SMS Gate for Android (https://docs.sms-gate.app): телефони Android бо SIM ҳамчун шлюз. */
function smsGateDriver(settings) {
  return {
    name: 'smsgate',
    async send(phone, text) {
      const user = settings.get('sms_gate_user');
      const password = settings.get('sms_gate_password');
      let url = settings.get('sms_gate_url');
      if (!url || !user || !password) return failed('smsgate_not_configured');
      const payload = { phoneNumbers: [phone], textMessage: { text }, withDeliveryReport: true };
      const deviceId = settings.get('sms_gate_device_id');
      if (deviceId) payload.deviceId = deviceId;
      const sim = settings.get('sms_gate_sim_number');
      if (sim > 0) payload.simNumber = sim;
      url += `${url.includes('?') ? '&' : '?'}deviceActiveWithin=12`;
      const result = await post(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        timeoutMs: 10_000,
      });
      if (result.error) return failed(result.error, true);
      if (result.status < 200 || result.status >= 300) return failed(`http_${result.status}`, result.status >= 500);
      const id = result.json?.id;
      return ok(id !== undefined && id !== null ? String(id) : null);
    },
  };
}

/**
 * Драйвери log: танҳо барои development/test — рамз дар хотира (тестҳо) ва дар лог (dev).
 * Дар production ҳеҷ гоҳ кор намекунад (рамз набояд дар лог бошад).
 */
function logDriver(config, outbox, log) {
  return {
    name: 'log',
    async send(phone, text) {
      if (config.isProduction) return failed('log_driver_disabled_in_production');
      outbox.push({ phone, text, at: Date.now() });
      if (outbox.length > 200) outbox.shift();
      if (!config.isTest) log?.warn({ phone: maskPhone(phone), text }, 'sms_log_driver');
      return ok(null);
    },
  };
}

function nullDriver() {
  return { name: 'null', send: async () => ok(null) };
}

/**
 * Фиристодани SMS (35): драйвери асосӣ бо як такрори кӯтоҳ (танҳо хатои зуд),
 * баъд — захиравӣ (масалан AlifTech → SMS Gate). Дар sms_logs танҳо рақами пӯшида ва ҳолат.
 */
export class SmsService {
  constructor({ db, settings, config, log }) {
    this.db = db;
    this.settings = settings;
    this.config = config;
    this.log = log;
    this.outbox = [];
    this.override = null;
  }

  make(name) {
    switch (name) {
      case 'alif':
        return alifDriver(this.settings);
      case 'smsgate':
        return smsGateDriver(this.settings);
      case 'null':
        return nullDriver();
      default:
        return logDriver(this.config, this.outbox, this.log);
    }
  }

  /** Барои тестҳо. */
  useDrivers(primary, fallback = null) {
    this.override = { primary, fallback };
  }

  drivers() {
    if (this.override) return [this.override.primary, this.override.fallback].filter(Boolean);
    const primaryName = this.settings.get('sms_driver');
    const fallbackName = this.settings.get('sms_fallback_driver');
    const list = [this.make(primaryName)];
    if (fallbackName && fallbackName !== primaryName) list.push(this.make(fallbackName));
    return list;
  }

  async send(phone, text, template) {
    let result = failed('no_driver');
    let driverName = 'none';
    for (const [index, driver] of this.drivers().entries()) {
      if (index > 0) this.log?.warn({ from: driverName, to: driver.name }, 'sms_fallback');
      driverName = driver.name;
      result = await this.attempt(driver, phone, text, template);
      if (result.ok) break;
    }
    return { ...result, driver: driverName };
  }

  async attempt(driver, phone, text, template) {
    const started = Date.now();
    let result;
    try {
      result = await driver.send(phone, text);
      // Такрор танҳо барои хатои зуд — ҷавоби OTP бояд аз timeout-и Android (30 с) зудтар бошад.
      if (!result.ok && result.retryable && Date.now() - started < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        result = await driver.send(phone, text);
      }
    } catch (error) {
      result = failed(`exception_${error?.name ?? 'Error'}`);
    }
    const durationMs = Date.now() - started;

    await this.db
      .exec(
        `INSERT INTO sms_logs (id, phone_masked, template, driver, status, provider_id, error, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          uuidv7(),
          maskPhone(phone),
          template,
          driver.name,
          result.ok ? 'sent' : 'failed',
          result.providerId ? String(result.providerId).slice(0, 120) : null,
          result.error,
          durationMs,
        ],
      )
      .catch((error) => this.log?.warn({ code: error.code }, 'sms_log_failed'));

    if (!result.ok) {
      this.log?.error({ driver: driver.name, error: result.error, phone: maskPhone(phone), duration_ms: durationMs }, 'sms_send_failed');
    }
    return result;
  }
}
