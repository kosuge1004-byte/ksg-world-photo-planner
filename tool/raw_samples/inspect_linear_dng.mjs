import {open, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const typeSizes = new Map([
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [10, 8],
  [13, 4],
]);

async function readExact(handle, offset, length, fileSize) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset + length > fileSize) {
    throw new Error(`read outside file: offset=${offset}, length=${length}`);
  }
  const bytes = Buffer.alloc(length);
  const {bytesRead} = await handle.read(bytes, 0, length, offset);
  if (bytesRead !== length) throw new Error('short DNG read');
  return bytes;
}

async function readIfd(handle, offset, fileSize) {
  const countBytes = await readExact(handle, offset, 2, fileSize);
  const count = countBytes.readUInt16LE(0);
  if (count < 1 || count > 4096) throw new Error(`invalid IFD count: ${count}`);
  const directory = await readExact(handle, offset + 2, count * 12 + 4, fileSize);
  const tags = new Map();
  for (let index = 0; index < count; index += 1) {
    const entryOffset = index * 12;
    const tag = directory.readUInt16LE(entryOffset);
    const type = directory.readUInt16LE(entryOffset + 2);
    const valueCount = directory.readUInt32LE(entryOffset + 4);
    const valueOffset = directory.readUInt32LE(entryOffset + 8);
    tags.set(tag, {
      tag,
      type,
      count: valueCount,
      valueOffset,
      inline: Buffer.from(directory.subarray(entryOffset + 8, entryOffset + 12)),
    });
  }
  return {
    offset,
    tags,
    nextOffset: directory.readUInt32LE(count * 12),
  };
}

async function tagBytes(handle, entry, fileSize) {
  const typeSize = typeSizes.get(entry.type);
  if (typeSize === undefined) throw new Error(`unsupported TIFF type ${entry.type}`);
  const byteLength = typeSize * entry.count;
  return byteLength <= 4 ? entry.inline.subarray(0, byteLength) :
    readExact(handle, entry.valueOffset, byteLength, fileSize);
}

