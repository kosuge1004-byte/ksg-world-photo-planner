import fs from 'node:fs';
import assert from 'node:assert/strict';

const main = fs.readFileSync(
  'android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt',
  'utf8',
);

// Work331's first pass coalesced ANY second concurrent processor-launch
// request onto whatever attempt happened to already be pending, regardless
// of which job it belonged to. Because StackJobRegistry.activeJob() does not
// count an interruptedRecoverable job as "active", a brand-new, unrelated
// job can legitimately be started while an older job's automatic resume is
// still retrying after an Android FGS-start denial. If the two shared a
// single pending slot, the new job's caller could be told "success" purely
// because the OLD job's ProcessorService happened to start — while the new
// job's own parameters (taskName/payloadPath/statusPath) were never used to
// start anything. This test locks in that coalescing must be keyed by
// jobId, so two different jobs always get independent attempts.

assert.match(
  main,
  /private val pendingProcessorLaunches = mutableMapOf<String, ProcessorLaunchState>\(\)/,
  'pending processor launches must be keyed by jobId (a map), not a single shared slot',
);

// requestProcessorLaunch must look the existing attempt up BY jobId.
assert.match(
  main,
  /val existing = pendingProcessorLaunches\[supervisorRequest\.jobId\]/,
  'looking up an in-flight attempt to coalesce onto must be keyed by the new request\'s own jobId',
);
assert.match(
  main,
  /pendingProcessorLaunches\[supervisorRequest\.jobId\] = state/,
  'a newly created attempt must be registered under its own jobId',
);

// The success/failure paths must remove the entry by the *specific* jobId
// that resolved, not clear a single global slot (which would risk clobbering
// an unrelated job's still-pending state).
assert.match(
  main,
  /val jobId = state\.supervisorRequest\.jobId/,
  'attemptProcessorLaunch must capture the specific jobId of the state it is resolving',
);
const removeCount = (main.match(/pendingProcessorLaunches\.remove\(jobId\)/g) || []).length;
assert.ok(
  removeCount >= 2,
  'both the success path and the terminal-failure path must remove only their own jobId entry ' +
    `(found ${removeCount} occurrence(s), expected at least 2)`,
);

// retryProcessorLaunchIfForeground must be scoped to the specific job's
// state (identity-checked against the map), not act on "whatever is
// pending" globally.
assert.match(
  main,
  /private fun retryProcessorLaunchIfForeground\(state: ProcessorLaunchState\) \{\s*\n[\s\S]{0,500}if \(pendingProcessorLaunches\[state\.supervisorRequest\.jobId\] !== state\) return/,
  'a scheduled retry must only act if it is still the registered attempt for that specific job',
);

// A window-focus regain must retry every pending job independently, not
// just a single one.
assert.match(
  main,
  /private fun retryAllPendingProcessorLaunchesIfForeground\(\) \{[\s\S]{0,250}pendingProcessorLaunches\.values\.toList\(\)[\s\S]{0,120}\.forEach \{ attemptProcessorLaunch\(it\) \}/,
  'regaining window focus must retry every pending job in the map, not a single global pending state',
);

// Each job's retry-scheduled bookkeeping and attempt counter must live on
// its own state object, not a single shared boolean/counter that would let
// one job's scheduled retry suppress another's.
assert.match(main, /var attempt = 0\s*\n\s*var retryScheduled = false/,
  'attempt count and retry-scheduled flag must both be per-job (on ProcessorLaunchState), not global');

console.log('Work332 processor launch job-identity isolation contract: PASS');
