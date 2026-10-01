import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const regularizer=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_map_regularizer.dart',import.meta.url),
  'utf8',
);
const order=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_depth_order.dart',import.meta.url),
  'utf8',
);

test('high-confidence labels are protected anchors',()=>{
  assert.match(regularizer,/confidence\[index\] >= anchorConfidence/);
});

test('regularizer uses observed ordinal median plus majority support',()=>{
  assert.match(regularizer,/_sortWeightedLabels/);
  assert.match(regularizer,/final double half = totalWeight \* 0\.5/);
  assert.match(regularizer,/candidateFraction <= 0\.5/);
  assert.doesNotMatch(regularizer,/averageLabel|meanLabel/);
});

test('full-resolution regularization reuses typed neighbor buffers',()=>{
  assert.match(regularizer,/final Int32List neighborLabels/);
  assert.match(regularizer,/final Float64List neighborWeights/);
  assert.doesNotMatch(regularizer,/List<_WeightedLabel>/);
});

test('first regularization pass reads input without an eager full-plane copy',()=>{
  assert.match(regularizer,/Int32List labels = input\.frameIndices/);
  assert.match(regularizer,/Float32List confidence = input\.confidence/);
  assert.match(regularizer,/nextLabels = Int32List\.fromList\(labels\)/);
  assert.match(regularizer,/nextConfidence = Float32List\.fromList\(confidence\)/);
});

test('owned final-stack maps alternate two typed buffer pairs',()=>{
  assert.match(regularizer,/reuseInputBuffers/);
  assert.match(regularizer,/currentIsInput \? alternateLabels! : input\.frameIndices/);
  assert.match(regularizer,/nextLabels\.setAll\(0, labels\)/);
});

test('order refinement considers only immediately adjacent focus frames',()=>{
  assert.match(order,/<int>\[current - 1, current \+ 1\]/);
  assert.doesNotMatch(order,/current - 2|current \+ 2/);
});
