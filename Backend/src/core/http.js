import { ApiError } from './errors.js';
import { normalizeLocale } from './i18n.js';

/** Забон: Accept-Language (tk/tg → tk, ru) ё майдони locale дар бадан. */
export function localeOf(request) {
  const header = String(request.headers['accept-language'] ?? '').toLowerCase();
  if (header.startsWith('ru')) return 'ru';
  if (header.startsWith('tk') || header.startsWith('tg')) return 'tk';
  const bodyLocale = request.body && typeof request.body === 'object' ? request.body.locale : null;
  return normalizeLocale(bodyLocale);
}

export function deviceIdOf(request) {
  const value = request.headers['x-device-id'];
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{4,64}$/.test(value) ? value : null;
}

export function appVersionOf(request) {
  const value = request.headers['x-app-version'];
  return typeof value === 'string' && /^[A-Za-z0-9._+-]{1,32}$/.test(value) ? value : null;
}

export function userAgentOf(request) {
  return String(request.headers['user-agent'] ?? '').slice(0, 255);
}

export function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,4096})$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Суроғаи оммавии сервер (барои ҳалқаи даъват ва WebSocket). */
export function baseUrlOf(request, config) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(request.headers['x-forwarded-proto'] ?? request.protocol ?? 'http').split(',')[0].trim();
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? 'localhost').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export function userIdOf(request) {
  const id = request.user?.id;
  if (!id) throw new ApiError('AUTH_UNAUTHORIZED');
  return id;
}

/** Ҷавоби муваффақ (01): {success, message, data, errors}. */
export function ok(data) {
  return { success: true, message: 'OK', data, errors: [] };
}
