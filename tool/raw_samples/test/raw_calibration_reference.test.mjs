import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calibrateRawSample,
  calibrateSamplePoints,
  rawCalibrationParameters,
  RawCalibrationReferenceError,
} from '../raw_calibration_reference.mjs';

const metadata = {
  activeArea: {left: 0, top: 0},
  blackLevels: [10, 20, 30, 40],
  whiteLevel: 100,
  cameraWhiteBalance: [2, 1, 1, 1.5],
};

test('uses maximum black level for DNG-compatible normalization', () => {
  const parameters = rawCalibrationParameters(metadata);
  assert.equal(parameters.normalizationScale, 1 / 60);
  assert.deepEqual(parameters.gains, [2, 1, 1, 1.5]);
});

test('applies black subtraction, normalization, and CFA white balance', () => {
  const values = calibrateSamplePoints([
    {x: 0, y: 0, value: 55},
    {x: 1, y: 0, value: 60},
    {x: 0, y: 1, value: 65},
    {x: 1, y: 1, value: 70},
  ], metadata).map((point) => point.value);
  assert.deepEqual(values, [1.5, 2 / 3, 7 / 12, 0.75]);
});

test('anchors black pattern to ActiveArea and WB pattern to image CFA', () => {
  const value = calibrateRawSample({
    value: 100,
    x: 0,
    y: 0,
    activeLeft: 1,
    activeTop: 1,
    blackLevels: [10, 20, 30, 40],
    whiteLevel: 200,
    cameraWhiteBalance: [2, 3, 4, 5],
  });
  assert.equal(value, (100 - 40) / (200 - 40) * 2);
});

test('preserves negative values but clips sensor overrange before white balance', () => {
  const shadow = calibrateRawSample({
    ...metadata,
    value: 5,
    x: 0,
    y: 0,
  });
  const highlight = calibrateRawSample({
    ...metadata,
    value: 150,
    x: 0,
    y: 0,
  });
  assert.ok(shadow < 0);
  assert.equal(highlight, 2);
  const highlightWithoutWhiteBalance = calibrateRawSample({
    blackLevels: metadata.blackLevels,
    whiteLevel: metadata.whiteLevel,
    value: 150,
    x: 0,
    y: 0,
  });
  assert.equal(highlightWithoutWhiteBalance, 1);
});

test('rejects invalid level and gain metadata', () => {
  assert.throws(
      () => rawCalibrationParameters({
        blackLevels: [0, 0, 0, 100],
        whiteLevel: 100,
      }),
      RawCalibrationReferenceError);
  assert.throws(
      () => rawCalibrationParameters({
        blackLevels: [0, 0, 0, 0],
        whiteLevel: 100,
        cameraWhiteBalance: [1, 0, 1, 1],
      }),
      RawCalibrationReferenceError);
});

test('applies DNG linearization before black subtraction and clamps table overflow to last entry', () => {
  const common = {
    x: 0,
    y: 0,
    blackLevels: [10, 10, 10, 10],
    whiteLevel: 100,
    linearizationTable: [0, 20, 40, 80],
  };
  assert.ok(Math.abs(calibrateRawSample({...common, value: 2}) - ((40 - 10) / 90)) < 1e-12);
  assert.ok(Math.abs(calibrateRawSample({...common, value: 99}) - ((80 - 10) / 90)) < 1e-12);
});

test('adds horizontal and vertical black deltas before normalization', () => {
  const value = calibrateRawSample({
    value: 80,
    x: 1,
    y: 1,
    blackLevels: [10, 20, 30, 40],
    blackLevelDeltaH: [1, 5],
    blackLevelDeltaV: [2, 7],
    width: 2,
    height: 2,
    whiteLevel: 120,
  });
  // Computed black at (1,1) is 40+5+7=52. Maximum computed black is also 52.
  assert.equal(value, (80 - 52) / (120 - 52));
});

test('normalization uses maximum computed black level including deltas', () => {
  const parameters = rawCalibrationParameters({
    blackLevels: [10, 20, 30, 40],
    blackLevelDeltaH: [0, 6],
    blackLevelDeltaV: [0, 8],
    width: 2,
    height: 2,
    whiteLevel: 120,
  });
  assert.equal(parameters.normalizationScale, 1 / (120 - 54));
});
