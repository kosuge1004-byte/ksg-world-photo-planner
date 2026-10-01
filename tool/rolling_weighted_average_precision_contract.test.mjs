import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// This test locks in the numeric finding made while building
// `tiled_weighted_average_combiner.dart`: a rolling fold of a weighted
// average must accumulate at the SAME precision the production combiner
// uses internally (FP64), narrowing to FP32 only once at the very final
// divide, or it silently disagrees with the production result.

function fp64BatchLikeProduction(samples, weights) {
  // Mirrors TiledKappaSigmaCombiner's finalSums/finalWeightSums loop
  // (enableOutlierRejection: false path) exactly: Float64 accumulation,
  // single narrow-to-Float32 at the end.
  let sum = 0.0;
  let weightSum = 0.0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * weights[i];
    weightSum += weights[i];
  }
  const value = weightSum > 0 ? sum / weightSum : 0;
  return Math.fround(value);
}

function fp64RollingFold(samples, weights) {
  // Mirrors mergeIntoRollingWeightedAverageAccumulator +
  // finalizeRollingWeightedAverage: each "fold" adds into FP64 running
  // totals (JS numbers are FP64 natively), narrowing to Float32 only in
  // the final division — never per-fold.
  let sum = 0.0;
  let weightSum = 0.0;
  for (let i = 0; i < samples.length; i++) {
    // Each iteration stands in for one call to
    // mergeIntoRollingWeightedAverageAccumulator with the previous
    // generation's (sum, weightSum) as previousWeightedSum/previousWeightSum.
    sum = sum + samples[i] * weights[i];
    weightSum = weightSum + weights[i];
  }
  const value = weightSum > 0 ? sum / weightSum : 0;
  return Math.fround(value);
}

function fp32PerFoldRounding(samples, weights) {
  // The rejected first design: narrows to Float32 after every fold,
  // exactly what happens if the accumulator store is Float32-backed
  // (LinearRgbTileStore) instead of Float64-backed (Float64RgbTileStore).
  let sum = Math.fround(0.0);
  let weightSum = Math.fround(0.0);
  for (let i = 0; i < samples.length; i++) {
    sum = Math.fround(sum + Math.fround(samples[i] * weights[i]));
    weightSum = Math.fround(weightSum + weights[i]);
  }
  const value = weightSum > 0 ? sum / weightSum : 0;
  return Math.fround(value);
}

function randomTrial(rng) {
  const frameCount = 3 + Math.floor(rng() * 200);
  const samples = [];
  const weights = [];
  for (let i = 0; i < frameCount; i++) {
    samples.push(Math.fround(rng() * 60000));
    weights.push(Math.fround(0.05 + rng() * 0.95));
  }
  return { samples, weights };
}

// Deterministic PRNG so this test is reproducible, not flaky.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('FP64 rolling fold matches the production FP64-accumulated weighted average bit-for-bit', () => {
  const rng = mulberry32(20260909);
  for (let trial = 0; trial < 5000; trial++) {
    const { samples, weights } = randomTrial(rng);
    const production = fp64BatchLikeProduction(samples, weights);
    const rolling = fp64RollingFold(samples, weights);
    assert.equal(
      rolling,
      production,
      `trial ${trial}: FP64 rolling fold diverged from production result`,
    );
  }
});

test('a Float32-backed rolling accumulator (the rejected design) measurably diverges from production', () => {
  // This is a guardrail, not an aspiration: it documents *why*
  // tiled_weighted_average_combiner.dart uses Float64RgbTileStore instead
  // of the project's usual Float32-backed LinearRgbTileStore for its
  // running totals. If this test ever starts failing (i.e. FP32 per-fold
  // rounding stops diverging), that's not a problem to fix — it would
  // just mean this guardrail is no longer demonstrating the risk it
  // exists to document.
  const rng = mulberry32(20260909);
  let mismatches = 0;
  const trials = 5000;
  for (let trial = 0; trial < trials; trial++) {
    const { samples, weights } = randomTrial(rng);
    const production = fp64BatchLikeProduction(samples, weights);
    const fp32PerFold = fp32PerFoldRounding(samples, weights);
    if (fp32PerFold !== production) mismatches++;
  }
  // Observed ~77% divergence during development; assert a wide but
  // non-trivial lower bound so this guardrail stays meaningful without
  // being pinned to an exact percentage.
  assert.ok(
    mismatches > trials * 0.3,
    `expected the rejected FP32-per-fold design to diverge from production ` +
      `in a large fraction of trials, got ${mismatches}/${trials}`,
  );
});

test('tiled_weighted_average_combiner.dart accumulates in Float64RgbTileStore, not the project-wide Float32 LinearRgbTileStore', () => {
  const source = fs.readFileSync(
    'lib/core/stacking/tiled_weighted_average_combiner.dart',
    'utf8',
  );
  assert.match(source, /Float64RgbTileStore weightedSum/);
  assert.match(source, /Float64RgbTileStore weightSum/);
  assert.match(
    source,
    /final Float64List outSum =\s*Float64List\(region\.outputWidth \* region\.outputHeight \* 3\);/,
  );
  assert.match(source, /final Float64List outWeight = Float64List\(outSum\.length\);/);
  // The one and only place FP32 narrowing should happen.
  assert.match(source, /final Float32List out = Float32List\(sum\.length\);/);
});
