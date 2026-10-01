import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../../lib/core/color/raw_camera_color_profile.dart', import.meta.url),
  'utf8',
);

test('camera-color consensus breaks equal-size compatibility groups by matrix medoid distance', () => {
  assert.match(source, /smallestGroupMatrixDistance/);
  assert.match(source, /groupMatrixDistance\s*\+=\s*delta\s*\*\s*delta/);
  assert.match(source, /compatibleIndices\.length\s*==\s*largestGroupSize/);
  assert.match(source, /groupMatrixDistance\s*<\s*smallestGroupMatrixDistance/);
});

test('camera-color consensus keeps an actually observed representative matrix', () => {
  assert.match(source, /d65XyzToCamera:\s*representative\.d65XyzToCamera/);
});
