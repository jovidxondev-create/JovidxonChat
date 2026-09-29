/**
 * Клиенти API-и админ: cookie-и HttpOnly (браузер худаш мефиристад) + CSRF-токен дар сарлавҳа.
 * Ҳамаи дархостҳо ба ҳамон домен (/api/v1/admin) — бе CORS.
 */
let csrfToken = null;
const listeners = new Set();

export class ApiError extends Error {
  constructor(code, status, errors = [], messageKey = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.errors = errors;
    this.messageKey = messageKey;
  }

  fieldError(field) {
    return this.errors.find((e) => e.field === field) ?? null;
  }
}

export function onUnauthorized(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCsrf(token) {
  csrfToken = token;
}

export async function api(method, path, body, { quiet401 = false } = {}) {
  let response;
  try {
    response = await fetch(`/api/v1/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK', 0);
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok || !json?.success) {
    const error = new ApiError(json?.message ?? 'SERVER_ERROR', response.status, json?.errors ?? [], json?.message_key ?? null);
    if (response.status === 401 && !quiet401 && error.code === 'AUTH_UNAUTHORIZED' && error.messageKey !== 'error_admin_credentials') {
      for (const listener of listeners) listener();
    }
    throw error;
  }
  if (json.data?.csrf_token) csrfToken = json.data.csrf_token;
  return json.data;
}

export const get = (path, options) => api('GET', path, undefined, options);
export const post = (path, body = {}) => api('POST', path, body);
export const patch = (path, body = {}) => api('PATCH', path, body);
export const del = (path, body) => api('DELETE', path, body);

/** Матни хато барои корбар (i18n). */
export function errorText(t, error) {
  if (!(error instanceof ApiError)) return t('error_generic');
  if (error.messageKey && t(`err_${error.messageKey}`) !== `err_${error.messageKey}`) return t(`err_${error.messageKey}`);
  const key = `err_${error.code}`;
  const text = t(key);
  return text === key ? t('error_generic') : text;
}

export function fieldText(t, error, field) {
  const e = error instanceof ApiError ? error.fieldError(field) : null;
  if (!e) return null;
  const rule = String(e.code).replace(/^VALIDATION_/, '').toLowerCase();
  return t(`v_${rule}`);
}

export function formatBytes(bytes) {
  const n = Number(bytes ?? 0);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(value, lang) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(lang === 'ru' ? 'ru-RU' : 'ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value ?? 0));
}
