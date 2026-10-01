import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Linear DNG declares scene-referred semantics for scene-linear pre-white-balanced RGB', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  const refs = source.match(/writeEntry\(50879,\s*shortType,\s*1,\s*0\)/g) ?? [];
  const whites = source.match(/writeEntry\(50729,\s*rationalType,\s*2,\s*asShotWhiteXyOffset\)/g) ?? [];
  assert.equal(refs.length, 2);
  assert.equal(whites.length, 2);
  assert.doesNotMatch(source, /writeEntry\(50728/); // AsShotWhiteXY is used instead
  assert.match(source, /3127/);
  assert.match(source, /3290/);
});

test('Linear DNG export still refuses baked exposure/tone/look processing', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/export_result.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /does not bake exposure, white point, LUTs, or tone curves/);
});
