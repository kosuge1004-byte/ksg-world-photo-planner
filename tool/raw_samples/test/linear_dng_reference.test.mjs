
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeLinearDngReference,
  encodeBigLinearDngReference,
  parseIfd0,
} from '../linear_dng_reference.mjs';

test('Linear DNG contract uses Float32 LinearRaw and DNG 1.4 compatibility', () => {
  const file = encodeLinearDngReference({
    width: 2,
    height: 1,
    pixels: Float32Array.from([-0.25, 0.5, 2.0, 1.5, 0.25, -0.1]),
  });
  const tags = parseIfd0(file);
  assert.equal(tags.get(262).value & 0xffff, 34892); // LinearRaw
  assert.equal(tags.get(277).value & 0xffff, 3); // RGB planes
  assert.equal(tags.get(339).count, 3); // SampleFormat array
  assert.equal(tags.get(50706).value, 0x00000401); // 1,4,0,0 bytes
  assert.equal(tags.get(50707).value, 0x00000401);
  assert.equal(tags.get(50778).value & 0xffff, 21); // D65
  assert.equal(tags.get(51110).value, 1); // no extra black render
});

test('Linear DNG keeps signed and overrange Float32 samples losslessly at storage precision', () => {
  const input = [-0.25, 0.5, 2.0, 1.5, 0.25, -0.1];
  const file = encodeLinearDngReference({
    width: 2,
    height: 1,
    pixels: Float32Array.from(input),
  });
  const tags = parseIfd0(file);
  const pixelOffset = tags.get(273).value;
  const output = [];
  for (let i = 0; i < input.length; i++) {
    output.push(file.readFloatLE(pixelOffset + i * 4));
  }
  for (let i = 0; i < input.length; i++) {
    assert.equal(output[i], Math.fround(input[i]));
  }
});

test('ColorMatrix1, D65 AsShotWhiteXY, and scene-referred semantics are present', () => {
  const file = encodeLinearDngReference({
    width: 1,
    height: 1,
    pixels: Float32Array.from([0.1, 0.2, 0.3]),
  });
  const tags = parseIfd0(file);
  assert.equal(tags.get(50721).type, 10);
  assert.equal(tags.get(50721).count, 9);
  assert.equal(tags.get(50729).type, 5);
  assert.equal(tags.get(50729).count, 2);
  assert.equal(tags.get(50778).value & 0xffff, 21);
  assert.equal(tags.get(50879).value & 0xffff, 0);
  assert.equal(tags.has(50728), false);
  assert.ok(tags.get(50708).count > 1);
});


test('64-bit DNG uses the BigTIFF header and LONG8 strip offsets', () => {
  const file = encodeBigLinearDngReference({
    width: 2,
    height: 2,
    rowsPerStrip: 1,
    pixels: Float32Array.from([
      -0.25, 0.5, 2.0,
      1.5, 0.25, -0.1,
      0.0, 1.0, 4.0,
      0.2, 0.3, 0.4,
    ]),
  });
  assert.equal(file.toString('ascii', 0, 2), 'II');
  assert.equal(file.readUInt16LE(2), 43);
  assert.equal(file.readUInt16LE(4), 8);
  assert.equal(file.readUInt16LE(6), 0);
  const ifd = Number(file.readBigUInt64LE(8));
  const count = Number(file.readBigUInt64LE(ifd));
  assert.equal(count, 22);
  let stripOffsetType;
  let stripByteCountType;
  for (let i = 0; i < count; i++) {
    const off = ifd + 8 + i * 20;
    const tag = file.readUInt16LE(off);
    if (tag === 273) stripOffsetType = file.readUInt16LE(off + 2);
    if (tag === 279) stripByteCountType = file.readUInt16LE(off + 2);
  }
  assert.equal(stripOffsetType, 16);
  assert.equal(stripByteCountType, 16);
});


test('synthetic linear-sRGB ColorMatrix maps the declared D65 white to neutral', () => {
  const m = [
    3.2409699419045226, -1.537383177570094, -0.4986107602930034,
    -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
    0.05563007969699366, -0.20397695888897652, 1.0569715142428786,
  ];
  const d65 = [0.3127 / 0.3290, 1, (1 - 0.3127 - 0.3290) / 0.3290];
  const rgb = [0, 1, 2].map((r) =>
    m[r * 3] * d65[0] + m[r * 3 + 1] * d65[1] + m[r * 3 + 2] * d65[2]
  );
  for (const value of rgb) assert.ok(Math.abs(value - 1) < 1e-12);
});
