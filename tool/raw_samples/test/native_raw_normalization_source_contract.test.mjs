import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const decoder=readFileSync(
  new URL('../../../lib/core/raw/native_raw_decoder.dart',import.meta.url),
  'utf8',
);

test('owned RAW normalization has no second full-resolution Float32 plane',()=>{
  assert.match(decoder,/_normalizeOwnedSamplesInPlace/);
  assert.doesNotMatch(decoder,/Float32List\(outputCount\)/);
  assert.match(decoder,/Float32List\.sublistView\(storage, 0, outputCount\)/);
});

test('normalization view is allocated before its single compact scratch bitset',()=>{
  const view=decoder.indexOf('Float32List.sublistView(storage, 0, outputCount)');
  const visited=decoder.indexOf('final Uint8List visited');
  assert.ok(view>=0 && visited>view);
  assert.doesNotMatch(decoder,/final Uint8List hasPredecessor/);
  assert.match(decoder,/_hasNormalizationPredecessor\(start, frame\.width, active\)/);
  assert.match(decoder,/@pragma\('vm:never-inline'\)/);
});

test('per-pixel normalization helpers are non-capturing top-level functions',()=>{
  assert.match(decoder,/@pragma\('vm:prefer-inline'\)\nint _normalizationSourceIndex/);
  assert.match(decoder,/@pragma\('vm:prefer-inline'\)\nbool _hasNormalizationPredecessor/);
  assert.match(decoder,/bool _isNormalizationBitMarked/);
  assert.match(decoder,/void _markNormalizationBit/);
  assert.doesNotMatch(decoder,/int sourceIndex\(int targetIndex\)/);
});

test('orientation mapping uses integer indices without coordinate records',()=>{
  assert.match(decoder,/final int y = targetIndex ~\/ outputWidth/);
  assert.match(decoder,/switch \(frame\.orientation\)/);
  assert.doesNotMatch(decoder,/_sourceCoordinate|\(int, int\) source/);
});
