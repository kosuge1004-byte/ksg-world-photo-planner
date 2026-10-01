import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');

test('terminal notifications, cleanup, and callback progress are bounded', () => {
  const reporter = read('lib/core/background/stack_job_reporter.dart');
  assert.match(reporter, /_bestEffortTimeout = Duration\(seconds: 10\)/);
  assert.match(reporter, /Future<void> _runBestEffort/);
  assert.match(reporter, /void updateBestEffort/);
  assert.match(reporter, /bool _bestEffortUpdateInFlight = false/);
  assert.match(reporter, /if \(_bestEffortUpdateInFlight\) return/);
  assert.match(reporter, /Future<void> _drainBestEffortUpdates/);
  assert.match(reporter, /while \(_hasPendingBestEffortUpdate\)/);
  assert.match(reporter, /Future<void> runBestEffortCleanup/);
  assert.match(reporter, /_runBestEffort\('completion notification'/);
  assert.match(reporter, /'cancellation marker cleanup'/);

  for (const path of [
    'lib/core/background/cfa_drizzle_background_worker.dart',
    'lib/core/background/focus_marking_background_worker.dart',
    'lib/core/background/focus_stack_background_worker.dart',
    'lib/core/background/meteor_background_worker.dart',
    'lib/core/background/meteor_composite_background_worker.dart',
    'lib/core/background/standard_stack_background_worker.dart',
  ]) {
    assert.doesNotMatch(read(path), /unawaited\(reporter\.update/);
  }
  assert.match(
    read('lib/core/background/focus_stack_background_worker.dart'),
    /runBestEffortCleanup\([\s\S]*?focus stack result cleanup/,
  );
  assert.match(
    read('lib/core/background/meteor_background_worker.dart'),
    /runBestEffortCleanup\([\s\S]*?meteor frame-store cleanup/,
  );
});

test('launch preparation is visibly animated and reports copy stages', () => {
  const screen = read('lib/features/common/standard_background_progress_screen.dart');
  const controller = read('lib/core/background/background_stack_controller.dart');
  const stager = read('lib/core/background/background_input_stager.dart');
  assert.match(screen, /status == null \? '準備中' : '\$percent%'/);
  assert.match(screen, /value: status == null \? null : progress/);
  assert.match(screen, /status\?\.stage \?\? _startingStage/);
  assert.match(screen, /onLaunchStage: _showLaunchStage/);
  assert.match(controller, /入力RAWをコピー中 \(\$current \/ \$total\)/);
  assert.match(stager, /onProgress\?\.call\(index \+ 1, sourcePaths\.length\)/);
});

test('startup and preflight I/O have finite deadlines', () => {
  const main = read('lib/main.dart');
  assert.match(main, /_startupInitializationTimeout = Duration\(seconds: 10\)/);
  assert.match(main, /Future\.wait/);
  assert.match(main, /initialize\(\)\.timeout\(_startupInitializationTimeout\)/);

  const controller = read('lib/core/background/background_stack_controller.dart');
  assert.match(controller, /_inputSizePreflightTimeout = Duration\(minutes: 2\)/);
  assert.match(controller, /_sumExistingFileBytesUnchecked\(paths\)\.timeout/);
});

test('brightness export is memory-gated and busy result routes cannot pop', () => {
  const result = read('lib/features/common/result_screen.dart');
  assert.match(result, /_maximumBrightnessSourceBytes/);
  assert.match(result, /_maximumBrightnessWorkingBytes/);
  assert.match(result, /JpegDecoder\(\)[\s\S]*?startDecode/);
  assert.match(result, /PopScope<void>\([\s\S]*?canPop: !_busy/);
});
