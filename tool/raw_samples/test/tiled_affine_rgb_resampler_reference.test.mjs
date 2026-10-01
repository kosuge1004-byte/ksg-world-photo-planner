import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AffineResamplingCancelled,
  identitySamplingTransform,
  sampleAffineRgbTile,
  samplingTransform,
  similaritySamplingTransform,
} from '../tiled_affine_rgb_resampler_reference.mjs';

function frame(width, height) {
  const output = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x + y * 10;
      const base = (y * width + x) * 3;
      output[base] = value;
      output[base + 1] = value + 100;
      output[base + 2] = value + 200;
    }
  }
  return output;
}

function channelAt(tile, x, y, channel) {
  return tile.interleavedRgb[(y * tile.width + x) * 3 + channel];
}

test('identity returns exact RGB and a bounded source rectangle', () => {
  const result = sampleAffineRgbTile({
    frame: frame(6, 5),
    width: 6,
    height: 5,
    outputX: 2,
    outputY: 1,
    outputWidth: 3,
    outputHeight: 2,
    transform: identitySamplingTransform(),
  });

  assert.deepEqual(result.inputBounds, {x: 2, y: 1, width: 4, height: 3});
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const expected = x + 2 + (y + 1) * 10;
      assert.equal(channelAt(result, x, y, 0), expected);
      assert.equal(channelAt(result, x, y, 1), expected + 100);
      assert.equal(channelAt(result, x, y, 2), expected + 200);
      assert.equal(result.coverage[y * 3 + x], 1);
    }
  }
});

test('subpixel translation is bilinear in one sampling pass', () => {
  const result = sampleAffineRgbTile({
    frame: frame(5, 5), width: 5, height: 5,
    outputX: 1, outputY: 1, outputWidth: 1, outputHeight: 1,
    transform: similaritySamplingTransform({
      rotationDegrees: 0,
      sourceOffsetX: 0.5,
      sourceOffsetY: 0.5,
      centerX: 2,
      centerY: 2,
    }),
  });
  assert.ok(Math.abs(channelAt(result, 0, 0, 0) - 16.5) < 1e-6);
});

test('positive rotation follows the declared output-to-source convention', () => {
  const result = sampleAffineRgbTile({
    frame: frame(5, 5), width: 5, height: 5,
    outputX: 3, outputY: 2, outputWidth: 1, outputHeight: 1,
    transform: similaritySamplingTransform({
      rotationDegrees: 90,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
      centerX: 2,
      centerY: 2,
    }),
  });
  assert.ok(Math.abs(channelAt(result, 0, 0, 0) - 32) < 1e-6);
});

test('outside pixels are uncovered instead of edge-clamped', () => {
  const result = sampleAffineRgbTile({
    frame: frame(4, 4), width: 4, height: 4,
    outputX: 0, outputY: 1, outputWidth: 2, outputHeight: 1,
    transform: similaritySamplingTransform({
      rotationDegrees: 0,
      sourceOffsetX: -1,
      sourceOffsetY: 0,
      centerX: 0,
      centerY: 0,
    }),
  });
  assert.deepEqual([...result.coverage], [0, 1]);
  assert.equal(channelAt(result, 0, 0, 0), 0);
  assert.equal(channelAt(result, 1, 0, 0), 10);
});

test('fully outside tiles have no input bounds', () => {
  const result = sampleAffineRgbTile({
    frame: frame(4, 4), width: 4, height: 4,
    outputX: 0, outputY: 0, outputWidth: 2, outputHeight: 2,
    transform: similaritySamplingTransform({
      rotationDegrees: 0,
      sourceOffsetX: 100,
      sourceOffsetY: 100,
      centerX: 0,
      centerY: 0,
    }),
  });
  assert.equal(result.inputBounds, null);
  assert.deepEqual([...result.coverage], [0, 0, 0, 0]);
});

test('cancellation and non-finite transforms fail explicitly', () => {
  assert.throws(
    () => sampleAffineRgbTile({
      frame: frame(4, 4), width: 4, height: 4,
      outputX: 0, outputY: 0, outputWidth: 2, outputHeight: 2,
      transform: identitySamplingTransform(),
      isCancelled: () => true,
    }),
    AffineResamplingCancelled,
  );
  assert.throws(
    () => samplingTransform({
      m00: Number.NaN, m01: 0, m02: 0,
      m10: 0, m11: 1, m12: 0,
    }),
    /finite/,
  );
  assert.throws(
    () => sampleAffineRgbTile({
      frame: frame(4, 4), width: 4, height: 4,
      outputX: 2, outputY: 2, outputWidth: 2, outputHeight: 2,
      transform: samplingTransform({
        m00: 1e308, m01: 1e308, m02: 1e308,
        m10: 0, m11: 1, m12: 0,
      }),
    }),
    /finite/,
  );
});
