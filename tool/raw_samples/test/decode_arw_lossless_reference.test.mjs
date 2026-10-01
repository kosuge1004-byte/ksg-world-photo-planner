import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ArwLosslessReferenceError,
  decodeLosslessJpegTile,
  decodeSonyArw2Block,
  decodeSonyArwLossless,
} from '../decode_arw_lossless_reference.mjs';

function sonyArw2Block() {
  const bytes = Buffer.alloc(16);
  const writeBits = (position, count, value) => {
    for (let bit = 0; bit < count; bit += 1) {
      bytes[(position + bit) >> 3] |=
        ((value >> bit) & 1) << ((position + bit) & 7);
    }
  };
  writeBits(0, 11, 200);
  writeBits(11, 11, 50);
  writeBits(22, 4, 2);
  writeBits(26, 4, 9);
  let position = 30;
  for (let index = 0; index < 16; index += 1) {
    if (index === 2 || index === 9) continue;
    writeBits(position, 7, index + 1);
    position += 7;
  }
  return bytes;
}

function differentialLosslessJpeg({predictor = 1} = {}) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc3, 0x00, 0x14,
    0x0e, 0x00, 0x01, 0x00, 0x01, 0x04,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0x04, 0x11, 0x00,
    0xff, 0xc4, 0x00, 0x15,
    0x00,
    0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x01,
    0xff, 0xda, 0x00, 0x0e,
    0x04,
    0x01, 0x00,
    0x02, 0x00,
    0x03, 0x00,
    0x04, 0x00,
    predictor, 0x00, 0x00,
    0x73,
    0xff, 0xd9,
  ]);
}

function syntheticArw({
  jpeg = differentialLosslessJpeg(),
  whiteBalance = [2048, 1024, 1024, 1536],
} = {}) {
  const bytes = Buffer.alloc(512);
  const ifdOffset = 8;
  const jpegOffset = 320;
  const cropOriginOffset = 240;
  const cropSizeOffset = 248;
  const blackOffset = 256;
  const whiteBalanceOffset = 264;
  const entries = [
    [0x0100, 3, 1, 2],
    [0x0101, 3, 1, 2],
    [0x0102, 3, 1, 14],
    [0x0103, 3, 1, 7],
    [0x0106, 3, 1, 32803],
    [0x0112, 3, 1, 1],
    [0x0115, 3, 1, 1],
    [0x0142, 3, 1, 2],
    [0x0143, 3, 1, 2],
    [0x0144, 4, 1, jpegOffset],
    [0x0145, 4, 1, jpeg.length],
    [0x7310, 3, 4, blackOffset],
    ...(whiteBalance === null ? [] : [
      [0x7313, 8, 4, whiteBalanceOffset],
    ]),
    [0x828d, 3, 2, 0x00020002],
    [0x828e, 1, 4, 0x02010100],
    [0xc61d, 3, 1, 16383],
    [0xc61f, 4, 2, cropOriginOffset],
    [0xc620, 4, 2, cropSizeOffset],
  ];
  bytes.write('II', 0, 'ascii');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(ifdOffset, 4);
  bytes.writeUInt16LE(entries.length, ifdOffset);
  entries.forEach(([tag, type, count, value], index) => {
    const offset = ifdOffset + 2 + index * 12;
    bytes.writeUInt16LE(tag, offset);
    bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(count, offset + 4);
    bytes.writeUInt32LE(value, offset + 8);
  });
  bytes.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12);
  bytes.writeUInt32LE(0, cropOriginOffset);
  bytes.writeUInt32LE(0, cropOriginOffset + 4);
  bytes.writeUInt32LE(2, cropSizeOffset);
  bytes.writeUInt32LE(2, cropSizeOffset + 4);
  for (let index = 0; index < 4; index += 1) {
    bytes.writeUInt16LE(512, blackOffset + index * 2);
  }
  whiteBalance?.forEach((value, index) => {
    bytes.writeInt16LE(value, whiteBalanceOffset + index * 2);
  });
  jpeg.copy(bytes, jpegOffset);
  return bytes;
}

function syntheticArw2({bitsPerSample}) {
  const bytes = Buffer.alloc(512);
  const ifdOffset = 8;
  const stripOffset = 320;
  const blackOffset = 256;
  const entries = [
    [0x0100, 3, 1, 32],
    [0x0101, 3, 1, 2],
    [0x0102, 3, 1, bitsPerSample],
    [0x0103, 3, 1, 32767],
    [0x0106, 3, 1, 32803],
    [0x0111, 4, 1, stripOffset],
    [0x0112, 3, 1, 1],
    [0x0115, 3, 1, 1],
    [0x0116, 4, 1, 2],
    [0x0117, 4, 1, 64],
    [0x7310, 3, 4, blackOffset],
    [0x828d, 3, 2, 0x00020002],
    [0x828e, 1, 4, 0x02010100],
    [0xc61d, 3, 1, 16380],
  ];
  bytes.write('II', 0, 'ascii');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(ifdOffset, 4);
  bytes.writeUInt16LE(entries.length, ifdOffset);
  entries.forEach(([tag, type, count, value], index) => {
    const offset = ifdOffset + 2 + index * 12;
    bytes.writeUInt16LE(tag, offset);
    bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(count, offset + 4);
    bytes.writeUInt32LE(value, offset + 8);
  });
  bytes.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12);
  for (let index = 0; index < 4; index += 1) {
    bytes.writeUInt16LE(512, blackOffset + index * 2);
    sonyArw2Block().copy(bytes, stripOffset + index * 16);
  }
  return bytes;
}

