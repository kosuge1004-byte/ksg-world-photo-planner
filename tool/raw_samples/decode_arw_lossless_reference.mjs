import {createHash} from 'node:crypto';
import {
  lstat,
  open,
} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const maximumIfdCount = 16;
const maximumEntriesPerIfd = 4096;
const maximumTileCount = 4096;
const maximumCompressedTileBytes = 8 * 1024 * 1024;
const defaultMaximumPixelCount = 64_000_000;

export class ArwLosslessReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArwLosslessReferenceError';
  }
}

function fail(message) {
  throw new ArwLosslessReferenceError(message);
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

function typeSize(type) {
  if ([1, 2, 6, 7].includes(type)) return 1;
  if ([3, 8].includes(type)) return 2;
  if ([4, 9, 11, 13].includes(type)) return 4;
  if ([5, 10, 12].includes(type)) return 8;
  return 0;
}

async function readExact(handle, offset, length, totalLength) {
  if (!rangeFits(offset, length, totalLength)) {
    fail('ARW read range is outside the file');
  }
  const bytes = Buffer.alloc(length);
  const {bytesRead} = await handle.read(bytes, 0, length, offset);
  if (bytesRead !== length) fail('ARW read ended early');
  return bytes;
}

async function entryUnsignedValues(
    handle,
    entry,
    littleEndian,
    totalLength,
    maximumCount = 4096) {
  const size = typeSize(entry.type);
  if (![1, 3, 4, 13].includes(entry.type) ||
      size === 0 ||
      entry.count > maximumCount) {
    return null;
  }
  const byteLength = size * entry.count;
  if (!Number.isSafeInteger(byteLength)) return null;
  let bytes;
  if (byteLength <= 4) {
    bytes = entry.raw.subarray(8, 8 + byteLength);
  } else {
    if (!rangeFits(entry.value, byteLength, totalLength)) return null;
    bytes = await readExact(
        handle,
        entry.value,
        byteLength,
        totalLength);
  }
  const values = [];
  for (let index = 0; index < entry.count; index += 1) {
    const offset = index * size;
    if (entry.type === 1) {
      values.push(bytes[offset]);
    } else if (entry.type === 3) {
      values.push(uint16(bytes, offset, littleEndian));
    } else {
      values.push(uint32(bytes, offset, littleEndian));
    }
  }
  return values;
}

async function entrySignedShortValues(
    handle,
    entry,
    littleEndian,
    totalLength,
    maximumCount = 4096) {
  if (entry?.type !== 8 ||
      entry.count > maximumCount) {
    return null;
  }
  const byteLength = 2 * entry.count;
  let bytes;
  if (byteLength <= 4) {
    bytes = entry.raw.subarray(8, 8 + byteLength);
  } else {
    if (!rangeFits(entry.value, byteLength, totalLength)) return null;
    bytes = await readExact(
        handle,
        entry.value,
        byteLength,
        totalLength);
  }
  const values = [];
  for (let index = 0; index < entry.count; index += 1) {
    const offset = index * 2;
    values.push(littleEndian ?
      bytes.readInt16LE(offset) :
      bytes.readInt16BE(offset));
  }
  return values;
}

function normalizedCameraWhiteBalance(levels) {
  if (levels?.length !== 4 ||
      levels.some((value) => value <= 0)) {
    return null;
  }
  const green = (levels[1] + levels[2]) / 2;
  if (!Number.isFinite(green) || green <= 0) return null;
  return levels.map((value) => value / green);
}

function cfaPattern(values) {
  const key = values?.join(',');
  if (key === '0,1,1,2') return {name: 'RGGB', offsets: [[0, 0], [1, 0], [0, 1], [1, 1]]};
  return null;
}

async function parseSensorIfd(handle, totalLength) {
  const header = await readExact(handle, 0, 8, totalLength);
  const littleEndian =
      header[0] === 0x49 &&
      header[1] === 0x49 &&
      header.readUInt16LE(2) === 42;
  const bigEndian =
      header[0] === 0x4d &&
      header[1] === 0x4d &&
      header.readUInt16BE(2) === 42;
  if (!littleEndian && !bigEndian) {
    fail('ARW is not a classic TIFF container');
  }
  const isLittleEndian = littleEndian;
  const firstIfd = uint32(header, 4, isLittleEndian);
  const pending = [firstIfd];
  const enqueued = new Set([firstIfd]);
  const visited = new Set();
  let inheritedOrientation = 1;
  let inheritedSonyCurve = null;
  let best = null;

  const appendIfd = (offset) => {
    if (offset <= 0 || enqueued.has(offset)) return;
    if (enqueued.size >= maximumIfdCount) {
      fail('ARW IFD count exceeds the safety limit');
    }
    enqueued.add(offset);
    pending.push(offset);
  };

  while (pending.length > 0) {
    const ifdOffset = pending.shift();
    if (!Number.isSafeInteger(ifdOffset) ||
        ifdOffset <= 0 ||
        visited.has(ifdOffset) ||
        !rangeFits(ifdOffset, 2, totalLength)) {
      continue;
    }
    visited.add(ifdOffset);
    const countBytes = await readExact(handle, ifdOffset, 2, totalLength);
    const entryCount = uint16(countBytes, 0, isLittleEndian);
    if (entryCount < 1 || entryCount > maximumEntriesPerIfd) {
      fail('ARW IFD entry count exceeds the safety limit');
    }
    const directoryLength = 2 + entryCount * 12 + 4;
    const directory = await readExact(
        handle,
        ifdOffset,
        directoryLength,
        totalLength);
    const entries = new Map();
    for (let index = 0; index < entryCount; index += 1) {
      const offset = 2 + index * 12;
      const raw = directory.subarray(offset, offset + 12);
      const entry = {
        tag: uint16(raw, 0, isLittleEndian),
        type: uint16(raw, 2, isLittleEndian),
        count: uint32(raw, 4, isLittleEndian),
        value: uint32(raw, 8, isLittleEndian),
        raw,
      };
      entries.set(entry.tag, entry);
    }

    const values = async (tag, maximumCount = 4096) => {
      const entry = entries.get(tag);
      if (entry === undefined) return null;
      return entryUnsignedValues(
          handle,
          entry,
          isLittleEndian,
          totalLength,
          maximumCount);
    };
    const scalar = async (tag) => (await values(tag, 1))?.[0] ?? null;
    const orientation = await scalar(0x0112);
    if (orientation !== null && orientation >= 1 && orientation <= 8) {
      inheritedOrientation = orientation;
    }
    const sonyCurveValues = await values(0x7010, 4);
    if (sonyCurveValues !== null) {
      if (sonyCurveValues.length !== 4) fail('Sony curve must have 4 values');
      inheritedSonyCurve = sonyCurveValues.map((value) =>
        (value >> 2) & 0x0fff);
    }

    const subIfds = await values(0x014a, maximumIfdCount);
    for (const offset of subIfds ?? []) {
      appendIfd(offset);
    }
    const exifIfd = await scalar(0x8769);
    if (exifIfd !== null) appendIfd(exifIfd);
    const nextIfd = uint32(
        directory,
        2 + entryCount * 12,
        isLittleEndian);
    appendIfd(nextIfd);

    const width = await scalar(0x0100);
    const height = await scalar(0x0101);
    const bitsPerSample = await scalar(0x0102);
    const compression = await scalar(0x0103);
    const photometric = await scalar(0x0106);
    const samplesPerPixel = (await scalar(0x0115)) ?? 1;
    const stripOffsets = await values(0x0111, maximumTileCount);
    const rowsPerStrip = await scalar(0x0116);
    const stripByteCounts = await values(0x0117, maximumTileCount);
    const tileWidth = await scalar(0x0142);
    const tileHeight = await scalar(0x0143);
    const tileOffsets = await values(0x0144, maximumTileCount);
    const tileByteCounts = await values(0x0145, maximumTileCount);
    const repeat = await values(0x828d, 2);
    const patternValues = await values(0x828e, 4);
    const pattern = cfaPattern(patternValues);
    if (width === null ||
        height === null ||
        bitsPerSample === null ||
        ![7, 32767].includes(compression) ||
        photometric !== 32803 ||
        samplesPerPixel !== 1 ||
        repeat?.join(',') !== '2,2' ||
        pattern === null) {
      continue;
    }
    if (width <= 0 ||
        height <= 0 ||
        width % 2 !== 0 ||
        height % 2 !== 0 ||
        bitsPerSample < 2 ||
        bitsPerSample > 16) {
      continue;
    }
    let storage;
    if (compression === 7) {
      if (tileWidth === null || tileHeight === null ||
          tileOffsets === null || tileByteCounts === null ||
          tileWidth <= 0 || tileHeight <= 0 ||
          tileWidth % 2 !== 0 || tileHeight % 2 !== 0) continue;
      const columns = Math.ceil(width / tileWidth);
      const rows = Math.ceil(height / tileHeight);
      const expectedTiles = columns * rows;
      if (expectedTiles < 1 || expectedTiles > maximumTileCount ||
          tileOffsets.length !== expectedTiles ||
          tileByteCounts.length !== expectedTiles ||
          tileOffsets.some((offset, index) =>
            tileByteCounts[index] < 4 ||
            tileByteCounts[index] > maximumCompressedTileBytes ||
            !rangeFits(offset, tileByteCounts[index], totalLength))) continue;
      storage = {
        kind: 'jpeg-lossless', width: tileWidth, height: tileHeight,
        columns, rows, offsets: tileOffsets, byteCounts: tileByteCounts,
      };
    } else {
      if (!isLittleEndian || ![12, 14].includes(bitsPerSample) ||
          width % 32 !== 0 ||
          rowsPerStrip === null || rowsPerStrip <= 0 ||
          stripOffsets === null || stripByteCounts === null) continue;
      const rows = Math.ceil(height / rowsPerStrip);
      if (rows < 1 || rows > maximumTileCount ||
          stripOffsets.length !== rows || stripByteCounts.length !== rows ||
          stripOffsets.some((offset, index) => {
            const firstRow = index * rowsPerStrip;
            const rowCount = Math.min(rowsPerStrip, height - firstRow);
            return stripByteCounts[index] !== rowCount * width ||
              !rangeFits(offset, stripByteCounts[index], totalLength);
          })) continue;
      storage = {
        kind: 'sony-arw2', width, height: rowsPerStrip,
        columns: 1, rows, offsets: stripOffsets,
        byteCounts: stripByteCounts,
      };
    }

    const cropOrigin = await values(0xc61f, 2);
    const cropSize = await values(0xc620, 2);
    const blackLevels = await values(0x7310, 4);
    const whiteBalanceEntry = entries.get(0x7313);
    const sonyWbRggbLevels = whiteBalanceEntry === undefined ?
      null :
      await entrySignedShortValues(
          handle,
          whiteBalanceEntry,
          isLittleEndian,
          totalLength,
          4);
    const cameraWhiteBalance =
        normalizedCameraWhiteBalance(sonyWbRggbLevels);
    const whiteLevel = (await scalar(0xc61d)) ??
        ((1 << bitsPerSample) - 1);
    const activeLeft = cropOrigin?.[0] ?? 0;
    const activeTop = cropOrigin?.[1] ?? 0;
    const activeWidth = cropSize?.[0] ?? width;
    const activeHeight = cropSize?.[1] ?? height;
    if (activeLeft + activeWidth > width ||
        activeTop + activeHeight > height ||
        activeWidth <= 0 ||
        activeHeight <= 0 ||
        whiteLevel <= 0 ||
        whiteLevel > 65535 ||
        (whiteBalanceEntry !== undefined &&
         cameraWhiteBalance === null)) {
      continue;
    }
    const candidate = {
      width,
      height,
      bitsPerSample,
      compression,
      storage,
      cfaPattern: pattern.name,
      cfaOffsets: pattern.offsets,
      orientation: inheritedOrientation,
      activeArea: {
        left: activeLeft,
        top: activeTop,
        width: activeWidth,
        height: activeHeight,
      },
      blackLevels: blackLevels ?? [0, 0, 0, 0],
      sonyWbRggbLevels,
      cameraWhiteBalance,
      sonyCurve: inheritedSonyCurve,
      whiteLevel,
    };
    if (best === null || width * height > best.width * best.height) {
      best = candidate;
    }
  }
  if (best === null) {
    fail('No supported JPEG Lossless or Sony ARW2 CFA IFD was found');
  }
  return best;
}

function buildHuffmanTable(counts, symbols) {
  const table = Array.from({length: 17}, () => new Map());
  let code = 0;
  let symbolIndex = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let index = 0; index < counts[length - 1]; index += 1) {
      if (symbolIndex >= symbols.length) {
        fail('JPEG Huffman table is truncated');
      }
      table[length].set(code, symbols[symbolIndex]);
      code += 1;
      symbolIndex += 1;
    }
    if (code > (1 << length)) {
      fail('JPEG Huffman table is oversubscribed');
    }
    code <<= 1;
  }
  if (symbolIndex !== symbols.length) {
    fail('JPEG Huffman table symbol count is inconsistent');
  }
  return table;
}

