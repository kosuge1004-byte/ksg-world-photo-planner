import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('dual alignment validates release-mode thresholds and dimensions', () => {
  const source = readFileSync(
    new URL('../../../lib/core/registration/adaptive_dual_alignment_resampler.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /identityAdvantageRatio\.isFinite/);
  assert.match(source, /absoluteDifferenceFloor\.isFinite/);
  assert.match(source, /relativeDifferenceFloor\.isFinite/);
  assert.match(source, /Reference\/source dimensions must match the output image/);
  assert.match(source, /Reference invalid-mask dimensions/);
  assert.match(source, /Source invalid-mask dimensions/);
});

test('dual alignment rejects non-finite reference or identity samples', () => {
  const source = readFileSync(
    new URL('../../../lib/core/registration/adaptive_dual_alignment_resampler.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Adaptive dual alignment received a non-finite RGB sample/);
});

test('affine RGB resampler never marks non-finite interpolation output covered', () => {
  const source = readFileSync(
    new URL('../../../lib/core/registration/tiled_affine_rgb_resampler.dart', import.meta.url),
    'utf8',
  );
  const check = source.indexOf('RGB resampling produced a non-finite covered sample.');
  const coverage = source.indexOf('coverage[outputPixel] = 1;', check);
  assert.ok(check >= 0);
  assert.ok(coverage > check);
});
