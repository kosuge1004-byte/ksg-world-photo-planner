import fs from 'node:fs';
import assert from 'node:assert/strict';

const main = fs.readFileSync(
  'android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt',
  'utf8',
);
const recovery = fs.readFileSync(
  'lib/core/background/foreground_timeout_recovery.dart',
  'utf8',
);
const milkyWay = fs.readFileSync(
  'lib/features/milkyway/cfa_drizzle_milky_way_progress_screen.dart',
  'utf8',
);

// --- Native: a terminally failed *restart* must downgrade a stuck ---------
// --- queued/running job to interruptedRecoverable instead of leaving it ---
// --- invisible to both ForegroundTimeoutRecovery and StackJobRegistry. ----

assert.match(main, /val isRestart: Boolean/,
  'ProcessorLaunchWaiter must track whether it originated from a restart call, ' +
    'so a terminal failure can tell a restart apart from a brand-new job\'s first start');
assert.match(main, /isRestart = false,/,
  'the brand-new job path (restart=false) must mark its waiter as not a restart');
assert.match(main, /isRestart = true,/,
  'the restart path (restart=true) must mark its waiter as a restart');

assert.match(
  main,
  /if \(state\.waiters\.any \{ it\.isRestart \}\) \{\s*\n\s*markJobRecoverableAfterProcessorLaunchFailure\(/,
  'a terminally failed restart attempt must downgrade the job status; a brand-new job\'s first-start failure must not (BackgroundStackController already tears that one down)',
);

assert.match(main, /private fun markJobRecoverableAfterProcessorLaunchFailure\(/,
  'must have a dedicated function to downgrade a stuck job to interruptedRecoverable');
assert.match(
  main,
  /if \(currentState != "queued" && currentState != "running"\) return/,
  'must only downgrade a job that still claims to be in-flight, never touching an already-terminal or already-recoverable status',
);
assert.match(main, /json\.put\("state", "interruptedRecoverable"\)/,
  'the downgrade must set state to interruptedRecoverable so it re-enters the already-audited recovery path');
assert.match(
  main,
  /const val RECOVERY_CAUSE_PROCESSOR_RESTART_DENIED = "processor-restart-fgs-denied"/,
  'must use a distinct, named recovery cause rather than mislabeling this as the original foreground-service-timeout',
);
assert.match(main, /recoveryCause: String = RECOVERY_CAUSE_PROCESSOR_RESTART_DENIED/,
  'the downgraded status must carry the distinct recovery cause');

// onDestroy must apply the same downgrade for any restart still pending
// when the app is torn down, not just the terminal-failure branch reached
// during normal operation.
assert.match(
  main,
  /override fun onDestroy\(\)[\s\S]{0,1400}else if \(state\.waiters\.any \{ it\.isRestart \}\) \{[\s\S]{0,250}markJobRecoverableAfterProcessorLaunchFailure\(/,
  'onDestroy must also downgrade any job whose restart was still pending when the activity was torn down',
);

// --- Dart: ForegroundTimeoutRecovery must accept the new recovery cause ---
// --- as well as the original one, since both represent "this job is not --
// --- actually running and needs an explicit foregrounded relaunch". ------

assert.match(recovery, /'foreground-service-timeout'/);
assert.match(recovery, /'processor-restart-fgs-denied'/,
  'ForegroundTimeoutRecovery must also treat the new native recovery cause as automatically retryable');
assert.doesNotMatch(
  recovery,
  /status\.recoveryCause != 'foreground-service-timeout'/,
  'must not hard-code a single recovery cause string any more; use the recoverable-causes set instead',
);

// --- Dart: the milky way screen gets parity with the standard screen's ---
// --- manual recovery affordances, and the sticky-_error bug is fixed. ----

assert.match(milkyWay, /bool _restartingProcessor = false;/);
assert.match(milkyWay, /bool _autoResumingTimeout = false;/);
assert.match(milkyWay, /Future<void> _restartProcessor\(\) async \{/,
  'milky way screen must offer the same manual restart action as the standard screen');
assert.match(milkyWay, /bool get _processorUnresponsive/,
  'milky way screen must detect a stuck running/queued job the same way the standard screen does');
assert.match(milkyWay, /'処理システムだけ再起動して続行'/,
  'milky way screen must offer the unresponsive-processor recovery button');
assert.match(milkyWay, /'保存済み地点から再開'/,
  'milky way screen must offer the interruptedRecoverable manual resume button (parity with the standard screen)');

// The automatic resume attempt must not set a dead-end _error (matches the
// fix already applied to the standard and app-root observers).
const autoResumeCatch = milkyWay.match(
  /ForegroundTimeoutRecovery\.resumeIfNeeded\(\);\s*\n\s*\} on Object([\s\S]{0,300})/,
);
assert.ok(autoResumeCatch, 'could not locate the automatic resumeIfNeeded() catch block in the milky way screen');
assert.doesNotMatch(
  autoResumeCatch[1],
  /setState\(\(\) => _error = error\)/,
  'the milky way screen\'s automatic resume attempt must not set _error either',
);

// The sticky-_error fix: recovering to a healthy in-flight state must clear
// a previously-set _error, or the screen stays on the failure view forever
// even after the job starts running again.
assert.match(
  milkyWay,
  /if \(\(status\.state == StackJobState\.queued \|\|\s*\n\s*status\.state == StackJobState\.running\) &&\s*\n\s*_error != null\) \{\s*\n[\s\S]{0,400}setState\(\(\) => _error = null\)/,
  '_error must be cleared once the job is observed healthy (queued/running) again, or the failure screen never recovers',
);

console.log('Work333 stuck-job self-healing and milky-way parity contract: PASS');