class EntropyBits {
  constructor(bytes, offset) {
    this.bytes = bytes;
    this.offset = offset;
    this.current = 0;
    this.remaining = 0;
  }

  nextByte() {
    if (this.offset >= this.bytes.length) {
      fail('JPEG entropy stream is truncated');
    }
    const value = this.bytes[this.offset];
    this.offset += 1;
    if (value !== 0xff) return value;
    if (this.offset >= this.bytes.length) {
      fail('JPEG entropy marker is truncated');
    }
    const following = this.bytes[this.offset];
    this.offset += 1;
    if (following === 0x00) return 0xff;
    fail('Unexpected marker inside JPEG entropy data');
  }

  bit() {
    if (this.remaining === 0) {
      this.current = this.nextByte();
      this.remaining = 8;
    }
    this.remaining -= 1;
    return (this.current >> this.remaining) & 1;
  }

  bits(count) {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = value * 2 + this.bit();
    }
    return value;
  }

  finish() {
    if (this.remaining > 0) {
      const mask = 2 ** this.remaining - 1;
      if ((this.current & mask) !== mask) {
        fail('JPEG entropy padding is not all ones');
      }
    }
    let markerOffset = this.offset;
    if (markerOffset >= this.bytes.length ||
        this.bytes[markerOffset] !== 0xff) {
      fail('JPEG entropy data is not followed by EOI');
    }
    while (markerOffset < this.bytes.length &&
        this.bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    if (markerOffset >= this.bytes.length ||
        this.bytes[markerOffset] !== 0xd9) {
      fail('JPEG entropy data is not followed by EOI');
    }
  }
}

