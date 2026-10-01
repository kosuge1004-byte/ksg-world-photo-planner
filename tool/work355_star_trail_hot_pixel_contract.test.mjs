import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const worker = read('lib/core/background/standard_stack_background_worker.dart');
const settings = read('lib/core/settings/app_settings.dart');
const hot = read('lib/core/stacking/star_trail_hot_pixels.dart');

test('hot-pixel removal is opt-in and forced off for the pure-max reference', () => {
  assert.match(settings, /static const bool defaultStarTrailHotPixelRemoval = false;/);
  assert.match(worker, /input\['starTrailHotPixelRemoval'\] as bool\? \?\? false;/);
  assert.match(worker, /'automaticStarTrailForegroundProtection': false,\n\s+'starTrailHotPixelRemoval': false,/);
});

test('candidates are saved before the feature checkpoint (restored frames always have them)', () => {
  const save = worker.indexOf('await hotCandidateStore.save(');
  const features = worker.indexOf('await compactFeatureCheckpoints!.save(index, features);');
  assert.ok(save > 0 && features > save);
});

test('the merge and the reference read through the correction only when a map exists', () => {
  assert.match(worker, /final LinearRgbTileStore correctedMergeStore =\n\s+hotPixelMap\.isEmpty\n\s+\? mergeStore\n\s+: HotPixelCorrectedRgbStore\(mergeStore, hotPixelMap\);/);
  assert.match(worker, /mergeStarTrailFrameIntoRollingAccumulator\(\n\s+frameStore: correctedMergeStore,/);
  assert.match(worker, /referenceStore: averagedForeground \?\? referenceReadStore,/);
});

test('detection thresholds and the temporal rule match the reference', () => {
  assert.match(hot, /const int defaultHotPixelMinFrames = 20;/);
  assert.match(hot, /const double defaultHotPixelFraction = 0\.7;/);
  assert.match(hot, /double sigmaK = 8,\n\s+double sharpness = 2\.5,/);
  assert.match(hot, /const int _correctionMargin = 3;/);
});
