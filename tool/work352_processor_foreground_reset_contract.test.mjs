import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const main = read('android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt');
const reset = read('android/app/src/main/kotlin/com/mobilestack/app/ProcessorForegroundResetActivity.kt');

test('reset Activity lives in the same OS process as ProcessorService', () => {
  const activity = manifest.match(/<activity\s+android:name="\.ProcessorForegroundResetActivity"[\s\S]*?\/>/);
  assert.ok(activity, 'declared');
  assert.match(activity[0], /android:process=":processor"/);
  assert.match(activity[0], /android:exported="false"/);
  assert.match(activity[0], /android:excludeFromRecents="true"/);
  assert.match(activity[0], /android:noHistory="true"/);
  assert.match(manifest, /android:name="\.ProcessorService"[\s\S]{0,200}android:process=":processor"/);
});

test('FGS type is still mediaProcessing (Play policy invariant)', () => {
  assert.match(manifest, /android:name="\.ProcessorService"[\s\S]{0,400}android:foregroundServiceType="mediaProcessing"/);
});

test('reset is requested on both budget-exhausted paths, bounded and focus-gated', () => {
  const calls = main.match(/requestProcessorForegroundReset\(state\)/g) ?? [];
  assert.equal(calls.length, 2);
  assert.match(main, /if \(state\.budgetResets >= MAX_PROCESSOR_BUDGET_RESETS\) return\n\s+if \(!hasWindowFocus\(\)\) return/);
  assert.match(main, /private const val MAX_PROCESSOR_BUDGET_RESETS = 2/);
  assert.match(main, /if \(isForegroundServiceTimeLimitExhausted\(error\)\) \{\n\s+requestProcessorForegroundReset\(state\)/);
});

test('reset Activity finishes itself quickly and does not start services', () => {
  assert.match(reset, /handler\.postDelayed\(finishRunnable, VISIBLE_MS\)/);
  assert.match(reset, /const val VISIBLE_MS = 400L/);
  assert.doesNotMatch(reset, /startForegroundService|startService/);
});
