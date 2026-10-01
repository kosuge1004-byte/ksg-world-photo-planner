import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Linear DNG path preserves signed/HDR finite samples without clipping', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  const stripEncoder = source.slice(
    source.indexOf('Future<Uint8List> _encodeLinearDngFloat32Strip'),
    source.indexOf('Future<File> exportTileStoreToLinearDng'),
  );
  const exportBody = source.slice(source.indexOf('Future<File> exportTileStoreToLinearDng'));
  assert.match(stripEncoder, /setFloat32/);
  assert.match(stripEncoder, /value\.abs\(\) > 3\.4028234663852886e38/);
  assert.match(exportBody, /_encodeLinearDngFloat32Strip/);
  assert.doesNotMatch(stripEncoder, /\.clamp\(0(?:\.0)?,\s*1(?:\.0)?\)/);
  assert.doesNotMatch(stripEncoder, /value\s*<\s*0\s*\?\s*0/);
});

test('both Linear DNG headers validate projected image byte count', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  assert.equal(
    (source.match(/Projected Linear DNG image byte count must be positive/g) ?? []).length,
    2,
  );
  assert.equal(
    (source.match(/width \* height \* 3 \* 4/g) ?? []).length >= 2,
    true,
  );
});


test('Linear DNG writer enforces binary source-validity transparency masks', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  const exportBody = source.slice(source.indexOf('Future<File> exportTileStoreToLinearDng'));
  assert.match(exportBody, /value != 0 && value != 255/);
  assert.match(exportBody, /Transparency mask must be binary validity data \(0 or 255 only\)/);
});
