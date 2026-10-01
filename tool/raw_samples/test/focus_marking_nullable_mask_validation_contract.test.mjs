import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const source = fs.readFileSync(
  new URL('lib/core/focus_stack/high_precision_focus_marking.dart', root),
  'utf8',
);
const start = source.indexOf(
  'Future<HighPrecisionFocusMarking> buildHighPrecisionFocusMarkingFromScoreFiles',
);
const end = source.indexOf('final double sceneFloor', start);
const validation = source.slice(start, end);

test('nullable resident masks are iterated only inside the explicit null guard', () => {
  const guard = validation.indexOf('if (validMasks != null) {');
  const loop = validation.indexOf('for (final Uint8List? mask in validMasks)', guard);
  const fallback = validation.indexOf('} else {', loop);
  assert.ok(guard >= 0 && loop > guard && fallback > loop);
});

test('file-backed mask list validates exact full-resolution byte length', () => {
  assert.match(validation, /for \(final File\? maskFile in validMaskFiles!\)/);
  assert.match(validation, /await maskFile\.length\(\) != pixels/);
});
