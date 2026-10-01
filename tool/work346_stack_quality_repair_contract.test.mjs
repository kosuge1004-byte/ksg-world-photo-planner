import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync('lib/core/background/standard_stack_background_worker.dart', 'utf8');
const milky = readFileSync('lib/core/session/milky_way_pipeline.dart', 'utf8');
const dual = readFileSync('lib/core/registration/adaptive_dual_alignment_resampler.dart', 'utf8');
const kappa = readFileSync('lib/core/stacking/tiled_kappa_sigma_combiner.dart', 'utf8');

test('WORK346+ invalidates WORK345 checkpoints after stack-math changes', () => {
  const match = worker.match(/'algorithmRevision':\s*(\d+)/);
  assert.ok(match, 'algorithmRevision must be present');
  assert.ok(Number(match[1]) >= 346, 'revision must remain newer than WORK345');
});

test('dual alignment removes isolated identity-domain decisions with a halo', () => {
  assert.match(dual, /requireSpatialIdentitySupport = true/);
  assert.match(dual, /final int halo = requireSpatialIdentitySupport \? 2 : 0/);
  assert.match(dual, /_hasIdentityNeighbour\(/);
  assert.match(dual, /8-connected neighbourhood/);
  assert.match(dual, /expandedTile/);
});

test('Milky Way kappa-sigma keeps RGB source membership synchronized', () => {
  assert.match(kappa, /this\.synchronizeRgbRejection = false/);
  assert.match(kappa, /_pixelSurvivesAllChannels/);
  assert.match(kappa, /synchronizedSurvivorCounts/);
  assert.match(milky, /synchronizeRgbRejection: true/);
});

test('Milky Way rejection cannot intentionally collapse a >=2-frame stack to one survivor', () => {
  assert.match(milky, /minimumSurvivingFrames: includedIndices\.length >= 2 \? 2 : 1/);
  assert.match(kappa, /synchronizedSurvivorCounts\[pixel\] >= minimumSurvivingFrames/);
  assert.match(kappa, /retaining a possible transient is preferable/);
});

test('checkpoint identity records the new survivor and RGB synchronization semantics', () => {
  assert.match(milky, /'minimumSurvivingFrames': includedIndices\.length >= 2 \? 2 : 1/);
  assert.match(milky, /'synchronizeRgbRejection': true/);
});

test('exact contribution diagnostics report low-count and RGB-mismatch area explicitly', () => {
  assert.match(worker, /rgbCountMismatchPixels=/);
  assert.match(worker, /pixelsAnyChannelBelow2=/);
  assert.match(worker, /pixelsAnyChannelZero=/);
});

// Behavioural mirror of WORK346's deliberately minimal spatial rule.
function supportedIdentity(candidates, width, height, x, y) {
  if (!candidates[y * width + x]) return false;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      if (candidates[ny * width + nx]) return true;
    }
  }
  return false;
}

test('spatial rule suppresses a singleton but preserves a thin connected foreground', () => {
  const width = 5, height = 3;
  const isolated = new Uint8Array(width * height);
  isolated[1 * width + 2] = 1;
  assert.equal(supportedIdentity(isolated, width, height, 2, 1), false);

  const thin = new Uint8Array(width * height);
  thin[1 * width + 2] = 1;
  thin[1 * width + 3] = 1;
  assert.equal(supportedIdentity(thin, width, height, 2, 1), true);
  assert.equal(supportedIdentity(thin, width, height, 3, 1), true);
});
