import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Dart covered RGB tiles enforce binary coverage', () => {
  const source = readFileSync(
    new URL('../../../lib/core/registration/tiled_affine_rgb_resampler.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Coverage must be binary/);
  assert.match(source, /value != 0 && value != 1/);
});

test('Dart contribution count guards Uint16 overflow', () => {
  const source = readFileSync(
    new URL('../../../lib/core/stacking/tiled_kappa_sigma_combiner.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Stack contribution counter overflow/);
  assert.match(source, /finalCounts\[index\] == 65535/);
});
