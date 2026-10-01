import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../../lib/core/color/dng_d65_color_transform.dart', import.meta.url),
  'utf8',
);

test('DNG camera-matrix inversion rejects excessive numerical condition number', () => {
  assert.match(source, /_matrixInfinityNorm\(matrix\)/);
  assert.match(source, /_matrixInfinityNorm\(inverse\)/);
  assert.match(source, /conditionNumber\s*=\s*matrixInfinityNorm\s*\*\s*inverseInfinityNorm/);
  assert.match(source, /conditionNumber\s*>\s*_maximumColorMatrixConditionNumber/);
  assert.match(source, /_maximumColorMatrixConditionNumber\s*=\s*1e6/);
});
