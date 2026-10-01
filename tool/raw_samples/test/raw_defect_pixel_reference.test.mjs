import assert from 'node:assert/strict';
import test from 'node:test';

import {
  correctExplicitDefectPixels,
  RawDefectPixelReferenceError,
} from '../raw_defect_pixel_reference.mjs';

function uniform(width, height, value = 1) {
  return Array(width * height).fill(value);
}

test('corrects only an explicit point from same-phase neighbors', () => {
  const samples = uniform(7, 7);
  samples[2 * 7 + 2] = 99;
  const result = correctExplicitDefectPixels({
    width: 7,
    height: 7,
    samples,
    points: [{x: 2, y: 2}],
  });
  assert.equal(result.correctedCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.samples[2 * 7 + 2], 1);
});

test('selects the opposing direction with the smallest gradient', () => {
  const samples = uniform(9, 9, 50);
  const set = (x, y, value) => {
    samples[y * 9 + x] = value;
  };
  set(4, 4, 999);
  set(2, 4, 1);
  set(6, 4, 1.2);
  set(4, 2, 0);
  set(4, 6, 10);
  set(2, 2, 0);
  set(6, 6, 20);
  set(6, 2, 0);
  set(2, 6, 30);
  const result = correctExplicitDefectPixels({
    width: 9,
    height: 9,
    samples,
    points: [{x: 4, y: 4}],
  });
  assert.equal(result.samples[4 * 9 + 4], 1.1);
});

test('uses the median same-phase fallback at an image boundary', () => {
  const samples = uniform(3, 3);
  samples[0] = 999;
  samples[2] = 2;
  samples[6] = 4;
  samples[8] = 100;
  const result = correctExplicitDefectPixels({
    width: 3,
    height: 3,
    samples,
    points: [{x: 0, y: 0}],
  });
  assert.equal(result.samples[0], 4);
});

test('excludes every listed defect from interpolation sources', () => {
  const samples = uniform(7, 7);
  samples[2 * 7 + 2] = 99;
  samples[2 * 7 + 4] = 88;
  const result = correctExplicitDefectPixels({
    width: 7,
    height: 7,
    samples,
    points: [{x: 2, y: 2}, {x: 4, y: 2}],
  });
  assert.equal(result.correctedCount, 2);
  assert.equal(result.samples[2 * 7 + 2], 1);
  assert.equal(result.samples[2 * 7 + 4], 1);
});

test('rejects duplicate and out-of-bounds coordinates', () => {
  assert.throws(
      () => correctExplicitDefectPixels({
        width: 2,
        height: 2,
        samples: uniform(2, 2),
        points: [{x: 1, y: 1}, {x: 1, y: 1}],
      }),
      RawDefectPixelReferenceError);
  assert.throws(
      () => correctExplicitDefectPixels({
        width: 2,
        height: 2,
        samples: uniform(2, 2),
        points: [{x: 2, y: 0}],
      }),
      RawDefectPixelReferenceError);
});