async function tagValues(handle, ifd, tag, fileSize) {
  const entry = ifd.tags.get(tag);
  if (entry === undefined) throw new Error(`missing required TIFF tag ${tag}`);
  const bytes = await tagBytes(handle, entry, fileSize);
  const values = [];
  for (let index = 0; index < entry.count; index += 1) {
    const offset = index * (typeSizes.get(entry.type) ?? 0);
    switch (entry.type) {
      case 1:
      case 2:
        values.push(bytes[offset]);
        break;
      case 3:
        values.push(bytes.readUInt16LE(offset));
        break;
      case 4:
      case 13:
        values.push(bytes.readUInt32LE(offset));
        break;
      case 5:
        values.push(bytes.readUInt32LE(offset) / bytes.readUInt32LE(offset + 4));
        break;
      case 10:
        values.push(bytes.readInt32LE(offset) / bytes.readInt32LE(offset + 4));
        break;
      default:
        throw new Error(`unsupported TIFF type ${entry.type}`);
    }
  }
  return values;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function requireArray(actual, expected, label) {
  if (actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function inspectLinearDng(filePath) {
  const absolutePath = path.resolve(filePath);
  const fileState = await stat(absolutePath);
  const handle = await open(absolutePath, 'r');
  try {
    const header = await readExact(handle, 0, 8, fileState.size);
    requireEqual(header.toString('ascii', 0, 2), 'II', 'byte order');
    requireEqual(header.readUInt16LE(2), 42, 'classic TIFF magic');
    const ifd0 = await readIfd(handle, header.readUInt32LE(4), fileState.size);
    const one = async (tag) => (await tagValues(handle, ifd0, tag, fileState.size))[0];
    const width = await one(256);
    const height = await one(257);
    requireArray(await tagValues(handle, ifd0, 258, fileState.size), [32, 32, 32], 'BitsPerSample');
    requireEqual(await one(259), 1, 'Compression');
    requireEqual(await one(262), 34892, 'PhotometricInterpretation');
    requireEqual(await one(274), 1, 'Orientation');
    requireEqual(await one(277), 3, 'SamplesPerPixel');
    requireEqual(await one(284), 1, 'PlanarConfiguration');
    requireArray(await tagValues(handle, ifd0, 339, fileState.size), [3, 3, 3], 'SampleFormat');
    requireArray(await tagValues(handle, ifd0, 50706, fileState.size), [1, 4, 0, 0], 'DNGVersion');
    requireArray(await tagValues(handle, ifd0, 50707, fileState.size), [1, 4, 0, 0], 'DNGBackwardVersion');

    const stripOffsets = await tagValues(handle, ifd0, 273, fileState.size);
    const stripByteCounts = await tagValues(handle, ifd0, 279, fileState.size);
    requireEqual(stripOffsets.length, stripByteCounts.length, 'strip array count');
    const expectedRgbBytes = width * height * 3 * 4;
    requireEqual(stripByteCounts.reduce((sum, value) => sum + value, 0), expectedRgbBytes, 'RGB byte count');

    const channelMin = [Infinity, Infinity, Infinity];
    const channelMax = [-Infinity, -Infinity, -Infinity];
    const channelSum = [0, 0, 0];
    let finiteSamples = 0;
    let negativeSamples = 0;
    let aboveOneSamples = 0;
    let zeroSamples = 0;
    for (let strip = 0; strip < stripOffsets.length; strip += 1) {
      const bytes = await readExact(
          handle, stripOffsets[strip], stripByteCounts[strip], fileState.size);
      const samples = new Float32Array(
          bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index];
        if (!Number.isFinite(value)) throw new Error(`non-finite RGB sample at strip ${strip}, index ${index}`);
        const channel = index % 3;
        if (value < channelMin[channel]) channelMin[channel] = value;
        if (value > channelMax[channel]) channelMax[channel] = value;
        channelSum[channel] += value;
        finiteSamples += 1;
        if (value < 0) negativeSamples += 1;
        if (value > 1) aboveOneSamples += 1;
        if (value === 0) zeroSamples += 1;
      }
    }
    requireEqual(finiteSamples, width * height * 3, 'finite RGB sample count');

    const subIfdOffsets = await tagValues(handle, ifd0, 330, fileState.size);
    let maskIfd;
    let thumbnailIfd;
    for (const subIfdOffset of subIfdOffsets) {
      const child = await readIfd(handle, subIfdOffset, fileState.size);
      const newSubFileType =
          (await tagValues(handle, child, 254, fileState.size))[0];
      if (newSubFileType === 4 && maskIfd === undefined) maskIfd = child;
      else if (newSubFileType === 1 && thumbnailIfd === undefined) {
        thumbnailIfd = child;
      } else {
        throw new Error(`unexpected or duplicate SubIFD type ${newSubFileType}`);
      }
    }
    if (maskIfd === undefined) throw new Error('missing transparency-mask SubIFD');
    const maskOne = async (tag) => (await tagValues(handle, maskIfd, tag, fileState.size))[0];
    requireEqual(await maskOne(254), 4, 'mask NewSubFileType');
    requireEqual(await maskOne(256), width, 'mask width');
    requireEqual(await maskOne(257), height, 'mask height');
    requireEqual(await maskOne(258), 8, 'mask BitsPerSample');
    requireEqual(await maskOne(259), 1, 'mask Compression');
    requireEqual(await maskOne(262), 4, 'mask PhotometricInterpretation');
    requireEqual(await maskOne(277), 1, 'mask SamplesPerPixel');
    const maskOffset = await maskOne(273);
    const maskByteCount = await maskOne(279);
    requireEqual(maskByteCount, width * height, 'mask byte count');
    const mask = await readExact(handle, maskOffset, maskByteCount, fileState.size);
    let validPixels = 0;
    let transparentPixels = 0;
    for (const value of mask) {
      if (value === 255) validPixels += 1;
      else if (value === 0) transparentPixels += 1;
      else throw new Error(`non-binary transparency value ${value}`);
    }

    let thumbnail;
    if (thumbnailIfd !== undefined) {
      requireEqual(ifd0.nextOffset, thumbnailIfd.offset, 'main NextIFD thumbnail link');
      const thumbnailOne = async (tag) =>
        (await tagValues(handle, thumbnailIfd, tag, fileState.size))[0];
      const thumbnailWidth = await thumbnailOne(256);
      const thumbnailHeight = await thumbnailOne(257);
      if (thumbnailWidth < 1 || thumbnailWidth > 512 ||
          thumbnailHeight < 1 || thumbnailHeight > 512) {
        throw new Error(`invalid thumbnail dimensions ${thumbnailWidth}x${thumbnailHeight}`);
      }
      requireArray(
          await tagValues(handle, thumbnailIfd, 258, fileState.size),
          [8, 8, 8], 'thumbnail BitsPerSample');
      requireEqual(await thumbnailOne(259), 1, 'thumbnail Compression');
      requireEqual(await thumbnailOne(262), 2, 'thumbnail PhotometricInterpretation');
      requireEqual(await thumbnailOne(277), 3, 'thumbnail SamplesPerPixel');
      requireEqual(await thumbnailOne(284), 1, 'thumbnail PlanarConfiguration');
      const thumbnailOffset = await thumbnailOne(273);
      const thumbnailByteCount = await thumbnailOne(279);
      requireEqual(
          thumbnailByteCount, thumbnailWidth * thumbnailHeight * 3,
          'thumbnail byte count');
      if (thumbnailOffset + thumbnailByteCount > Math.min(...stripOffsets)) {
        throw new Error('thumbnail pixels are not header-resident');
      }
      const thumbnailBytes = await readExact(
          handle, thumbnailOffset, thumbnailByteCount, fileState.size);
      let minimumSample = 255;
      let maximumSample = 0;
      for (const value of thumbnailBytes) {
        if (value < minimumSample) minimumSample = value;
        if (value > maximumSample) maximumSample = value;
      }
      thumbnail = {
        ifdOffset: thumbnailIfd.offset,
        dataOffset: thumbnailOffset,
        width: thumbnailWidth,
        height: thumbnailHeight,
        byteLength: thumbnailByteCount,
        minimumSample,
        maximumSample,
      };
    } else {
      requireEqual(ifd0.nextOffset, 0, 'main NextIFD without thumbnail');
    }

    const modelBytes = await tagBytes(handle, ifd0.tags.get(50708), fileState.size);
    const model = modelBytes.subarray(0, modelBytes.indexOf(0)).toString('utf8');
    const baselineExposure = (await tagValues(handle, ifd0, 50730, fileState.size))[0];
    const rgbDataEnd = Math.max(...stripOffsets.map(
        (offset, index) => offset + stripByteCounts[index]));
    const maskDataEnd = maskOffset + maskByteCount;
    requireEqual(maskDataEnd, fileState.size, 'file end after transparency mask');

    return {
      status: 'ok',
      file: absolutePath,
      byteLength: fileState.size,
      width,
      height,
      uniqueCameraModel: model,
      baselineExposureEv: baselineExposure,
      rgb: {
        strips: stripOffsets.length,
        byteLength: expectedRgbBytes,
        dataEndOffset: rgbDataEnd,
        finiteSamples,
        negativeSamples,
        aboveOneSamples,
        zeroSamples,
        channelMin,
        channelMax,
        channelMean: channelSum.map((sum) => sum / (width * height)),
      },
      transparencyMask: {
        ifdOffset: maskIfd.offset,
        dataOffset: maskOffset,
        byteLength: maskByteCount,
        validPixels,
        transparentPixels,
      },
      thumbnail,
    };
  } finally {
    await handle.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('usage: node inspect_linear_dng.mjs <path>');
  console.log(JSON.stringify(await inspectLinearDng(args[0]), null, 2));
}

if (process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({status: 'error', message: String(error)}));
    process.exitCode = 1;
  });
}

export {inspectLinearDng};
