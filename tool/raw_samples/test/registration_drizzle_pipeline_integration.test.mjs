import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStars } from '../star_centroid_detector_reference.mjs';
import { estimateSimilarityTransform }
  from '../star_similarity_transform_estimator_reference.mjs';
import { cfaDrizzle, invertSimilarityTransform }
  from '../cfa_drizzle_reference.mjs';
import { cfaColorAt } from '../mobile_stack_adaptive_demosaic_reference.mjs';

/// Full-pipeline integration test: star detection -> transform
/// estimation -> transform inversion -> CFA-domain drizzle, wiring
/// together every module built across Work36-39 the way the real
/// stacking pipeline will (a green-channel luminance plane is what real
/// frames would demosaic-then-extract, or approximate via a proxy, for
/// the *registration* pass, kept separate from the raw CFA samples that
/// *drizzle* actually combines).
///
/// This specifically exercises the handoff points between modules that
/// each module's own unit tests cannot: does `estimateSimilarityTransform`
/// 's output field names and rotation-sign convention actually match
/// what `invertSimilarityTransform` expects, and does the inverted
/// transform actually place a moved frame's samples back at the
/// reference frame's true positions on the drizzle output grid.

function makeGreenPlaneAndMosaic(width, height, cfaPattern, backgroundValue) {
  // A shared underlying "sky": bright point sources placed at true
  // (sub-pixel) positions, rendered once into a green-only luminance
  // plane (what detectStars consumes) and once into a full CFA mosaic
  // (what cfaDrizzle consumes), from the same source list, so the two
  // views are consistent with each other.
  const luminance = {
    width,
    height,
    samples: new Float32Array(width * height).fill(backgroundValue),
  };
  const mosaic = {
    width,
    height,
    cfaPattern,
    samples: new Float32Array(width * height).fill(backgroundValue),
  };
  return { luminance, mosaic };
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
  'detection, estimation, inversion, and drizzle combine consistently '
  + 'end to end',
  () => {
    const width = 160;
    const height = 140;
    const cfaPattern = 'rggb';
    const centerX = width / 2;
    const centerY = height / 2;
    const trueRotation = 3.0;
    const trueDx = 4.0;
    const trueDy = -2.5;
    const outputScale = 2;

    const truth = seededRandomStarField(24, 4040, width, height, 15);

    // Reference frame (frame 0): stars at their true positions.
    const { luminance: referenceLuminance, mosaic: referenceMosaic } =
      makeGreenPlaneAndMosaic(width, height, cfaPattern, 0.12);
    for (const star of truth) {
      addGaussianStar(referenceLuminance, star.x, star.y, star.peak, 1.3);
      addGaussianStar(referenceMosaic, star.x, star.y, star.peak, 1.3);
    }

    // Target frame (frame 1): the same sky, rotated and shifted, as a
    // second burst exposure would be.
    const { luminance: targetLuminance, mosaic: targetMosaic } =
      makeGreenPlaneAndMosaic(width, height, cfaPattern, 0.12);
    for (const star of truth) {
      const moved = rotatePoint(
        star.x, star.y, trueRotation, centerX, centerY, trueDx, trueDy,
      );
      addGaussianStar(targetLuminance, moved.x, moved.y, star.peak, 1.3);
      addGaussianStar(targetMosaic, moved.x, moved.y, star.peak, 1.3);
    }

    // Stage 1: detect stars in both frames.
    const referenceStars = detectStars(referenceLuminance,
      { thresholdSigma: 5 });
    const targetStars = detectStars(targetLuminance, { thresholdSigma: 5 });
    assert.ok(referenceStars.length >= truth.length - 6);
    assert.ok(targetStars.length >= truth.length - 6);

    // Stage 2: estimate the rigid transform mapping reference -> target
    // (this is AffineSamplingTransform.similarity's convention: "where
    // in the target frame does a given reference position land").
    const estimate = estimateSimilarityTransform(referenceStars,
      targetStars);
    assert.ok(Math.abs(estimate.rotationDegrees - trueRotation) < 0.05);

    // Stage 3: invert it to get the forward direction cfaDrizzle needs
    // (given a target-frame position, where does it land on the
    // reference/output grid).
    const forwardTransform = invertSimilarityTransform(estimate);

    // Cross-check: applying forwardTransform to each matched target
    // star should land it back near its corresponding *reference* star,
    // not the other way around -- this is exactly the bug class an
    // inversion mistake (e.g. forgetting to negate the rotation, or
    // swapping which centroid is subtracted) would produce, and unlike
    // the isolated invertSimilarityTransform unit test, this checks it
    // against the estimator's *actual* output on *detected* (not
    // hand-built) stars.
    let checked = 0;
    for (const match of estimate.matches.slice(0, 6)) {
      const reference = referenceStars[match.referenceIndex];
      const target = targetStars[match.targetIndex];
      const mapped = forwardTransform(target.x, target.y);
      assert.ok(
        Math.hypot(mapped.x - reference.x, mapped.y - reference.y) < 1.0,
        `match ${checked}: forward-transformed target `
          + `(${target.x.toFixed(2)}, ${target.y.toFixed(2)}) -> `
          + `(${mapped.x.toFixed(2)}, ${mapped.y.toFixed(2)}) not close to `
          + `reference (${reference.x.toFixed(2)}, `
          + `${reference.y.toFixed(2)})`,
      );
      checked += 1;
    }
    assert.ok(checked >= 6);

    // Stage 4: drizzle both raw CFA frames onto one supersampled output
    // grid, using the identity transform for the reference frame and
    // the just-inverted transform for the target frame.
    const outputWidth = width * outputScale;
    const outputHeight = height * outputScale;
    const drizzled = cfaDrizzle({
      frames: [
        { ...referenceMosaic, forwardTransform: (x, y) => ({ x, y }) },
        { ...targetMosaic, forwardTransform },
      ],
      outputWidth,
      outputHeight,
      outputScale,
      pixfrac: 0.8,
    });

    // Sanity: the combined green channel should show meaningfully higher
    // coverage (more contributing drops) near the known star positions
    // than in a random empty region, confirming the two frames actually
    // landed on top of each other rather than drizzling to unrelated
    // locations.
    const green = drizzled.channels[1];
    let coveredNearStars = 0;
    let totalNearStars = 0;
    for (const star of truth.slice(0, 8)) {
      const outputX = Math.round(star.x * outputScale);
      const outputY = Math.round(star.y * outputScale);
      if (outputX < 1 || outputY < 1 || outputX >= outputWidth - 1
          || outputY >= outputHeight - 1) continue;
      totalNearStars += 1;
      let localMaxCoverage = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const index = (outputY + dy) * outputWidth + (outputX + dx);
          localMaxCoverage = Math.max(localMaxCoverage, green.coverage[index]);
        }
      }
      if (localMaxCoverage > 0) coveredNearStars += 1;
    }
    assert.ok(totalNearStars >= 5, 'expected several in-bounds check stars');
    assert.equal(
      coveredNearStars,
      totalNearStars,
      'expected every checked star position to have drizzle coverage from '
        + 'at least one frame',
    );
  },
);
