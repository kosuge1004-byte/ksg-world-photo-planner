import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Dart DNG validity requires surviving R, G and B contributions', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_validity.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /interleavedCounts\[base\] > 0/);
  assert.match(source, /interleavedCounts\[base \+ 1\] > 0/);
  assert.match(source, /interleavedCounts\[base \+ 2\] > 0/);
  assert.doesNotMatch(source, /interleavedRgb/);
});
