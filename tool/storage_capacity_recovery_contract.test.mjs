import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync('lib/core/background/standard_stack_background_worker.dart', 'utf8');
const reporter = fs.readFileSync('lib/core/background/stack_job_reporter.dart', 'utf8');

test('rolling star-trail checks bounded working storage before starting each second-pass RAW', () => {
  assert.match(worker, /_ensureRollingStarTrailStorageHeadroom/);
  assert.match(worker, /pixels \* 84 \+ 768 \* 1024 \* 1024/);
  assert.match(worker, /await _ensureRollingStarTrailStorageHeadroom\([\s\S]*?width: passWidth,[\s\S]*?height: passHeight/);
  assert.doesNotMatch(
    worker.match(/Future<void> _ensureRollingStarTrailStorageHeadroom[\s\S]*?^}/m)?.[0] ?? '',
    /sourcePaths\.length|remainingFrames/,
  );
});

test('ENOSPC is translated into a recoverable storage pause', () => {
  assert.match(worker, /No space left on device/i);
  assert.match(worker, /errorCode == 28/);
  assert.match(worker, /空き容量不足・再開待ち/);
  assert.match(worker, /reporter\.pauseRecoverable/);
});

test('external storage pause does not request an immediate supervisor restart', () => {
  const start = reporter.indexOf('Future<void> pauseRecoverable');
  const end = reporter.indexOf('Future<void> failRecoverable', start);
  assert.ok(start >= 0 && end > start);
  const body = reporter.slice(start, end);
  assert.doesNotMatch(body, /supervisor-restart/);
  assert.match(body, /external-resource-pause/);
});

test('orphaned full-frame RGB temp directories are reclaimed at job start', () => {
  assert.match(worker, /_cleanupOrphanedLinearRgbTempDirectories/);
  assert.match(worker, /mobile-stack-linear-rgb-/);
  assert.match(worker, /await _cleanupOrphanedLinearRgbTempDirectories\(\)/);
});


test('post-decode storage shortage uses the same non-restarting recoverable pause path', () => {
  const start = worker.indexOf('Future<void> _ensurePostDecodeStorageHeadroom');
  const end = worker.indexOf('Future<void> _ensureStarTrailDecodeStorageHeadroom', start);
  assert.ok(start >= 0 && end > start);
  const body = worker.slice(start, end);
  assert.match(body, /throw _StorageCapacityException/);
  assert.doesNotMatch(body, /throw StateError/);
});
