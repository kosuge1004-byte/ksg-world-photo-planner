import assert from 'node:assert/strict';
import test from 'node:test';

import {
  estimateSimilarityTransform,
  InvalidStarTransformInput,
  StarTransformEstimationFailed,
} from '../star_similarity_transform_estimator_reference.mjs';

function makeStar(x, y, flux = 1) {
  return { x, y, flux };
}

function applyGroundTruth(star, rotationDegrees, dx, dy, centerX, centerY) {
  const radians = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const ox = star.x - centerX;
  const oy = star.y - centerY;
  return makeStar(
    centerX + cosine * ox - sine * oy + dx,
    centerY + sine * ox + cosine * oy + dy,
    star.flux,
  );
}

function referenceField(count, seed, width = 200, height = 200) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const stars = [];
  for (let i = 0; i < count; i++) {
    stars.push(makeStar(
      10 + next() * (width - 20),
      10 + next() * (height - 20),
      1 + next() * 9, // descending sort applied by caller if needed
    ));
  }
  return stars;
}

/// Applies the estimator's output as a forward transform, matching
/// `AffineSamplingTransform.similarity`'s convention, so tests can verify
/// round-trip behavior against the actual public API contract, not just
/// internal fields.
function applyEstimatedTransform(estimate, x, y) {
  const radians = estimate.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const ox = x - estimate.centerX;
  const oy = y - estimate.centerY;
  return {
    x: estimate.centerX + cosine * ox - sine * oy + estimate.sourceOffsetX,
    y: estimate.centerY + sine * ox + cosine * oy + estimate.sourceOffsetY,
  };
}

test('rejects non-array or non-finite star lists', () => {
  assert.throws(
    () => estimateSimilarityTransform(null, []),
    InvalidStarTransformInput,
  );
  assert.throws(
    () => estimateSimilarityTransform(
      [{ x: NaN, y: 1 }],
      [{ x: 1, y: 1 }],
    ),
    InvalidStarTransformInput,
  );
});

test('fails clearly with too few stars', () => {
  const reference = referenceField(2, 1);
  const target = reference.map((star) => applyGroundTruth(star, 0, 5, 5, 0, 0));
  assert.throws(
    () => estimateSimilarityTransform(reference, target),
    StarTransformEstimationFailed,
  );
});

test('recovers a pure translation exactly (noiseless)', () => {
  const reference = referenceField(15, 7);
  const target = reference.map(
    (star) => applyGroundTruth(star, 0, 12.5, -8.25, 0, 0),
  );
  const estimate = estimateSimilarityTransform(reference, target);
  assert.ok(Math.abs(estimate.rotationDegrees) < 1e-6);
  assert.equal(estimate.inlierCount, reference.length);
  assert.ok(estimate.rmsResidual < 1e-6);

  for (let i = 0; i < reference.length; i++) {
    const mapped = applyEstimatedTransform(estimate, reference[i].x,
      reference[i].y);
    assert.ok(Math.abs(mapped.x - target[i].x) < 1e-6);
    assert.ok(Math.abs(mapped.y - target[i].y) < 1e-6);
  }
});

test('recovers a small rotation plus translation exactly (noiseless)', () => {
  const reference = referenceField(20, 21);
  const centerX = 100;
  const centerY = 100;
  const trueRotation = 3.5; // degrees, typical of a short handheld burst
  const trueDx = -4.0;
  const trueDy = 6.5;
  const target = reference.map(
    (star) => applyGroundTruth(
      star,
      trueRotation,
      trueDx,
      trueDy,
      centerX,
      centerY,
    ),
  );
  const estimate = estimateSimilarityTransform(reference, target);
  assert.ok(
    Math.abs(estimate.rotationDegrees - trueRotation) < 1e-3,
    `expected rotation near ${trueRotation}, got `
      + `${estimate.rotationDegrees}`,
  );
  assert.equal(estimate.inlierCount, reference.length);
  assert.ok(estimate.rmsResidual < 1e-6);

  for (let i = 0; i < reference.length; i++) {
    const mapped = applyEstimatedTransform(estimate, reference[i].x,
      reference[i].y);
    assert.ok(Math.abs(mapped.x - target[i].x) < 1e-4);
    assert.ok(Math.abs(mapped.y - target[i].y) < 1e-4);
  }
});

