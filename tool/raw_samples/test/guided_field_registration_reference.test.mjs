import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateSimilarityTransform } from '../star_similarity_transform_estimator_reference.mjs';
import { fitLocalResidualCorrectionField } from '../local_residual_correction_reference.mjs';
import {
  applyPixelHomography,
  assertPlausibleFixedCameraTransform,
  evaluateRegistrationCoverageGate,
  GuidedFieldRegistrationFailed,
  guidedRegistrationOrder,
  InvalidGuidedFieldRegistrationInput,
  preferTemporalCenterReference,
  refineGuidedFieldRegistration,
  selectSpatiallyDistributedStars,
} from '../guided_field_registration_reference.mjs';
import { makeFixedTripodSkySequence } from '../synthetic_fixed_tripod_sky_reference.mjs';

const W = 6000;
const H = 4000;
const select = (stars) => selectSpatiallyDistributedStars(stars.slice(0, 1200), { imageWidth: W, imageHeight: H });

function wholeFieldError(referenceAll, targetAll, map) {
  const truth = new Map(targetAll.map((s) => [s.id, s]));
  const errors = [];
  for (const r of referenceAll) {
    const q = truth.get(r.id);
    if (!q) continue;
    const p = map(r.x, r.y);
    errors.push(Math.hypot(p.x - q.x, p.y - q.y));
  }
  errors.sort((a, b) => a - b);
  return { p95: errors[Math.floor(errors.length * 0.95)], max: errors[errors.length - 1] };
}

function registerChain(sequence, referenceIndex, options = {}) {
  const reference = select(sequence[referenceIndex]);
  const models = new Map();
  const results = new Map();
  for (const { index, neighbour } of guidedRegistrationOrder(sequence.length, referenceIndex)) {
    const target = select(sequence[index]);
    const seeds = [];
    if (models.has(neighbour)) seeds.push(models.get(neighbour));
    try {
      seeds.push(estimateSimilarityTransform(reference.slice(0, 150), target.slice(0, 150), { toleranceRadius: 3, minInliers: 5 }));
    } catch { /* chained seed may still work */ }
    for (const seed of seeds) {
      try {
        const result = refineGuidedFieldRegistration(reference, target, seed, { imageWidth: W, imageHeight: H, ...options });
        models.set(index, result.transform);
        results.set(index, { result, reference, target });
        break;
      } catch (error) {
        if (!(error instanceof GuidedFieldRegistrationFailed)) throw error;
      }
    }
  }
  return results;
}

function fullModelError(sequence, referenceIndex, index, entry) {
  const { result, reference, target } = entry;
  const global = (x, y) => applyPixelHomography(result.transform, x, y);
  const matches = result.matches.map((m) => {
    const r = reference[m.referenceIndex]; const t = target[m.targetIndex]; const p = global(r.x, r.y);
    return { referenceX: r.x, referenceY: r.y, residualX: t.x - p.x, residualY: t.y - p.y };
  });
  const field = fitLocalResidualCorrectionField(matches, { maximumCorrectionMagnitude: 3 });
  return wholeFieldError(sequence[referenceIndex], sequence[index], (x, y) => {
    const p = global(x, y); const d = field.evaluate(x, y);
    return { x: p.x + d.dx, y: p.y + d.dy };
  });
}

test('rigid registration collapses to a band on a fixed-tripod sky (reproduces the Work350 log)', () => {
  const sequence = makeFixedTripodSkySequence();
  const reference = sequence[2].slice(0, 150);
  const near = estimateSimilarityTransform(reference, sequence[3].slice(0, 150), { toleranceRadius: 3, minInliers: 5 });
  const far = estimateSimilarityTransform(reference, sequence[30].slice(0, 150), { toleranceRadius: 3, minInliers: 5 });
  assert.ok(near.inlierCount > 60);
  assert.ok(far.inlierCount < 20, `far inliers ${far.inlierCount}`);
  const t = far.rotationDegrees * Math.PI / 180; const c = Math.cos(t); const s = Math.sin(t);
  const rigid = (x, y) => ({
    x: far.centerX + c * (x - far.centerX) - s * (y - far.centerY) + far.sourceOffsetX,
    y: far.centerY + s * (x - far.centerX) + c * (y - far.centerY) + far.sourceOffsetY,
  });
  assert.ok(wholeFieldError(sequence[2], sequence[30], rigid).p95 > 20);
});

for (const [name, options, limit] of [
  ['default 14mm-class geometry', {}, 1.2],
  ['landscape foreground (lower 40% starless)', { foregroundFraction: 0.4 }, 1.2],
  ['wider lens', { focalPx: 1500 }, 1.2],
  ['longer lens, higher altitude', { focalPx: 3500, altitudeDeg: 50 }, 1.2],
  ['southern hemisphere', { latitudeDeg: -33, azimuthDeg: 180, altitudeDeg: 40 }, 1.2],
  ['noisy centroids and heavy dropout', { centroidNoise: 0.35, dropout: 0.3 }, 2.0],
  ['40 s interval (26 min span)', { intervalSec: 40 }, 1.6],
]) {
  test(`guided chained registration keeps whole-field error sub-pixel-class: ${name}`, () => {
    const sequence = makeFixedTripodSkySequence(options);
    const results = registerChain(sequence, 2);
    assert.equal(results.size, sequence.length - 1, 'every frame registers');
    for (const [index, entry] of results) {
      assert.ok(entry.result.inlierCount >= 100, `frame ${index} inliers ${entry.result.inlierCount}`);
      const error = fullModelError(sequence, 2, index, entry);
      assert.ok(error.p95 <= limit, `frame ${index} whole-field p95 ${error.p95}`);
      const gate = evaluateRegistrationCoverageGate({
        matches: entry.result.matches, referenceStars: entry.reference, imageWidth: W, imageHeight: H,
      });
      assert.ok(gate.passed, `frame ${index} coverage ${gate.reasons.join(';')}`);
    }
  });
}

