import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TiledStackingCancelled,
  combineCoveredRgb,
} from '../tiled_kappa_sigma_reference.mjs';

function covered(red, green = red, blue = red, coverage = 1) {
  return {
    rgb: new Float32Array([red, green, blue]),
    coverage: new Uint8Array([coverage]),
  };
}

test('uses FP64 frame-weighted means', () => {
  const result = combineCoveredRgb({
    frames: [covered(1, 2, 3), covered(3, 4, 5)],
    frameWeights: [1, 3],
  });
  assert.deepEqual([...result.rgb], [2.5, 3.5, 4.5]);
  assert.deepEqual([...result.contributions], [2, 2, 2]);
});

test('iteratively rejects a one-frame outlier', () => {
  const result = combineCoveredRgb({
    frames: [covered(1), covered(1), covered(1), covered(1), covered(10)],
    frameWeights: [1, 1, 1, 1, 1],
    kappa: 1,
  });
  assert.deepEqual([...result.rgb], [1, 1, 1]);
  assert.deepEqual([...result.contributions], [4, 4, 4]);
});

test('does not mix uncovered observations as black samples', () => {
  const result = combineCoveredRgb({
    frames: [covered(2, 3, 4), covered(100, 100, 100, 0)],
    frameWeights: [1, 1],
  });
  assert.deepEqual([...result.rgb], [2, 3, 4]);
  assert.deepEqual([...result.contributions], [1, 1, 1]);
});

test('tracks rejection independently per RGB channel', () => {
  const result = combineCoveredRgb({
    frames: [
      covered(1, 2, 3), covered(1, 2, 3), covered(1, 2, 3),
      covered(1, 2, 3), covered(1, 2, 30),
    ],
    frameWeights: [1, 1, 1, 1, 1],
    kappa: 1,
  });
  assert.deepEqual([...result.rgb], [1, 2, 3]);
  assert.deepEqual([...result.contributions], [5, 5, 4]);
});

test('does not clip below the minimum survivor count', () => {
  const result = combineCoveredRgb({
    frames: [covered(0), covered(10)],
    frameWeights: [1, 1],
    kappa: 0.1,
    minimumSurvivingFrames: 2,
  });
  assert.deepEqual([...result.rgb], [5, 5, 5]);
  assert.deepEqual([...result.contributions], [2, 2, 2]);
});

test('rejects cancellation, invalid weights, and non-finite RGB', () => {
  assert.throws(
    () => combineCoveredRgb({
      frames: [covered(1)],
      frameWeights: [1],
      isCancelled: () => true,
    }),
    TiledStackingCancelled,
  );
  assert.throws(
    () => combineCoveredRgb({frames: [covered(1)], frameWeights: [0]}),
    /weights/,
  );
  assert.throws(
    () => combineCoveredRgb({
      frames: [{rgb: new Float32Array([Number.NaN, 1, 1]),
        coverage: new Uint8Array([1])}],
      frameWeights: [1],
    }),
    /covered RGB/,
  );
});


test('coverage is strictly binary because nonzero means fully valid', () => {
  const frames = [{
    rgb: new Float32Array([1, 1, 1]),
    coverage: new Uint8Array([2]),
  }];
  assert.throws(
    () => combineCoveredRgb({
      frames,
      frameWeights: [1],
      minimumSurvivingFrames: 1,
    }),
    /Invalid covered RGB frame/,
  );
});
