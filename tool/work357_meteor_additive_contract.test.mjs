import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const compositor = read('lib/core/meteor/streak_compositor.dart');
const result = read('lib/core/meteor/meteor_composite_result.dart');
const worker = read('lib/core/background/meteor_composite_background_worker.dart');
const settings = read('lib/core/settings/app_settings.dart');

test('lighten stays the default; payloads without the key keep lighten', () => {
  assert.match(compositor, /orElse: \(\) => MeteorCompositeBlendMode\.lighten/);
  assert.match(result, /MeteorCompositeBlendMode blendMode = MeteorCompositeBlendMode\.lighten,/);
  assert.match(settings, /static const bool defaultMeteorAdditiveComposite = false;/);
  assert.match(worker, /meteorCompositeBlendModeFromName\(\n\s+input\['meteorCompositeBlendMode'\] as String\?,/);
});

test('the historical lighten call is unchanged in the else branch', () => {
  assert.match(result, /\} else \{\n\s+compositeSelectedStreaksInPlace\(\n\s+destination: composited,\n\s+foreground: foreground\.tile,\n\s+foregroundCoverage: foreground\.coverage,\n\s+streaks: group\.value\n\s+\.map\(\(s\) => _RegisteredStreak\(s, transforms\[group\.key\]!\)\)\n\s+\.toList\(\),\n\s+paddingPixels: paddingPixels,\n\s+\);/);
});

test('additive parameters are estimated once, before the output tile loop', () => {
  const estimate = result.indexOf('perStreak.add(estimateStreakAdditiveParameters(');
  const outputLoop = result.indexOf('outputStore = await intermediateTileStoreFactory(');
  assert.ok(estimate > 0 && outputLoop > estimate);
});

test('foreground frames are never part of the background stack (residue cannot be double counted)', () => {
  assert.match(result, /cannot be part of the background stack/);
});
