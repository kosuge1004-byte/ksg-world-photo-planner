import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const blender = read('lib/core/focus_stack/focus_tiled_blender.dart');
const pyramid = read('lib/core/focus_stack/focus_pyramid_blend.dart');
const worker = read('lib/core/background/focus_stack_background_worker.dart');
const settings = read('lib/core/settings/app_settings.dart');
const pipeline = read('lib/core/focus_stack/focus_stack_pipeline.dart');

test('depth map remains the default everywhere', () => {
  assert.match(blender, /FocusBlendMethod blendMethod = FocusBlendMethod\.depthMap,/);
  assert.match(pipeline, /FocusBlendMethod blendMethod = FocusBlendMethod\.depthMap,/);
  assert.match(blender, /orElse: \(\) => FocusBlendMethod\.depthMap/);
  assert.match(settings, /static const bool defaultFocusPyramidBlend = false;/);
  assert.match(worker, /focusBlendMethodFromName\(input\['focusBlendMethod'\] as String\?\)/);
});

test('pyramid path changes the tile plan and binds that into the checkpoint', () => {
  assert.match(blender, /tileSize: pyramid \? focusPyramidCoreTileSize : tileSize,/);
  assert.match(blender, /if \(pyramid\) 'blendMethod': 'pyramid',/);
});

test('tiling exactness margin exceeds the dependency radius', () => {
  const levels = Number(pyramid.match(/const int focusPyramidLevels = (\d+);/)[1]);
  const margin = Number(pyramid.match(/const int focusPyramidMargin = (\d+);/)[1]);
  assert.ok(margin > 4 * 2 ** levels, `margin ${margin} vs radius ${4 * 2 ** levels}`);
});

test('uncovered frame pixels are filled before building pyramids', () => {
  assert.match(blender, /if \(frame\.coverage\[pixel\] != 0\) continue;\n\s+final int base = pixel \* 3;\n\s+filled\[base\] = depthMap\[base\];/);
});
