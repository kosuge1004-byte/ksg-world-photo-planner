import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const writer = readFileSync(new URL('lib/core/export/linear_dng_writer.dart', root), 'utf8');
const focusExport = readFileSync(new URL('lib/core/focus_stack/focus_stack_linear_dng_export.dart', root), 'utf8');

test('focus-stack DNG export streams its existing file-backed coverage mask', () => {
  assert.match(
    focusExport,
    /transparencyMaskSource:\s*result\.coverageMask/,
    'focus-stack export must pass the existing coverage plane directly',
  );
  assert.doesNotMatch(
    focusExport,
    /Uint8List\s*\(\s*result\.coverage\.length\s*\)/,
    'focus-stack export must not duplicate the full-resolution coverage plane',
  );
});

test('Linear DNG writer converts 0/1 validity to 0/255 in bounded chunks', () => {
  assert.match(writer, /Uint8List\?\s+binaryValidityMask/);
  assert.match(writer, /\(transparencyMask != null \? 1 : 0\)[\s\S]{0,200}\(binaryValidityMask != null \? 1 : 0\)/);
  assert.match(writer, /if \(maskSources > 1\)/);
  assert.match(writer, /binaryValidityMask\.any\(\(int value\) => value != 0 && value != 1\)/);
  assert.match(writer, /const int maskChunkBytes = 262144/);
  assert.match(writer, /encodedMask\[index\] = source\[offset \+ index\] == 0 \? 0 : 255/);
  assert.match(writer, /if \(isCancelled\?\.call\(\) \?\? false\)/);
  assert.match(writer, /sink\.add\(Uint8List\.sublistView\(encodedMask, 0, count\)\);[\s\S]{0,300}await sink\.flush\(\);/);
});
