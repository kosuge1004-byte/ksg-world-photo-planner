import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('production Linear DNG writer keeps mask SubIFDs independent from the thumbnail NextIFD chain', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /writeEntry\(\s*330,\s*longType,\s*subIfdCount,\s*subIfdOffsetsArrayOffset/,
  );
  assert.match(
    source,
    /writeEntry\(\s*330,\s*ifd8Type,\s*subIfdCount,\s*subIfdOffsetsArrayOffset/,
  );
  assert.match(source, /transparencyMaskDataOffset/);
  assert.match(source, /SubIFDs -> thumbnail first, then transparency mask/);
  assert.doesNotMatch(source, /subIfdValueOffset/);
  assert.doesNotMatch(source, /nextIfdPointerOffset/);
});

test('Classic and BigTIFF mask IFDs themselves terminate with NextIFD zero', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /data\.setUint32\(e,\s*0,\s*Endian\.little\)/);
  assert.match(source, /data\.setUint64\(e,\s*0,\s*Endian\.little\)/);
});
