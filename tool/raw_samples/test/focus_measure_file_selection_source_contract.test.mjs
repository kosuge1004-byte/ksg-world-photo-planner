import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const selection=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_measure_file_selection.dart',import.meta.url),
  'utf8',
);

test('file-backed focus selection keeps only bounded score chunks',()=>{
  assert.match(selection,/int chunkPixels = 65536/);
  assert.match(selection,/Float32List\(chunkPixels\)/);
  assert.doesNotMatch(selection,/List<FocusMeasurePlane>/);
});

test('file-backed winner comparison and confidence match the in-memory path',()=>{
  assert.match(selection,/if \(score > best\)/);
  assert.match(selection,/\(\(best - second\) \/ best\)\.clamp\(0, 1\)\.toDouble\(\)/);
  assert.doesNotMatch(selection,/score >= best/);
});

test('file-backed order refinement considers only adjacent focus frames',()=>{
  assert.match(selection,/<int>\[current - 1, current \+ 1\]/);
  assert.match(selection,/currentScore <= bestAdjacentScore \* adjacentScoreRatio/);
  assert.doesNotMatch(selection,/current - 2|current \+ 2/);
});

test('file-backed focus readers close on every exit',()=>{
  assert.match(selection,/finally \{/);
  assert.match(selection,/for \(final RandomAccessFile reader in readers\.reversed\)/);
  assert.match(selection,/await reader\.close\(\)/);
});
