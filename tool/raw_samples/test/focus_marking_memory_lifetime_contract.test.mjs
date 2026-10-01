import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const source = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_marking_analysis_pipeline.dart', root),
  'utf8',
);

test('focus marking reference uses null as the all-valid mask', () => {
  assert.doesNotMatch(source, /final Uint8List referenceCoverage/);
  const referenceBlock = source.slice(
    source.indexOf('final File referenceScoreFile'),
    source.indexOf('combinedScoreFiles.add(referenceScoreFile)'),
  );
  assert.match(referenceBlock, /validMask:\s*null/);
  assert.match(source, /final List<File\?> maskFiles = List<File\?>\.filled\(inputs\.length, null\)/);
});

test('focus marking releases source luminance before aligned allocation', () => {
  const loop = source.indexOf('for (int index = 0; index < stores.length; index++)');
  const estimate = source.indexOf('estimateFocusAlignmentFromLuminance(', loop);
  const release = source.indexOf('sourceLuminance = null;', estimate);
  const resample = source.indexOf('resampleFocusLuminanceForMarking(', release);
  assert.ok(loop >= 0 && estimate > loop);
  assert.ok(release > estimate);
  assert.ok(resample > release);
});
