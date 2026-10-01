import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const weights=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_blend_weights.dart',import.meta.url),
  'utf8',
);
const blender=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_blender.dart',import.meta.url),
  'utf8',
);

test('secondary candidates are limited to immediately adjacent focus frames',()=>{
  assert.match(weights,/<int>\[winner - 1, winner \+ 1\]/);
  assert.doesNotMatch(weights,/winner - 2|winner \+ 2/);
});

test('high-confidence winner stays hard selected',()=>{
  assert.match(weights,/confidence >= hardWinnerConfidence/);
  assert.match(weights,/destination\[destinationOffset \+ winner\] = 1/);
});

test('secondary weight is attenuated by aligned RGB mismatch',()=>{
  assert.match(weights,/haloAttenuation/);
  assert.match(weights,/_relativeRgbDifference/);
});

test('final blend is weighted linear RGB with coverage preservation',()=>{
  assert.match(blender,/blendAlignedFocusFramesMemoryBounded/);
  assert.match(blender,/frameWeights\.fillRange\(0, frameWeights\.length, 0\)/);
  assert.match(blender,/final Float32List output = frames\[0\]\.interleavedRgb/);
  assert.match(blender,/final Uint8List coverage = frames\[0\]\.coverage/);
  assert.match(blender,/r \+= frame\.interleavedRgb\[base\] \* weight/);
  assert.match(blender,/g \+= frame\.interleavedRgb\[base \+ 1\] \* weight/);
  assert.match(blender,/b \+= frame\.interleavedRgb\[base \+ 2\] \* weight/);
  assert.match(blender,/if \(!\(usedWeight > 0\)\) \{/);
  assert.match(blender,/output\[outBase \+ 2\] = 0/);
  assert.match(blender,/coverage\[pixel\] = 1/);
});
