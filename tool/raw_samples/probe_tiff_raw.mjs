import {createHash} from 'node:crypto';
import {
  lstat,
  open,
} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {sha256File} from '../dng_corpus/verify_dng_corpus.mjs';

const maximumIfdCount = 16;
const maximumEntriesPerIfd = 4096;
const defaultMaximumPreviewBytes = 8 * 1024 * 1024;

export class TiffRawProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TiffRawProbeError';
  }
}

function rangeFits(offset, length, totalLength) {
  return Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset <= totalLength &&
      length <= totalLength - offset;
}

function uint16(bytes, offset, littleEndian) {
  return littleEndian ?
    bytes.readUInt16LE(offset) :
    bytes.readUInt16BE(offset);
}

function uint32(bytes, offset, littleEndian) {
  return littleEndian ?
    bytes.readUInt32LE(offset) :
    bytes.readUInt32BE(offset);
}

function scalarValue(bytes, offset, type, count, littleEndian) {
  if (count !== 1) return null;
  if (type === 3) return uint16(bytes, offset, littleEndian);
  if (type === 4) return uint32(bytes, offset, littleEndian);
  return null;
}

async function readExact(handle, offset, length, totalLength) {
  if (!rangeFits(offset, length, totalLength)) {
    throw new TiffRawProbeError('TIFF read range is outside the file');
  }
  const bytes = Buffer.alloc(length);
  const {bytesRead} = await handle.read(bytes, 0, length, offset);
  if (bytesRead !== length) {
    throw new TiffRawProbeError('TIFF read ended before the requested range');
  }
  return bytes;
}

function appendCandidate(
    candidates,
    {
      offset,
      length,
      source,
      ifdOffset,
      width,
      height,
    },
    totalLength) {
  if (offset === null ||
      length === null ||
      length < 4 ||
      !rangeFits(offset, length, totalLength)) {
    return;
  }
  candidates.push({
    offset,
    length,
    source,
    ifdOffset,
    width,
    height,
  });
}

