import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const blender = read('lib/core/focus_stack/focus_tiled_blender.dart');
const pipeline = read('lib/core/focus_stack/focus_stack_pipeline.dart');
const worker = read('lib/core/background/focus_stack_background_worker.dart');
const controller = read('lib/core/background/background_stack_controller.dart');
const settings = read('lib/core/settings/app_settings.dart');

test('focus normalization is off by default everywhere', () => {
  assert.match(settings, /static const bool defaultFocusExposureNormalization = false;/);
  assert.match(pipeline, /bool normalizeFrameExposure = false,/);
  assert.match(worker, /input\['focusNormalizeExposure'\] as bool\? \?\? false;/);
});

test('gains are applied only when provided and bound into the checkpoint only when used', () => {
  assert.match(blender, /if \(frameGains != null\) \{\n\s+applyFocusFrameGainInPlace\(\n\s+sampled\.tile\.interleavedRgb,\n\s+frameGains\[frame\],/);
  assert.match(blender, /if \(frameGains != null\)\n\s+'frameGains':/);
  assert.match(pipeline, /if \(normalizeFrameExposure\) \{\n\s+frameGains = await estimateFocusFrameGains\(/);
});

test('a settings read failure cannot block a focus launch', () => {
  assert.match(controller, /_focusExposureNormalizationSetting\(\) async \{\n\s+try \{\n\s+return await AppSettings\.loadFocusExposureNormalization\(\);\n\s+\} on Object \{\n\s+return AppSettings\.defaultFocusExposureNormalization;/);
});
