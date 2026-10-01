import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const controller = fs.readFileSync('lib/core/engine/adaptive_resource_controller.dart', 'utf8');
const reader = fs.readFileSync('lib/core/engine/default_resource_reader.dart', 'utf8');
const worker = fs.readFileSync('lib/core/background/standard_stack_background_worker.dart', 'utf8');
const activity = fs.readFileSync('android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt', 'utf8');

test('headless resource reader uses proc instead of depending on MainActivity channel', () => {
  assert.match(reader, /\/proc\/meminfo/);
  assert.match(reader, /\/proc\/self\/status/);
  assert.match(reader, /\/proc\/stat/);
  assert.match(reader, /MissingPluginException/);
});

test('adaptive controller has boost constrained and critical states', () => {
  assert.match(controller, /AdaptiveResourceState\.boost/);
  assert.match(controller, /AdaptiveResourceState\.constrained/);
  assert.match(controller, /AdaptiveResourceState\.critical/);
  assert.match(controller, /available < 384 \* 1024 \* 1024/);
  assert.match(controller, /available < 896 \* 1024 \* 1024/);
});

test('standard background worker replaced fixed long-stack cooldown', () => {
  assert.match(worker, /waitUntilSafeToStartNextFrame/);
  assert.doesNotMatch(worker, /sourcePaths\.length >= 32 \? 4 : 2/);
  assert.match(worker, /adaptiveResource \$\{decision\.reason\}/);
});

test('foreground activity reports real memory and Android thermal status when available', () => {
  assert.match(activity, /memoryInfo\.totalMem/);
  assert.match(activity, /Debug\.getPss\(\)/);
  assert.match(activity, /currentThermalStatus/);
  assert.match(activity, /BatteryManager\.EXTRA_TEMPERATURE/);
});
