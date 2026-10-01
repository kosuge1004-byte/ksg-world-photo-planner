import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('linear RGB color transform rejects non-finite source samples', () => {
  const source = readFileSync(
    new URL('../../../lib/core/color/linear_rgb_color_transform.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /Linear RGB input samples must all be finite/);
  assert.doesNotMatch(source, /_safeSample/);
  assert.doesNotMatch(source, /isFinite \? value : 0/);
});

test('RAW WB harmonization rejects corrupt or Float32-overflow output', () => {
  const source = readFileSync(
    new URL('../../../lib/core/color/raw_camera_color_profile.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /non-finite RAW samples/);
  assert.match(source, /exceeds finite Float32 range/);
  assert.doesNotMatch(source, /\.clamp\(0(?:\.0)?,\s*1(?:\.0)?\)/);
});

test('Drizzle accumulator cannot create negative scientific coverage', () => {
  const source = readFileSync(
    new URL('../../../lib/core/drizzle/drizzle_accumulator.dart', import.meta.url),
    'utf8',
  );
  const negativeGuards = source.match(/weight < 0/g) ?? [];
  assert.ok(negativeGuards.length >= 3);
  assert.match(source, /!dropRadius\.isFinite/);
  assert.match(source, /!effectiveHalfWidth\.isFinite/);
  assert.match(source, /!effectiveHalfHeight\.isFinite/);
});
