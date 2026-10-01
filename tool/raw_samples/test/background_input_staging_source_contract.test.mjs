import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const controller = await readFile(new URL('../../../lib/core/background/background_stack_controller.dart', import.meta.url), 'utf8');
const stager = await readFile(new URL('../../../lib/core/background/background_input_stager.dart', import.meta.url), 'utf8');

test('background jobs stage picker RAWs into job-owned storage before enqueue', () => {
  assert.match(controller, /BackgroundInputStager\.stageGroup/);
  assert.ok((controller.match(/groupName: 'source'/g) ?? []).length >= 5);
  assert.match(stager, /\.openRead\(\)[\s\S]*?\.timeout\(copyInactivityTimeout\)[\s\S]*?\.pipe\(temporary\.openWrite\(\)\)/);
  assert.match(stager, /copiedLength != sourceLength/);
  assert.match(stager, /temporary\.rename\(destination\.path\)/);
});

test('standard star-trail payload uses staged source, dark and flat paths', () => {
  const start = controller.indexOf('startStandardStack');
  const end = controller.indexOf('startFocusStack', start);
  const section = controller.slice(start, end);
  assert.match(section, /sourcePaths: originalSourcePaths/);
  assert.match(section, /'sourcePaths': sourcePaths/);
  assert.match(section, /'darkFramePaths': stagedDarkFramePaths/);
  assert.match(section, /'flatFramePaths': stagedFlatFramePaths/);
  assert.doesNotMatch(section, /'sourcePaths': originalSourcePaths/);
});
