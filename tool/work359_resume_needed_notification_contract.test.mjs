import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const processor = read('android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt');
const supervisor = read('android/app/src/main/kotlin/com/mobilestack/app/SupervisorService.kt');

test('budget pause posts a tappable, audible-once notification on a default-importance channel', () => {
  assert.match(processor, /private const val ATTENTION_CHANNEL_ID = "stack_attention"/);
  assert.match(processor, /NotificationManager\.IMPORTANCE_DEFAULT,/);
  assert.match(processor, /\.setContentIntent\(openAppPendingIntent\(\)\)/);
  assert.match(processor, /\.setAutoCancel\(true\)/);
  assert.match(processor, /\.setOnlyAlertOnce\(true\)/);
  assert.match(processor, /Intent\(this, MainActivity::class\.java\)/);
});

test('both budget paths notify: onTimeout and exhausted-at-startup', () => {
  const onTimeout = processor.slice(processor.indexOf('override fun onTimeout('), processor.indexOf('override fun onDestroy('));
  assert.match(onTimeout, /postResumeNeededNotification\(\)/);
  assert.match(processor, /writeSystemTimeoutRecoverable\(statusPath, fgsType = -1\)\n[\s\S]{0,300}postResumeNeededNotification\(\)/);
});

test('supervisor waiting notification tells the person to open the app and opens it on tap', () => {
  assert.match(supervisor, /アプリを開くとすぐ再開できます/);
  assert.match(supervisor, /\.setContentIntent\(openApp\)/);
});
