import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const workflow = fs.readFileSync(
  new URL('.github/workflows/native-raw-abi.yml', root),
  'utf8',
);
const preflight = fs.readFileSync(
  new URL('tool/work187_codex_preflight.sh', root),
  'utf8',
);

test('arm64 release builds can exclude every non-arm64 native ABI', () => {
  const gradle = fs.readFileSync(
    new URL('android/app/build.gradle.kts', root),
    'utf8',
  );
  assert.match(gradle, /gradleProperty\("mobileStackArm64Only"\)/);
  assert.match(gradle, /abiFilters \+= "arm64-v8a"/);
  assert.match(gradle, /"lib\/armeabi-v7a\/\*\*"/);
  assert.match(gradle, /"lib\/x86_64\/\*\*"/);
});

test('CI builds and ABI-checks both Android debug and release arm64 APKs', () => {
  assert.match(workflow, /flutter build apk[\s\S]*?--debug[\s\S]*?--target-platform android-arm64/);
  assert.match(workflow, /flutter build apk[\s\S]*?--release[\s\S]*?--target-platform android-arm64/);
  assert.match(workflow, /app-debug\.apk/);
  assert.match(workflow, /app-release\.apk/);
  assert.match(workflow, /android-arm64-debug\/libmobile_stack_raw\.so/);
  assert.match(workflow, /android-arm64-release\/libmobile_stack_raw\.so/);
  assert.ok((workflow.match(/-PmobileStackArm64Only=true/g) ?? []).length >= 2);
  assert.match(workflow, /armeabi-v7a\|x86\|x86_64/);
});

test('CI compiles and ABI-checks iOS debug and release without signing', () => {
  assert.match(workflow, /flutter build ios[\s\S]*?--debug[\s\S]*?--no-codesign/);
  assert.match(workflow, /flutter build ios[\s\S]*?--release[\s\S]*?--no-codesign/);
  assert.ok(
    (workflow.match(/bash tool\/check_native_exports\.sh[\s\S]*?build\/ios\/iphoneos\/Runner\.app\/Runner/g) ?? []).length >= 2,
  );
});

test('local preflight includes Android release build and release ABI verification', () => {
  assert.match(preflight, /flutter build apk --release --target-platform android-arm64/);
  assert.match(preflight, /app-release\.apk/);
  assert.match(preflight, /android-arm64-release\/libmobile_stack_raw\.so/);
  assert.match(preflight, /android-release-abi\.txt/);
  assert.ok((preflight.match(/-PmobileStackArm64Only=true/g) ?? []).length >= 2);
  assert.match(preflight, /non-arm64 native ABI found in release APK/);
});
