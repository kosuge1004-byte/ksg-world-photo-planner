import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const controller = fs.readFileSync('lib/core/background/background_stack_controller.dart', 'utf8');
const screen = fs.readFileSync('lib/features/common/standard_background_progress_screen.dart', 'utf8');
const registry = fs.readFileSync('lib/core/background/stack_job_registry.dart', 'utf8');

test('standard stack performs storage preflight before creating/staging a new job', () => {
  const start = controller.indexOf('static Future<BackgroundStackLaunch> _startStandardStackInternal(');
  assert.ok(start >= 0);
  const body = controller.slice(start, controller.indexOf('static Future<BackgroundStackLaunch> startFocusStack(', start));
  const preflight = body.indexOf('await _preflightStandardStackStorage(');
  const createJob = body.indexOf('final String jobId =');
  const stage = body.indexOf('final List<String> sourcePaths = await BackgroundInputStager.stageGroup(', createJob);
  assert.match(body.slice(createJob, stage), /pureMaxReference \? 'pure-max-reference' : 'standard-stack'/);
  assert.ok(preflight >= 0, 'preflight call missing');
  assert.ok(createJob > preflight, 'job creation must happen after preflight');
  assert.ok(stage > preflight, 'input staging must happen after preflight');
});

test('preflight uses metadata-only dimensions, durable RAW staging, and mode-specific bounded star-trail working space', () => {
  assert.match(controller, /RawFileProbe\(\)\.probe\(sourcePaths\[referenceIndex\]\)/);
  assert.match(controller, /createProductionNativeRawMetadataProbe\(\)/);
  assert.match(controller, /stagedInputBytes/);
  assert.match(controller, /mode == ProcessingMode\.starTrail\s*\? frameBytes \* 7/);
  assert.match(controller, /rollingMilkyWay\s*\? metadata\.width \* metadata\.height \* 186/);
  assert.match(controller, /:\s*frameBytes \* sourcePaths\.length/);
  assert.match(controller, /mode == ProcessingMode\.starTrail \|\| rollingMilkyWay[\s\S]*?\? 768 \* 1024 \* 1024/);
});

test('preflight reports required available and missing capacity to the user', () => {
  assert.match(controller, /概算必要空き容量/);
  assert.match(controller, /現在の空き容量/);
  assert.match(controller, /不足容量/);
  assert.match(controller, /BackgroundStoragePreflightException/);
});

test('storage preflight refusal keeps the processing session retryable', () => {
  assert.match(screen, /on BackgroundStoragePreflightException catch/);
  assert.match(screen, /resetToReady\(\)/);
});


test('capacity refusal preserves the previous terminal job until the new job can fit', () => {
  const reclaim = controller.indexOf('await _boundedPreviousTerminalJobReclaimableBytes()');
  const firstPreflight = controller.indexOf('await _preflightStandardStackStorage(', reclaim);
  const discard = controller.indexOf('await StackJobRegistry.discardPreviousTerminalJob()', firstPreflight);
  const secondPreflight = controller.indexOf('await _preflightStandardStackStorage(', discard);
  assert.ok(reclaim >= 0, 'reclaimable terminal capacity estimate missing');
  assert.ok(firstPreflight > reclaim, 'preflight must happen after reclaimable-byte estimate');
  assert.ok(discard > firstPreflight, 'previous terminal job must not be deleted before capacity admission');
  assert.ok(secondPreflight > discard, 'real free space must be rechecked after deletion');
  assert.match(controller, /effectiveAvailable = available \+ reclaimableTerminalJobBytes/);
});

test('previous terminal size scan cannot hold the launch path indefinitely', () => {
  assert.match(controller, /_terminalJobSizeTimeout = Duration\(seconds: 10\)/);
  assert.match(controller, /previousTerminalJobReclaimableBytes\(\)\.timeout\(/);
  assert.match(controller, /on Object \{[\s\S]{0,220}return 0;/);
});

test('only safe terminal managed job directories are counted as reclaimable capacity', () => {
  assert.match(registry, /previousTerminalJobReclaimableBytes/);
  assert.match(registry, /StackJobState\.interruptedRecoverable/);
  assert.match(registry, /p\.isWithin\(canonicalRoot, canonicalJob\)/);
  assert.match(registry, /list\(recursive: true, followLinks: false\)/);
});