test('decodes a four-component SOF3 tile into a 2x2 CFA mosaic', () => {
  const samples = new Uint16Array(4);
  const result = decodeLosslessJpegTile(differentialLosslessJpeg(), {
    expectedMosaicWidth: 2,
    expectedMosaicHeight: 2,
    cfaOffsets: [[0, 0], [1, 0], [0, 1], [1, 1]],
    writeSample(x, y, value) {
      samples[y * 2 + x] = value;
    },
  });
  assert.equal(result.precision, 14);
  assert.deepEqual([...samples], [8192, 8193, 8191, 8192]);
});

test('decodes a Sony ARW2 same-parity 16-pixel block', () => {
  assert.deepEqual([...decodeSonyArw2Block(sonyArw2Block())], [
    104, 108, 400, 116, 120, 124, 128, 132,
    136, 100, 144, 148, 152, 156, 160, 164,
  ]);
});

test('decodes both 12-bit and 14-bit Sony ARW2 containers', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-arw2-container-'));
  try {
    for (const bitsPerSample of [12, 14]) {
      const filePath = path.join(directory, `sample-${bitsPerSample}.arw`);
      await writeFile(filePath, syntheticArw2({bitsPerSample}));
      const result = await decodeSonyArwLossless(filePath);
      assert.equal(result.status, 'ok');
      assert.equal(result.decoder, 'sony-arw2-block-v1');
      assert.equal(result.bitsPerSample, bitsPerSample);
      assert.equal(result.width, 32);
      assert.equal(result.height, 2);
      assert.equal(result.minimum, 100);
      assert.equal(result.maximum, 400);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('decodes a bounded synthetic tiled Sony ARW', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-arw-lossless-'));
  const filePath = path.join(directory, 'sample.ARW');
  try {
    await writeFile(filePath, syntheticArw());
    const result = await decodeSonyArwLossless(filePath);
    assert.equal(result.status, 'ok');
    assert.equal(result.decoder, 'jpeg-lossless-sof3-predictor1');
    assert.equal(result.width, 2);
    assert.equal(result.height, 2);
    assert.equal(result.bitsPerSample, 14);
    assert.equal(result.cfaPattern, 'RGGB');
    assert.deepEqual(result.blackLevels, [512, 512, 512, 512]);
    assert.deepEqual(
        result.sonyWbRggbLevels,
        [2048, 1024, 1024, 1536]);
    assert.deepEqual(
        result.cameraWhiteBalance,
        [2, 1, 1, 1.5]);
    assert.equal(result.whiteLevel, 16383);
    assert.equal(result.minimum, 8191);
    assert.equal(result.maximum, 8193);
    assert.equal(
        result.uint16LittleEndianSha256,
        '059e277b1b59007651159b01dc870b3683d48abff40fdc0298427b19d579d984');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rejects an ARW above the caller pixel limit', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-arw-pixel-limit-'));
  const filePath = path.join(directory, 'sample.arw');
  try {
    await writeFile(filePath, syntheticArw());
    await assert.rejects(
        decodeSonyArwLossless(filePath, {maximumPixelCount: 3}),
        ArwLosslessReferenceError);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('accepts a supported ARW without optional camera white balance', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-arw-no-wb-'));
  const filePath = path.join(directory, 'sample.arw');
  try {
    await writeFile(filePath, syntheticArw({whiteBalance: null}));
    const result = await decodeSonyArwLossless(filePath);
    assert.equal(result.sonyWbRggbLevels, null);
    assert.equal(result.cameraWhiteBalance, null);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rejects invalid Sony RGGB white-balance levels', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-arw-invalid-wb-'));
  const filePath = path.join(directory, 'sample.arw');
  try {
    await writeFile(
        filePath,
        syntheticArw({whiteBalance: [2048, 0, 1024, 1536]}));
    await assert.rejects(
        decodeSonyArwLossless(filePath),
        ArwLosslessReferenceError);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rejects an unsupported JPEG lossless predictor', () => {
  assert.throws(
      () => decodeLosslessJpegTile(
        differentialLosslessJpeg({predictor: 2}), {
        expectedMosaicWidth: 2,
        expectedMosaicHeight: 2,
        cfaOffsets: [[0, 0], [1, 0], [0, 1], [1, 1]],
        writeSample() {},
      }),
      ArwLosslessReferenceError);
});
