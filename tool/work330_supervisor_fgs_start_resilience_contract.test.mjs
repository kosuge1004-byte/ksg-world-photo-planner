import fs from 'node:fs';
import assert from 'node:assert/strict';

const main = fs.readFileSync('android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt', 'utf8');

assert.match(main, /if \(!restart\) \{[\s\S]{0,400}requestProcessorLaunch\(/,
  'new-job path must attempt the processor launch first (via requestProcessorLaunch)');
assert.match(main, /launchReceiver = acknowledgement/,
  'processor launch must request an acknowledgement from the isolated service');
assert.match(main, /resultCode == ProcessorService\.RESULT_LAUNCH_ACCEPTED[\s\S]{0,100}completeProcessorLaunch\(state\)/,
  'caller success must wait until the processor runtime accepts the launch');
assert.match(main, /Supervisor FGS start denied; processor continues and supervisor is deferred/,
  'FGS denial for the supervisor must be deferred rather than reported as processor_start_failed');
assert.match(main, /override fun onWindowFocusChanged\(hasFocus: Boolean\)[\s\S]*retryPendingSupervisorIfForeground\(\)/,
  'deferred supervisor must retry on foreground window focus');
assert.match(main, /message\.contains\("startForegroundService\(\) not allowed"/,
  'must recognize the exact real-device denial seen in Work329');

// Ordering guard: in source position, ProcessorService's own FGS start call
// must appear before SupervisorService's, in both the launch helper and the
// best-effort helper, so a future edit cannot silently reintroduce
// Work329's supervisor-first ordering.
const processorFgsIndex = main.indexOf('startForegroundService(processorIntent)');
const supervisorFgsIndex = main.indexOf('startForegroundService(supervisorIntent)');
assert.ok(processorFgsIndex > -1, 'processor FGS start call must exist');
assert.ok(supervisorFgsIndex > -1, 'supervisor FGS start call must exist');
assert.ok(processorFgsIndex < supervisorFgsIndex,
  'must not place supervisor FGS start before processor launch again');

console.log('Work330 supervisor FGS start resilience contract: PASS');