function huffmanSymbol(bits, table) {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    code = code * 2 + bits.bit();
    const symbol = table[length].get(code);
    if (symbol !== undefined) return symbol;
  }
  fail('JPEG entropy code is not in the Huffman table');
}

function difference(bits, category) {
  if (category === 0) return 0;
  if (category < 0 || category > 16) {
    fail('JPEG lossless difference category is unsupported');
  }
  const value = bits.bits(category);
  const threshold = 2 ** (category - 1);
  return value < threshold ? value - (2 ** category - 1) : value;
}

export function decodeLosslessJpegTile(
    bytes,
    {
      expectedMosaicWidth,
      expectedMosaicHeight,
      cfaOffsets,
      writeSample,
    }) {
  if (!Buffer.isBuffer(bytes) ||
      bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8) {
    fail('Tile does not begin with JPEG SOI');
  }
  let offset = 2;
  let frame = null;
  const huffmanTables = new Map();
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail('JPEG marker prefix is missing');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail('JPEG marker is truncated');
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) fail('JPEG ended before a lossless scan');
    if (marker === 0xd8 || marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) fail('JPEG segment length is truncated');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) {
      fail('JPEG segment range is invalid');
    }
    const start = offset + 2;
    const end = offset + length;

    if (marker === 0xc3) {
      if (length < 8) fail('JPEG SOF3 is truncated');
      const precision = bytes[start];
      const height = bytes.readUInt16BE(start + 1);
      const width = bytes.readUInt16BE(start + 3);
      const componentCount = bytes[start + 5];
      if (componentCount !== 4 ||
          length !== 8 + componentCount * 3 ||
          precision < 2 ||
          precision > 16 ||
          width <= 0 ||
          height <= 0) {
        fail('JPEG SOF3 geometry is unsupported');
      }
      const components = [];
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = start + 6 + index * 3;
        const id = bytes[componentOffset];
        const sampling = bytes[componentOffset + 1];
        if (sampling !== 0x11 || bytes[componentOffset + 2] !== 0) {
          fail('JPEG SOF3 sampling or table selector is unsupported');
        }
        components.push(id);
      }
      frame = {precision, width, height, components};
    } else if (marker === 0xc4) {
      let cursor = start;
      while (cursor < end) {
        const selector = bytes[cursor];
        cursor += 1;
        if ((selector >> 4) !== 0 || cursor + 16 > end) {
          fail('Only lossless DC Huffman tables are supported');
        }
        const counts = [...bytes.subarray(cursor, cursor + 16)];
        cursor += 16;
        const symbolCount = counts.reduce((sum, value) => sum + value, 0);
        if (symbolCount < 1 || cursor + symbolCount > end) {
          fail('JPEG Huffman table length is invalid');
        }
        const symbols = bytes.subarray(cursor, cursor + symbolCount);
        cursor += symbolCount;
        huffmanTables.set(
            selector & 0x0f,
            buildHuffmanTable(counts, symbols));
      }
    } else if (marker === 0xdd) {
      if (length !== 4 || bytes.readUInt16BE(start) !== 0) {
        fail('JPEG restart intervals are not supported');
      }
    } else if (marker === 0xda) {
      if (frame === null) fail('JPEG SOS appears before SOF3');
      const scanComponentCount = bytes[start];
      if (scanComponentCount !== 4 ||
          length !== 6 + scanComponentCount * 2) {
        fail('JPEG lossless scan component count is unsupported');
      }
      const tables = [];
      for (let index = 0; index < scanComponentCount; index += 1) {
        const scanOffset = start + 1 + index * 2;
        if (bytes[scanOffset] !== frame.components[index]) {
          fail('JPEG scan component order is unsupported');
        }
        const selector = bytes[scanOffset + 1];
        if ((selector & 0x0f) !== 0) {
          fail('JPEG lossless AC table selector must be zero');
        }
        const table = huffmanTables.get(selector >> 4);
        if (table === undefined) fail('JPEG Huffman table is missing');
        tables.push(table);
      }
      const predictor = bytes[start + 1 + scanComponentCount * 2];
      const spectralEnd = bytes[start + 2 + scanComponentCount * 2];
      const approximation = bytes[start + 3 + scanComponentCount * 2];
      if (predictor !== 1 || spectralEnd !== 0 || approximation !== 0) {
        fail('Only predictor 1 with zero point transform is supported');
      }
      if (frame.width * 2 !== expectedMosaicWidth ||
          frame.height * 2 !== expectedMosaicHeight ||
          cfaOffsets.length !== 4) {
        fail('JPEG component geometry does not match the TIFF tile');
      }
      const bitReader = new EntropyBits(bytes, end);
      const previous = Array.from(
          {length: 4},
          () => new Uint16Array(frame.width));
      const current = Array.from(
          {length: 4},
          () => new Uint16Array(frame.width));
      const initial = 2 ** (frame.precision - 1);
      const maximum = 2 ** frame.precision - 1;
      for (let y = 0; y < frame.height; y += 1) {
        for (let x = 0; x < frame.width; x += 1) {
          for (let component = 0; component < 4; component += 1) {
            const predictorValue =
                y === 0 ?
                  (x === 0 ? initial : current[component][x - 1]) :
                  (x === 0 ?
                    previous[component][x] :
                    current[component][x - 1]);
            const category = huffmanSymbol(bitReader, tables[component]);
            const sample =
                predictorValue + difference(bitReader, category);
            if (sample < 0 || sample > maximum) {
              fail('JPEG lossless sample is outside source precision');
            }
            current[component][x] = sample;
            const [cfaX, cfaY] = cfaOffsets[component];
            writeSample(x * 2 + cfaX, y * 2 + cfaY, sample);
          }
        }
        for (let component = 0; component < 4; component += 1) {
          previous[component].set(current[component]);
        }
      }
      bitReader.finish();
      return {
        precision: frame.precision,
        componentWidth: frame.width,
        componentHeight: frame.height,
      };
    }
    offset = end;
  }
  fail('JPEG contains no supported lossless scan');
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

