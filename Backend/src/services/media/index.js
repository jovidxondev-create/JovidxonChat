import crypto from 'node:crypto';
import os from 'node:os';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { ApiError, fail } from '../../core/errors.js';
import { localeOf } from '../../core/http.js';
import { normalizeUuid, uuidv7 } from '../../core/ids.js';
import { cleanName } from '../../core/text.js';
import { presentMedia } from '../../presenters.js';
import { Users } from '../users.js';
import { detect } from './detect.js';
import { clampDuration, mp4Info, oggDuration } from './inspect.js';
import { stripMetadata } from './strip.js';

sharp.cache(false);
sharp.concurrency(Math.max(1, Math.min(2, os.availableParallelism?.() ?? 1)));

export const KINDS = ['image', 'video', 'voice', 'document'];
export const CHUNK_SIZE = 512 * 1024;
const THUMB_EDGE = 640;
const TAIL_SIZE = 65_536;

/** Номи файл танҳо барои намоиш (роҳ ва аломатҳои хатарнок хориҷ). */
export function safeFileName(name, extension) {
  let value = cleanName(String(name ?? '').replaceAll('\\', '/').split('/').pop() ?? '');
  value = value.replace(/[<>:"/\\|?*]/gu, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!value) return null;
  const chars = [...value];
  if (chars.length > 200) {
    const dot = value.lastIndexOf('.');
    const suffix = dot > 0 && value.length - dot <= 10 ? value.slice(dot) : `.${extension}`;
    value = chars.slice(0, 200 - [...suffix].length).join('') + suffix;
  }
  return value;
}

export function contentDisposition(type, fileName) {
  const ascii = fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'file';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** "bytes=0-99" | "bytes=100-" | "bytes=-500"; null — Range нодида; false — 416. */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (size <= 0) return false;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix <= 0) return false;
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || start > end) return false;
  return [start, end];
}

function mapMultipartError(error) {
  if (error instanceof ApiError) return error;
  switch (error?.code) {
    case 'FST_REQ_FILE_TOO_LARGE':
      return new ApiError('MEDIA_TOO_LARGE');
    case 'FST_INVALID_MULTIPART_CONTENT_TYPE':
      return fail.field('file', 'required');
    case 'FST_PARTS_LIMIT':
    case 'FST_FILES_LIMIT':
    case 'FST_FIELDS_LIMIT':
      return fail.field('file', 'length');
    default:
      return new ApiError('UPLOAD_FAILED');
  }
}

async function readLimited(stream, max) {
  const parts = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > max) throw new ApiError('MEDIA_TOO_LARGE');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

