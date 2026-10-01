import fs from 'node:fs';
import assert from 'node:assert/strict';

const main = fs.readFileSync(
  'android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt',
  'utf8',
);
const standard = fs.readFileSync(
  'lib/features/common/standard_background_progress_screen.dart',
  'utf8',
);
const cfa = fs.readFileSync(
  'lib/features/milkyway/cfa_drizzle_milky_way_progress_screen.dart',
  'utf8',
);
const home = fs.readFileSync('lib/features/home/home_screen.dart', 'utf8');

// --- Native: the processor's own FGS-start denial must be retried, not ---
// --- treated as an immediate, unretryable failure. -----------------------

assert.match(main, /private val pendingProcessorLaunches = mutableMapOf<String, ProcessorLaunchState>\(\)/,
  'must track pending processor launches keyed by jobId, not a single global slot');
assert.match(main, /var retryScheduled = false/,
  'retry-scheduled bookkeeping must live per pending job, not as one shared global flag');
assert.match(main, /private const val MAX_PROCESSOR_FGS_RETRIES = \d+/,
  'processor FGS-start retry must be bounded, not infinite');

assert.match(
  main,
  /if \(\(isForegroundStartNotAllowed\(error\) \|\|\s*isForegroundServiceTimeLimitExhausted\(error\)\) &&\s*state\.attempt < MAX_PROCESSOR_FGS_RETRIES\) \{/,
  'a processor FGS-start denial, including an exhausted mediaProcessing budget, must be retried (bounded) rather than failing on the first attempt',
);
assert.match(main, /state\.attempt \+= 1/,
  'a deferred processor retry must increment the shared attempt counter');
assert.match(main, /scheduleProcessorRetry\(state\)/,
  'a denied processor launch must schedule a deferred retry for its own state');

// Only genuinely exhausted retries or non-FGS errors may fail the call, and
// every waiter registered on the attempt must be told (not just the first).
assert.match(
  main,
  /\} else \{\s*\n\s*failProcessorLaunch\(state, error\)/,
  'only a non-FGS error or exhausted retries may report processor_start_failed/processor_restart_failed, to every waiter',
);
assert.match(main, /state\.waiters\.toList\(\)\.forEach \{ it\.result\.success\(null\) \}/,
  'a successful launch must resolve every waiter registered on the same attempt, not just one');
assert.match(main, /private fun failProcessorLaunch\([\s\S]{0,900}waiter\.result\.error\(/,
  'the shared terminal failure helper must resolve every waiter');

assert.match(main, /private fun retryProcessorLaunchIfForeground\(state: ProcessorLaunchState\)/,
  'must retry a specific deferred processor launch once in the foreground');
assert.match(main, /private fun retryAllPendingProcessorLaunchesIfForeground\(\)/,
  'window focus regain must be able to retry every pending job, not just one');
assert.match(
  main,
  /override fun onWindowFocusChanged\(hasFocus: Boolean\)[\s\S]*retryAllPendingProcessorLaunchesIfForeground\(\)[\s\S]*retryPendingSupervisorIfForeground\(\)/,
  'window focus regain must retry all pending processor launches and a pending supervisor start',
);

assert.match(
  main,
  /override fun onDestroy\(\)[\s\S]{0,2200}pendingProcessorLaunches\.clear\(\)/,
  'onDestroy must clear all pending processor retry state to avoid a stale retry after teardown',
);
assert.match(
  main,
  /override fun onDestroy\(\)[\s\S]{0,1300}state\.waiters\.forEach/,
  'onDestroy must resolve any still-pending waiters for every job instead of leaving their Result forever incomplete',
);

// --- Native: a second concurrent launch request for the *same* job must --
// --- coalesce onto its in-flight attempt, but a request for a *different*-
// --- job must never be absorbed into someone else's pending attempt ------
// --- (an interruptedRecoverable job's retry must not silently swallow a --
// --- brand-new, unrelated job's Result). ----------------------------------

assert.match(
  main,
  /private fun requestProcessorLaunch\([\s\S]{0,150}\) \{\s*\n\s*val existing = pendingProcessorLaunches\[supervisorRequest\.jobId\]\s*\n\s*if \(existing != null\) \{\s*\n\s*existing\.waiters\.add\(waiter\)\s*\n\s*return\s*\n\s*\}/,
  'a second concurrent launch request for the SAME jobId must join the existing waiter list; the lookup must be keyed by jobId, not an unconditional single pending state',
);

// --- Dart: the manual restart button must not fire while the automatic ---
// --- foreground-resume attempt for the same job is already in flight, ----
// --- since both ultimately race into the same native launch path. --------

assert.match(
  standard,
  /if \(launch == null \|\| _restartingProcessor \|\| _autoResumingTimeout\) return;/,
  'manual restart must not fire while an automatic resume attempt is already in flight',
);
assert.match(
  standard,
  /onPressed: \(_restartingProcessor \|\|\s*_autoResumingTimeout\)\s*\? null\s*:\s*_restartProcessor,/,
  'the manual restart button must be disabled while an automatic resume attempt is in flight',
);

// --- Dart: automatic (non-user-initiated) foreground resume attempts ----
// --- must never freeze a recoverable job into a dead-end error screen. --

function autoResumeCatchIsNonFatal(source, describeScreen) {
  const match = source.match(
    /ForegroundTimeoutRecovery\.resumeIfNeeded\(\);\s*\n\s*\} on Object([\s\S]{0,200})/,
  );
  assert.ok(match, `${describeScreen}: could not locate the automatic resumeIfNeeded() catch block`);
  assert.doesNotMatch(
    match[1],
    /setState\(\(\) => _error = error\)/,
    `${describeScreen}: automatic foreground-resume failure must not set _error ` +
      '(that hides the recoverable-job UI behind an unretryable failure screen)',
  );
}

autoResumeCatchIsNonFatal(standard, 'standard_background_progress_screen.dart');
autoResumeCatchIsNonFatal(cfa, 'cfa_drizzle_milky_way_progress_screen.dart');

// home_screen.dart already swallowed this without a UI-visible _error;
// confirm it still does, for consistency across all three observers.
assert.match(home, /ForegroundTimeoutRecovery\.resumeIfNeeded\(\)/);
assert.doesNotMatch(
  home,
  /resumeIfNeeded\(\)[\s\S]{0,120}setState\(\(\) => _error/,
  'home_screen.dart must not surface a dead-end error from the automatic resume attempt either',
);

console.log('Work331 processor own FGS start resilience contract: PASS');
