import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const regularizer=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_map_regularizer.dart',import.meta.url),
  'utf8',
);
const pipeline=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_stack_pipeline.dart',import.meta.url),
  'utf8',
);

test('production focus stack uses file-backed two-pass regularization',()=>{
  assert.match(pipeline,/await regularizeFileBackedFocusWinnerMapTwoPass\(/);
  assert.doesNotMatch(pipeline,/regularizeFocusWinnerMap\(\s*winners,\s*reuseInputBuffers:\s*true/);
});

test('file-backed regularization keeps only row neighborhoods resident',()=>{
  assert.match(regularizer,/labels-pass1\.i32/);
  assert.match(regularizer,/confidence-pass1\.f32/);
  assert.match(regularizer,/final Map<int, _RegularizerRow> rows/);
  assert.match(regularizer,/rows\.removeWhere/);
  assert.doesNotMatch(regularizer,/regularizeFocusWinnerMapFileBackedTwoPass[\s\S]*alternateLabels/);
});

test('file-backed pass preserves Float32 confidence and Int32 labels',()=>{
  assert.match(regularizer,/final Int32List outputLabels = Int32List\(width\)/);
  assert.match(regularizer,/final Float32List outputConfidence = Float32List\(width\)/);
  assert.match(regularizer,/await _readExact\(labelsReader, labels\.buffer\.asUint8List\(\)\)/);
  assert.match(regularizer,/await _readExact\(confidenceReader, confidence\.buffer\.asUint8List\(\)\)/);
});
