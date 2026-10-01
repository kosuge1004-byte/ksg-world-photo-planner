import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('production adaptive demosaic validates finite CFA input support', () => {
  const source = readFileSync(
    new URL('../../../lib/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Adaptive demosaic input contains a non-finite CFA sample/);
});

test('production adaptive demosaic checks RGB before Float32 storage', () => {
  const source = readFileSync(
    new URL('../../../lib/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart', import.meta.url),
    'utf8',
  );
  const check = source.indexOf('Adaptive demosaic produced a non-finite or Float32-overflow RGB sample.');
  const store = source.indexOf('output[base] = red;', check);
  assert.ok(check >= 0);
  assert.ok(store > check);
  assert.match(source, /maximumFloat32 = 3\.4028234663852886e38/);
});

test('adaptive demosaic does not clamp valid linear range', () => {
  const source = readFileSync(
    new URL('../../../lib/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('final double red =');
  const end = source.indexOf('return LinearRgbTile', start);
  const outputWrite = source.slice(start, end);
  assert.doesNotMatch(outputWrite, /\.clamp\(0(?:\.0)?,\s*1(?:\.0)?\)/);
});
