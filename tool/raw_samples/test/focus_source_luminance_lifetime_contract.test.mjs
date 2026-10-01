import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const pipeline = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_stack_pipeline.dart', root),
  'utf8',
);
const alignment = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_frame_alignment_pipeline.dart', root),
  'utf8',
);

test('focus pipeline releases source luminance before allocating aligned luminance', () => {
  const estimate = pipeline.indexOf('estimateFocusAlignmentFromLuminance(');
  const release = pipeline.indexOf('sourceLuminance = null;', estimate);
  const resample = pipeline.indexOf('resampleFocusLuminanceForMarking(', release);
  assert.ok(estimate >= 0, 'correspondence estimation must remain explicit');
  assert.ok(release > estimate, 'source luminance must be released after correspondence');
  assert.ok(resample > release, 'aligned allocation must happen after source release');
});

test('split marking resampler preserves production bicubic sampling and green-channel extraction', () => {
  const start = alignment.indexOf('Future<FocusAlignedLuminanceResult> resampleFocusLuminanceForMarking');
  assert.ok(start >= 0);
  const body = alignment.slice(start, alignment.indexOf('/// Align one source frame', start));
  assert.match(body, /ResamplingInterpolation\.bicubic/);
  assert.match(body, /transform \?\? correspondence!\.alignment\.toSamplingTransform\(\)/);
  assert.match(body, /interleavedRgb\[localPixel \* 3 \+ 1\]/);
  assert.match(body, /coverage\[globalPixel\] = sampled\.coverage\[localPixel\]/);
});
