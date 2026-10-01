import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Dart drizzle gap fill validates finite values and non-negative coverage', () => {
  const source = readFileSync(
    new URL('../../../lib/core/drizzle/drizzle_gap_fill.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /channel\.value\.any/);
  assert.match(source, /channel\.coverage\.any/);
  assert.match(source, /minimumCoverage\.isFinite/);
});

test('tiled gap fill rejects non-finite minimum coverage', () => {
  const source = readFileSync(
    new URL('../../../lib/core/drizzle/tiled_drizzle_gap_fill.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /minimumCoverage\.isFinite/);
});


test('Dart gap fill never converts synthesized values into source coverage', () => {
  const source = readFileSync(
    new URL('../../../lib/core/drizzle/drizzle_gap_fill.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /filledCoverage\[index\] = 0;/);
  assert.doesNotMatch(source, /filledCoverage\[index\] = coverageSum;/);
});
