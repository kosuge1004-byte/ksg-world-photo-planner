import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pubspec = readFileSync(
  new URL('../../../pubspec.yaml', import.meta.url),
  'utf8',
);
const gradle = readFileSync(
  new URL('../../../android/gradle.properties', import.meta.url),
  'utf8',
);
const manifest = readFileSync(
  new URL('../../../android/app/src/main/AndroidManifest.xml', import.meta.url),
  'utf8',
);
const main = readFileSync(
  new URL('../../../lib/main.dart', import.meta.url),
  'utf8',
);

test('current Workmanager and notification dependencies are wired', () => {
  assert.match(pubspec, /workmanager:\s*\^0\.10\.7/);
  assert.match(pubspec, /flutter_local_notifications:\s*\^22\.2\.0/);
  assert.match(main, /Workmanager\(\)\.initialize\(backgroundTaskDispatcher\)/);
});

test('Android foreground worker and notification permission are configured', () => {
  assert.match(gradle, /workmanager\.enableDataSyncForegroundService=true/);
  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
});
