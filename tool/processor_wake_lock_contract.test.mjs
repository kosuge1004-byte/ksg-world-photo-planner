import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const processor = fs.readFileSync(
  'android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt',
  'utf8',
);

test('processor acquires a partial wake lock while foreground', () => {
  assert.match(processor, /PowerManager\.PARTIAL_WAKE_LOCK/);
  assert.match(processor, /fun acquireProcessingWakeLock/);
  assert.match(processor, /acquireProcessingWakeLock\(\)/);
});

test('processor wake lock uses a bounded timeout, not an unbounded acquire()', () => {
  // acquire() with no timeout is exactly the pattern Android's own WakeLock
  // guidance flags as a common battery-drain bug source; this must always
  // pass an explicit duration.
  assert.match(processor, /\.acquire\(WAKE_LOCK_TIMEOUT_MS\)/);
  assert.doesNotMatch(processor, /wakeLock[^\n]*\.acquire\(\)/);
});

test('processor wake lock is released on service teardown', () => {
  assert.match(processor, /fun releaseProcessingWakeLock/);
  assert.match(
    processor,
    /override fun onDestroy\(\)[\s\S]{0,400}releaseProcessingWakeLock\(\)/,
  );
});
