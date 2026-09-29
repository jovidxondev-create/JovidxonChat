import crypto from 'node:crypto';

// Аломатҳои идоравии C0/C1 (ба ҷуз \n ва \t).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
// Bidi-override ва аломатҳои ноаён (фиреби RTL дар ном ва номи файл).
const BIDI = /[‪-‮⁦-⁩‎‏﻿]/gu;

/** Тозакунии матни корбар бе тағйири маъно: \r\n → \n, аломатҳои идоравӣ хориҷ. */
export function clean(value, multiline = true) {
  let v = String(value).replace(/\r\n?/g, '\n').replace(CONTROL, '');
  if (!multiline) v = v.replace(/[\n\t]/g, ' ');
  return v;
}

/** Барои номҳо: як сатр, бе bidi, фосилаҳои такрорӣ як. */
export function cleanName(value) {
  return clean(value, false).replace(BIDI, '').replace(/\s{2,}/gu, ' ').trim();
}

export function length(value) {
  return [...String(value)].length;
}

export function truncate(value, max) {
  const chars = [...String(value)];
  if (chars.length <= max) return String(value);
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

/** Сатри яккатора барои пешнамоиш (рӯйхати чатҳо, ҷавоб, push). */
export function preview(value, max = 160) {
  return truncate(String(value ?? '').replace(/\s+/gu, ' ').trim(), max);
}

/** Барои LIKE/ILIKE: %, _ ва \ ҳамчун аломати оддӣ. */
export function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function randomToken(size, alphabet = TOKEN_ALPHABET) {
  let out = '';
  for (let i = 0; i < size; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function fromB64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  return Buffer.from(value, 'base64url');
}

/** +992901234567 → +992*****4567 (39). */
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return '';
  return `+${digits.slice(0, 3)}${'*'.repeat(digits.length - 7)}${digits.slice(-4)}`;
}

/** E.164: +992901234567. 00-и байналмилалӣ ба + табдил меёбад. */
export function normalizePhone(raw) {
  let value = String(raw ?? '').trim().replace(/[\s\-().\/]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

export function isValidUtf8(value) {
  // Сатрҳои JS ҳамеша UTF-16 ҳастанд; суррогатҳои танҳо = UTF-8-и вайрон дар манбаъ.
  return typeof value === 'string' && value.isWellFormed();
}
