import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const marking = fs.readFileSync(
  new URL('lib/core/focus_stack/high_precision_focus_marking.dart', root),
  'utf8',
);
const analysis = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_marking_analysis_pipeline.dart', root),
  'utf8',
);

test('retainConfidence false avoids allocating the full-resolution Float32 plane', () => {
  const start = marking.indexOf('Future<HighPrecisionFocusMarking> buildHighPrecisionFocusMarkingFromScoreFiles');
  const end = marking.indexOf('Future<double> _sceneNoiseFloorFromScoreFiles', start);
  const body = marking.slice(start, end);
  assert.match(body, /retainConfidence \? Float32List\(pixels\) : Float32List\(0\)/);
  assert.doesNotMatch(body, /final Float32List displayConfidence = Float32List\(pixels\)/);
});

test('production analysis still disables retained confidence', () => {
  assert.match(analysis, /retainConfidence:\s*false/);
});