async function thumbnailFrom(input, { maxPixels = 60_000_000 } = {}) {
  try {
    const { data, info } = await sharp(input, { pages: 1, limitInputPixels: maxPixels, failOn: 'none' })
      .rotate()
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/**
 * Хатти лӯлаи медиа (11, 12, 34): upload → санҷиш (magic bytes, андоза, квота) → коркард →
 * нигоҳдорӣ дар PostgreSQL (қисмҳои 512 KB) → download бо авторизатсия, Range ва ETag.
 * Сурат бо сифати аслии камера нигоҳ дошта мешавад (метамаълумот бе фишурдани дубора пок мешавад).
 */
export class Media {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get db() {
    return this.ctx.db;
  }

  // ================================================================ дастрасӣ

  find(id) {
    return this.db.one("SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL AND status = 'ready'", [id]);
  }

  /** Кӣ медиаро дида метавонад: соҳиб; аъзои чати паём; расми профил (privacy); расми гурӯҳ; story. */
  async canView(media, viewerId) {
    if (media.owner_id === viewerId) return true;
    const viaChat = await this.db.value(
      `SELECT 1 FROM message_attachments a
       JOIN messages m ON m.id = a.message_id AND m.deleted_at IS NULL
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
       JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
       WHERE a.media_id = $1 LIMIT 1`,
      [media.id, viewerId],
    );
    if (viaChat) return true;
    const avatarOwner = await this.db.value("SELECT id FROM users WHERE avatar_media_id = $1 AND status = 'active' LIMIT 1", [
      media.id,
    ]);
    if (avatarOwner && (await this.ctx.users.canSeeAvatar(avatarOwner, viewerId))) return true;
    const groupAvatar = await this.db.value(
      `SELECT 1 FROM chat_groups g
       JOIN conversations c ON c.id = g.conversation_id AND c.deleted_at IS NULL
       JOIN conversation_members cm ON cm.conversation_id = g.conversation_id AND cm.user_id = $2
       WHERE g.avatar_media_id = $1 LIMIT 1`,
      [media.id, viewerId],
    );
    if (groupAvatar) return true;
    const stories = await this.db.many(
      'SELECT id, user_id, privacy FROM stories WHERE media_id = $1 AND deleted_at IS NULL AND expires_at > now()',
      [media.id],
    );
    for (const story of stories) {
      if (await this.ctx.stories.canView(story, viewerId)) return true;
    }
    return false;
  }

  /** Медиа барои паём/story: мавҷуд, намуди мувофиқ ва барои корбар дастрас (forward низ). */
  async requireUsable(mediaId, userId, expectedKind) {
    const media = await this.find(mediaId);
    if (!media || !(await this.canView(media, userId))) throw fail.notFound();
    if (expectedKind && media.kind !== expectedKind) throw fail.field('media_id', 'unsupported');
    return media;
  }

  async isReferenced(mediaId) {
    return (
      (await this.db.value(
        `SELECT 1 FROM message_attachments WHERE media_id = $1
         UNION ALL SELECT 1 FROM users WHERE avatar_media_id = $1
         UNION ALL SELECT 1 FROM chat_groups WHERE avatar_media_id = $1
         UNION ALL SELECT 1 FROM stories WHERE media_id = $1 AND deleted_at IS NULL
         LIMIT 1`,
        [mediaId],
      )) !== null
    );
  }

  // ================================================================ нигоҳдорӣ

  async writeChunk(mediaId, idx, data) {
    await this.db.exec('INSERT INTO media_chunks (media_id, idx, data) VALUES ($1, $2, $3)', [mediaId, idx, data]);
  }

  async writeBuffer(mediaId, buffer) {
    let idx = 0;
    for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
      await this.writeChunk(mediaId, idx++, buffer.subarray(offset, offset + CHUNK_SIZE));
    }
    return idx;
  }

  discard(mediaId) {
    return this.db.exec('DELETE FROM media_files WHERE id = $1', [mediaId]).catch(() => 0);
  }

  /** Хониши тасодуфӣ аз файли дар база (барои MP4). */
  reader(mediaId, size, chunkSize = CHUNK_SIZE) {
    const cache = new Map();
    const load = async (idx) => {
      if (!cache.has(idx)) {
        if (cache.size > 6) cache.delete(cache.keys().next().value);
        cache.set(idx, (await this.db.value('SELECT data FROM media_chunks WHERE media_id = $1 AND idx = $2', [mediaId, idx])) ?? Buffer.alloc(0));
      }
      return cache.get(idx);
    };
    return async (offset, length) => {
      if (offset >= size) return Buffer.alloc(0);
      const end = Math.min(size, offset + length);
      const parts = [];
      for (let pos = offset; pos < end; ) {
        const idx = Math.floor(pos / chunkSize);
        const chunk = await load(idx);
        const from = pos - idx * chunkSize;
        const take = Math.min(chunk.length - from, end - pos);
        if (take <= 0) break;
        parts.push(chunk.subarray(from, from + take));
        pos += take;
      }
      return Buffer.concat(parts);
    };
  }

  async *chunkStream(mediaId, start, end, chunkSize) {
    for (let idx = Math.floor(start / chunkSize); idx <= Math.floor(end / chunkSize); idx++) {
      const base = idx * chunkSize;
      const from = Math.max(start, base) - base;
      const to = Math.min(end, base + chunkSize - 1) - base;
      const data = await this.db.value('SELECT substring(data FROM $3 FOR $4) FROM media_chunks WHERE media_id = $1 AND idx = $2', [
        mediaId,
        idx,
        from + 1,
        to - from + 1,
      ]);
      if (!data) throw new Error('media_chunk_missing');
      yield data;
    }
  }

  // ================================================================ upload

  async processImage(buffer, mime) {
    let meta;
    try {
      meta = await sharp(buffer, { limitInputPixels: 268_402_689, failOn: 'error' }).metadata();
    } catch {
      throw new ApiError('MEDIA_TYPE_UNSUPPORTED');
    }
    if (!meta.width || !meta.height) throw new ApiError('MEDIA_TYPE_UNSUPPORTED');
    const pixels = meta.width * (meta.pageHeight ?? meta.height);
    if (pixels > 250_000_000) throw new ApiError('MEDIA_TOO_LARGE');

    let output = stripMetadata(buffer, mime);
    if (!output) {
      // Сохтори ғайриоддӣ — бо сифати баланд аз нав рамзгузорӣ (метамаълумот пок мешавад).
      try {
        const encoded = await sharp(buffer, { limitInputPixels: 100_000_000, animated: true })
          .rotate()
          .keepIccProfile()
          .toFormat(mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpeg', { quality: 92 })
          .toBuffer();
        output = { buffer: encoded, orientation: 1 };
      } catch {
        throw new ApiError('MEDIA_TYPE_UNSUPPORTED');
      }
    }
    const orientation = output.orientation ?? meta.orientation ?? 1;
    let width = meta.width;
    let height = meta.pageHeight && meta.pages > 1 ? meta.pageHeight : meta.height;
    if (orientation >= 5) [width, height] = [height, width];
    const thumb = await thumbnailFrom(output.buffer, { maxPixels: mime === 'image/jpeg' ? 268_402_689 : 60_000_000 });
    return { buffer: output.buffer, width, height, thumb };
  }

  /** Файлро аз multipart қисм ба қисм ба база менависад (сурат — пурра дар хотира барои коркард). */
  async storeStream(stream, kind, ownerId, originalName) {
    const limit = this.ctx.settings.mediaLimitBytes(kind);
    const hash = crypto.createHash('sha256');
    const pending = [];
    let pendingLength = 0;
    let total = 0;
    let idx = 0;
    let draft = null;
    let head = null;
    let tail = Buffer.alloc(0);

    const start = async (sample) => {
      const detected = await detect(sample, kind, originalName);
      if (detected.rejected) {
        this.ctx.log?.info({ kind, detected: detected.detected }, 'media_type_rejected');
        throw new ApiError('MEDIA_TYPE_UNSUPPORTED');
      }
      const id = uuidv7();
      await this.db.exec(
        `INSERT INTO media_files (id, owner_id, kind, status, mime_type, extension, original_name, chunk_size)
         VALUES ($1, $2, $3, 'uploading', $4, $5, $6, $7)`,
        [id, ownerId, kind, detected.mime, detected.extension, safeFileName(originalName, detected.extension), CHUNK_SIZE],
      );
      draft = { id, kind, mime: detected.mime, extension: detected.extension };
      head = Buffer.from(sample.subarray(0, TAIL_SIZE));
    };

    const flush = async (force) => {
      if (pendingLength === 0) return;
      let all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      pending.length = 0;
      while (all.length >= CHUNK_SIZE || (force && all.length > 0)) {
        const piece = all.subarray(0, CHUNK_SIZE);
        hash.update(piece);
        await this.writeChunk(draft.id, idx++, piece);
        all = all.subarray(piece.length);
      }
      if (all.length) pending.push(all);
      pendingLength = all.length;
    };

    try {
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > limit) throw new ApiError('MEDIA_TOO_LARGE');
        pending.push(chunk);
        pendingLength += chunk.length;
        tail = tail.length + chunk.length > TAIL_SIZE
          ? Buffer.concat([tail, chunk]).subarray(-TAIL_SIZE)
          : Buffer.concat([tail, chunk]);
        if (!draft && pendingLength >= CHUNK_SIZE) await start(Buffer.concat(pending));
        if (draft && kind !== 'image' && pendingLength >= CHUNK_SIZE) await flush(false);
      }
      if (stream.truncated) throw new ApiError('MEDIA_TOO_LARGE');
      if (total === 0) throw fail.field('file', 'required');
      if (!draft) await start(Buffer.concat(pending));

      if (kind === 'image') {
        const processed = await this.processImage(Buffer.concat(pending), draft.mime);
        pending.length = 0;
        pendingLength = 0;
        const chunks = await this.writeBuffer(draft.id, processed.buffer);
        return {
          ...draft,
          size: processed.buffer.length,
          sha256: crypto.createHash('sha256').update(processed.buffer).digest('hex'),
          chunks,
          width: processed.width,
          height: processed.height,
          thumb: processed.thumb,
          head,
          tail,
        };
      }
      await flush(true);
      return { ...draft, size: total, sha256: hash.digest('hex'), chunks: idx, width: null, height: null, thumb: null, head, tail };
    } catch (error) {
      if (draft) await this.discard(draft.id);
      throw error;
    }
  }

  /** Метамаълумоти видео/овоз, thumbnail-и клиент, квота → status = ready. */
  async finalize(stored, fields, clientThumb, ownerId) {
    let { width, height, thumb } = stored;
    let duration = null;
    const hint = /^\d{1,6}$/.test(fields.duration_seconds ?? '') ? Number(fields.duration_seconds) : null;

    if (stored.kind === 'voice' || stored.kind === 'video') {
      if (stored.mime.includes('ogg')) {
        duration = oggDuration(stored.head, stored.tail);
      } else if (/mp4|3gpp|quicktime/.test(stored.mime)) {
        const info = await mp4Info(this.reader(stored.id, stored.size), stored.size).catch(() => null);
        duration = info?.duration ?? null;
        if (stored.kind === 'video' && info?.width) {
          width = info.width;
          height = info.height;
        }
      }
      duration = clampDuration(duration ?? hint);
    }
    if (stored.kind === 'video') {
      if (!width && /^\d{1,5}$/.test(fields.width ?? '') && /^\d{1,5}$/.test(fields.height ?? '')) {
        width = Number(fields.width);
        height = Number(fields.height);
      }
      if (clientThumb?.length) thumb = await thumbnailFrom(clientThumb);
    }

    const quotaMb = this.ctx.settings.get('media_user_quota_mb');
    if (quotaMb > 0) {
      const usage = await this.db.value(
        "SELECT COALESCE(sum(size_bytes), 0) FROM media_files WHERE owner_id = $1 AND deleted_at IS NULL AND status = 'ready'",
        [ownerId],
      );
      if (Number(usage) + stored.size > quotaMb * 1024 * 1024) throw new ApiError('MEDIA_QUOTA_EXCEEDED');
    }

    await this.db.tx(async (tx) => {
      if (thumb) {
        await tx.exec('INSERT INTO media_thumbs (media_id, mime_type, width, height, data) VALUES ($1, $2, $3, $4, $5)', [
          stored.id,
          'image/jpeg',
          thumb.width,
          thumb.height,
          thumb.data,
        ]);
      }
      await tx.exec(
        `UPDATE media_files SET status = 'ready', size_bytes = $2, sha256 = $3, chunk_count = $4, width = $5, height = $6,
           duration_seconds = $7, has_thumb = $8 WHERE id = $1`,
        [stored.id, stored.size, stored.sha256, stored.chunks, width ?? null, height ?? null, duration, Boolean(thumb)],
      );
    });
    this.ctx.log?.info({ media_id: stored.id, kind: stored.kind, size: stored.size }, 'media_stored');
    return this.db.one('SELECT * FROM media_files WHERE id = $1', [stored.id]);
  }

  /** multipart: kind (пеш аз file), file, duration_seconds?, width?, height?, thumbnail? (постери видео). */
  async receive(request, ownerId, forcedKind = null) {
    if (!request.isMultipart()) throw fail.field('file', 'required');
    const maxAny = Math.max(...KINDS.map((kind) => this.ctx.settings.mediaLimitBytes(kind)));
    const fields = {};
    let stored = null;
    let clientThumb = null;
    try {
      const parts = request.parts({ limits: { fileSize: maxAny, files: 2, fields: 10, fieldSize: 2048, parts: 14 } });
      for await (const part of parts) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value ?? '').trim();
        } else if (part.fieldname === 'file' && !stored) {
          const kind = forcedKind ?? String(fields.kind ?? 'document').toLowerCase();
          if (!KINDS.includes(kind)) {
            part.file.resume();
            throw fail.field('kind', 'unsupported');
          }
          stored = await this.storeStream(part.file, kind, ownerId, part.filename);
        } else if (part.fieldname === 'thumbnail' && !clientThumb) {
          clientThumb = await readLimited(part.file, 5 * 1024 * 1024);
        } else {
          part.file.resume();
        }
      }
    } catch (error) {
      if (stored) await this.discard(stored.id);
      throw mapMultipartError(error);
    }
    if (!stored) throw fail.field('file', 'required');
    try {
      return await this.finalize(stored, fields, clientThumb, ownerId);
    } catch (error) {
      await this.discard(stored.id);
      throw error;
    }
  }

  /** POST /media */
  async upload(request) {
    const media = await this.receive(request, request.user.id);
    return { media: presentMedia(media) };
  }

  /** POST /me/avatar (multipart: file) */
  async uploadAvatar(request) {
    const me = request.user.id;
    const media = await this.receive(request, me, 'image');
    await this.ctx.users.update(me, { avatar_media_id: media.id });
    const user = await this.ctx.users.find(me);
    return { user: Users.presentSelf(user, localeOf(request)), media: presentMedia(media) };
  }

  // ================================================================ download

  /** Админ танҳо расми профил/гурӯҳ ва замимаи паёми шикоятшударо мебинад — на медиаи хусусии дигар. */
  async canAdminView(media) {
    return (
      (await this.db.value(
        `SELECT 1 FROM users WHERE avatar_media_id = $1
         UNION ALL SELECT 1 FROM chat_groups WHERE avatar_media_id = $1
         UNION ALL SELECT 1 FROM message_attachments a JOIN reports r ON r.target_message_id = a.message_id WHERE a.media_id = $1
         LIMIT 1`,
        [media.id],
      )) !== null
    );
  }

  async serve(request, reply, thumb, allowed = (media) => this.canView(media, request.user.id)) {
    const id = normalizeUuid(request.params.id);
    const media = id ? await this.find(id) : null;
    if (!media || !(await allowed(media))) throw fail.notFound();

    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    };

    if (thumb) {
      if (!media.has_thumb) throw fail.notFound();
      const etag = `"${String(media.sha256).slice(0, 32)}-t"`;
      if (String(request.headers['if-none-match'] ?? '').split(',').map((s) => s.trim()).includes(etag)) {
        return reply.code(304).headers({ ETag: etag, 'Cache-Control': baseHeaders['Cache-Control'] }).send();
      }
      const row = await this.db.one('SELECT mime_type, data FROM media_thumbs WHERE media_id = $1', [media.id]);
      if (!row) throw fail.notFound();
      return reply
        .code(200)
        .headers({ ...baseHeaders, ETag: etag, 'Content-Type': row.mime_type, 'Content-Disposition': contentDisposition('inline', 'thumb.jpg') })
        .send(row.data);
    }

    const size = Number(media.size_bytes);
    const etag = `"${String(media.sha256).slice(0, 32)}"`;
    const fileName = media.original_name ?? `file.${media.extension}`;
    const headers = {
      ...baseHeaders,
      ETag: etag,
      'Content-Type': media.mime_type,
      'Content-Disposition': contentDisposition(media.kind === 'document' ? 'attachment' : 'inline', fileName),
    };
    if (String(request.headers['if-none-match'] ?? '').split(',').map((s) => s.trim()).includes(etag)) {
      return reply.code(304).headers({ ETag: etag, 'Cache-Control': headers['Cache-Control'] }).send();
    }

    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = request.headers.range;
    const ifRange = request.headers['if-range'];
    if (range && (!ifRange || ifRange === etag)) {
      const parsed = parseRange(range, size);
      if (parsed === false) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      if (parsed) {
        [start, end] = parsed;
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
    }
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
    reply.code(status).headers(headers);
    if (request.method === 'HEAD' || size === 0) return reply.send();
    return reply.send(Readable.from(this.chunkStream(media.id, start, end, media.chunk_size)));
  }

  /** DELETE /media/:id — танҳо медиаи худ, ки ба ҷое пайваст нест. */
  async destroy(request) {
    const id = normalizeUuid(request.params.id);
    const media = id ? await this.db.one('SELECT id, owner_id FROM media_files WHERE id = $1 AND deleted_at IS NULL', [id]) : null;
    if (!media || media.owner_id !== request.user.id) throw fail.notFound();
    if (await this.isReferenced(media.id)) throw new ApiError('CONFLICT_VERSION');
    await this.db.exec('UPDATE media_files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [media.id]);
    return { deleted: true };
  }
}
