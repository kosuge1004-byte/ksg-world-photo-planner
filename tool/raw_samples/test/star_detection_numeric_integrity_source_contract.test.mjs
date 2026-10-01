import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Dart star detector rejects non-finite luminance and runtime parameter corruption', () => {
  const source = readFileSync(
    new URL('../../../lib/core/registration/star_detector.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Star-detection source must contain only finite luminance samples/);
  assert.match(source, /Star-detection parameters must be finite and within valid ranges/);
  assert.match(source, /thresholdSigma\.isFinite/);
  assert.match(source, /noiseFloorSigma\.isFinite/);
});

test('Dart Gaussian PSF refinement validates finite inputs and peak bounds', () => {
  const source = readFileSync(
    new URL('../../../lib/core/registration/gaussian_psf_centroid_refinement.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /PSF refinement requires finite luminance and centroid inputs/);
  assert.match(source, /PSF peak coordinates must lie inside the source image/);
  assert.match(source, /source\.samples\.any/);
});
