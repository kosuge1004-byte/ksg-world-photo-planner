import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const analysis=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_marking_analysis_pipeline.dart',import.meta.url),
  'utf8',
);
const exact=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_exact_preview.dart',import.meta.url),
  'utf8',
);
const model=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_marking_preview_model.dart',import.meta.url),
  'utf8',
);
const review=readFileSync(
  new URL('../../../lib/features/focus_stack/focus_marking_review_screen.dart',import.meta.url),
  'utf8',
);
const screen=readFileSync(
  new URL('../../../lib/features/focus_stack/focus_stack_screen.dart',import.meta.url),
  'utf8',
);

test('precision-critical central review preview is derived from aligned analysis coordinates',()=>{
  assert.match(analysis,/buildExactFocusPreview/);
  assert.match(analysis,/alignedLuminance/);
  assert.match(model,/exactPreviewLuminance8/);
  assert.match(review,/_ExactFocusPreviewImage/);
  const start=review.indexOf('class _FocusPreviewImage');
  const end=review.indexOf('class _ExactFocusPreviewImage');
  assert.ok(start>=0 && end>start);
  const centralPreview=review.slice(start,end);
  assert.doesNotMatch(centralPreview,/Image\.memory/);
  assert.match(centralPreview,/_ExactFocusPreviewImage/);
});

test('exact preview is display-only and does not feed focus measurement or blending',()=>{
  assert.match(exact,/display-only/i);
  assert.doesNotMatch(exact,/modifiedLaplacianFocusMeasure|blendAlignedFocusFrames/);
});

test('completed-result message reflects that Linear DNG save is already connected',()=>{
  assert.match(screen,/await exportFocusStackResult\(/);
  assert.match(screen,/label: Text\(saving \? '保存中' : '\$\{outputFormat\.label\}として保存'\)/);
  assert.doesNotMatch(screen,/Linear DNG出力は次工程で接続します/);
});

test('user selection remains the only frame subset sent to final stack',()=>{
  assert.match(screen,/_runConfirmedStack\([\s\S]*?confirmed\.selectedInputs,[\s\S]*?referencePath:\s*_referencePath!/);
  assert.match(screen,/inputs: selectedInputs/);
});
