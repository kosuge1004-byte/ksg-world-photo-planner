
const D65_XYZ_TO_LINEAR_SRGB = [
  3.2409699419045226, -1.537383177570094, -0.4986107602930034,
  -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
  0.05563007969699366, -0.20397695888897652, 1.0569715142428786,
];

const align4 = (v) => (v + 3) & ~3;

export function encodeLinearDngReference({
  width,
  height,
  rowsPerStrip = 64,
  pixels,
}) {
  if (!(width > 0 && height > 0 && rowsPerStrip > 0)) {
    throw new RangeError('invalid dimensions');
  }
  if (!pixels || pixels.length !== width * height * 3) {
    throw new RangeError('pixels must be RGB float triplets');
  }
  const model = Buffer.from('MobileStack Linear sRGB\0', 'utf8');
  const software = Buffer.from('Mobile Stack\0', 'utf8');

  const entryCount = 22;
  const ifdOffset = 8;
  const ifdBytes = 2 + entryCount * 12 + 4;
  let cursor = align4(ifdOffset + ifdBytes);
  const bitsOffset = cursor; cursor = align4(cursor + 6);
  const sampleFormatOffset = cursor; cursor = align4(cursor + 6);
  const softwareOffset = cursor; cursor = align4(cursor + software.length);
  const modelOffset = cursor; cursor = align4(cursor + model.length);
  const matrixOffset = cursor; cursor = align4(cursor + 72);
  const asShotWhiteXyOffset = cursor; cursor = align4(cursor + 16);

  const stripCount = Math.ceil(height / rowsPerStrip);
  const stripOffsetsArrayOffset = stripCount > 1 ? cursor : 0;
  if (stripCount > 1) cursor = align4(cursor + stripCount * 4);
  const stripCountsArrayOffset = stripCount > 1 ? cursor : 0;
  if (stripCount > 1) cursor = align4(cursor + stripCount * 4);
  const pixelOffset = align4(cursor);

  const stripOffsets = [];
  const stripCounts = [];
  let next = pixelOffset;
  for (let s = 0; s < stripCount; s++) {
    const start = s * rowsPerStrip;
    const rows = Math.min(rowsPerStrip, height - start);
    const bytes = width * rows * 12;
    stripOffsets.push(next);
    stripCounts.push(bytes);
    next += bytes;
  }

  const out = Buffer.alloc(next);
  out.write('II', 0, 2, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdOffset, 4);
  out.writeUInt16LE(entryCount, ifdOffset);
  let e = ifdOffset + 2;
  const entry = (tag, type, count, value) => {
    out.writeUInt16LE(tag, e);
    out.writeUInt16LE(type, e + 2);
    out.writeUInt32LE(count, e + 4);
    out.writeUInt32LE(value >>> 0, e + 8);
    e += 12;
  };

  entry(254, 4, 1, 0);
  entry(256, 4, 1, width);
  entry(257, 4, 1, height);
  entry(258, 3, 3, bitsOffset);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 34892);
  entry(273, 4, stripCount, stripCount === 1 ? stripOffsets[0] : stripOffsetsArrayOffset);
  entry(274, 3, 1, 1);
  entry(277, 3, 1, 3);
  entry(278, 4, 1, rowsPerStrip);
  entry(279, 4, stripCount, stripCount === 1 ? stripCounts[0] : stripCountsArrayOffset);
  entry(284, 3, 1, 1);
  entry(305, 2, software.length, softwareOffset);
  entry(339, 3, 3, sampleFormatOffset);
  entry(50706, 1, 4, 0x00000401);
  entry(50707, 1, 4, 0x00000401);
  entry(50708, 2, model.length, modelOffset);
  entry(50721, 10, 9, matrixOffset);
  entry(50729, 5, 2, asShotWhiteXyOffset);
  entry(50778, 3, 1, 21);
  entry(50879, 3, 1, 0);
  entry(51110, 4, 1, 1);
  out.writeUInt32LE(0, e);

  for (let c = 0; c < 3; c++) {
    out.writeUInt16LE(32, bitsOffset + c * 2);
    out.writeUInt16LE(3, sampleFormatOffset + c * 2);
  }
  software.copy(out, softwareOffset);
  model.copy(out, modelOffset);

  const denom = 100000000;
  for (let i = 0; i < 9; i++) {
    out.writeInt32LE(Math.round(D65_XYZ_TO_LINEAR_SRGB[i] * denom), matrixOffset + i * 8);
    out.writeInt32LE(denom, matrixOffset + i * 8 + 4);
  }
  out.writeUInt32LE(3127, asShotWhiteXyOffset);
  out.writeUInt32LE(10000, asShotWhiteXyOffset + 4);
  out.writeUInt32LE(3290, asShotWhiteXyOffset + 8);
  out.writeUInt32LE(10000, asShotWhiteXyOffset + 12);
  if (stripCount > 1) {
    for (let i = 0; i < stripCount; i++) {
      out.writeUInt32LE(stripOffsets[i], stripOffsetsArrayOffset + i * 4);
      out.writeUInt32LE(stripCounts[i], stripCountsArrayOffset + i * 4);
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    out.writeFloatLE(pixels[i], pixelOffset + i * 4);
  }
  return out;
}

