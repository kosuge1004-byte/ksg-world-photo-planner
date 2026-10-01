import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const registry = readFileSync(
  new URL('../../../lib/core/demosaic/demosaic_registry.dart', import.meta.url),
  'utf8',
);
const factory = readFileSync(
  new URL('../../../lib/core/pipeline/phase2_quality_pipeline_factory.dart', import.meta.url),
  'utf8',
);
const policy = readFileSync(
  new URL('../../../lib/core/quality/highest_quality_policy.dart', import.meta.url),
  'utf8',
);
const milky = readFileSync(
  new URL('../../../lib/core/session/milky_way_pipeline.dart', import.meta.url),
  'utf8',
);

test('highest-quality demosaic requires an explicitly production-quality backend', () => {
  assert.match(registry, /requireProduction\(DemosaicAlgorithm algorithm\)/);
  assert.match(registry, /if \(!engine\.isProductionQuality\)/);
  assert.match(registry, /throw DemosaicBackendUnavailable/);
  assert.match(factory, /registry\.requireProduction\(/);
  assert.doesNotMatch(factory, /ReferenceBilinearDemosaic/);
});

test('highest-quality policy forbids automatic precision or resolution downgrade', () => {
  assert.match(policy, /allowFp16Fallback\s*=>\s*false/);
  assert.match(policy, /allowApproximateMath\s*=>\s*false/);
  assert.match(policy, /allowAutomaticResolutionReduction\s*=>\s*false/);
  assert.match(policy, /stack_accumulation'\s*=>\s*ProcessingPrecision\.float64/);
});

test('Milky Way keeps full-resolution stack output while bounding only star detection memory', () => {
  assert.match(milky, /maximumRegistrationPixels = 16 \* 1024 \* 1024/);
  assert.match(milky, /The stack, bicubic resampling and\s*\/\/ exported pixels remain full resolution/);
});
