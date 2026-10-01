import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const worker = read('lib/core/background/standard_stack_background_worker.dart');
const pipeline = read('lib/core/session/star_trail_pipeline.dart');
const settings = read('lib/core/settings/app_settings.dart');
const store = read('lib/core/background/post_decode_pipeline_checkpoint_store.dart');

test('all Work356 options are opt-in and forced off for the pure-max reference', () => {
  for (const name of ['MeteorProtection', 'MeanBackground', 'ForegroundAverage']) {
    assert.match(settings, new RegExp(`static const bool defaultStarTrail${name} = false;`));
    assert.match(worker, new RegExp(`input\\['starTrail${name}'\\] as bool\\? \\?\\? false;`));
    assert.match(worker, new RegExp(`'starTrail${name}': false,`));
  }
});

test('meteor protection only relaxes the blinking rule for isolated streaks with known segment counts', () => {
  assert.match(pipeline, /const int starTrailMeteorProtectionMinimumBlinkSegments = 4;/);
  assert.match(pipeline, /minimumBlinkSegmentsForIsolated != null &&\n\s+result\.category == StreakPersistenceCategory\.isolated &&\n\s+segmentCounts != null &&/);
  assert.match(worker, /starTrailMeteorProtection\n\s+\? starTrailMeteorProtectionMinimumBlinkSegments\n\s+: null,/);
});

test('rolling sum uses its own checkpoint directory and must be in step with the maximum', () => {
  assert.match(store, /String directoryName = 'post_decode_pipeline_checkpoints_v1',/);
  assert.match(worker, /directoryName: 'star_trail_rolling_sum_v1',/);
  assert.match(worker, /restoredSum\.committedItems == rollingItems &&/);
  assert.match(worker, /rollingSumAvailable = false;/);
});

test('the default path exports and protects exactly the rolling maximum', () => {
  assert.match(worker, /final LinearRgbTileStore combinedInput = meanCombined \?\? finalStore;/);
  assert.match(worker, /if \(starTrailMeanBackground\) \{\n\s+meanCombined = await combineStarTrailMeanAndMax\(/);
  assert.match(worker, /tileStore: finalStore == rollingRgb \? combinedInput : finalStore,/);
  assert.match(worker, /starTrailForegroundAverage \? meanStore : null;/);
});

test('storage headroom keeps the historical base and adds the sum only when used', () => {
  assert.match(worker, /pixels \* 84 \+ 768 \* 1024 \* 1024 \+\n\s+\(includeRollingSum \? pixels \* 36 : 0\);/);
});
