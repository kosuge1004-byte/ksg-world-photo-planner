import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('native CFA reconstruction guards Float32 downcast', () => {
  const source = readFileSync(
    new URL('../../../lib/core/drizzle/reconstruct_native_cfa_from_drizzle.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Reconstructed CFA sample exceeds finite Float32 range/);
  assert.match(source, /value\.abs\(\) > maximumFloat32/);
});

test('tiled CFA reconstruction validates stores before processing', () => {
  const source = readFileSync(
    new URL('../../../lib/core/drizzle/tiled_reconstruct_native_cfa_from_drizzle.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Saturation coverage must be finite and non-negative/);
  assert.match(source, /Drizzle reconstruction input must contain finite values/);
  assert.match(source, /coverage < 0/);
});
