import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidBmpInput, encodeBmp } from '../bmp_writer_reference.mjs';

test('encodes a 1x1 red pixel to the exact expected byte sequence', () => {
  // Hand-computed expected bytes for a 1x1 24-bit BMP, red pixel
  // (255, 0, 0):
  // File header (14 bytes):
  //   'B','M', fileSize=14+40+4=58 (LE u32), reserved1=0, reserved2=0,
  //   pixelDataOffset=54 (LE u32)
  // DIB header (40 bytes):
  //   headerSize=40, width=1, height=1, planes=1, bpp=24, compression=0,
  //   imageSize=4, hRes=2835, vRes=2835, colorsUsed=0, importantColors=0
  // Pixel data (4 bytes: 3 BGR bytes + 1 padding byte, since 1*3=3 is
  // not a multiple of 4): B=0, G=0, R=255, pad=0
  const width = 1;
  const height = 1;
  const rgb8 = new Uint8Array([255, 0, 0]); // pure red
  const bmp = encodeBmp({ width, height, rgb8 });

  const expected = new Uint8Array([
    0x42, 0x4d, // 'B','M'
    58, 0, 0, 0, // fileSize = 58
    0, 0, // reserved1
    0, 0, // reserved2
    54, 0, 0, 0, // pixelDataOffset = 54
    40, 0, 0, 0, // DIB header size = 40
    1, 0, 0, 0, // width = 1
    1, 0, 0, 0, // height = 1
    1, 0, // planes = 1
    24, 0, // bits per pixel = 24
    0, 0, 0, 0, // compression = 0 (BI_RGB)
    4, 0, 0, 0, // image (pixel data) size = 4
    0x13, 0x0b, 0, 0, // horizontal resolution = 2835
    0x13, 0x0b, 0, 0, // vertical resolution = 2835
    0, 0, 0, 0, // colors used = 0
    0, 0, 0, 0, // important colors = 0
    0, 0, 255, 0, // pixel: B=0, G=0, R=255, padding=0
  ]);

  assert.equal(bmp.length, expected.length);
  assert.deepEqual(Array.from(bmp), Array.from(expected));
});

test('total file size and pixel data offset are always 14 + 40 + pixelDataSize / 54', () => {
  const width = 5;
  const height = 3;
  const rgb8 = new Uint8Array(width * height * 3).fill(128);
  const bmp = encodeBmp({ width, height, rgb8 });
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const fileSize = view.getUint32(2, true);
  const pixelDataOffset = view.getUint32(10, true);
  assert.equal(pixelDataOffset, 54);
  assert.equal(fileSize, bmp.length);
  assert.equal(fileSize, 54 + view.getUint32(34, true));
});

test('row byte count is padded to a multiple of 4 bytes', () => {
  // width=1 -> 3 raw bytes/row -> padded to 4.
  // width=4 -> 12 raw bytes/row -> already a multiple of 4, no padding.
  // width=5 -> 15 raw bytes/row -> padded to 16.
  for (const [width, expectedStride] of [[1, 4], [4, 12], [5, 16], [2, 8]]) {
    const height = 2;
    const rgb8 = new Uint8Array(width * height * 3).fill(1);
    const bmp = encodeBmp({ width, height, rgb8 });
    const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
    const imageSize = view.getUint32(34, true);
    assert.equal(
      imageSize,
      expectedStride * height,
      `width=${width}: expected stride ${expectedStride}`,
    );
  }
});

