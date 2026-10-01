import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../../lib/core/color/raw_camera_color_profile.dart', import.meta.url),
  'utf8',
);

test('WB harmonization removes arbitrary common metadata gain scale before sample scaling', () => {
  assert.match(source, /normalizedPhaseWhiteBalance\(CfaPattern pattern\)/);
  assert.match(source, /gain\s*\/\s*greenGain/);
  assert.match(source, /source\.normalizedPhaseWhiteBalance\(sourcePattern\)/);
  assert.match(source, /targetRgbGains\[color\]\s*\/\s*sourcePhaseGains\[phase\]/);
  assert.doesNotMatch(source, /targetRgbGains\[color\]\s*\/\s*source\.phaseWhiteBalance\[phase\]/);
});
