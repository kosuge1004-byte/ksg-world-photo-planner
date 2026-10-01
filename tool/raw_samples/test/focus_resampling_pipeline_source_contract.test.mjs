import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pipeline = readFileSync(
  new URL('../../../lib/core/focus_stack/focus_frame_alignment_pipeline.dart', import.meta.url),
  'utf8',
);
const measure = readFileSync(
  new URL('../../../lib/core/focus_stack/focus_measure.dart', import.meta.url),
  'utf8',
);

test('focus alignment paths use bicubic sampling with the combined transform', () => {
  assert.match(pipeline, /ResamplingInterpolation\.bicubic/);
  assert.match(pipeline, /correspondence\.alignment\.toSamplingTransform\(\)/);
  // Work233 has two production paths: the compatibility combined path and the
  // split marking path that releases source luminance before aligned allocation.
  assert.equal((pipeline.match(/resampler\.sampleTile\(/g) ?? []).length, 2);
  assert.equal((pipeline.match(/ResamplingInterpolation\.bicubic/g) ?? []).length, 2);
  assert.doesNotMatch(pipeline, /\bresizeImage\s*\(|\bdownsampleImage\s*\(/);
});

test('marking-only alignment retains green luminance instead of full RGB', () => {
  assert.match(pipeline, /alignFocusLuminanceForMarking/);
  assert.match(pipeline, /_FocusAlignmentOutput\.greenLuminance/);
  assert.match(pipeline, /pixels \* \(luminanceOnly \? 1 : 3\)/);
  assert.match(pipeline, /outputSamples\[globalPixel\]/);
});

test('aligned coverage is propagated into focus measurement', () => {
  assert.match(pipeline, /validMask:\s*alignedFrame\.coverage/);
  assert.match(measure, /Uint8List\? validMask/);
  assert.match(measure, /responseValid/);
  assert.match(measure, /validCount/);
});

test('invalid resampling borders cannot become false high-focus derivative stencils', () => {
  assert.match(measure, /validMask\[index - 1\] != 0/);
  assert.match(measure, /validMask\[index \+ 1\] != 0/);
  assert.match(measure, /validMask\[index - width\] != 0/);
  assert.match(measure, /validMask\[index \+ width\] != 0/);
});
