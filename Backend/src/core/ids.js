import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let lastMs = 0;
let sequence = 0;

/**
 * UUIDv7 (RFC 9562): вақт-тартибнок (индекси B-tree-и хуб), пешгӯинашаванда (74 бит тасодуфӣ).
 * Дар як миллисония тартиб бо ҳисобгари 12-битӣ нигоҳ дошта мешавад.
 */
export function uuidv7() {
  let ms = Date.now();
  if (ms <= lastMs) {
    sequence = (sequence + 1) & 0x0fff;
    if (sequence === 0) lastMs += 1;
    ms = lastMs;
  } else {
    lastMs = ms;
    sequence = crypto.randomInt(0x0400);
  }

  const bytes = crypto.randomBytes(16);
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = (ms >>> 24) & 0xff;
  bytes[3] = (ms >>> 16) & 0xff;
  bytes[4] = (ms >>> 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((sequence >>> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** ID аз роҳ: нодуруст → null (хизматҳо 404 медиҳанд, мавҷудият ошкор намешавад). */
export function normalizeUuid(value) {
  return isUuid(value) ? value.toLowerCase() : null;
}
