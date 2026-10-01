import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Classic and BigTIFF writers explicitly describe full-raster crop geometry', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  const cropOrigin = source.match(/writeEntry\(50719,\s*rationalType,\s*2,\s*defaultCropOriginOffset\)/g) ?? [];
  const cropSize = source.match(/writeEntry\(50720,\s*rationalType,\s*2,\s*defaultCropSizeOffset\)/g) ?? [];
  const active = source.match(/writeEntry\(50829,\s*longType,\s*4,\s*activeAreaDataOffset\)/g) ?? [];
  assert.equal(cropOrigin.length, 2);
  assert.equal(cropSize.length, 2);
  assert.equal(active.length, 2);
  assert.match(source, /data\.setUint32\(activeAreaDataOffset \+ 8,\s*height/);
  assert.match(source, /data\.setUint32\(activeAreaDataOffset \+ 12,\s*width/);
});

test('writer does not invent MaskedAreas for synthesized stack output', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /writeEntry\(50830/);
});
