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

test('file-backed marking can skip retained confidence without changing mask confidence decisions', () => {
  assert.match(marking, /bool retainConfidence = true/);
  assert.match(marking, /retainConfidence \? Float32List\(pixels\) : Float32List\(0\)/);
  assert.match(marking, /if \(retainConfidence\) displayConfidence\[pixel\] = confidence/);
  assert.match(marking, /reliableWinner =\s*frame == winner && confidence >= minimumMarkConfidence/s);
  assert.match(marking, /reliableOverlap =\s*frame != winner && ratio >= acceptableBestScoreRatio/s);
});

test('production focus marking disables diagnostic confidence retention', () => {
  const call = analysis.slice(
    analysis.indexOf('buildHighPrecisionFocusMarkingFromScoreFiles('),
    analysis.indexOf('reportProgress?.call(', analysis.indexOf('buildHighPrecisionFocusMarkingFromScoreFiles(')),
  );
  assert.match(call, /retainConfidence:\s*false/);
});
