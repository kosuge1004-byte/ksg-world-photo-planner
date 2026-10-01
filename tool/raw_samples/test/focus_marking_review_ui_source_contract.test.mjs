import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const model=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_marking_preview_model.dart',import.meta.url),
  'utf8',
);
const review=readFileSync(
  new URL('../../../lib/features/focus_stack/focus_marking_review_screen.dart',import.meta.url),
  'utf8',
);
const entry=readFileSync(
  new URL('../../../lib/features/focus_stack/focus_stack_screen.dart',import.meta.url),
  'utf8',
);

test('review model carries exact mask, omission flag and user selection',()=>{
  assert.match(model,/Uint8List markingMask/);
  assert.match(model,/final bool selected/);
  assert.match(model,/final bool omissionCandidate/);
  assert.match(model,/selectedCount/);
  assert.match(model,/selectedInputs/);
});

test('review UI overlays the binary focus mask on an exact-coordinate analysis preview',()=>{
  assert.match(review,/_ExactFocusPreviewImage/);
  assert.match(review,/RawImage/);
  assert.match(review,/_FocusMaskImage/);
  assert.match(review,/marked \/ count/);
  assert.match(review,/PixelFormat\.rgba8888/);
  assert.doesNotMatch(review,/canvas\.drawRect/);
});

test('user can toggle every frame and at least two frames are preserved',()=>{
  assert.match(review,/Checkbox\(/);
  assert.match(model,/length < 2/);
  assert.match(review,/深度合成には最低2枚必要です/);
});

test('review exposes marking visibility and omission-candidate state',()=>{
  assert.match(review,/マーキング/);
  assert.match(review,/省略候補/);
  assert.match(review,/showOmissionCandidate/);
});

test('focus-stack screen contains a live analysis-to-review navigation boundary',()=>{
  assert.match(entry,/FocusMarkingReviewScreen/);
  assert.match(entry,/_analyzeAndReview/);
  assert.match(entry,/analyzeFocusMarking/);
});
