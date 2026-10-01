import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('lib/app.dart', 'utf8');
const coordinator = fs.readFileSync(
  'lib/core/background/foreground_timeout_recovery.dart',
  'utf8',
);
const home = fs.readFileSync('lib/features/home/home_screen.dart', 'utf8');
const standard = fs.readFileSync(
  'lib/features/common/standard_background_progress_screen.dart',
  'utf8',
);
const cfa = fs.readFileSync(
  'lib/features/milkyway/cfa_drizzle_milky_way_progress_screen.dart',
  'utf8',
);

test('app root triggers timeout recovery on foreground resume and cold UI start', () => {
  assert.match(app, /with WidgetsBindingObserver/);
  assert.match(app, /AppLifecycleState\.resumed/);
  assert.match(app, /addPostFrameCallback/);
  assert.match(app, /ForegroundTimeoutRecovery\.resumeIfNeeded\(\)/);
});

test('recovery is gated to the durable FGS-timeout interrupted state', () => {
  assert.match(coordinator, /StackJobState\.interruptedRecoverable/);
  assert.match(coordinator, /foreground-service-timeout/);
  assert.match(coordinator, /StackJobRegistry\.recoverableJob\(\)/);
});

test('one shared in-flight future prevents duplicate processor restart calls', () => {
  assert.match(coordinator, /static Future<bool>\? _inFlight/);
  assert.match(coordinator, /if \(current != null\) return current/);
  assert.match(coordinator, /BackgroundStackController\.restartProcessor\(launch\)/);
});

test('all relevant progress surfaces route foreground recovery through coordinator', () => {
  assert.match(home, /ForegroundTimeoutRecovery\.resumeIfNeeded\(\)/);
  assert.match(standard, /ForegroundTimeoutRecovery\.resumeIfNeeded\(\)/);
  assert.match(cfa, /ForegroundTimeoutRecovery\.resumeIfNeeded\(\)/);
});
