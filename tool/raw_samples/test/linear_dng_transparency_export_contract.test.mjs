import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('normal and resumed Milky Way exports pass the exact contribution store into export', () => {
  const source = readFileSync(
    new URL('../../../lib/core/session/export_pipeline_result.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /contributionStore\s*=\s*result\.contributionStore/);
  assert.match(source, /contributionStore:\s*contributionStore/);
  assert.match(source, /resumeContributionStore/);
});

test('Linear DNG export streams validity directly from the contribution store', () => {
  const source = readFileSync(
    new URL('../../../lib/core/export/export_result.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /exportTileStoreToLinearDng\(/);
  assert.match(source, /contributionStore:\s*contributionStore/);
  assert.doesNotMatch(source, /buildLinearDngTransparencyMask\(/);
  assert.doesNotMatch(source, /tileStore.*==\s*0/);
});
