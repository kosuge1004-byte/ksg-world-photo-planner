import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLinearDngTransparencyMask,
  summarizeLinearDngTransparencyMask,
} from '../linear_dng_validity_reference.mjs';

test('validity comes from surviving RGB contributions', () => {
  const mask = buildLinearDngTransparencyMask(Uint16Array.from([
    1,1,1, 5,0,5, 0,0,0, 2,3,4,
  ]));
  assert.deepEqual(Array.from(mask), [255,0,0,255]);
  assert.deepEqual(summarizeLinearDngTransparencyMask(mask), {
    validPixelCount: 2, invalidPixelCount: 2,
  });
});

test('one missing color plane makes the output pixel undefined', () => {
  for (const counts of [[0,1,1],[1,0,1],[1,1,0]]) {
    assert.equal(buildLinearDngTransparencyMask(Uint16Array.from(counts))[0], 0);
  }
});

test('validity contract never depends on image brightness', () => {
  assert.equal(
    buildLinearDngTransparencyMask(Uint16Array.from([1,1,1]))[0],
    255,
  );
});