function readLsbBits(bytes, position, count) {
  let value = 0;
  for (let bit = 0; bit < count; bit += 1) {
    value |= ((bytes[(position + bit) >> 3] >>
      ((position + bit) & 7)) & 1) << bit;
  }
  return value;
}

export function decodeSonyArw2Block(block, curve = null) {
  if (!Buffer.isBuffer(block) || block.length !== 16) {
    fail('Sony ARW2 block must contain exactly 16 bytes');
  }
  const high = readLsbBits(block, 0, 11);
  const low = readLsbBits(block, 11, 11);
  const highIndex = readLsbBits(block, 22, 4);
  const lowIndex = readLsbBits(block, 26, 4);
  if (high < low || highIndex === lowIndex) {
    fail('Sony ARW2 block extrema are inconsistent');
  }
  let shift = 0;
  while (((high - low) >> shift) > 127) shift += 1;
  let position = 30;
  const samples = new Uint16Array(16);
  for (let index = 0; index < 16; index += 1) {
    let value;
    if (index === highIndex) value = high;
    else if (index === lowIndex) value = low;
    else {
      value = low + (readLsbBits(block, position, 7) << shift);
      position += 7;
      value = Math.min(value, 2047);
    }
    samples[index] = curve === null ? value << 1 : curve[value << 1];
  }
  if (position !== 128) fail('Sony ARW2 block length is inconsistent');
  return samples;
}

