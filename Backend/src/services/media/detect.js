import { fileTypeFromBuffer } from 'file-type';

/**
 * Намуди файл аз magic bytes (11, 34) — на аз номи файл ва на аз Content-Type-и клиент.
 * Extension ҳамеша аз MIME муайян мешавад.
 */

// detected MIME → [MIME-и нигоҳдошта, extension]
const IMAGE = {
  'image/jpeg': ['image/jpeg', 'jpg'],
  'image/png': ['image/png', 'png'],
  'image/webp': ['image/webp', 'webp'],
  'image/gif': ['image/gif', 'gif'],
};

const VIDEO = {
  'video/mp4': ['video/mp4', 'mp4'],
  'video/x-m4v': ['video/mp4', 'mp4'],
  'video/3gpp': ['video/3gpp', '3gp'],
  'video/3gpp2': ['video/3gpp2', '3g2'],
  'video/quicktime': ['video/quicktime', 'mov'],
  'video/webm': ['video/webm', 'webm'],
  'video/x-matroska': ['video/x-matroska', 'mkv'],
  'video/matroska': ['video/x-matroska', 'mkv'],
};

const VOICE = {
  'audio/ogg': ['audio/ogg', 'ogg'],
  'application/ogg': ['audio/ogg', 'ogg'],
  'audio/opus': ['audio/ogg', 'ogg'],
  'audio/mp4': ['audio/mp4', 'm4a'],
  'audio/x-m4a': ['audio/mp4', 'm4a'],
  'audio/m4a': ['audio/mp4', 'm4a'],
  'video/mp4': ['audio/mp4', 'm4a'],
  'audio/aac': ['audio/aac', 'aac'],
  'audio/x-aac': ['audio/aac', 'aac'],
  'audio/mpeg': ['audio/mpeg', 'mp3'],
  'audio/webm': ['audio/webm', 'webm'],
  'video/webm': ['audio/webm', 'webm'],
  'audio/3gpp': ['audio/3gpp', '3gp'],
  'video/3gpp': ['audio/3gpp', '3gp'],
  'audio/amr': ['audio/amr', 'amr'],
  'audio/wav': ['audio/wav', 'wav'],
  'audio/x-wav': ['audio/wav', 'wav'],
  'audio/vnd.wave': ['audio/wav', 'wav'],
  'audio/flac': ['audio/flac', 'flac'],
  'audio/x-flac': ['audio/flac', 'flac'],
};

const DOCUMENT = {
  'application/pdf': ['application/pdf', 'pdf'],
  'application/zip': ['application/zip', 'zip'],
  'application/x-rar-compressed': ['application/vnd.rar', 'rar'],
  'application/vnd.rar': ['application/vnd.rar', 'rar'],
  'application/x-7z-compressed': ['application/x-7z-compressed', '7z'],
  'application/gzip': ['application/gzip', 'gz'],
  'application/x-tar': ['application/x-tar', 'tar'],
  'application/x-bzip2': ['application/x-bzip2', 'bz2'],
  'application/x-xz': ['application/x-xz', 'xz'],
  'application/rtf': ['application/rtf', 'rtf'],
  'text/rtf': ['application/rtf', 'rtf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xlsx',
  ],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
  'application/vnd.oasis.opendocument.text': ['application/vnd.oasis.opendocument.text', 'odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  'application/vnd.oasis.opendocument.presentation': ['application/vnd.oasis.opendocument.presentation', 'odp'],
  'application/epub+zip': ['application/epub+zip', 'epub'],
  'image/heic': ['image/heic', 'heic'],
  'image/heif': ['image/heif', 'heif'],
  'image/avif': ['image/avif', 'avif'],
  'image/bmp': ['image/bmp', 'bmp'],
  'image/tiff': ['image/tiff', 'tif'],
  'image/svg+xml': ['image/svg+xml', 'svg'],
  'text/plain': ['text/plain', 'txt'],
  'text/csv': ['text/csv', 'csv'],
  'application/json': ['application/json', 'json'],
  'application/xml': ['application/xml', 'xml'],
  'text/markdown': ['text/markdown', 'md'],
};

/** Ҳеҷ гоҳ қабул намешаванд (иҷрошаванда / скрипт / HTML / APK). */
const BLOCKED = new Set([
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-msi',
  'application/x-elf',
  'application/x-mach-binary',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/wasm',
  'application/x-sh',
  'text/html',
  'application/xhtml+xml',
  'application/x-httpd-php',
  'text/javascript',
  'application/javascript',
]);

// Документҳои OLE2 (doc/xls/ppt) ва номаълум: extension аз номи аслӣ, агар бехатар бошад.
const DANGEROUS_EXT = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'ps1', 'vbs', 'js', 'mjs', 'jar', 'apk', 'aab', 'sh', 'php', 'phtml',
  'html', 'htm', 'xhtml', 'svgz', 'hta', 'lnk', 'reg', 'cpl', 'jse', 'wsf',
]);

function textKind(sample) {
  if (sample.includes(0)) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(sample.subarray(0, 8192));
  // Бисёр аломатҳои иваз (�) — эҳтимол бинарӣ.
  const replacement = (text.match(/�/g) ?? []).length;
  if (replacement > 8) return null;
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 2048).toLowerCase();
  if (head.startsWith('<?php') || head.includes('<?php')) return 'application/x-httpd-php';
  if (head.startsWith('#!')) return 'application/x-sh';
  if (/<!doctype\s+html|<html[\s>]|<script[\s>]|<iframe[\s>]|<body[\s>]/.test(head)) return 'text/html';
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  if (head.startsWith('<?xml')) return 'application/xml';
  return 'text/plain';
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Намуди файлро аз аввалаш (≥ 4100 байт, беҳтараш 64 KB) муайян мекунад.
 * Бармегардонад {mime, extension} ё {rejected: true}.
 */
export async function detect(sample, kind, originalName) {
  // "audio/ogg; codecs=opus" → "audio/ogg"
  let detected = (await fileTypeFromBuffer(sample))?.mime?.split(';')[0].trim().toLowerCase() ?? null;
  const ext = extensionOf(originalName);

  if (detected === null) {
    detected = textKind(sample);
    if (detected === 'text/plain' && ext) {
      const byExt = { csv: 'text/csv', json: 'application/json', xml: 'application/xml', md: 'text/markdown' }[ext];
      if (byExt) detected = byExt;
    }
  }
  if (detected && BLOCKED.has(detected)) return { rejected: true, detected };

  const table = { image: IMAGE, video: VIDEO, voice: VOICE, document: { ...VOICE, ...VIDEO, ...IMAGE, ...DOCUMENT } }[kind];
  if (!table) return { rejected: true, detected };

  if (detected && table[detected]) {
    const [mime, extension] = table[detected];
    return { mime, extension };
  }
  if (kind === 'document') {
    // OLE2 (doc/xls/ppt/msg) ва форматҳои номаълуми бинарӣ — ҳамчун application/octet-stream.
    if (detected === null || detected === 'application/x-cfb') {
      const safeExt = ext && !DANGEROUS_EXT.has(ext) ? ext : 'bin';
      const oleMime = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' }[safeExt];
      return { mime: detected === 'application/x-cfb' && oleMime ? oleMime : 'application/octet-stream', extension: safeExt };
    }
    // Дигар форматҳои маълум (масалан шрифт, архивҳои дигар) — бе иҷро, ҳамчун бинарӣ.
    const safeExt = ext && !DANGEROUS_EXT.has(ext) ? ext : 'bin';
    return { mime: 'application/octet-stream', extension: safeExt };
  }
  return { rejected: true, detected };
}
