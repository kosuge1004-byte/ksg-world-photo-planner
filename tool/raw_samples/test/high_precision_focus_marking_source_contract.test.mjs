import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const marking=readFileSync(
  new URL('../../../lib/core/focus_stack/high_precision_focus_marking.dart',import.meta.url),
  'utf8',
);
const selection=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_frame_selection_policy.dart',import.meta.url),
  'utf8',
);
const screen=readFileSync(
  new URL('../../../lib/features/focus_stack/focus_stack_screen.dart',import.meta.url),
  'utf8',
);

test('marking uses multiple support radii, robust floor, and median fusion',()=>{
  assert.match(marking,/supportRadii = const <int>\[1, 2, 4\]/);
  assert.match(marking,/_robustPositiveNoiseFloor/);
  assert.match(marking,/_upperMedian\(normalized, normalizedCount\)/);
  assert.match(marking,/_selectKth\(positive, middle\)/);
  assert.match(marking,/Float64List normalized/);
  assert.match(marking,/Directory\.systemTemp\.createTemp/);
  assert.match(marking,/_writeFocusScale/);
  assert.match(marking,/writeModifiedLaplacianFocusMeasureFile/);
  assert.match(marking,/_robustPositiveNoiseFloorInPlace/);
  assert.match(marking,/buildHighPrecisionFocusMarkingFromScoreFiles/);
  assert.match(marking,/_sceneNoiseFloorFromScoreFiles/);
  assert.match(marking,/fusionChunkPixels/);
});

test('marking preserves reliable overlap for omission analysis',()=>{
  assert.match(marking,/acceptableBestScoreRatio/);
  assert.match(marking,/score \/ bestScore/);
  assert.match(marking,/reliableWinner/);
  assert.match(marking,/reliableOverlap/);
});

test('auto exclusion is optional and cannot remove all marked coverage',()=>{
  assert.match(selection,/required bool autoExclude/);
  assert.match(selection,/if \(!autoExclude\)/);
  assert.match(selection,/_allMarkedPixelsStillCovered/);
  assert.match(selection,/selectedCount <= 2/);
});

test('UI exposes both user-selectable omission options',()=>{
  assert.match(screen,/省略可能な写真を表示/);
  assert.match(screen,/省略可能な写真を自動除外/);
  assert.match(screen,/あとから個別にONへ戻せます/);
});
