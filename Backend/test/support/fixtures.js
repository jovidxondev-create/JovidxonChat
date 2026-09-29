import sharp from 'sharp';

/** Файлҳои тестӣ дар хотира сохта мешаванд (дар repo файли бинарӣ нест). */

function oggPage(headerType, granule, payload) {
  const header = Buffer.alloc(28);
  header.write('OggS', 0, 'latin1');
  header[5] = headerType;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(1234, 14);
  header[26] = 1;
  header[27] = payload.length;
  return Buffer.concat([header, payload]);
}

/** OGG/Opus бо дарозии seconds (pre-skip 312). */
export function oggOpus(seconds = 5) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  const tags = Buffer.from('OpusTags\0\0\0\0\0\0\0\0', 'latin1');
  return Buffer.concat([
    oggPage(2, 0, head),
    oggPage(0, 0, tags),
    oggPage(0, 48000, Buffer.alloc(40, 1)),
    oggPage(4, 48000 * seconds + 312, Buffer.alloc(40, 2)),
  ]);
}

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/** MP4 бо moov дар охир (бе faststart): 7 с, 1280×720, гардиши 90°. */
export function mp4(rotated = true) {
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2avc1mp41', 'latin1'));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(7000, 16);
  const tkhd = Buffer.alloc(84);
  if (rotated) {
    tkhd.writeInt32BE(0, 40);
    tkhd.writeInt32BE(0x10000, 44);
  } else {
    tkhd.writeInt32BE(0x10000, 40);
  }
  tkhd.writeUInt32BE((1280 * 65536) >>> 0, 76);
  tkhd.writeUInt32BE((720 * 65536) >>> 0, 80);
  return Buffer.concat([ftyp, box('mdat', Buffer.alloc(700_000, 7)), box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd)))]);
}

/** JPEG бо EXIF (Make/Model), ориентатсияи 6 ва «Motion Photo»-и сохта баъд аз EOI. */
export async function jpegWithExif() {
  const base = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3366cc' } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: 'SecretPhoneMaker', Model: 'SecretModel-X' } })
    .toBuffer();
  return Buffer.concat([base, Buffer.from('ftypMOTIONPHOTOVIDEODATA-should-be-removed', 'latin1')]);
}

export async function pngWithText() {
  const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } })
    .png()
    .toBuffer();
  // tEXt chunk пеш аз IEND
  const text = Buffer.from('Comment\0GPS 38.5N 68.7E secret', 'latin1');
  const chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  text.copy(chunk, 8);
  const iend = png.length - 12;
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)]);
}

export function multipart(fields, files) {
  const boundary = `----jovidxon${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
