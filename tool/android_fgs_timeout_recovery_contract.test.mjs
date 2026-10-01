import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
const processor = fs.readFileSync('android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt', 'utf8');
const home = fs.readFileSync('lib/features/home/home_screen.dart', 'utf8');
const progress = fs.readFileSync('lib/features/common/standard_background_progress_screen.dart', 'utf8');
const coordinator = fs.readFileSync('lib/core/background/foreground_timeout_recovery.dart', 'utf8');

test('processor foreground service is classified as mediaProcessing, not dataSync', () => {
  assert.match(manifest, /FOREGROUND_SERVICE_MEDIA_PROCESSING/);
  assert.match(manifest, /foregroundServiceType="mediaProcessing"/);
  assert.doesNotMatch(manifest, /FOREGROUND_SERVICE_DATA_SYNC/);
  assert.doesNotMatch(manifest, /foregroundServiceType="dataSync"/);
});

test('platform timeout remains recoverable and does not supervisor-loop', () => {
  assert.match(processor, /foreground-service-timeout/);
  assert.match(processor, /stopSelf\(startId\)/);
  assert.match(processor, /Never create a supervisor-restart marker here/);
});

test('bringing the UI foreground auto-resumes a platform-timeout job from checkpoints', () => {
  assert.match(home, /ForegroundTimeoutRecovery\.resumeIfNeeded\(\)/);
  assert.match(coordinator, /BackgroundStackController\.restartProcessor\(launch\)/);
  assert.match(progress, /_resumeAfterPlatformTimeoutIfNeeded/);
  // Work333 broadened this from a single hard-coded `!=` comparison to a
  // small set of recoverable causes (also covering a denied processor
  // *restart*, not just the original foreground-service-timeout), but
  // 'foreground-service-timeout' must still be one of them and the gate
  // must still require exactly interruptedRecoverable + a recognized cause.
  // home_screen.dart's own optimistic check must reuse this same shared
  // set rather than duplicating a literal string that could drift out of
  // sync with it (exactly the kind of duplication that caused this whole
  // recovery-cause inconsistency in the first place).
  assert.match(coordinator, /'foreground-service-timeout'/);
  assert.match(coordinator, /!recoverableCauses\.contains\(status\.recoveryCause\)/);
});

test('historical crash evidence is labeled as history, not current stop cause', () => {
  assert.match(progress, /過去のprocessor終了履歴/);
  assert.match(progress, /今回原因ではありません/);
});