test('rows are stored bottom-up (BMP convention) and channels are BGR', () => {
  // A 1x2 image: top row (source row 0) red, bottom row (source row 1)
  // green -- in the input's top-to-bottom convention.
  const width = 1;
  const height = 2;
  const rgb8 = new Uint8Array([
    255, 0, 0, // row 0 (top): red
    0, 255, 0, // row 1 (bottom): green
  ]);
  const bmp = encodeBmp({ width, height, rgb8 });
  const strideBytes = 4; // width=1 -> 3 bytes padded to 4
  const pixelDataOffset = 54;

  // BMP's first stored row (bottom-up) must be the input's LAST row
  // (green), and the last stored row must be the input's FIRST row
  // (red).
  const firstStoredRow = bmp.slice(
    pixelDataOffset,
    pixelDataOffset + strideBytes,
  );
  const secondStoredRow = bmp.slice(
    pixelDataOffset + strideBytes,
    pixelDataOffset + strideBytes * 2,
  );
  // BGR order: green (0,255,0) -> B=0,G=255,R=0
  assert.deepEqual(Array.from(firstStoredRow.slice(0, 3)), [0, 255, 0]);
  // BGR order: red (255,0,0) -> B=0,G=0,R=255
  assert.deepEqual(Array.from(secondStoredRow.slice(0, 3)), [0, 0, 255]);
});

test('a larger synthetic gradient round-trips pixel-for-pixel through manual decoding', () => {
  const width = 17; // deliberately not a multiple of 4, to exercise padding
  const height = 11;
  const rgb8 = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      rgb8[index] = (x * 13) % 256;
      rgb8[index + 1] = (y * 17) % 256;
      rgb8[index + 2] = (x + y * 3) % 256;
    }
  }
  const bmp = encodeBmp({ width, height, rgb8 });
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const pixelDataOffset = view.getUint32(10, true);
  const decodedWidth = view.getInt32(18, true);
  const decodedHeight = view.getInt32(22, true);
  assert.equal(decodedWidth, width);
  assert.equal(decodedHeight, height);
  const strideBytes = Math.ceil((width * 3) / 4) * 4;

  for (let y = 0; y < height; y++) {
    const sourceRow = height - 1 - y; // bottom-up storage
    const rowStart = pixelDataOffset + y * strideBytes;
    for (let x = 0; x < width; x++) {
      const decodedIndex = rowStart + x * 3;
      const originalIndex = (sourceRow * width + x) * 3;
      assert.equal(bmp[decodedIndex], rgb8[originalIndex + 2], `B at (${x},${sourceRow})`);
      assert.equal(bmp[decodedIndex + 1], rgb8[originalIndex + 1], `G at (${x},${sourceRow})`);
      assert.equal(bmp[decodedIndex + 2], rgb8[originalIndex], `R at (${x},${sourceRow})`);
    }
  }
});

test('rejects non-positive or non-integer dimensions', () => {
  const rgb8 = new Uint8Array(3);
  assert.throws(() => encodeBmp({ width: 0, height: 1, rgb8 }), InvalidBmpInput);
  assert.throws(() => encodeBmp({ width: 1, height: -1, rgb8 }), InvalidBmpInput);
  assert.throws(() => encodeBmp({ width: 1.5, height: 1, rgb8 }), InvalidBmpInput);
});

test('rejects a mismatched rgb8 length', () => {
  assert.throws(
    () => encodeBmp({ width: 2, height: 2, rgb8: new Uint8Array(10) }),
    InvalidBmpInput,
  );
});

test('rejects a non-Uint8Array rgb8', () => {
  assert.throws(
    () => encodeBmp({ width: 1, height: 1, rgb8: [255, 0, 0] }),
    InvalidBmpInput,
  );
});

test('accepts a Uint8ClampedArray (the natural output of toneMapToDisplayRgb)', () => {
  const rgb8 = new Uint8ClampedArray([10, 20, 30, 40, 50, 60]);
  const bmp = encodeBmp({ width: 2, height: 1, rgb8 });
  assert.ok(bmp.length > 0);
});

test('rejects dimensions beyond the conservative 32767 safety limit', () => {
  assert.throws(
    () => encodeBmp({
      width: 40000,
      height: 1,
      rgb8: new Uint8Array(40000 * 3),
    }),
    InvalidBmpInput,
  );
});
