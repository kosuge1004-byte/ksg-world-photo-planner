import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('registration weight requires a finite half-weight radius', () => {
  const source = readFileSync(
    new URL('../../../lib/core/stacking/registration_quality_weight.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /residualHalfWeightRadius\.isFinite/);
  assert.match(source, /Registration weighting produced an invalid result/);
});

test('comprehensive frame weight requires finite quality scale parameters', () => {
  const source = readFileSync(
    new URL('../../../lib/core/stacking/comprehensive_frame_quality_weight.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /roundnessHalfWeight\.isFinite/);
  assert.match(source, /countShortfallHalfWeightFraction\.isFinite/);
  assert.match(source, /Combined frame quality weight is invalid/);
});
