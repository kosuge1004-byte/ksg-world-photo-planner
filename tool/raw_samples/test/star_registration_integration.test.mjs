import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStars } from '../star_centroid_detector_reference.mjs';
import { estimateSimilarityTransform }
  from '../star_similarity_transform_estimator_reference.mjs';

/// End-to-end integration test: renders two synthetic star-field planes
/// (a reference frame and a target frame related by a known small
/// rotation + translation, as a short handheld/tripod astrophotography
/// burst would produce), runs the actual detector on each, feeds the
/// detected (not ground-truth) star lists into the transform estimator,
/// and checks the recovered transform against the known ground truth.
/// This exercises the two modules together the way the real registration
/// pipeline will call them, rather than only unit-testing each in
/// isolation against hand-built star lists.

function makePlane(width, height, backgroundValue) {
  return {
    width,
    height,
    samples: new Float32Array(width * height).fill(backgroundValue),
  };
}

function addGaussianStar(plane, cx, cy, peakAmplitude, sigma, radius = 6) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.round(cx) + dx;
      const y = Math.round(cy) + dy;
      if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) continue;
      const ox = x - cx;
      const oy = y - cy;
      const value = peakAmplitude
        * Math.exp(-(ox * ox + oy * oy) / (2 * sigma * sigma));
      plane.samples[y * plane.width + x] += value;
    }
  }
}

function addSeededNoise(plane, amplitude, seed) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < plane.samples.length; i++) {
    plane.samples[i] += (next() - 0.5) * amplitude;
  }
}

function seededRandomStarField(count, seed, width, height, margin) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: margin + next() * (width - 2 * margin),
      y: margin + next() * (height - 2 * margin),
      peak: 3 + next() * 6,
    });
  }
  return stars;
}

function rotatePoint(x, y, rotationDegrees, centerX, centerY, dx, dy) {
  const radians = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const ox = x - centerX;
  const oy = y - centerY;
  return {
    x: centerX + cosine * ox - sine * oy + dx,
    y: centerY + sine * ox + cosine * oy + dy,
  };
}

test(
  'detector + estimator recover a known small transform end to end',
  () => {
    const width = 240;
    const height = 200;
    const trueRotation = 2.2;
    const trueDx = 6.4;
    const trueDy = -3.1;
    const centerX = width / 2;
    const centerY = height / 2;

    const truth = seededRandomStarField(30, 2024, width, height, 20);

    const referencePlane = makePlane(width, height, 0.15);
    for (const star of truth) {
      addGaussianStar(referencePlane, star.x, star.y, star.peak, 1.3);
    }
    addSeededNoise(referencePlane, 0.03, 111);

    const targetPlane = makePlane(width, height, 0.15);
    for (const star of truth) {
      const moved = rotatePoint(
        star.x,
        star.y,
        trueRotation,
        centerX,
        centerY,
        trueDx,
        trueDy,
      );
      addGaussianStar(targetPlane, moved.x, moved.y, star.peak, 1.3);
    }
    // A couple of frame-local spurious sources: a satellite/aircraft
    // trail only in the target frame, and residual noise-level bumps.
    addSeededNoise(targetPlane, 0.03, 222);

    const referenceStars = detectStars(referencePlane, { thresholdSigma: 5 });
    const targetStars = detectStars(targetPlane, { thresholdSigma: 5 });

    assert.ok(referenceStars.length >= truth.length - 4,
      `expected close to ${truth.length} reference detections, got `
        + `${referenceStars.length}`);
    assert.ok(targetStars.length >= truth.length - 4,
      `expected close to ${truth.length} target detections, got `
        + `${targetStars.length}`);

    const estimate = estimateSimilarityTransform(
      referenceStars,
      targetStars,
    );

    assert.ok(
      Math.abs(estimate.rotationDegrees - trueRotation) < 0.05,
      `expected rotation near ${trueRotation}, got `
        + `${estimate.rotationDegrees}`,
    );
    assert.ok(estimate.inlierCount >= truth.length - 5);
    assert.ok(estimate.rmsResidual < 1.5);

    // Cross-check a few individual reference detections actually land
    // near their corresponding target detections under the estimated
    // transform, using the same forward-mapping convention as
    // AffineSamplingTransform.similarity.
    const radians = estimate.rotationDegrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const forward = (x, y) => {
      const ox = x - estimate.centerX;
      const oy = y - estimate.centerY;
      return {
        x: estimate.centerX + cosine * ox - sine * oy + estimate.sourceOffsetX,
        y: estimate.centerY + sine * ox + cosine * oy + estimate.sourceOffsetY,
      };
    };
    let checked = 0;
    for (const match of estimate.matches.slice(0, 5)) {
      const reference = referenceStars[match.referenceIndex];
      const target = targetStars[match.targetIndex];
      const predicted = forward(reference.x, reference.y);
      assert.ok(
        Math.hypot(predicted.x - target.x, predicted.y - target.y) < 1.0,
      );
      checked += 1;
    }
    assert.ok(checked >= 5);
  },
);

test(
  'detector + estimator remain stable across a full simulated stacking burst',
  () => {
    // A short burst of frames, each rotated slightly further from the
    // first (as the sky drifts over a real exposure sequence), all
    // registered back to frame 0.
    const width = 220;
    const height = 220;
    const centerX = width / 2;
    const centerY = height / 2;
    const truth = seededRandomStarField(26, 909, width, height, 20);
    const frameCount = 5;
    const rotationPerFrame = 1.1; // degrees, cumulative
    const drift = { dx: 1.4, dy: -0.9 }; // px per frame, cumulative

    const renderFrame = (frameIndex) => {
      const plane = makePlane(width, height, 0.15);
      for (const star of truth) {
        const moved = rotatePoint(
          star.x,
          star.y,
          rotationPerFrame * frameIndex,
          centerX,
          centerY,
          drift.dx * frameIndex,
          drift.dy * frameIndex,
        );
        addGaussianStar(plane, moved.x, moved.y, star.peak, 1.3);
      }
      addSeededNoise(plane, 0.03, 1000 + frameIndex);
      return plane;
    };

    const referenceStars = detectStars(renderFrame(0), { thresholdSigma: 5 });
    for (let frameIndex = 1; frameIndex < frameCount; frameIndex++) {
      const targetStars = detectStars(renderFrame(frameIndex),
        { thresholdSigma: 5 });
      const estimate = estimateSimilarityTransform(
        referenceStars,
        targetStars,
      );
      const expectedRotation = rotationPerFrame * frameIndex;
      assert.ok(
        Math.abs(estimate.rotationDegrees - expectedRotation) < 0.1,
        `frame ${frameIndex}: expected rotation near `
          + `${expectedRotation}, got ${estimate.rotationDegrees}`,
      );
      assert.ok(
        estimate.inlierCount >= truth.length - 4,
        `frame ${frameIndex}: only ${estimate.inlierCount} inliers`,
      );
      assert.ok(estimate.rmsResidual < 1.5);
    }
  },
);
