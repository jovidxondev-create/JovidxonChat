/**
 * Пок кардани метамаълумот БЕ фишурдани дубора (сифати аслии камера нигоҳ дошта мешавад):
 * EXIF (GPS, модели телефон, вақт), XMP, IPTC, шарҳҳо ва маълумоти пинҳон баъд аз охири файл
 * (масалан видеои «Motion Photo»). Танҳо ориентатсия (барои намоиши дуруст) ва профили ранг мемонанд.
 */

function minimalExif(orientation) {
  // APP1 "Exif\0\0" + TIFF (big-endian) бо як тег: Orientation (0x0112) SHORT.
  const buf = Buffer.alloc(36);
  let o = 0;
  buf.writeUInt16BE(0xffe1, o); o += 2;
  buf.writeUInt16BE(34, o); o += 2;
  buf.write('Exif\0\0', o, 'latin1'); o += 6;
  buf.write('MM', o, 'latin1'); o += 2;
  buf.writeUInt16BE(0x002a, o); o += 2;
  buf.writeUInt32BE(8, o); o += 4;
  buf.writeUInt16BE(1, o); o += 2;
  buf.writeUInt16BE(0x0112, o); o += 2;
  buf.writeUInt16BE(3, o); o += 2;
  buf.writeUInt32BE(1, o); o += 4;
  buf.writeUInt16BE(orientation, o); o += 2;
  buf.writeUInt16BE(0, o); o += 2;
  buf.writeUInt32BE(0, o);
  return buf;
}

/** Orientation аз сегменти EXIF (APP1). */
function readExifOrientation(segment) {
  // segment: байтҳои баъд аз дарозӣ ("Exif\0\0" + TIFF)
  if (segment.length < 14 || segment.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const tiff = segment.subarray(6);
  const little = tiff.toString('latin1', 0, 2) === 'II';
  if (!little && tiff.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = (off) => (little ? tiff.readUInt16LE(off) : tiff.readUInt16BE(off));
  const u32 = (off) => (little ? tiff.readUInt32LE(off) : tiff.readUInt32BE(off));
  try {
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count && i < 512; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Маркери EOI-и тасвири асосиро меҷӯяд: FF00 — байти пуркардашуда, RSTn ва FF-и пуркунанда
 * гузаронида мешаванд; сегментҳои байни scan-ҳо (DHT, SOS-и progressive) бо дарозиашон.
 */
function findEoi(buffer, from) {
  let i = from;
  while (i < buffer.length - 1) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const next = buffer[i + 1];
    if (next === 0xff) {
      i += 1;
    } else if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      i += 2;
    } else if (next === 0xd9) {
      return i + 2;
    } else {
      if (i + 4 > buffer.length) return buffer.length;
      i += 2 + buffer.readUInt16BE(i + 2);
    }
  }
  return buffer.length;
}

export function stripJpeg(input) {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;
  const parts = [Buffer.from([0xff, 0xd8])];
  let orientation = 1;
  let insertAt = 1;
  let offset = 2;
  let sawScan = false;

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) return null;
    let marker = input[offset + 1];
    // Байтҳои пуркунандаи 0xFF
    while (marker === 0xff && offset + 2 < input.length) {
      offset += 1;
      marker = input[offset + 1];
    }
    if (marker === 0xd9) break;
    const length = input.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > input.length) return null;
    const segment = input.subarray(offset, offset + 2 + length);
    const payload = input.subarray(offset + 4, offset + 2 + length);

    if (marker === 0xda) {
      // SOS: баъд аз он маълумоти тасвир то EOI; ҳар чизе баъд аз EOI партофта мешавад.
      const end = findEoi(input, offset + 2 + length);
      parts.push(input.subarray(offset, end));
      if (input[end - 2] !== 0xff || input[end - 1] !== 0xd9) parts.push(Buffer.from([0xff, 0xd9]));
      sawScan = true;
      break;
    }

    let keep = true;
    if (marker === 0xe1) {
      const o = readExifOrientation(payload);
      if (o) orientation = o;
      keep = false; // EXIF/XMP
    } else if (marker === 0xe2) {
      keep = payload.toString('latin1', 0, 12) === 'ICC_PROFILE\0'; // MPF ва дигарон — не
    } else if (marker >= 0xe3 && marker <= 0xef && marker !== 0xee) {
      keep = false; // APP3..APP15 (IPTC/Photoshop, Ducky ва ғ.), APP14 (Adobe) мемонад
    } else if (marker === 0xfe) {
      keep = false; // COM
    }
    if (keep) {
      parts.push(segment);
      if (marker === 0xe0) insertAt = parts.length; // EXIF баъд аз JFIF
    }
    offset += 2 + length;
  }

  if (!sawScan) return null;
  if (orientation !== 1) parts.splice(insertAt, 0, minimalExif(orientation));
  return { buffer: Buffer.concat(parts), orientation };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'bKGD', 'pHYs', 'cICP',
  'acTL', 'fcTL', 'fdAT',
]);

export function stripPng(input) {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const parts = [PNG_SIGNATURE];
  let offset = 8;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > input.length) return null;
    if (PNG_KEEP.has(type)) parts.push(input.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  return { buffer: Buffer.concat(parts), orientation: 1 };
}

export function stripWebp(input) {
  if (input.length < 12 || input.toString('latin1', 0, 4) !== 'RIFF' || input.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunks = [];
  let offset = 12;
  const end = Math.min(input.length, 8 + input.readUInt32LE(4));
  while (offset + 8 <= end) {
    const fourcc = input.toString('latin1', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const padded = size + (size & 1);
    if (offset + 8 + size > input.length) return null;
    const chunk = Buffer.from(input.subarray(offset, Math.min(input.length, offset + 8 + padded)));
    if (fourcc === 'VP8X' && chunk.length >= 9) chunk[8] &= ~(0x08 | 0x04); // EXIF ва XMP flags
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') chunks.push(chunk);
    offset += 8 + padded;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return { buffer: Buffer.concat([header, body]), orientation: 1 };
}

export function stripMetadata(buffer, mime) {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(buffer);
    case 'image/png':
      return stripPng(buffer);
    case 'image/webp':
      return stripWebp(buffer);
    default:
      return { buffer, orientation: 1 };
  }
}
