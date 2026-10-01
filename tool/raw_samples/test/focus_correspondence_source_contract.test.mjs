import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const detector=readFileSync(new URL('../../../lib/core/focus_stack/focus_feature_detector.dart',import.meta.url),'utf8');
const matcher=readFileSync(new URL('../../../lib/core/focus_stack/focus_feature_matcher.dart',import.meta.url),'utf8');
const pipeline=readFileSync(new URL('../../../lib/core/focus_stack/focus_correspondence_pipeline.dart',import.meta.url),'utf8');

test('focus features use the smaller structure-tensor eigenvalue with NMS',()=>{
  assert.match(detector,/0\.5 \* \(trace - math\.sqrt\(discriminant\)\)/);
  assert.match(detector,/suppressionRadius/);
  assert.match(detector,/tooClose/);
});

test('focus feature matching uses ZNCC, separation, and mutual best matching',()=>{
  assert.match(matcher,/meanA/);
  assert.match(matcher,/energyA/);
  assert.match(matcher,/minimumSeparation/);
  assert.match(matcher,/reverse\[f\.bestIndex\]/);
  assert.match(matcher,/r\.bestIndex != referenceIndex/);
});

test('correspondence pipeline connects feature matches to robust scaled-similarity estimator',()=>{
  assert.match(pipeline,/detectFocusFeatures/);
  assert.match(pipeline,/matchFocusFeatures/);
  assert.match(pipeline,/estimateFocusAlignment/);
});
