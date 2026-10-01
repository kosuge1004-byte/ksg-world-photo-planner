
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function combineValidSamples(samples) {
  let weighted = 0;
  let coverage = 0;
  let saturatedCoverage = 0;
  for (const sample of samples) {
    if (sample.saturated) {
      saturatedCoverage += sample.weight;
      continue;
    }
    weighted += sample.value * sample.weight;
    coverage += sample.weight;
  }
  return {
    value: coverage > 0 ? weighted / coverage : 0,
    validCoverage: coverage,
    saturatedCoverage,
  };
}

test('saturated CFA sample cannot bias the drizzle value', () => {
  const result = combineValidSamples([
    {value: 100, weight: 1, saturated: false},
    {value: 102, weight: 1, saturated: false},
    {value: 65535, weight: 1, saturated: true},
  ]);
  assert.equal(result.value, 101);
  assert.equal(result.validCoverage, 2);
  assert.equal(result.saturatedCoverage, 1);
});

test('saturation fraction uses valid + saturated observed coverage', () => {
  const mixed = combineValidSamples([
    {value: 100, weight: 1, saturated: false},
    {value: 65535, weight: 1, saturated: true},
  ]);
  const observed = mixed.validCoverage + mixed.saturatedCoverage;
  assert.equal(mixed.saturatedCoverage / observed, 0.5);

  const allSaturated = combineValidSamples([
    {value: 65535, weight: 1, saturated: true},
    {value: 65535, weight: 1, saturated: true},
  ]);
  const allObserved =
      allSaturated.validCoverage + allSaturated.saturatedCoverage;
  assert.equal(allSaturated.validCoverage, 0);
  assert.equal(allSaturated.saturatedCoverage / allObserved, 1);
});

test('production tiled CFA drizzle separates saturated and scientific coverage', () => {
  const drizzle = readFileSync(
    new URL('../../../lib/core/drizzle/tiled_cfa_drizzle.dart', import.meta.url),
    'utf8',
  );
  const reconstruct = readFileSync(
    new URL('../../../lib/core/drizzle/tiled_reconstruct_native_cfa_from_drizzle.dart', import.meta.url),
    'utf8',
  );

  assert.match(
    drizzle,
    /if \(isSaturated\)[\s\S]*saturationAccumulators![\s\S]*else \{[\s\S]*accumulators\[channel\]/,
  );
  assert.match(reconstruct, /saturationDecisionCoverage \+ saturatedCoverage/);
  assert.match(reconstruct, /nativeSaturationDecisionCoverage\?\[index\] \?\? validCoverage/);
  assert.match(reconstruct, /saturatedCoverage \/ observedCoverage/);
});

test('robust-rejection saturation decision keeps pre-rejection unsaturated observations in the denominator', () => {
  // One saturated observation, three unsaturated observations, but robust
  // rejection keeps only one unsaturated value for the scientific signal.
  const survivorCoverage = 1;
  const preRejectionUnsaturatedCoverage = 3;
  const saturatedCoverage = 1;
  const legacyFraction = saturatedCoverage / (survivorCoverage + saturatedCoverage);
  const correctedFraction = saturatedCoverage /
      (preRejectionUnsaturatedCoverage + saturatedCoverage);
  assert.equal(legacyFraction, 0.5);
  assert.equal(correctedFraction, 0.25);
  assert.ok(correctedFraction < 0.5);

  const pipeline = readFileSync(
    new URL('../../../lib/core/session/cfa_drizzle_milky_way_pipeline.dart', import.meta.url),
    'utf8',
  );
  const streaming = readFileSync(
    new URL('../../../lib/core/drizzle/tiled_robust_combine_cfa_drizzle.dart', import.meta.url),
    'utf8',
  );
  assert.match(pipeline, /robustDrizzleCfaFramesParallelTiled\(/);
  assert.match(pipeline, /saturationDecisionCoverageStore = streamed\.preRejectionCoverageStore/);
  assert.match(streaming, /final Float64List\? preRejectionCoverageSum/);
  assert.match(streaming, /preRejectionCoverageSum!\[interleaved\] \+= coverage\[pixel\]/);
  assert.match(streaming, /preRejectionCoverage exceeds finite Float32 range|Streaming robust CFA drizzle output exceeds finite Float32 range/);
});
