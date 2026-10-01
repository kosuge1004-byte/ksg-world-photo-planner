import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const registryPath = new URL(
  '../../../lib/core/background/stack_job_registry.dart',
  import.meta.url,
);
const controllerPath = new URL(
  '../../../lib/core/background/background_stack_controller.dart',
  import.meta.url,
);
const progressPath = new URL(
  '../../../lib/features/milkyway/cfa_drizzle_milky_way_progress_screen.dart',
  import.meta.url,
);

test('registry clear can match one concrete job generation', async () => {
  const source = await readFile(registryPath, 'utf8');
  assert.match(source, /String\? expectedStatusPath/);
  assert.match(source, /record\.statusPath != expectedStatusPath/);
  assert.match(source, /discardTerminalJob/);
});

test('terminal cleanup is constrained to managed CFA job directories', async () => {
  const source = await readFile(registryPath, 'utf8');
  assert.match(source, /p\.isWithin\(canonicalRoot, canonicalJob\)/);
  assert.match(source, /p\.basename\(canonicalJob\)\.startsWith\('cfa-drizzle-'\)/);
  assert.match(source, /p\.dirname\(canonicalStatus\) == canonicalJob/);
  assert.match(source, /p\.dirname\(canonicalOutput\) == canonicalJob/);
  assert.match(source, /status\.state == StackJobState\.queued/);
  assert.match(source, /status\.state == StackJobState\.running/);
});

test('new stack reclaims only the previous terminal generation', async () => {
  const source = await readFile(controllerPath, 'utf8');
  assert.match(source, /final StackJobRecord\? active = await StackJobRegistry\.activeJob\(\)/);
  assert.match(source, /await StackJobRegistry\.discardPreviousTerminalJob\(\)/);
});

test('closing background result discards its terminal job as one unit', async () => {
  const source = await readFile(progressPath, 'utf8');
  assert.match(source, /deleteTemporaryResultOnDispose:\s*false/);
  assert.match(source, /await StackJobRegistry\.discardTerminalJob\(/);
  assert.match(source, /statusPath:\s*launch\.statusPath/);
  assert.match(source, /outputPath:\s*outputPath/);
});
