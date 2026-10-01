import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Dart star-transform estimator validates release-mode parameters and final output', () => {
  const source = readFileSync(
    new URL('../../../lib/core/registration/star_transform_estimator.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Star-transform parameters must be finite and within valid ranges/);
  assert.match(source, /Estimated star transform contains non-finite parameters/);
  assert.match(source, /maxAcceptableRmsResidual\.isFinite/);
});

test('shared similarity math validates transform and point finiteness', () => {
  const source = readFileSync(
    new URL('../../../lib/core/registration/similarity_transform_math.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Similarity transform parameters must be finite/);
  assert.match(source, /Similarity transform point coordinates must be finite/);
});

test('local residual fit/evaluate and iterative inverse reject non-finite state', () => {
  const residual = readFileSync(
    new URL('../../../lib/core/registration/local_residual_correction.dart', import.meta.url),
    'utf8',
  );
  const inverse = readFileSync(
    new URL('../../../lib/core/registration/invert_similarity_transform_with_local_correction.dart', import.meta.url),
    'utf8',
  );
  assert.match(residual, /Local residual matches must contain only finite values/);
  assert.match(residual, /Local residual evaluation coordinates must be finite/);
  assert.match(inverse, /Initial inverse-transform guess must be finite/);
  assert.match(inverse, /Local-correction inversion produced a non-finite prediction/);
});
