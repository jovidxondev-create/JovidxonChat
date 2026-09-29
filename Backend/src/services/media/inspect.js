/**
 * Дарозӣ ва андозаи аудио/видео аз metadata — бе ffmpeg (34):
 * OGG (Opus/Vorbis): granule-и саҳифаи охирин; MP4/M4A/3GP/MOV: mvhd (дарозӣ) ва tkhd (андоза, гардиш).
 * read(offset, length) → Buffer — хониши тасодуфӣ аз файл (дар база).
 */

export function oggDuration(head, tail) {
  if (head.length < 4 || head.toString('latin1', 0, 4) !== 'OggS') return null;
  let rate = null;
  let preSkip = 0;
  const opus = head.indexOf('OpusHead', 0, 'latin1');
  const vorbis = head.indexOf('\x01vorbis', 0, 'latin1');
  if (opus >= 0 && head.length >= opus + 12) {
    rate = 48000;
    preSkip = head.readUInt16LE(opus + 10);
  } else if (vorbis >= 0 && head.length >= vorbis + 16) {
    rate = head.readUInt32LE(vorbis + 12);
  }
  if (!rate) return null;
  const last = tail.lastIndexOf('OggS', tail.length, 'latin1');
  if (last < 0 || tail.length < last + 14) return null;
  const granule = Number(tail.readBigInt64LE(last + 6));
  if (!(granule > 0)) return null;
  return Math.max(0, granule - preSkip) / rate;
}

async function findBox(read, start, end, type) {
  let offset = start;
  for (let guard = 0; offset + 8 <= end && guard < 10_000; guard++) {
    const header = await read(offset, 16);
    if (header.length < 8) return null;
    let size = header.readUInt32BE(0);
    const boxType = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) return null;
      size = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize) return null;
    if (boxType === type) return [offset + headerSize, Math.min(end, offset + size)];
    offset += size;
  }
  return null;
}

async function mvhdDuration(read, moov) {
  const box = await findBox(read, moov[0], moov[1], 'mvhd');
  if (!box) return null;
  const data = await read(box[0], 32);
  if (data.length < 20) return null;
  if (data[0] === 1) {
    if (data.length < 32) return null;
    const timescale = data.readUInt32BE(20);
    const duration = Number(data.readBigUInt64BE(24));
    return timescale > 0 ? duration / timescale : null;
  }
  const timescale = data.readUInt32BE(12);
  const duration = data.readUInt32BE(16);
  return timescale > 0 ? duration / timescale : null;
}

/** Андозаи track-и видеоӣ аз tkhd (16.16 fixed), бо назардошти гардиши 90°/270°. */
async function videoDimensions(read, moov) {
  let offset = moov[0];
  for (let guard = 0; guard < 16; guard++) {
    const trak = await findBox(read, offset, moov[1], 'trak');
    if (!trak) return null;
    const tkhd = await findBox(read, trak[0], trak[1], 'tkhd');
    if (tkhd) {
      const data = await read(tkhd[0], 92);
      const v1 = data[0] === 1;
      const matrixOffset = v1 ? 52 : 40;
      const sizeOffset = v1 ? 88 : 76;
      if (data.length >= sizeOffset + 8) {
        const width = Math.round(data.readUInt32BE(sizeOffset) / 65536);
        const height = Math.round(data.readUInt32BE(sizeOffset + 4) / 65536);
        if (width > 0 && height > 0) {
          const a = data.readInt32BE(matrixOffset);
          const b = data.readInt32BE(matrixOffset + 4);
          const rotated = a === 0 && Math.abs(b) === 65536;
          return rotated ? { width: height, height: width } : { width, height };
        }
      }
    }
    offset = trak[1];
  }
  return null;
}

export async function mp4Info(read, size) {
  const moov = await findBox(read, 0, size, 'moov');
  if (!moov) return { duration: null, width: null, height: null };
  const duration = await mvhdDuration(read, moov).catch(() => null);
  const dims = await videoDimensions(read, moov).catch(() => null);
  return { duration, width: dims?.width ?? null, height: dims?.height ?? null };
}

export function clampDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  return Math.max(0, Math.min(86_400, Math.round(seconds)));
}
