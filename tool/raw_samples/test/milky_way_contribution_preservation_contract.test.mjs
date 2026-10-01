import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pipeline = readFileSync(
  new URL('../../../lib/core/session/milky_way_pipeline.dart', import.meta.url),
  'utf8',
);
const exportPipeline = readFileSync(
  new URL('../../../lib/core/session/export_pipeline_result.dart', import.meta.url),
  'utf8',
);

test('Milky Way result preserves exact final rejection contribution counts', () => {
  assert.match(pipeline, /final LinearContributionTileStore\? contributionStore/);
  assert.match(pipeline, /interleavedCounts: combined\.contributingSamples/);
  assert.match(pipeline, /await contributionStore\.commit\(\)/);
  assert.match(pipeline, /contributionStore: contributionStore/);
});

test('Milky Way export wrappers dispose both direct and resumed contribution stores', () => {
  assert.match(exportPipeline, /result\.contributionStore\?\.dispose\(\)/);
  assert.match(exportPipeline, /await contributionStore\?\.dispose\(\)/);
});