export function parseIfd0(buffer) {
  if (buffer.toString('ascii', 0, 2) !== 'II' || buffer.readUInt16LE(2) !== 42) {
    throw new Error('not little-endian TIFF');
  }
  const ifd = buffer.readUInt32LE(4);
  const count = buffer.readUInt16LE(ifd);
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const off = ifd + 2 + i * 12;
    tags.set(buffer.readUInt16LE(off), {
      type: buffer.readUInt16LE(off + 2),
      count: buffer.readUInt32LE(off + 4),
      value: buffer.readUInt32LE(off + 8),
    });
  }
  return tags;
}


export function encodeBigLinearDngReference({
  width,
  height,
  rowsPerStrip = 64,
  pixels,
}) {
  if (!(width > 0 && height > 0 && rowsPerStrip > 0)) {
    throw new RangeError('invalid dimensions');
  }
  if (!pixels || pixels.length !== width * height * 3) {
    throw new RangeError('pixels must be RGB float triplets');
  }
  const model = Buffer.from('MobileStack Linear sRGB\0', 'utf8');
  const software = Buffer.from('Mobile Stack\0', 'utf8');
  const align8 = (v) => (v + 7) & ~7;

  const entryCount = 22;
  const ifdOffset = 16;
  const ifdBytes = 8 + entryCount * 20 + 8;
  let cursor = align8(ifdOffset + ifdBytes);
  const bitsOffset = cursor; cursor = align8(cursor + 6);
  const sampleFormatOffset = cursor; cursor = align8(cursor + 6);
  const softwareOffset = cursor; cursor = align8(cursor + software.length);
  const modelOffset = cursor; cursor = align8(cursor + model.length);
  const matrixOffset = cursor; cursor = align8(cursor + 72);
  const asShotWhiteXyOffset = cursor; cursor = align8(cursor + 16);

  const stripCount = Math.ceil(height / rowsPerStrip);
  const stripOffsetsArrayOffset = stripCount > 1 ? cursor : 0;
  if (stripCount > 1) cursor = align8(cursor + stripCount * 8);
  const stripCountsArrayOffset = stripCount > 1 ? cursor : 0;
  if (stripCount > 1) cursor = align8(cursor + stripCount * 8);
  const pixelOffset = align8(cursor);

  const stripOffsets = [];
  const stripCounts = [];
  let next = BigInt(pixelOffset);
  for (let s = 0; s < stripCount; s++) {
    const start = s * rowsPerStrip;
    const rows = Math.min(rowsPerStrip, height - start);
    const bytes = width * rows * 12;
    stripOffsets.push(next);
    stripCounts.push(BigInt(bytes));
    next += BigInt(bytes);
  }
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('reference writer only supports safe JS allocation');
  }
  const out = Buffer.alloc(Number(next));
  out.write('II', 0, 2, 'ascii');
  out.writeUInt16LE(43, 2);
  out.writeUInt16LE(8, 4);
  out.writeUInt16LE(0, 6);
  out.writeBigUInt64LE(BigInt(ifdOffset), 8);
  out.writeBigUInt64LE(BigInt(entryCount), ifdOffset);

  let e = ifdOffset + 8;
  const entry = (tag, type, count, value) => {
    out.writeUInt16LE(tag, e);
    out.writeUInt16LE(type, e + 2);
    out.writeBigUInt64LE(BigInt(count), e + 4);
    out.writeBigUInt64LE(BigInt(value), e + 12);
    e += 20;
  };

  entry(254, 4, 1, 0);
  entry(256, 4, 1, width);
  entry(257, 4, 1, height);
  entry(258, 3, 3, 32n | (32n << 16n) | (32n << 32n));
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 34892);
  entry(273, 16, stripCount, stripCount === 1 ? stripOffsets[0] : stripOffsetsArrayOffset);
  entry(274, 3, 1, 1);
  entry(277, 3, 1, 3);
  entry(278, 4, 1, rowsPerStrip);
  entry(279, 16, stripCount, stripCount === 1 ? stripCounts[0] : stripCountsArrayOffset);
  entry(284, 3, 1, 1);
  entry(305, 2, software.length, softwareOffset);
  entry(339, 3, 3, 3n | (3n << 16n) | (3n << 32n));
  entry(50706, 1, 4, 0x00000401);
  entry(50707, 1, 4, 0x00000401);
  entry(50708, 2, model.length, modelOffset);
  entry(50721, 10, 9, matrixOffset);
  entry(50729, 5, 2, asShotWhiteXyOffset);
  entry(50778, 3, 1, 21);
  entry(50879, 3, 1, 0);
  entry(51110, 4, 1, 1);
  out.writeBigUInt64LE(0n, e);

  software.copy(out, softwareOffset);
  model.copy(out, modelOffset);

  const denom = 100000000;
  for (let i = 0; i < 9; i++) {
    out.writeInt32LE(Math.round(D65_XYZ_TO_LINEAR_SRGB[i] * denom), matrixOffset + i * 8);
    out.writeInt32LE(denom, matrixOffset + i * 8 + 4);
  }
  out.writeUInt32LE(3127, asShotWhiteXyOffset);
  out.writeUInt32LE(10000, asShotWhiteXyOffset + 4);
  out.writeUInt32LE(3290, asShotWhiteXyOffset + 8);
  out.writeUInt32LE(10000, asShotWhiteXyOffset + 12);
  if (stripCount > 1) {
    for (let i = 0; i < stripCount; i++) {
      out.writeBigUInt64LE(stripOffsets[i], stripOffsetsArrayOffset + i * 8);
      out.writeBigUInt64LE(stripCounts[i], stripCountsArrayOffset + i * 8);
    }
  }
  for (let i = 0; i < pixels.length; i++) {
    out.writeFloatLE(pixels[i], pixelOffset + i * 4);
  }
  return out;
}


