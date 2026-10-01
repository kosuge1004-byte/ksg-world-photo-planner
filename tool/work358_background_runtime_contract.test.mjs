import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const reporter = read('lib/core/background/stack_job_reporter.dart');
const dispatcher = read('lib/core/background/background_task_dispatcher.dart');
const controller = read('lib/core/background/background_stack_controller.dart');
const blender = read('lib/core/focus_stack/focus_tiled_blender.dart');

test('status file is written before any platform call; platform calls are bounded', () => {
  const write = reporter.indexOf('writeAtomically(\n              statusPath');
  const platform = reporter.indexOf('Workmanager().reportProgress(snapshot.toMap())');
  assert.ok(write > 0 && platform > write);
  assert.match(reporter, /static const Duration _platformCallTimeout = Duration\(seconds: 3\);/);
  assert.match(reporter, /Workmanager\(\)\.reportProgress\(snapshot\.toMap\(\)\)\.timeout\(\n\s+_platformCallTimeout,/);
  assert.match(reporter, /jobLabel: jobLabel,\n\s+\)\.timeout\(_platformCallTimeout\);/);
});

test('WorkManager progress is forwarded only inside the WorkManager-hosted engine', () => {
  assert.match(reporter, /static bool workManagerHosted = false;/);
  assert.match(reporter, /if \(workManagerHosted\) \{/);
  assert.match(dispatcher, /StackJobReporter\.workManagerHosted = true;/);
});

test('Android heavy jobs never run under WorkManager (no 10-minute worker limit)', () => {
  assert.match(controller, /if \(Platform\.isAndroid\) \{[\s\S]{0,700}await RemoteProcessorBridge\.start\([\s\S]{0,300}return;\n\s+\}/);
});

test('pyramid focus blend reports per-tile progress for the stall watchdog', () => {
  assert.match(blender, /onPyramidTileCompleted\?\.call\(tileIndex \+ 1, plan\.tiles\.length\);/);
});
