import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync('lib/core/background/standard_stack_background_worker.dart', 'utf8');
const milky = readFileSync('lib/core/session/milky_way_pipeline.dart', 'utf8');
const detector = readFileSync('lib/core/registration/star_detector.dart', 'utf8');
const psf = readFileSync('lib/core/registration/gaussian_psf_centroid_refinement.dart', 'utf8');
const psfGate = readFileSync('lib/core/registration/star_psf_quality.dart', 'utf8');
const local = readFileSync('lib/core/registration/local_residual_correction.dart', 'utf8');

test('WORK347 invalidates WORK346 checkpoints before changing quality semantics', () => {
  const revision = Number(worker.match(/'algorithmRevision': (\d+)/)?.[1] ?? 0);
  assert.ok(revision >= 347, `algorithmRevision must remain >=347, got ${revision}`);
});

test('Gaussian marginal PSF fit exports a local curvature width estimate', () => {
  assert.match(psf, /sigmaX/);
  assert.match(psf, /sigmaY/);
  assert.match(psf, /math\.sqrt\(-1 \/ denominator\)/);
  assert.match(detector, /psfFwhmPx/);
  assert.match(detector, /2\.354820045/);
});

test('compact star checkpoints preserve PSF width across process restart', () => {
  assert.match(worker, /'psfFwhmPx': star\.psfFwhmPx/);
  assert.match(worker, /psfFwhmPx: \(data\['psfFwhmPx'\] as num\?\)\?\.toDouble\(\)/);
});

test('local residual quality records RMS tail and direction, and local warp cannot worsen p95/max', () => {
  assert.match(local, /final class LocalResidualStatistics/);
  assert.match(local, /p95Magnitude/);
  assert.match(local, /maxMagnitude/);
  assert.match(local, /directionalCoherence/);
  assert.match(local, /localResidualCorrectionIsDistributionSafe/);
  assert.match(local, /correctedStatistics\.p95Magnitude <=/);
  assert.match(local, /correctedStatistics\.maxMagnitude <=/);
  assert.match(milky, /residualDirectionalCoherence/);
  assert.match(worker, /residualP95Px=/);
  assert.match(worker, /residualMaxPx=/);
});

test('classic and rolling Milky Way paths both enforce final PSF preservation before success', () => {
  assert.match(milky, /compareRegisteredStarPsf\(/);
  assert.match(milky, /evaluateStarPsfQualityGate\(/);
  assert.match(milky, /throw MilkyWayStackQualityFailed\(psfGate\)/);
  assert.match(worker, /Milky Way final PSF quality \(rolling\)/);
  assert.match(worker, /compareRegisteredStarPsf\(/);
  assert.match(worker, /throw MilkyWayStackQualityFailed\(psfGate\)/);
  const qualityIndex = worker.indexOf('Milky Way final PSF quality (rolling)');
  const publishIndex = worker.indexOf('await postDecodeCheckpoints!.publishCommitted', qualityIndex);
  assert.ok(qualityIndex >= 0 && publishIndex > qualityIndex,
    'rolling checkpoint must only publish after PSF quality evaluation');
});

test('PSF gate thresholds are explicit and fail closed when reference is measurable but final pairs disappear', () => {
  assert.match(psfGate, /minimumMeasuredPairs = 8/);
  assert.match(psfGate, /maximumMedianFwhmRatio = 1\.12/);
  assert.match(psfGate, /maximumP90FwhmRatio = 1\.30/);
  assert.match(psfGate, /maximumMedianRoundnessIncrease = 0\.12/);
  assert.match(psfGate, /passed: !referenceHadEnough/);
});

// Behavioural mirror of the Gaussian-curvature identity used by the Dart PSF
// width estimator: for a Gaussian, the second difference of log samples at
// unit spacing is exactly -1/sigma^2.
test('3-point Gaussian curvature recovers known sigma and FWHM', () => {
  const sigma = 1.5;
  const x0 = 0.2;
  const sample = (x) => Math.exp(-((x - x0) ** 2) / (2 * sigma ** 2));
  const logs = [-1, 0, 1].map(x => Math.log(sample(x)));
  const denominator = logs[0] - 2 * logs[1] + logs[2];
  const recoveredSigma = Math.sqrt(-1 / denominator);
  assert.ok(Math.abs(recoveredSigma - sigma) < 1e-12);
  const fwhm = 2.354820045 * recoveredSigma;
  assert.ok(Math.abs(fwhm - 3.5322300675) < 1e-9);
});

function gate({referenceMeasured, pairs, median, p90, roundness}) {
  if (pairs < 8) return referenceMeasured < 8;
  if (median > 1.12) return false;
  if (p90 > 1.30 && median > 1.05) return false;
  if (roundness > 0.12) return false;
  return true;
}

test('quality gate mirror blocks systematic blur and allows small interpolation-scale change', () => {
  assert.equal(gate({referenceMeasured: 20, pairs: 18, median: 1.03, p90: 1.07, roundness: 0.02}), true);
  assert.equal(gate({referenceMeasured: 20, pairs: 18, median: 1.20, p90: 1.35, roundness: 0.03}), false);
  assert.equal(gate({referenceMeasured: 20, pairs: 3, median: 1, p90: 1, roundness: 0}), false);
});
