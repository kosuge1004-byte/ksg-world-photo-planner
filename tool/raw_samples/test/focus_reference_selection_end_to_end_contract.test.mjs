import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const screen = fs.readFileSync(
  new URL('lib/features/focus_stack/focus_stack_screen.dart', root),
  'utf8',
);
const marking = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_marking_analysis_pipeline.dart', root),
  'utf8',
);
const stack = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_stack_pipeline.dart', root),
  'utf8',
);
const model = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_marking_preview_model.dart', root),
  'utf8',
);
const review = fs.readFileSync(
  new URL('lib/features/focus_stack/focus_marking_review_screen.dart', root),
  'utf8',
);

test('focus stack UI exposes a dedicated reference-photo selection page', () => {
  assert.match(screen, /class _FocusReferenceSelectionScreen/);
  assert.match(screen, /基準写真を選択/);
  assert.match(screen, /この写真を基準にする/);
  assert.match(screen, /_ReferenceSelectionCard/);
  assert.match(screen, /_referencePath/);
});

test('selected reference index is passed to marking and final stack', () => {
  assert.match(screen, /referenceIndex:\s*referenceIndex/);
  assert.match(screen, /referenceIndex:\s*selectedReferenceIndex/);
  assert.match(marking, /int referenceIndex = 0/);
  assert.match(stack, /int referenceIndex = 0/);
});

test('marking pipeline preserves original frame order while using selected reference', () => {
  assert.match(marking, /referenceStore = stores\[referenceIndex\]/);
  assert.match(marking, /previewSlots\[referenceIndex\]/);
  assert.match(marking, /scoreSlots\[referenceIndex\]/);
  assert.match(marking, /for \(int index = 0; index < stores\.length; index\+\+\)/);
  assert.match(marking, /if \(index == referenceIndex\) continue/);
});

test('final stack preserves original frame order while selected reference gets identity transform', () => {
  assert.match(stack, /referenceStore = decodedStores\[referenceIndex\]/);
  assert.match(stack, /transformSlots\[referenceIndex\] = AffineSamplingTransform\.identity\(\)/);
  assert.match(stack, /measureSlots\[referenceIndex\] = referenceMeasureFile/);
  assert.match(stack, /if \(index == referenceIndex\) continue/);
});

test('review marks reference and prevents its exclusion', () => {
  assert.match(model, /final bool isReference/);
  assert.match(model, /frames\[frameIndex\]\.isReference && !selected/);
  assert.match(model, /selected\[referenceFrameIndex\] = true/);
  assert.match(review, /基準写真は深度合成から除外できません/);
  assert.match(review, /onChanged:\s*frame\.isReference\s*\?\s*null/s);
  assert.match(review, /'基準'/);
});