function buildSonyCurve(breakpoints) {
  const curve = Uint16Array.from({length: 4096}, (_, index) => index);
  if (breakpoints === null) return curve;
  const points = [0, ...breakpoints, 4095];
  for (let range = 0; range < 5; range += 1) {
    if (points[range] > points[range + 1]) {
      fail('Sony curve breakpoints are not monotonic');
    }
    for (let value = points[range] + 1;
      value <= points[range + 1]; value += 1) {
      const mapped = curve[value - 1] + (1 << range);
      if (mapped > 65535) fail('Sony curve exceeds uint16');
      curve[value] = mapped;
    }
  }
  return curve;
}

function uint16LittleEndianSha256(samples, width, height) {
  const hash = createHash('sha256');
  const row = Buffer.alloc(width * 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      row.writeUInt16LE(samples[y * width + x], x * 2);
    }
    hash.update(row);
  }
  return hash.digest('hex');
}

export async function decodeSonyArwLossless(
    filePath,
    {
      maximumPixelCount = defaultMaximumPixelCount,
    } = {}) {
  if (!Number.isSafeInteger(maximumPixelCount) ||
      maximumPixelCount < 1 ||
      maximumPixelCount > defaultMaximumPixelCount) {
    fail('maximumPixelCount must be from 1 through 64000000');
  }
  const absolutePath = path.resolve(filePath);
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    fail('ARW path must be a regular file, not a symbolic link');
  }
  const handle = await open(absolutePath, 'r');
  let output;
  try {
    const opened = await handle.stat();
    if (!sameFileState(before, opened)) {
      fail('ARW changed before decoding began');
    }
    const sensor = await parseSensorIfd(handle, before.size);
    const pixelCount = sensor.width * sensor.height;
    if (!Number.isSafeInteger(pixelCount) ||
        pixelCount > maximumPixelCount) {
      fail('ARW sensor dimensions exceed the pixel limit');
    }
    const samples = new Uint16Array(pixelCount);
    const sonyCurve = sensor.storage.kind === 'sony-arw2' ?
      buildSonyCurve(sensor.sonyCurve) : null;
    let minimum = 65535;
    let maximum = 0;
    for (let tileIndex = 0;
      tileIndex < sensor.storage.offsets.length;
      tileIndex += 1) {
      const tileColumn = tileIndex % sensor.storage.columns;
      const tileRow = Math.floor(tileIndex / sensor.storage.columns);
      const bytes = await readExact(
          handle,
          sensor.storage.offsets[tileIndex],
          sensor.storage.byteCounts[tileIndex],
          before.size);
      if (sensor.storage.kind === 'jpeg-lossless') {
        decodeLosslessJpegTile(bytes, {
          expectedMosaicWidth: sensor.storage.width,
          expectedMosaicHeight: sensor.storage.height,
          cfaOffsets: sensor.cfaOffsets,
          writeSample(localX, localY, value) {
            const x = tileColumn * sensor.storage.width + localX;
            const y = tileRow * sensor.storage.height + localY;
            if (x >= sensor.width || y >= sensor.height) return;
            samples[y * sensor.width + x] = value;
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
          },
        });
      } else {
        const firstRow = tileIndex * sensor.storage.height;
        const rowCount = Math.min(sensor.storage.height,
            sensor.height - firstRow);
        for (let row = 0; row < rowCount; row += 1) {
          for (let x = 0; x < sensor.width; x += 16) {
            const values = decodeSonyArw2Block(
                bytes.subarray(row * sensor.width + x,
                    row * sensor.width + x + 16), sonyCurve);
            const block = x >> 4;
            const outputX = (block >> 1) * 32 + (block & 1);
            for (let index = 0; index < values.length; index += 1) {
              const value = values[index];
              samples[(firstRow + row) * sensor.width + outputX + index * 2] =
                value;
              minimum = Math.min(minimum, value);
              maximum = Math.max(maximum, value);
            }
          }
        }
      }
    }
    const points = [
      [0, 0],
      [sensor.activeArea.left, sensor.activeArea.top],
      [
        sensor.activeArea.left + sensor.activeArea.width - 1,
        sensor.activeArea.top + sensor.activeArea.height - 1,
      ],
      [sensor.width - 1, sensor.height - 1],
    ].map(([x, y]) => ({x, y, value: samples[y * sensor.width + x]}));
    output = {
      schemaVersion: 2,
      status: 'ok',
      format: 'ARW',
      decoder: sensor.storage.kind === 'jpeg-lossless' ?
        'jpeg-lossless-sof3-predictor1' : 'sony-arw2-block-v1',
      byteLength: before.size,
      width: sensor.width,
      height: sensor.height,
      bitsPerSample: sensor.bitsPerSample,
      cfaPattern: sensor.cfaPattern,
      orientation: sensor.orientation,
      activeArea: sensor.activeArea,
      blackLevels: sensor.blackLevels,
      sonyWbRggbLevels: sensor.sonyWbRggbLevels,
      cameraWhiteBalance: sensor.cameraWhiteBalance,
      whiteLevel: sensor.whiteLevel,
      tileWidth: sensor.storage.width,
      tileHeight: sensor.storage.height,
      tileCount: sensor.storage.offsets.length,
      minimum,
      maximum,
      samplePoints: points,
      uint16LittleEndianSha256:
          uint16LittleEndianSha256(samples, sensor.width, sensor.height),
    };
    const finished = await handle.stat();
    if (!sameFileState(opened, finished)) {
      fail('ARW changed while it was being decoded');
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(absolutePath);
  if (!sameFileState(before, after)) {
    fail('ARW changed while it was being decoded');
  }
  return output;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length === 1 && argumentsList[0] === '--help') {
    console.log(
        'usage: node decode_arw_lossless_reference.mjs <Sony ARW path>');
    return;
  }
  if (argumentsList.length !== 1) {
    fail('exactly one Sony ARW path is required');
  }
  console.log(JSON.stringify(
      await decodeSonyArwLossless(argumentsList[0])));
}

if (process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schemaVersion: 2,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
