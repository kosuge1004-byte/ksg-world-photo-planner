import fs from 'node:fs';
import assert from 'node:assert/strict';

const main = fs.readFileSync(
  'android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt',
  'utf8',
);

// A restart observed to reproducibly crash the freshly-relaunched
// :processor process, with no trace in either the Dart diagnostic log or
// writeBootstrapFailure's status write, is consistent with the new process
// racing the still-tearing-down old one after a blind, fixed-duration wait.
// Confirming actual death (via ActivityManager.runningAppProcesses) before
// relaunching is strictly safer regardless of whether that is the exact
// root cause, so a fixed "postDelayed(..., 750L)" guess must not return.

assert.doesNotMatch(
  main,
  /killProcess\(it\)[\s\S]{0,200}postDelayed\(\{[\s\S]{0,200}requestProcessorLaunch/,
  'must not relaunch the processor after a blind fixed-duration wait; death must be confirmed first',
);

assert.match(main, /private fun awaitProcessorDeathThenLaunch\(/,
  'must poll for confirmed processor death before relaunching');
assert.match(
  main,
  /val processes = try \{[\s\S]{0,250}activityManager\.runningAppProcesses[\s\S]{0,350}val stillAlive = processes\?\.any \{[\s\S]{0,150}it\.pid == targetPid[\s\S]{0,150}it\.processName == processorName/,
  'must check ActivityManager.runningAppProcesses for the specific :processor entry (by pid when known, ' +
    'so a freshly (re)spawned process under the same name cannot be mistaken for the one being waited on), ' +
    'not assume death after a timer',
);
assert.match(main, /if \(stillAlive != false && !timedOut\)/,
  'an unavailable process list must be treated as unknown and polled until the deadline');

// Polling must be bounded (both a per-poll interval and an overall
// timeout). Work336 requires an explicit recoverable launch failure when
// the deadline expires with unknown/live status; it must not race two writers.
assert.match(main, /private const val PROCESSOR_DEATH_POLL_INTERVAL_MS = \d+L/);
assert.match(main, /private const val PROCESSOR_DEATH_SETTLE_MS = \d+L/);
assert.match(main, /private const val PROCESSOR_DEATH_MAX_WAIT_MS = \d+L/);
assert.match(
  main,
  /val timedOut = android\.os\.SystemClock\.elapsedRealtime\(\) >= deadlineElapsedRealtimeMs/,
  'must track an absolute deadline so polling cannot continue indefinitely',
);
assert.match(
  main,
  /if \(stillAlive != false && !timedOut\) \{[\s\S]{0,700}return\s*\n\s*\}/,
  'must keep rescheduling itself while the process is still alive and the deadline has not passed',
);
assert.match(
  main,
  /mainHandler\.postDelayed\(\{[\s\S]{0,350}attemptProcessorLaunch\(state\)[\s\S]{0,200}\}, PROCESSOR_DEATH_SETTLE_MS\)/,
  'must launch (after the settle buffer) after death is confirmed',
);
assert.match(main, /if \(timedOut && stillAlive != false\) \{[\s\S]{0,500}failProcessorLaunch\([\s\S]{0,300}return/,
  'unknown/live processor at the deadline must fail safely before relaunch');
assert.doesNotMatch(main, /launching anyway/);

// The restart call site must route through the new poll-based helper
// rather than directly calling requestProcessorLaunch after killProcess.
assert.match(
  main,
  /pendingProcessorLaunches\[jobId\] = state[\s\S]{0,1200}killProcess\(it\)[\s\S]{0,250}awaitProcessorDeathThenLaunch\(/,
  'the restart path must hand off to awaitProcessorDeathThenLaunch after killing the old process',
);

// Work334-follow-up: killing :processor while ProcessorService's
// START_REDELIVER_INTENT contract is still active risks Android itself
// resurrecting the Service (and a fresh :processor) mid-restart, racing the
// explicit relaunch above. stopService() must run before the kill.
assert.match(
  main,
  /stopService\(Intent\(this, ProcessorService::class\.java\)\)[\s\S]{0,120}killProcess\(it\)/,
  'must stop the Service (cancelling START_REDELIVER_INTENT) before killing the old :processor, ' +
    'not just kill and hope',
);

console.log('Work334 processor-death confirmation before restart contract: PASS');
