import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const analysis = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_marking_analysis_pipeline.dart', root),
  'utf8',
);
const marking = fs.readFileSync(
  new URL('lib/core/focus_stack/high_precision_focus_marking.dart', root),
  'utf8',
);

test('production marking writes non-reference coverage to temp files instead of retaining full masks', () => {
  assert.match(analysis, /final List<File\?> maskFiles = List<File\?>\.filled\(inputs\.length, null\)/);
  assert.match(analysis, /frame-\$index\.mask\.u8/);
  assert.match(analysis, /await maskWriter\.writeFrom\(aligned\.coverage\)/);
  assert.match(analysis, /validMaskFiles:\s*maskFiles/);
  assert.doesNotMatch(analysis, /masks\.add\(aligned\.coverage\)/);
});

test('file-backed marking consumes coverage in bounded chunks', () => {
  assert.match(marking, /List<File\?>\? validMaskFiles/);
  assert.match(marking, /maskReaders/);
  assert.match(marking, /Uint8List\(chunkCapacity\)/);
  assert.match(marking, /_readExactBytes\(\s*reader,\s*maskChunks\[frame\],\s*currentChunkPixels/s);
  assert.match(marking, /maskChunks\[frame\]\[localPixel\] != 0/);
});