export function appendClassicTransparencyMask(buffer, {
  width,
  height,
  mask,
}) {
  if (mask.length !== width * height) {
    throw new RangeError('mask size does not match dimensions');
  }
  const oldIfd = buffer.readUInt32LE(4);
  const oldCount = buffer.readUInt16LE(oldIfd);
  const mainIfdOffset = align4(buffer.length);
  const mainCount = oldCount + 1;
  const mainIfdLength = 2 + mainCount * 12 + 4;
  const maskIfdOffset = align4(mainIfdOffset + mainIfdLength);
  const maskEntryCount = 10;
  const maskIfdLength = 2 + maskEntryCount * 12 + 4;
  const maskDataOffset = align4(maskIfdOffset + maskIfdLength);
  const out = Buffer.alloc(maskDataOffset + mask.length);
  buffer.copy(out, 0);
  out.writeUInt32LE(mainIfdOffset, 4);

  out.writeUInt16LE(mainCount, mainIfdOffset);
  let dst = mainIfdOffset + 2;
  let inserted = false;
  for (let i = 0; i < oldCount; i++) {
    const src = oldIfd + 2 + i * 12;
    const tag = buffer.readUInt16LE(src);
    if (!inserted && tag > 330) {
      out.writeUInt16LE(330, dst);
      out.writeUInt16LE(13, dst + 2); // TIFF_IFD
      out.writeUInt32LE(1, dst + 4);
      out.writeUInt32LE(maskIfdOffset, dst + 8);
      dst += 12;
      inserted = true;
    }
    buffer.copy(out, dst, src, src + 12);
    dst += 12;
  }
  if (!inserted) {
    out.writeUInt16LE(330, dst);
    out.writeUInt16LE(13, dst + 2);
    out.writeUInt32LE(1, dst + 4);
    out.writeUInt32LE(maskIfdOffset, dst + 8);
    dst += 12;
  }
  out.writeUInt32LE(0, dst); // main NextIFD stays zero

  out.writeUInt16LE(maskEntryCount, maskIfdOffset);
  let e = maskIfdOffset + 2;
  const entry = (tag, type, n, value) => {
    out.writeUInt16LE(tag, e);
    out.writeUInt16LE(type, e + 2);
    out.writeUInt32LE(n, e + 4);
    out.writeUInt32LE(value >>> 0, e + 8);
    e += 12;
  };
  entry(254, 4, 1, 4);
  entry(256, 4, 1, width);
  entry(257, 4, 1, height);
  entry(258, 3, 1, 8);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 4);
  entry(273, 4, 1, maskDataOffset);
  entry(277, 3, 1, 1);
  entry(278, 4, 1, height);
  entry(279, 4, 1, mask.length);
  out.writeUInt32LE(0, e);
  Buffer.from(mask).copy(out, maskDataOffset);
  return out;
}