test('recovers a larger rotation typical of a longer static-tripod session', () => {
  const reference = referenceField(24, 33);
  const centerX = 100;
  const centerY = 100;
  const trueRotation = 12; // degrees
  const trueDx = 3;
  const trueDy = -2;
  const target = reference.map(
    (star) => applyGroundTruth(
      star,
      trueRotation,
      trueDx,
      trueDy,
      centerX,
      centerY,
    ),
  );
  // A larger rotation displaces points far from the true rotation center
  // by more than a small default tolerance in the rotation-agnostic
  // coarse stage, so a wider initial tolerance is supplied; refinement
  // still converges to a tight fit once rotation is accounted for.
  const estimate = estimateSimilarityTransform(reference, target, {
    toleranceRadius: 20,
  });
  assert.ok(
    Math.abs(estimate.rotationDegrees - trueRotation) < 1e-2,
    `expected rotation near ${trueRotation}, got `
      + `${estimate.rotationDegrees}`,
  );
  assert.equal(estimate.inlierCount, reference.length);
  assert.ok(estimate.rmsResidual < 1e-3);
});

test('ignores spurious unmatched stars in both lists', () => {
  const reference = referenceField(18, 40);
  const trueRotation = 2.0;
  const trueDx = 5;
  const trueDy = -3;
  const target = reference.map(
    (star) => applyGroundTruth(star, trueRotation, trueDx, trueDy, 100, 100),
  );
  // Spurious stars: present in only one frame (a hot pixel the detector's
  // shape gates missed, a transient satellite glint, a false positive).
  const referenceWithOutliers = [
    ...reference,
    makeStar(15, 15),
    makeStar(180, 30),
    makeStar(60, 190),
  ];
  const targetWithOutliers = [
    ...target,
    makeStar(150, 150),
    makeStar(20, 20),
  ];
  const estimate = estimateSimilarityTransform(
    referenceWithOutliers,
    targetWithOutliers,
  );
  assert.ok(
    Math.abs(estimate.rotationDegrees - trueRotation) < 1e-2,
    `expected rotation near ${trueRotation}, got `
      + `${estimate.rotationDegrees}`,
  );
  // The true correspondences should all survive; the spurious stars
  // should not.
  assert.equal(estimate.inlierCount, reference.length);
  assert.ok(estimate.rmsResidual < 1e-2);
});

test('tolerates small centroiding noise without drifting far from truth', () => {
  const reference = referenceField(25, 55);
  const trueRotation = 1.5;
  const trueDx = 2.2;
  const trueDy = -1.8;
  let seed = 777;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed / 0x7fffffff) - 0.5) * 0.2; // +/-0.1px centroiding noise
  };
  const target = reference.map((star) => {
    const truth = applyGroundTruth(star, trueRotation, trueDx, trueDy, 100,
      100);
    return makeStar(truth.x + jitter(), truth.y + jitter(), star.flux);
  });
  const estimate = estimateSimilarityTransform(reference, target);
  assert.ok(
    Math.abs(estimate.rotationDegrees - trueRotation) < 0.05,
    `expected rotation near ${trueRotation}, got `
      + `${estimate.rotationDegrees}`,
  );
  assert.ok(estimate.inlierCount >= reference.length - 1);
  assert.ok(estimate.rmsResidual < 0.5);
});

test('fails clearly when the two frames share no consistent transform', () => {
  const reference = referenceField(10, 99);
  // Target stars placed independently at random, with no relationship to
  // the reference set: there should be no large consistent inlier group.
  const target = referenceField(10, 4242);
  assert.throws(
    () => estimateSimilarityTransform(reference, target, { minInliers: 5 }),
    StarTransformEstimationFailed,
  );
});

