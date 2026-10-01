import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const affine=readFileSync(
  new URL('../../../lib/core/registration/affine_sampling_transform.dart',import.meta.url),
  'utf8',
);
const focus=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_alignment_estimator.dart',import.meta.url),
  'utf8',
);

test('focus breathing is represented by one scaled-similarity sampling transform',()=>{
  assert.match(affine,/factory AffineSamplingTransform\.scaledSimilarity/);
  assert.match(focus,/AffineSamplingTransform\.scaledSimilarity/);
  assert.match(focus,/final double scale/);
  assert.match(focus,/final double rotationDegrees/);
  assert.match(focus,/final double sourceOffsetX/);
  assert.match(focus,/final double sourceOffsetY/);
});

test('focus alignment robustly refits after MAD residual rejection',()=>{
  assert.match(focus,/medianResidual/);
  assert.match(focus,/1\.4826/);
  assert.match(focus,/final List<FocusAlignmentMatch> inliers/);
  assert.match(focus,/_fitScaledSimilarity\(inliers\)/);
});

test('focus alignment fit is constrained to scaled similarity parameters',()=>{
  const fitClass = focus.match(/final class _Fit \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fitClass,/final double scale/);
  assert.match(fitClass,/final double rotationRadians/);
  assert.match(fitClass,/final double sourceOffsetX/);
  assert.match(fitClass,/final double sourceOffsetY/);
  assert.doesNotMatch(fitClass,/m00|m01|m10|m11|perspective/i);
});