export function appendBigTransparencyMask(buffer, {
  width,
  height,
  mask,
}) {
  if (mask.length !== width * height) {
    throw new RangeError('mask size does not match dimensions');
  }
  if (buffer.readUInt16LE(2) !== 43) {
    throw new Error('not BigTIFF');
  }
  const align8 = (v) => (v + 7) & ~7;
  const oldIfd = Number(buffer.readBigUInt64LE(8));
  const oldCount = Number(buffer.readBigUInt64LE(oldIfd));
  const mainIfdOffset = align8(buffer.length);
  const mainCount = oldCount + 1;
  const mainIfdLength = 8 + mainCount * 20 + 8;
  const maskIfdOffset = align8(mainIfdOffset + mainIfdLength);
  const maskEntryCount = 10;
  const maskIfdLength = 8 + maskEntryCount * 20 + 8;
  const maskDataOffset = align8(maskIfdOffset + maskIfdLength);
  const out = Buffer.alloc(maskDataOffset + mask.length);
  buffer.copy(out, 0);
  out.writeBigUInt64LE(BigInt(mainIfdOffset), 8);

  out.writeBigUInt64LE(BigInt(mainCount), mainIfdOffset);
  let dst = mainIfdOffset + 8;
  let inserted = false;
  for (let i = 0; i < oldCount; i++) {
    const src = oldIfd + 8 + i * 20;
    const tag = buffer.readUInt16LE(src);
    if (!inserted && tag > 330) {
      out.writeUInt16LE(330, dst);
      out.writeUInt16LE(18, dst + 2); // TIFF_IFD8
      out.writeBigUInt64LE(1n, dst + 4);
      out.writeBigUInt64LE(BigInt(maskIfdOffset), dst + 12);
      dst += 20;
      inserted = true;
    }
    buffer.copy(out, dst, src, src + 20);
    dst += 20;
  }
  if (!inserted) {
    out.writeUInt16LE(330, dst);
    out.writeUInt16LE(18, dst + 2);
    out.writeBigUInt64LE(1n, dst + 4);
    out.writeBigUInt64LE(BigInt(maskIfdOffset), dst + 12);
    dst += 20;
  }
  out.writeBigUInt64LE(0n, dst); // main NextIFD stays zero

  out.writeBigUInt64LE(BigInt(maskEntryCount), maskIfdOffset);
  let e = maskIfdOffset + 8;
  const entry = (tag, type, n, value) => {
    out.writeUInt16LE(tag, e);
    out.writeUInt16LE(type, e + 2);
    out.writeBigUInt64LE(BigInt(n), e + 4);
    out.writeBigUInt64LE(BigInt(value), e + 12);
    e += 20;
  };
  entry(254, 4, 1, 4);
  entry(256, 4, 1, width);
  entry(257, 4, 1, height);
  entry(258, 3, 1, 8);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 4);
  entry(273, 16, 1, maskDataOffset);
  entry(277, 3, 1, 1);
  entry(278, 4, 1, height);
  entry(279, 16, 1, mask.length);
  out.writeBigUInt64LE(0n, e);
  Buffer.from(mask).copy(out, maskDataOffset);
  return out;
}
