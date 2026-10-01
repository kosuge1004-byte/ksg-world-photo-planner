import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('reference focus measure does not allocate a full-resolution all-valid coverage mask', () => {
  const source = fs.readFileSync(
    new URL('../lib/core/focus_stack/focus_stack_pipeline.dart', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /final Uint8List referenceCoverage/);
  const referenceBlock = source.slice(
    source.indexOf('final File referenceMeasureFile'),
    source.indexOf('measureFiles.add(referenceMeasureFile)'),
  );
  assert.match(referenceBlock, /validMask:\s*null/);
});
