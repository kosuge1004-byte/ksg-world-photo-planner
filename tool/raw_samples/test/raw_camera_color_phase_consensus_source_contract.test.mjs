import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../../lib/core/color/raw_camera_color_profile.dart', import.meta.url),
  'utf8',
);

test('camera profile construction validates matrix independently of unknown CFA pattern', () => {
  assert.match(source, /cameraWhiteBalanceRgb:\s*const <double>\[1,\s*1,\s*1\]/);
  assert.doesNotMatch(
    source,
    /cameraWhiteBalanceRgb:\s*normalizedRgbWhiteBalance\(CfaPattern\.rggb\)/,
  );
});

test('same-pattern color consensus preserves per-green-phase WB medians', () => {
  assert.match(source, /normalizedPhaseGains/);
  assert.match(source, /pattern == representativePattern/);
  assert.match(source, /perPhase\[representativePhase\]/);
  assert.match(source, /consensusPhaseGains/);
});
