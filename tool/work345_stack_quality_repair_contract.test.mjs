import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync('lib/core/background/standard_stack_background_worker.dart', 'utf8');
const milky = readFileSync('lib/core/session/milky_way_pipeline.dart', 'utf8');
const exportPipeline = readFileSync('lib/core/session/export_pipeline_result.dart', 'utf8');
const rolling = readFileSync('lib/core/stacking/tiled_weighted_average_combiner.dart', 'utf8');

test('WORK345+ invalidates pre-fix standard-stack checkpoints', () => {
  const match = worker.match(/'algorithmRevision':\s*(\d+)/);
  assert.ok(match, 'algorithmRevision must be present');
  assert.ok(Number(match[1]) >= 345, 'revision must remain newer than pre-fix WORK344');
});

test('WORK345 does not disable streamed RAW by unconditionally enabling unsupported hot-pixel detection', () => {
  const occurrences = worker.match(/enableHotPixelDetection:\s*true/g) ?? [];
  assert.equal(occurrences.length, 0);
});

test('large-frame registration uses bounded coarse detection then native-resolution centroid refinement', () => {
  assert.match(milky, /maximumRegistrationPixels = 16 \* 1024 \* 1024/);
  assert.match(milky, /\? 2\s*:\s*1/);
  assert.match(milky, /_refineRegistrationStarsAtNativeResolution/);
  assert.match(milky, /await store\.readRegion\(/);
  assert.match(milky, /native-resolution RGB before the registration transform/);
});

test('rolling validity sidecar is not reported as exact frame contribution counts', () => {
  assert.match(rolling, /deliberately NOT an exact frame/);
  assert.match(worker, /rolling validity coverage/);
  assert.match(worker, /0\/1 presence, NOT frame/);
});

test('classic Milky Way path surfaces registration and exact contribution diagnostics', () => {
  assert.match(exportPipeline, /onFrameDiagnostics/);
  assert.match(worker, /Milky Way registration diagnostics \(classic\)/);
  assert.match(worker, /Milky Way exact contribution counts/);
});

test('noise proxy cannot falsely declare a stack successful merely because it is smoother', () => {
  assert.doesNotMatch(worker, /_logMilkyWayNoiseComparison/);
  const psf = worker.indexOf('evaluateStarPsfQualityGate(');
  const noise = worker.indexOf('evaluateFlatSkyNoiseQualityGate(', psf);
  assert.ok(psf >= 0 && noise > psf, 'PSF validation must precede the replacement noise gate');
  assert.doesNotMatch(worker, /verdict=reduced/);
  assert.doesNotMatch(worker, /verdict=INCREASED/);
});

test('rolling export keeps the fixed reference tone baseline', () => {
  assert.match(worker, /tone baseline \(fixed reference, WORK345\)/);
  assert.match(worker, /fixedToneBaseline\.exposureScale/);
  assert.doesNotMatch(worker, /tone baseline \(final-stack, WORK344\)/);
});
