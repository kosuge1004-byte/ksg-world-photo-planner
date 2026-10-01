import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Dart robust CFA combine rejects malformed/non-finite inputs', () => {
  const source = readFileSync(
    new URL('../../../lib/core/drizzle/robust_combine_cfa_drizzle.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /channel lengths must match image dimensions/);
  assert.match(source, /values must be finite and coverage must be finite and non-negative/);
  assert.match(source, /non-finite center or spread/);
  assert.match(source, /non-finite output/);
});

test('tiled robust CFA combine prevents Float64 to Float32 overflow', () => {
  const source = readFileSync(
    new URL('../../../lib/core/drizzle/tiled_robust_combine_cfa_drizzle.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /maximumFloat32 = 3\.4028234663852886e38/);
  assert.match(source, /output exceeds finite Float32 range/);
});