test(
  'with distance-pair matching disabled, the RMS-residual guard rejects '
  + 'a large-rotation false convergence',
  () => {
    // Regression test for the original translation-only-search bug (see
    // WORK36_PROGRESS.md): at large inter-frame rotations, that search
    // alone can lock onto a self-consistent but wrong correspondence
    // set; a widened toleranceRadius large enough to find *some* initial
    // match makes this more likely, not less. The residual guard must
    // catch it regardless of how loose toleranceRadius is. Distance-pair
    // matching is disabled here specifically to keep exercising the
    // translation-only path's guard in isolation; by default (see
    // 'recovers rotations well beyond the translation-only search's
    // range' below), distance-pair matching now solves this case
    // correctly instead.
    const reference = referenceField(20, 33);
    const target = reference.map(
      (star) => applyGroundTruth(star, 25, 3, -2, 100, 100),
    );
    assert.throws(
      () => estimateSimilarityTransform(reference, target, {
        toleranceRadius: 25,
        useDistancePairMatching: false,
      }),
      (error) => error instanceof StarTransformEstimationFailed
        && /RMS residual/.test(error.message),
    );
  },
);

test(
  'with distance-pair matching disabled, an explicit looser '
  + 'maxAcceptableRmsResidual can opt into a worse fit',
  () => {
    // Sanity-checks that the guard is a configurable option, not a hidden
    // hard limit, for callers with a deliberately different tolerance
    // policy (e.g. exploratory tooling). Distance-pair matching is
    // disabled for the same reason as the test above.
    const reference = referenceField(20, 33);
    const target = reference.map(
      (star) => applyGroundTruth(star, 25, 3, -2, 100, 100),
    );
    const estimate = estimateSimilarityTransform(reference, target, {
      toleranceRadius: 25,
      useDistancePairMatching: false,
      maxAcceptableRmsResidual: 100,
    });
    assert.ok(estimate.rmsResidual > 1.5);
  },
);

test(
  "recovers rotations well beyond the translation-only search's range, "
  + 'via distance-pair matching (enabled by default)',
  () => {
    // Euclidean distance between two points is invariant under rotation
    // and translation, so distance-pair hypotheses need no zero-rotation
    // assumption and no widened toleranceRadius, unlike the
    // translation-only coarse search alone (see the two tests above and
    // WORK36_PROGRESS.md's "Known limitation: rotation range").
    for (const rotation of [25, 45, 90, 120, 170]) {
      const reference = referenceField(20, 33);
      const target = reference.map(
        (star) => applyGroundTruth(star, rotation, 3, -2, 100, 100),
      );
      const estimate = estimateSimilarityTransform(reference, target);
      assert.ok(
        Math.abs(estimate.rotationDegrees - rotation) < 1e-6,
        `rotation=${rotation}: expected recovery near truth, got `
          + `${estimate.rotationDegrees}`,
      );
      assert.equal(estimate.inlierCount, reference.length);
      assert.ok(estimate.rmsResidual < 1e-6);
    }
  },
);

test(
  'distance-pair matching still respects the RMS-residual guard when '
  + 'frames share no consistent transform',
  () => {
    const reference = referenceField(15, 500);
    const target = referenceField(15, 6001);
    assert.throws(
      () => estimateSimilarityTransform(reference, target, {
        minInliers: 5,
      }),
      StarTransformEstimationFailed,
    );
  },
);



test('star-transform estimator rejects non-finite and degenerate runtime parameters', () => {
  const stars = [
    makeStar(0, 0),
    makeStar(10, 0),
    makeStar(0, 10),
  ];
  assert.throws(
    () => estimateSimilarityTransform(stars, stars, { toleranceRadius: NaN }),
    InvalidStarTransformInput,
  );
  assert.throws(
    () => estimateSimilarityTransform(stars, stars, { toleranceRadius: 0 }),
    InvalidStarTransformInput,
  );
  assert.throws(
    () => estimateSimilarityTransform(stars, stars, { minInliers: 1 }),
    InvalidStarTransformInput,
  );
  assert.throws(
    () => estimateSimilarityTransform(
      stars,
      stars,
      { maxAcceptableRmsResidual: Infinity },
    ),
    InvalidStarTransformInput,
  );
  assert.throws(
    () => estimateSimilarityTransform(stars, stars, { minPairDistance: 0 }),
    InvalidStarTransformInput,
  );
});
