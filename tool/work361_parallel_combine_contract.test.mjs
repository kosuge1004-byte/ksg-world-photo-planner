import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const pipeline = read('lib/core/session/milky_way_pipeline.dart');
const worker = read('lib/core/background/standard_stack_background_worker.dart');

test('one shared tile function serves the sequential and parallel paths', () => {
  const calls = pipeline.match(/_combineClassicTile\(/g) ?? [];
  assert.equal(calls.length, 3, 'declaration + sequential + worker');
  assert.doesNotMatch(pipeline, /final RejectionStackedRgbTile combined = await combiner\.combineTile\(/);
});

test('results are written strictly in tile order with the historical progress/logging/yield', () => {
  assert.match(pipeline, /while \(ready\.containsKey\(written\)\) \{\n\s+final RejectionStackedRgbTile tile = ready\.remove\(written\)!;\n\s+await writeInOrder\(written, tile\);/);
  assert.match(pipeline, /await stageCheckpoint\?\.recordProgress\(tileIndex \+ 1\);/);
  assert.match(pipeline, /await Future<void>\.delayed\(const Duration\(milliseconds: 24\)\);/);
});

test('parallel only for committed file-backed stores and within a memory budget', () => {
  assert.match(pipeline, /if \(store is FileBackedLinearRgbTileStore && store\.isCommitted\) \{/);
  assert.match(pipeline, /availableMemoryBytes ~\/ 4;/);
  assert.match(pipeline, /if \(workerCount < 2\) parallelEligible = false;/);
  assert.match(pipeline, /int combineWorkerIsolates = 1,/);
});

test('background Milky Way uses the core-count rule', () => {
  assert.match(worker, /combineWorkerIsolates: classicCombineWorkerCount\(\),/);
  assert.match(pipeline, /if \(cores >= 8\) return 3;\n\s+if \(cores >= 6\) return 2;\n\s+return 1;/);
});
