import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const processor = read('android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt');
const main = read('android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt');
const supervisor = read('android/app/src/main/kotlin/com/mobilestack/app/SupervisorService.kt');
const registry = read('lib/core/background/stack_job_registry.dart');
const controller = read('lib/core/background/background_stack_controller.dart');
const reporter = read('lib/core/background/stack_job_reporter.dart');
const worker = read('lib/core/background/standard_stack_background_worker.dart');

test('processor queues launches and acknowledges runtime acceptance', () => {
  assert.doesNotMatch(processor, /private var pendingIntent:/);
  assert.match(processor, /private val pendingLaunches = ArrayDeque<PendingLaunch>\(\)/);
  assert.match(processor, /runtimeReady = true[\s\S]{0,100}dispatchIfReady\(\)/);
  assert.match(processor, /acknowledgeLaunch\(launch\)[\s\S]{0,200}runtimeChannel\?\.invokeMethod/);
  assert.match(main, /ResultReceiver\(mainHandler\)/);
  assert.match(main, /PROCESSOR_LAUNCH_ACK_TIMEOUT_MS/);
  assert.match(main, /RECOVERY_CAUSE_PROCESSOR_LAUNCH_UNCONFIRMED/);
});

test('foreground promotion failures are caught in both services', () => {
  assert.match(processor, /try \{[\s\S]{0,180}startForeground\(/);
  assert.match(supervisor, /try \{[\s\S]{0,180}startForeground\(/);
});

test('watchdogs use real progress and recovery remains bounded', () => {
  assert.match(reporter, /final double previousProgress/);
  assert.match(reporter, /_progressEpochMs = now\.millisecondsSinceEpoch/);
  assert.match(supervisor, /optLong\("progressEpochMs"/);
  assert.match(supervisor, /MAX_AUTOMATIC_RESTARTS_PER_SIGNATURE/);
  assert.match(supervisor, /maintenance heap recycle/);
});

test('one durable active generation and failed-launch cleanup are enforced', () => {
  assert.match(registry, /status\.state != StackJobState\.interruptedRecoverable/);
  assert.match(registry, /cleanupOrphanedJobDirectories/);
  assert.match(controller, /_serializeLaunch/);
  assert.match(controller, /_deleteFailedNewJobDirectory/);
});

test('orphan cleanup is off the launch critical path and cannot delete a fresh or newly registered job', () => {
  assert.match(controller, /unawaited\(\(\) async \{[\s\S]{0,400}cleanupOrphanedJobDirectories/);
  assert.match(controller, /minimumAge: const Duration\(minutes: 10\)/);
  assert.doesNotMatch(controller, /await StackJobRegistry\.cleanupOrphanedJobDirectories\(\);/);
  assert.match(registry, /Duration minimumAge = Duration\.zero/);
  assert.match(registry, /stat\.modified\.isAfter\(oldestEligible\)/);
  assert.match(registry, /final StackJobRecord\? retained = await read\(\)/);
  assert.match(registry, /candidate == retainedDirectory/);
});

test('milky-way checkpoint stores are initialized only once', () => {
  const matches = worker.match(/milkyWayCompactFeatureCheckpoints =\s*\n\s*_MilkyWayCompactFeatureCheckpointStore/g) || [];
  assert.equal(matches.length, 1);
});
