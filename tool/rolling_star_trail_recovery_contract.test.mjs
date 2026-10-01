import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync('lib/core/background/standard_stack_background_worker.dart', 'utf8');
const starTrail = fs.readFileSync('lib/core/session/star_trail_pipeline.dart', 'utf8');
const meteor = fs.readFileSync('lib/core/session/meteor_pipeline.dart', 'utf8');
const checkpoint = fs.readFileSync('lib/core/background/post_decode_pipeline_checkpoint_store.dart', 'utf8');
const controller = fs.readFileSync('lib/core/background/background_stack_controller.dart', 'utf8');

test('star trail switches to compact first pass plus exact rolling second pass', () => {
  assert.match(worker, /if \(useRollingStarTrail\)/);
  assert.match(worker, /extractMeteorCompactFrameFeatures/);
  assert.match(worker, /classifyStarTrailNonSiderealCompactFeatures/);
  assert.match(worker, /mergeStarTrailFrameIntoRollingAccumulator/);
  assert.match(worker, /star_trail_compact_features_v1/);
});

test('legacy full-frame star-trail decode checkpoints are discarded before rolling work', () => {
  const branch = worker.indexOf('if (useRollingStarTrail) {');
  const cleanup = worker.indexOf('await decodeCheckpoints?.cleanupAll();', branch);
  const compact = worker.indexOf('extractMeteorCompactFrameFeatures', branch);
  assert.ok(branch >= 0 && cleanup > branch && compact > cleanup);
});

test('compact feature snapshots contain all signals required by aircraft rejection and gap fill', () => {
  assert.match(meteor, /final class MeteorCompactFrameFeatures/);
  assert.match(meteor, /final List<StreakCandidate> streaks/);
  assert.match(meteor, /final List<DetectedStar> stars/);
  assert.match(meteor, /likelyBlinkingByStreak/);
  assert.match(meteor, /sufficientBrightnessSamplesByStreak/);
  assert.match(worker, /computeGapFillSegments\([\s\S]*features\[index - 1\]\.stars/);
});

test('rolling accumulator retains validity separately so negative linear samples are not clamped to zero', () => {
  assert.match(starTrail, /LinearContributionTileStore\? previousValidity/);
  assert.match(starTrail, /priorValid && frameValid/);
  assert.match(starTrail, /final double weighted = current\[offset\] \* frameWeight;/);
  assert.match(starTrail, /weighted > old!\[offset\]/);
  assert.match(starTrail, /counts\[offset\] = 0/);
  assert.match(starTrail, /Rolling comparison-light input contains a non-finite sample/);
});

test('rolling checkpoint publication carries cursor and stage in the same atomic manifest', () => {
  assert.match(checkpoint, /int\? committedItems/);
  assert.match(checkpoint, /String\? checkpointStage/);
  assert.match(checkpoint, /'committedItems': committedItems/);
  assert.match(checkpoint, /'checkpointStage': checkpointStage/);
  assert.match(worker, /checkpointStage: 'rolling'/);
  assert.match(worker, /checkpointStage: 'finalized'/);
});

test('rolling checkpoint store can publish multiple immutable generations', () => {
  assert.match(checkpoint, /_generation = null;/);
  assert.match(checkpoint, /_newRgbStore = null;/);
  assert.match(checkpoint, /_newContributionStore = null;/);
});

test('start storage estimate is bounded by image size rather than star-trail frame count', () => {
  assert.match(controller, /mode == ProcessingMode\.starTrail\s*\? frameBytes \* 7/);
  assert.match(controller, /rollingMilkyWay\s*\? metadata\.width \* metadata\.height \* 186/);
  assert.match(controller, /:\s*frameBytes \* sourcePaths\.length/);
});

test('rolling comparison-light math is associative with explicit validity, including negative samples', () => {
  const frames = [
    {rgb: [-2, -1, -3, 5, 1, 0], valid: [1, 0]},
    {rgb: [-4, -0.5, -7, 4, 9, 3], valid: [1, 1]},
    {rgb: [-1, -8, -2, 2, 8, 7], valid: [0, 1]},
  ];
  const batch = [];
  for (let pixel = 0; pixel < 2; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const values = frames
        .filter(f => f.valid[pixel])
        .map(f => f.rgb[pixel * 3 + channel]);
      batch.push(values.length ? Math.max(...values) : 0);
    }
  }
  let rolling = Array(6).fill(0);
  let valid = [0, 0];
  for (const frame of frames) {
    for (let pixel = 0; pixel < 2; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        const o = pixel * 3 + channel;
        if (valid[pixel] && frame.valid[pixel]) rolling[o] = Math.max(rolling[o], frame.rgb[o]);
        else if (!valid[pixel] && frame.valid[pixel]) rolling[o] = frame.rgb[o];
      }
      valid[pixel] = valid[pixel] || frame.valid[pixel] ? 1 : 0;
    }
  }
  assert.deepEqual(rolling, batch);
  assert.equal(rolling[0], -2, 'negative-only valid samples must stay negative, not become zero');
});
