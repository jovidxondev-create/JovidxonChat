import { fail, fieldError } from './errors.js';
import { isUuid } from './ids.js';
import { clean, isValidUtf8, length, normalizePhone } from './text.js';

/**
 * Валидатсияи вуруд. Хатоҳо ҷамъ мешаванд ва якбора бо VALIDATION_FAILED (422) бармегарданд:
 * {field, code: VALIDATION_<RULE>, message_key: error_validation_<rule>}.
 * Қоидаҳо: required | length | format | unsupported | self.
 */
export class Validator {
  constructor(data) {
    this.data = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    this.errors = [];
  }

  static of(data) {
    return new Validator(data);
  }

  /** Майдон дар JSON ҳаст (ҳатто null). */
  present(field) {
    return Object.hasOwn(this.data, field);
  }

  /** Майдон ҳаст ва null нест. */
  has(field) {
    return this.present(field) && this.data[field] !== null && this.data[field] !== undefined;
  }

  raw(field) {
    return this.data[field];
  }

  fail(field, rule) {
    if (!this.errors.some((e) => e.field === field)) this.errors.push(fieldError(field, rule));
  }

  passes() {
    return this.errors.length === 0;
  }

  validate() {
    if (this.errors.length > 0) throw fail.validation(this.errors);
  }

  string(field, { required = false, min = 0, max = 255, pattern = null, multiline = false, trim = true } = {}) {
    if (!this.has(field)) {
      if (required) this.fail(field, 'required');
      return null;
    }
    let value = this.data[field];
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string' || !isValidUtf8(value)) {
      this.fail(field, 'format');
      return null;
    }
    value = clean(value, multiline);
    if (trim) value = value.trim();
    if (value === '') {
      if (required) {
        this.fail(field, 'required');
        return null;
      }
      return '';
    }
    const len = length(value);
    if (len < min || len > max) {
      this.fail(field, 'length');
      return null;
    }
    if (pattern && !pattern.test(value)) {
      this.fail(field, 'format');
      return null;
    }
    return value;
  }

  bool(field, { required = false } = {}) {
    if (!this.has(field)) {
      if (required) this.fail(field, 'required');
      return null;
    }
    const value = this.data[field];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === 0) return value === 1;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
    }
    this.fail(field, 'format');
    return null;
  }

  int(field, { required = false, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!this.has(field)) {
      if (required) this.fail(field, 'required');
      return null;
    }
    let value = this.data[field];
    if (typeof value === 'string' && /^-?\d{1,15}$/.test(value.trim())) value = Number(value.trim());
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      this.fail(field, 'format');
      return null;
    }
    if (value < min || value > max) {
      this.fail(field, 'length');
      return null;
    }
    return value;
  }

  enum(field, allowed, { required = false } = {}) {
    if (!this.has(field)) {
      if (required) this.fail(field, 'required');
      return null;
    }
    const value = this.data[field];
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : null;
    if (normalized === null || !allowed.includes(normalized)) {
      this.fail(field, 'unsupported');
      return null;
    }
    return normalized;
  }

  uuid(field, { required = false } = {}) {
    if (!this.has(field)) {
      if (required) this.fail(field, 'required');
      return null;
    }
    const value = this.data[field];
    if (!isUuid(value)) {
      this.fail(field, 'format');
      return null;
    }
    return value.toLowerCase();
  }

  uuidList(field, { max = 100, required = false } = {}) {
    if (!this.has(field)) {
      if (required) this.fail(field, 'required');
      return [];
    }
    const value = this.data[field];
    if (!Array.isArray(value)) {
      this.fail(field, 'format');
      return [];
    }
    if (value.length > max) {
      this.fail(field, 'length');
      return [];
    }
    const ids = new Set();
    for (const item of value) {
      if (!isUuid(item)) {
        this.fail(field, 'format');
        return [];
      }
      ids.add(item.toLowerCase());
    }
    if (required && ids.size === 0) this.fail(field, 'required');
    return [...ids];
  }

  phone(field, { required = true } = {}) {
    const raw = this.string(field, { required, min: 1, max: 32 });
    if (raw === null || raw === '') {
      if (raw === '' && required) this.fail(field, 'required');
      return null;
    }
    const phone = normalizePhone(raw);
    if (phone === null) this.fail(field, 'format');
    return phone;
  }
}

/** Параметрҳои query: адади бутун бо ҳудуд ё пешфарз. */
export function queryInt(query, name, fallback, min, max) {
  const raw = query?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^-?\d{1,15}$/.test(String(raw))) return fallback;
  return Math.min(max, Math.max(min, Number(raw)));
}

export function queryNullableInt(query, name) {
  const raw = query?.[name];
  if (raw === undefined || raw === null || raw === '' || !/^\d{1,15}$/.test(String(raw))) return null;
  return Number(raw);
}

export function queryBool(query, name) {
  const raw = String(query?.[name] ?? '').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}