test('guided refinement is deterministic', () => {
  const sequence = makeFixedTripodSkySequence();
  const a = registerChain(sequence, 2).get(20).result;
  const b = registerChain(sequence, 2).get(20).result;
  assert.deepEqual(a.transform, b.transform);
  assert.deepEqual(a.matches, b.matches);
});

test('spatial selection covers every populated cell and stays flux-sorted', () => {
  const stars = [];
  // 300 bright stars packed in one corner, 60 faint ones spread elsewhere.
  for (let i = 0; i < 300; i++) stars.push({ x: 10 + (i % 20) * 20, y: 10 + Math.floor(i / 20) * 20, flux: 100 + i });
  for (let i = 0; i < 60; i++) stars.push({ x: 1000 + (i % 10) * 480, y: 800 + Math.floor(i / 10) * 520, flux: 1 + i * 0.01 });
  const topOnly = [...stars].sort((a, b) => b.flux - a.flux).slice(0, 150);
  assert.ok(topOnly.every((s) => s.x < 500 && s.y < 500));
  const selected = selectSpatiallyDistributedStars(stars, { imageWidth: W, imageHeight: H, limit: 150 });
  assert.equal(selected.length, 150);
  assert.ok(selected.filter((s) => s.x >= 1000).length === 60, 'all spread stars kept');
  for (let i = 1; i < selected.length; i++) assert.ok(selected[i - 1].flux >= selected[i].flux);
});

test('coverage gate is relative to the reference star field', () => {
  const reference = [];
  for (let i = 0; i < 100; i++) reference.push({ x: 100 + (i % 10) * 580, y: 100 + Math.floor(i / 10) * 180 }); // upper half only
  const all = reference.map((_, i) => ({ referenceIndex: i }));
  const pass = evaluateRegistrationCoverageGate({ matches: all, referenceStars: reference, imageWidth: W, imageHeight: H });
  assert.ok(pass.passed, pass.reasons.join(';'));
  assert.deepEqual(pass.supportedQuadrants, [0, 1]);
  const band = all.filter((m) => reference[m.referenceIndex].x < 1500);
  const fail = evaluateRegistrationCoverageGate({ matches: band, referenceStars: reference, imageWidth: W, imageHeight: H });
  assert.equal(fail.passed, false);
  assert.ok(fail.reasons.some((r) => r.includes('span X')));
  assert.ok(fail.reasons.some((r) => r.includes('quadrant')));
  const few = evaluateRegistrationCoverageGate({ matches: all.slice(0, 5), referenceStars: reference, imageWidth: W, imageHeight: H });
  assert.ok(few.reasons.some((r) => r.startsWith('matches')));
});

test('plausibility rejects folds, extreme perspective and scale jumps', () => {
  const identity = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0, p20: 0, p21: 0 };
  assertPlausibleFixedCameraTransform(identity, W, H, 5e-5);
  assert.throws(() => assertPlausibleFixedCameraTransform({ ...identity, p20: 1e-4 }, W, H, 5e-5), GuidedFieldRegistrationFailed);
  assert.throws(() => assertPlausibleFixedCameraTransform({ ...identity, m00: 1.3, m11: 1.3 }, W, H, 5e-5), GuidedFieldRegistrationFailed);
});

test('registration order is outward from the reference with adjacent seeds', () => {
  assert.deepEqual(guidedRegistrationOrder(5, 2), [
    { index: 3, neighbour: 2 }, { index: 4, neighbour: 3 }, { index: 1, neighbour: 2 }, { index: 0, neighbour: 1 },
  ]);
  assert.throws(() => guidedRegistrationOrder(3, 3), InvalidGuidedFieldRegistrationInput);
});

test('temporal-center preference only reorders near-best candidates', () => {
  const quality = new Map([[0, 1.0], [5, 0.99], [9, 0.5], [4, 0.98]]);
  assert.deepEqual(preferTemporalCenterReference([0, 5, 4, 9], quality, 10), [4, 5, 0, 9]);
});

test('invalid inputs are rejected', () => {
  const seed = { rotationDegrees: 0, sourceOffsetX: 0, sourceOffsetY: 0, centerX: 0, centerY: 0 };
  assert.throws(() => refineGuidedFieldRegistration([], [], seed, { imageWidth: 0, imageHeight: 10 }), InvalidGuidedFieldRegistrationInput);
  assert.throws(() => refineGuidedFieldRegistration([{ x: NaN, y: 0 }], [], seed, { imageWidth: 10, imageHeight: 10 }), InvalidGuidedFieldRegistrationInput);
  assert.throws(() => refineGuidedFieldRegistration([], [], { ...seed, centerX: NaN }, { imageWidth: 10, imageHeight: 10 }), InvalidGuidedFieldRegistrationInput);
  assert.throws(() => refineGuidedFieldRegistration([], [], seed, { imageWidth: 10, imageHeight: 10 }), GuidedFieldRegistrationFailed);
});