async function appendSubIfds(
    handle,
    pending,
    {
      type,
      count,
      value,
      scalar,
      littleEndian,
      totalLength,
    }) {
  if (type !== 4 || count < 1) return;
  if (count === 1) {
    if (scalar !== null && scalar > 0) pending.push(scalar);
    return;
  }
  const limitedCount = Math.min(count, maximumIfdCount);
  const byteLength = limitedCount * 4;
  if (!rangeFits(value, byteLength, totalLength)) return;
  const offsets = await readExact(
      handle,
      value,
      byteLength,
      totalLength);
  for (let index = 0; index < limitedCount; index += 1) {
    const offset = uint32(offsets, index * 4, littleEndian);
    if (offset > 0) pending.push(offset);
  }
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 1 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 ||
        marker === 0xd8 ||
        (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 ||
        offset + segmentLength > bytes.length) {
      return null;
    }
    const isStartOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (segmentLength < 7) return null;
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function sameFileState(before, after) {
  return before.isFile() &&
      after.isFile() &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      before.dev === after.dev &&
      before.ino === after.ino;
}

function formatFromExtension(filePath) {
  const extension = path.extname(filePath).slice(1).toUpperCase();
  return /^[A-Z0-9]{1,16}$/.test(extension) ? extension : 'UNKNOWN';
}

export async function probeTiffRaw(
    filePath,
    {
      maximumPreviewBytes = defaultMaximumPreviewBytes,
      signal,
    } = {}) {
  if (!Number.isSafeInteger(maximumPreviewBytes) ||
      maximumPreviewBytes < 4 ||
      maximumPreviewBytes > defaultMaximumPreviewBytes) {
    throw new TiffRawProbeError(
        'maximumPreviewBytes must be an integer from 4 through 8388608');
  }
  const absolutePath = path.resolve(filePath);
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new TiffRawProbeError(
        'RAW path must be a regular file, not a symbolic link');
  }
  if (!Number.isSafeInteger(before.size) || before.size < 16) {
    throw new TiffRawProbeError('RAW file is too short or too large');
  }
  const rawSha256 = await sha256File(absolutePath, {signal});
  const handle = await open(absolutePath, 'r');
  let result;
  try {
    const header = await readExact(handle, 0, 8, before.size);
    const littleEndian =
        header[0] === 0x49 &&
        header[1] === 0x49 &&
        header.readUInt16LE(2) === 42;
    const bigEndian =
        header[0] === 0x4d &&
        header[1] === 0x4d &&
        header.readUInt16BE(2) === 42;
    if (!littleEndian && !bigEndian) {
      throw new TiffRawProbeError(
          'RAW file is not a classic TIFF container');
    }
    const isLittleEndian = littleEndian;
    const pendingIfds = [uint32(header, 4, isLittleEndian)];
    const visitedIfds = new Set();
    const candidates = [];

    while (pendingIfds.length > 0 &&
        visitedIfds.size < maximumIfdCount) {
      if (signal?.aborted) throw signal.reason;
      const ifdOffset = pendingIfds.shift();
      if (!Number.isSafeInteger(ifdOffset) ||
          ifdOffset <= 0 ||
          visitedIfds.has(ifdOffset) ||
          !rangeFits(ifdOffset, 2, before.size)) {
        continue;
      }
      visitedIfds.add(ifdOffset);
      const countBytes = await readExact(
          handle,
          ifdOffset,
          2,
          before.size);
      const entryCount = uint16(countBytes, 0, isLittleEndian);
      if (entryCount < 1 || entryCount > maximumEntriesPerIfd) continue;
      const directoryLength = 2 + entryCount * 12 + 4;
      if (!rangeFits(ifdOffset, directoryLength, before.size)) continue;
      const directory = await readExact(
          handle,
          ifdOffset,
          directoryLength,
          before.size);

      let width = null;
      let height = null;
      let compression = null;
      let stripOffset = null;
      let stripLength = null;
      let jpegOffset = null;
      let jpegLength = null;

      for (let index = 0; index < entryCount; index += 1) {
        const entryOffset = 2 + index * 12;
        const tag = uint16(directory, entryOffset, isLittleEndian);
        const type = uint16(directory, entryOffset + 2, isLittleEndian);
        const count = uint32(directory, entryOffset + 4, isLittleEndian);
        const value = uint32(directory, entryOffset + 8, isLittleEndian);
        const scalar = scalarValue(
            directory,
            entryOffset + 8,
            type,
            count,
            isLittleEndian);
        if (tag === 0x0100) width = scalar;
        if (tag === 0x0101) height = scalar;
        if (tag === 0x0103) compression = scalar;
        if (tag === 0x0111) stripOffset = scalar;
        if (tag === 0x0117) stripLength = scalar;
        if (tag === 0x0201) jpegOffset = scalar;
        if (tag === 0x0202) jpegLength = scalar;
        if (tag === 0x014a) {
          await appendSubIfds(handle, pendingIfds, {
            type,
            count,
            value,
            scalar,
            littleEndian: isLittleEndian,
            totalLength: before.size,
          });
        }
        if (tag === 0x8769 && scalar !== null && scalar > 0) {
          pendingIfds.push(scalar);
        }
      }

      appendCandidate(candidates, {
        offset: jpegOffset,
        length: jpegLength,
        source: 'jpeg-interchange',
        ifdOffset,
        width,
        height,
      }, before.size);
      if (compression === 6) {
        appendCandidate(candidates, {
          offset: stripOffset,
          length: stripLength,
          source: 'jpeg-strip',
          ifdOffset,
          width,
          height,
        }, before.size);
      }
      const nextOffset = uint32(
          directory,
          2 + entryCount * 12,
          isLittleEndian);
      if (nextOffset > 0) pendingIfds.push(nextOffset);
    }

    candidates.sort((left, right) =>
      right.length - left.length || left.offset - right.offset);
    let preview = null;
    for (const candidate of candidates) {
      if (candidate.length > maximumPreviewBytes) continue;
      const bytes = await readExact(
          handle,
          candidate.offset,
          candidate.length,
          before.size);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;
      const dimensions = jpegDimensions(bytes);
      preview = {
        source: candidate.source,
        ifdOffset: candidate.ifdOffset,
        offset: candidate.offset,
        byteLength: candidate.length,
        width: dimensions?.width ??
          (candidate.width !== null && candidate.width > 0 ?
            candidate.width :
            null),
        height: dimensions?.height ??
          (candidate.height !== null && candidate.height > 0 ?
            candidate.height :
            null),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      break;
    }
    result = {
      schemaVersion: 1,
      status: 'ok',
      format: formatFromExtension(absolutePath),
      byteLength: before.size,
      sha256: rawSha256,
      container: {
        kind: 'classic-tiff',
        byteOrder: isLittleEndian ? 'little-endian' : 'big-endian',
      },
      ifdsVisited: visitedIfds.size,
      candidatesFound: candidates.length,
      preview,
    };
  } finally {
    await handle.close();
  }
  const after = await lstat(absolutePath);
  if (!sameFileState(before, after)) {
    throw new TiffRawProbeError(
        'RAW file changed while it was being probed');
  }
  return result;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length === 1 && argumentsList[0] === '--help') {
    console.log('usage: node probe_tiff_raw.mjs <TIFF-based RAW path>');
    return;
  }
  if (argumentsList.length !== 1) {
    throw new Error('exactly one TIFF-based RAW path is required');
  }
  const result = await probeTiffRaw(argumentsList[0]);
  console.log(JSON.stringify(result));
}

if (process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schemaVersion: 1,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
