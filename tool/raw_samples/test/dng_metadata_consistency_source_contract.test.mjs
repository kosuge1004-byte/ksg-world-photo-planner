import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
  'utf8',
);

test('DNG declares 1.4 file and backward versions for Float32 compatibility', () => {
  assert.match(source, /_dngVersionInlineLittleEndian = 0x00000401/);
  assert.match(source, /_dngBackwardVersionInlineLittleEndian[\s\S]*0x00000401/);
  assert.equal(
    (source.match(/writeEntry\(50707, byteType, 4, _dngBackwardVersionInlineLittleEndian\)/g) ?? []).length,
    2,
  );
});

test('Classic and BigTIFF share the same LinearRaw colorimetric contract', () => {
  for (const tag of ['50721', '50729', '50730', '50778', '50879', '51110']) {
    assert.equal(
      (source.match(new RegExp(`writeEntry\\(${tag},`, 'g')) ?? []).length,
      2,
    );
  }
});


test('Classic and BigTIFF omit explicit BlackLevel and use the DNG default zero', () => {
  assert.equal((source.match(/writeEntry\(50714,/g) ?? []).length, 0);
  assert.match(source, /BlackLevel is omitted: the DNG-defined default is 0/);
});
