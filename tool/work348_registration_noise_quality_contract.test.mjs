import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const regPath = 'lib/core/registration/registration_hard_quality.dart';
const noisePath = 'lib/core/registration/flat_sky_noise_quality.dart';
const mwPath = 'lib/core/session/milky_way_pipeline.dart';
const workerPath = 'lib/core/background/standard_stack_background_worker.dart';
const reg = fs.readFileSync(regPath, 'utf8');
const noise = fs.readFileSync(noisePath, 'utf8');
const mw = fs.readFileSync(mwPath, 'utf8');
const worker = fs.readFileSync(workerPath, 'utf8');

function rmsFraction(ratio) {
  return Math.SQRT2 / 2.354820045 * Math.sqrt(ratio * ratio - 1);
}

test('12% final FWHM budget derives about 0.303 x FWHM radial RMS limit', () => {
  const f = rmsFraction(1.12);
  assert.ok(Math.abs(f - 0.3029115458) < 1e-9);
});

test('registration hard gate is wired before registration weight', () => {
  const gate = mw.indexOf('evaluateRegistrationHardQualityGate(');
  const weight = mw.indexOf('registrationQualityWeight(', gate);
  assert.ok(gate >= 0 && weight > gate);
  assert.match(mw, /registration quality hard gate:/);
});

test('registration tail limits reuse refined and original matching radii', () => {
  assert.match(reg, /refinedRadius = math\.max\(0\.75, transformToleranceRadius \/ 2\)/);
  assert.match(reg, /final double p95Limit = refinedRadius;/);
  assert.match(reg, /final double maxLimit = transformToleranceRadius;/);
});

test('registration spatial support is logged but not used as a blocking threshold', () => {
  assert.match(reg, /RegistrationSpatialCoverage/);
  assert.match(worker, /matchSpanX=/);
  assert.match(worker, /matchQuadrants=/);
  assert.doesNotMatch(reg, /minimumOccupiedQuadrants/);
});

test('flat-sky metric uses 2x2 checkerboard with unit white-noise gain', () => {
  assert.match(noise, /0\.5 \* \(g00 \+ g11 - g10 - g01\)/);
  const weights = [0.5, 0.5, -0.5, -0.5];
  const gain = weights.reduce((s, w) => s + w*w, 0);
  assert.equal(gain, 1);
});

test('flat-sky measurement excludes neighborhoods around reference stars and reuses coordinates', () => {
  assert.match(noise, /_nearReferenceStar/);
  assert.match(noise, /referenceStars: referenceStars/);
  assert.match(noise, /finalStore\.readRegion/);
});

test('noise gate is fail-only above 1.10 and follows PSF gate in both paths', () => {
  assert.match(noise, /double maximumNoiseRatio = 1\.10/);
  const psfClassic = mw.indexOf('Milky Way final PSF quality:');
  const noiseClassic = mw.indexOf('Milky Way flat-sky noise quality:');
  assert.ok(psfClassic >= 0 && noiseClassic > psfClassic);
  const psfRolling = worker.indexOf('Milky Way final PSF quality (rolling):');
  const noiseRolling = worker.indexOf('Milky Way flat-sky noise quality (rolling):');
  assert.ok(psfRolling >= 0 && noiseRolling > psfRolling);
});

test('WORK348 invalidates prior post-decode checkpoints', () => {
  assert.ok(Number(worker.match(/'algorithmRevision':\s*(\d+)/)[1]) >= 348);
});
