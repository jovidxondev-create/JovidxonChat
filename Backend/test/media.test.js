import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { createTestEnv } from './support/env.js';
import { jpegWithExif, mp4, multipart, oggOpus, pngWithText } from './support/fixtures.js';

let env;
before(async () => {
  env = await createTestEnv('media');
});
after(async () => {
  await env?.close();
});

async function upload(session, kind, name, data, extra = {}, files = []) {
  const form = multipart({ kind, ...extra }, [{ field: 'file', name, data }, ...files]);
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/v1/media',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': form.contentType },
    payload: form.body,
  });
  return { status: res.statusCode, body: res.json() };
}

async function download(session, url, headers = {}) {
  const res = await env.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${session.token}`, ...headers } });
  return { status: res.statusCode, headers: res.headers, body: res.rawPayload };
}

describe('images keep camera quality but lose private metadata', () => {
  test('JPEG: EXIF/trailing data removed losslessly, orientation kept, thumbnail created', async () => {
    const a = await env.user('media_anna');
    const original = await jpegWithExif();
    const res = await upload(a, 'image', 'IMG_2026.jpg', original);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const media = res.body.data.media;
    assert.equal(media.type, 'image');
    assert.equal(media.mime_type, 'image/jpeg');
    assert.equal(media.file_name, 'IMG_2026.jpg');
    // Ориентатсияи 6 → андозаи намоишӣ 800×1200.
    assert.equal(media.width, 800);
    assert.equal(media.height, 1200);
    assert.equal(media.thumbnail_url, `/api/v1/media/${media.id}/thumb`);

    const file = await download(a, media.url);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/jpeg');
    assert.equal(file.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.match(file.headers['content-security-policy'], /sandbox/);
    const text = file.body.toString('latin1');
    assert.ok(!text.includes('SecretPhoneMaker'), 'EXIF Make must be removed');
    assert.ok(!text.includes('MOTIONPHOTO'), 'data after EOI must be removed');
    assert.equal((await sharp(file.body).metadata()).orientation, 6);
    // Бе фишурдани дубора: маълумоти тасвир (аз SOS то EOI) айнан ҳамон аст.
    const sos = (buf) => buf.subarray(buf.indexOf(Buffer.from([0xff, 0xda])), buf.lastIndexOf(Buffer.from([0xff, 0xd9])) + 2);
    assert.ok(sos(file.body).equals(sos(original.subarray(0, original.indexOf('ftypMOTION')))));

    const thumb = await download(a, media.thumbnail_url);
    assert.equal(thumb.status, 200);
    const thumbMeta = await sharp(thumb.body).metadata();
    assert.ok(thumbMeta.width <= 640 && thumbMeta.height <= 640);
    assert.equal(thumbMeta.width < thumbMeta.height, true, 'thumbnail is rotated upright');

    // Range ва ETag.
    const part = await download(a, media.url, { range: 'bytes=0-99' });
    assert.equal(part.status, 206);
    assert.equal(part.body.length, 100);
    assert.equal(part.headers['content-range'], `bytes 0-99/${media.size_bytes}`);
    const tail = await download(a, media.url, { range: 'bytes=-10' });
    assert.ok(tail.body.equals(file.body.subarray(-10)));
    const bad = await download(a, media.url, { range: `bytes=${media.size_bytes + 5}-` });
    assert.equal(bad.status, 416);
    const cached = await download(a, media.url, { 'if-none-match': file.headers.etag });
    assert.equal(cached.status, 304);
  });

  test('PNG text chunks are stripped', async () => {
    const a = await env.user('media_png');
    const res = await upload(a, 'image', 'screen.png', await pngWithText());
    assert.equal(res.status, 200);
    const file = await download(a, res.body.data.media.url);
    assert.ok(!file.body.toString('latin1').includes('GPS 38.5N'));
    assert.equal((await sharp(file.body).metadata()).width, 300);
  });

  test('fake image (text pretending to be .jpg) → 415; wrong kind → 422', async () => {
    const a = await env.user('media_fake');
    const fake = await upload(a, 'image', 'photo.jpg', Buffer.from('<?php echo "hi"; ?>'));
    assert.equal(fake.status, 415);
    assert.equal(fake.body.message, 'MEDIA_TYPE_UNSUPPORTED');
    const html = await upload(a, 'document', 'page.txt', Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>'));
    assert.equal(html.status, 415);
    const kind = await upload(a, 'sticker', 'x.png', Buffer.from('x'));
    assert.equal(kind.status, 422);
    const exe = await upload(a, 'document', 'setup.exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]));
    assert.equal(exe.status, 415);
  });

  test('size limits come from settings', async () => {
    const a = await env.user('media_big');
    await env.ctx.settings.update({ media_max_document_mb: 1 }, null);
    try {
      const big = await upload(a, 'document', 'big.bin', crypto.randomBytes(1024 * 1024 + 10));
      assert.equal(big.status, 413);
      assert.equal(big.body.message, 'MEDIA_TOO_LARGE');
      const rows = await env.db.value("SELECT count(*) FROM media_files WHERE status = 'uploading'");
      assert.equal(rows, 0, 'partial upload is cleaned up');
    } finally {
      await env.ctx.settings.update({ media_max_document_mb: null }, null);
    }
  });
});

describe('voice, video, documents', () => {
  test('voice OGG/Opus duration from file', async () => {
    const a = await env.user('media_voice');
    const res = await upload(a, 'voice', 'voice.ogg', oggOpus(5));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.media.mime_type, 'audio/ogg');
    assert.equal(res.body.data.media.duration_seconds, 5);
  });

  test('video: large file streamed in chunks, duration/size from moov at the end, client poster', async () => {
    const a = await env.user('media_video');
    const video = mp4(true);
    const poster = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#aa2200' } }).jpeg().toBuffer();
    const res = await upload(a, 'video', 'clip.mp4', video, { duration_seconds: '99' }, [
      { field: 'thumbnail', name: 'poster.jpg', data: poster, type: 'image/jpeg' },
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const media = res.body.data.media;
    assert.equal(media.duration_seconds, 7, 'duration from mvhd wins over the client hint');
    assert.equal(media.width, 720);
    assert.equal(media.height, 1280);
    assert.equal(media.size_bytes, video.length);
    assert.ok(media.thumbnail_url);
    const chunks = await env.db.value('SELECT chunk_count FROM media_files WHERE id = $1', [media.id]);
    assert.equal(chunks, Math.ceil(video.length / (512 * 1024)));
    const whole = await download(a, media.url);
    assert.ok(whole.body.equals(video));
    // Range аз байни ду қисм.
    const mid = await download(a, media.url, { range: 'bytes=524280-524300' });
    assert.ok(mid.body.equals(video.subarray(524280, 524301)));
  });

  test('document keeps a safe display name and is served as attachment', async () => {
    const a = await env.user('media_doc');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(3000)]);
    const res = await upload(a, 'document', '../../Ҳисобот 2026.pdf', pdf);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.media.file_name, 'Ҳисобот 2026.pdf');
    const file = await download(a, res.body.data.media.url);
    assert.match(file.headers['content-disposition'], /^attachment; filename=".+"; filename\*=UTF-8''/);
    const txt = await upload(a, 'document', 'notes.csv', Buffer.from('name,phone\nali,1\n'));
    assert.equal(txt.body.data.media.mime_type, 'text/csv');
  });
});

describe('media access control', () => {
  test('only chat members, avatar privacy and forwarding rules', async () => {
    const a = await env.user('acc_alice');
    const b = await env.user('acc_bob');
    const x = await env.user('acc_xavier');
    const img = (await upload(a, 'image', 'p.jpg', await jpegWithExif())).body.data.media;

    // Ҳанӯз ба ҳеҷ ҷо пайваст нест → танҳо соҳиб.
    assert.equal((await download(b, img.url)).status, 404);
    const chat = await env.openChat(a, b);
    const sent = await env.send(a, chat.id, 'расм', { type: 'image', media_id: img.id });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.message.attachment.id, img.id);
    assert.equal((await download(b, img.url)).status, 200);
    assert.equal((await download(x, img.url)).status, 404);
    // Намуди нодуруст.
    const wrongType = await env.send(a, chat.id, '', { type: 'video', media_id: img.id });
    assert.equal(wrongType.status, 422);
    // Forward: B медиаро дида метавонад → ба X фиристода метавонад; X аз B медиаи бегонаро не.
    const chatBX = await env.openChat(b, x);
    assert.equal((await env.send(b, chatBX.id, '', { type: 'image', media_id: img.id })).status, 200);
    assert.equal((await download(x, img.url)).status, 200);
    const other = (await upload(a, 'image', 'q.jpg', await jpegWithExif())).body.data.media;
    assert.equal((await env.send(x, chatBX.id, '', { type: 'image', media_id: other.id })).status, 404);
    // Медиаи пайвастшударо нест кардан мумкин нест.
    assert.equal((await env.api('DELETE', `/api/v1/media/${img.id}`, { token: a.token })).status, 409);
    assert.equal((await env.api('DELETE', `/api/v1/media/${other.id}`, { token: a.token })).status, 200);
  });

  test('avatar upload and privacy_avatar = nobody', async () => {
    const a = await env.user('avatar_alice');
    const b = await env.user('avatar_bob');
    const form = multipart({}, [{ field: 'file', name: 'me.jpg', data: await jpegWithExif() }]);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/me/avatar',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': form.contentType },
      payload: form.body,
    });
    assert.equal(res.statusCode, 200);
    const avatarUrl = res.json().data.user.avatar_url;
    assert.match(avatarUrl, /^\/api\/v1\/media\//);
    assert.equal((await download(b, avatarUrl)).status, 200);
    await env.api('PATCH', '/api/v1/me/settings', { token: a.token, body: { privacy_avatar: 'nobody' } });
    assert.equal((await download(b, avatarUrl)).status, 404);
    const profile = await env.api('GET', `/api/v1/users/${a.user.id}`, { token: b.token });
    assert.equal(profile.body.data.user.avatar_url, null);
  });
});
