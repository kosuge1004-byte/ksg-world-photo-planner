import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const worker = readFileSync(
  new URL('../../../lib/core/background/standard_stack_background_worker.dart', import.meta.url),
  'utf8',
);
const processor = readFileSync(
  new URL('../../../android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt', import.meta.url),
  'utf8',
);

test('post-decode recovery skips non-reference RAWs when the committed stack is sufficient', () => {
  assert.match(worker, /final bool referenceOnlyPostDecodeRecovery\s*=\s*restoredPostDecode != null/);
  assert.match(worker, /referenceOnlyPostDecodeRecovery && index != referenceIndex/);
  assert.match(worker, /!referenceOnlyPostDecodeRecovery \|\| index == referenceIndex/);
  assert.match(worker, /quality\.linearScale < 1 && !referenceOnlyPostDecodeRecovery/);
});

test('rolling star-trail gap fill uses compact star sidecars instead of retaining full-frame RGB stores', () => {
  assert.match(worker, /final bool useRollingStarTrail = mode == ProcessingMode\.starTrail/);
  assert.match(worker, /computeGapFillSegments\([\s\S]*?starsBefore: features\[index - 1\]\.stars,[\s\S]*?starsAfter: features\[index\]\.stars/);
  assert.match(worker, /await compactFeatureCheckpoints!?\.save\(index, features\)/);
});

test('Android 15 foreground-service timeout is persisted as recoverable without restart marker', () => {
  assert.match(processor, /override fun onTimeout\(startId: Int, fgsType: Int\)/);
  assert.match(processor, /writeSystemTimeoutRecoverable\(activeStatusPath, fgsType\)/);
  assert.match(processor, /json\.put\("state", "interruptedRecoverable"\)/);
  assert.match(processor, /json\.put\("recoveryCause", "foreground-service-timeout"\)/);
  assert.doesNotMatch(
    processor.match(/private fun writeSystemTimeoutRecoverable[\s\S]*?\/\*\* Best-effort terminal status/)?.[0] ?? '',
    /supervisor-restart"\)/,
  );
});
