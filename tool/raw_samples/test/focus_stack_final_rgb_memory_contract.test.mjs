import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const pipeline = readFileSync(new URL('lib/core/focus_stack/focus_stack_pipeline.dart', root), 'utf8');
const blender = readFileSync(new URL('lib/core/focus_stack/focus_tiled_blender.dart', root), 'utf8');
const exporter = readFileSync(new URL('lib/core/focus_stack/focus_stack_linear_dng_export.dart', root), 'utf8');
const screen = readFileSync(new URL('lib/features/focus_stack/focus_stack_screen.dart', root), 'utf8');

test('production focus pipeline keeps final RGB file-backed instead of a full-resolution Float32List', () => {
  assert.match(pipeline, /final LinearRgbTileStore cameraRgbStore/);
  assert.match(pipeline, /blendRegisteredFocusStoresFromFileBackedWinnersAndCoverageToStore/);
  assert.doesNotMatch(pipeline, /blendRegisteredFocusStoresMemoryBounded\(/);
  assert.doesNotMatch(pipeline, /final Float32List interleavedCameraRgb/);
});

test('stored focus blender writes each blended tile directly and commits the output store', () => {
  assert.match(blender, /Future<FocusStoredBlendResult> blendRegisteredFocusStoresToStoreMemoryBounded/);
  assert.match(blender, /await outputStore\.writeTile\(/);
  assert.match(blender, /interleavedRgb: blended\.interleavedRgb/);
  assert.match(blender, /await outputStore\.commit\(\)/);
  assert.match(blender, /await outputStore\.abort\(\)/);
});

test('focus DNG export reads the final RGB store directly without a second full-image copy', () => {
  assert.match(exporter, /tileStore: result\.cameraRgbStore/);
  assert.doesNotMatch(exporter, /FileBackedLinearRgbTileStore\.createTemporary/);
  assert.doesNotMatch(exporter, /result\.interleavedCameraRgb/);
});

test('file-backed focus result ownership is released on replacement and screen disposal', () => {
  assert.match(pipeline, /Future<void> dispose\(\{bool retainCheckpointFiles = false\}\) async \{[\s\S]*closeRetainingFile\(\)[\s\S]*else \{\s*await cameraRgbStore\.dispose\(\)/);
  assert.match(pipeline, /finalResultTransferred = true/);
  assert.match(pipeline, /if \(!finalResultTransferred && finalStore != null\)/);
  assert.match(screen, /await previousResult\.dispose\(\)/);
  assert.match(screen, /result != null && !_isSaving/);
  assert.match(screen, /unawaited\(result\.dispose\(\)\)/);
  assert.match(screen, /if \(!mounted\) \{[\s\S]{0,100}await result\.dispose\(\)/);
  assert.match(screen, /else \{[\s\S]{0,100}await result\.dispose\(\)/);
});
