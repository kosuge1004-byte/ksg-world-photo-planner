import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Dart writer emits the required transparency-mask IFD tags', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /entry\(254,\s*longType,\s*1,\s*4\)/);
  assert.match(source, /entry\(262,\s*shortType,\s*1,\s*4\)/);
  assert.match(source, /entry\(258,\s*shortType,\s*1,\s*8\)/);
  assert.match(source, /entry\(277,\s*shortType,\s*1,\s*1\)/);
  assert.match(source, /includeTransparencyMask \? _align4\(cursor\) : null/);
  assert.match(source, /includeTransparencyMask \? _align8\(cursor\) : null/);
  assert.match(source, /_buildTransparencyMaskDirectory/);
  assert.match(source, /header\.transparencyMaskDataOffset/);
  assert.doesNotMatch(source, /subIfdValueOffset/);
  assert.doesNotMatch(source, /_buildTransparencyMaskTrailer/);
  assert.doesNotMatch(source, /header\.nextIfdPointerOffset/);
});

test('Dart writer selects BigTIFF with transparency-mask size included', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /includeTransparencyMask/);
  assert.match(source, /\(includeTransparencyMask \? pixelCount : 0\)/);
});
