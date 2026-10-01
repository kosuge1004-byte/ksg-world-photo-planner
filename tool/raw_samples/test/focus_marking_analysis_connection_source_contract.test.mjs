import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const analysis=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_marking_analysis_pipeline.dart',import.meta.url),
  'utf8',
);
const screen=readFileSync(
  new URL('../../../lib/features/focus_stack/focus_stack_screen.dart',import.meta.url),
  'utf8',
);
const review=readFileSync(
  new URL('../../../lib/features/focus_stack/focus_marking_review_screen.dart',import.meta.url),
  'utf8',
);

test('pre-composite analysis runs RAW decode, production demosaic, alignment and high-precision marking',()=>{
  assert.match(analysis,/rawDecoderRegistry\.requireDecoder/);
  assert.match(analysis,/demosaicReconstructedMosaic/);
  assert.match(analysis,/estimateFocusAlignmentFromLuminance/);
  assert.match(analysis,/resampleFocusLuminanceForMarking/);
  assert.doesNotMatch(analysis,/alignFocusFrameForMarking/);
  assert.doesNotMatch(analysis,/alignAndMeasureFocusFrame/);
  assert.match(analysis,/await writeHighPrecisionFocusFrameScoreFileBacked/);
  assert.match(analysis,/await buildHighPrecisionFocusMarkingFromScoreFiles/);
  assert.match(analysis,/mobile_stack_focus_scores_/);
  assert.doesNotMatch(analysis,/List<LuminancePlane\?> alignedLuminance/);
  assert.match(analysis,/buildExactFocusPreview\(aligned\.luminance\)/);
  assert.match(analysis,/alignedLuminance: aligned\.luminance/);
  assert.match(analysis,/buildHighPrecisionFocusMarking/);
  assert.match(analysis,/finally \{/);
  assert.match(analysis,/await store\.dispose\(\)/);
});

test('valid input button now launches analysis and review rather than an unfinished placeholder',()=>{
  assert.match(screen,/onPressed: validation\.isValid && !busy \? onPressed : null/);
  assert.match(screen,/合焦位置を解析/);
  assert.match(screen,/analyzeFocusMarking/);
  assert.match(screen,/FocusMarkingReviewScreen/);
});

test('confirmed user-selected inputs alone are passed to the actual focus-stack pipeline',()=>{
  assert.match(screen,/_runConfirmedStack\([\s\S]*?confirmed\.selectedInputs,[\s\S]*?referencePath:\s*_referencePath!/);
  assert.match(screen,/runFocusStackPipeline/);
  assert.match(screen,/inputs: selectedInputs/);
});

test('review overlay is projected into the same BoxFit.contain rectangle as the preview',()=>{
  assert.ok((review.match(/fit:\s*BoxFit\.contain/g) ?? []).length >= 2);
  assert.match(review,/outputWidth = frame\.exactPreviewWidth/);
  assert.match(review,/outputHeight = frame\.exactPreviewHeight/);
  assert.match(review,/frame\.markingWidth ~\/ outputWidth/);
  assert.match(review,/frame\.markingHeight ~\/ outputHeight/);
});

test('FocusStackScreen has only one review-launch method after Work220 corruption repair',()=>{
  assert.equal((screen.match(/Future<void> _analyzeAndReview\(/g) ?? []).length,1);
  assert.equal((screen.match(/class _BottomBar/g) ?? []).length,1);
});
