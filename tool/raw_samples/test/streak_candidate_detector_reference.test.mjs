import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectStreakCandidates,
  InvalidStreakDetectionInput,
  StreakCandidate,
} from '../streak_candidate_detector_reference.mjs';

function makeBlankPlane(width, height, backgroundValue = 0.1) {
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

/// Renders a smooth, continuous streak by summing many overlapping
/// cross-sectional Gaussian slices along a line -- matches the technique
/// already validated in star_centroid_detector_reference.test.mjs for
/// generating a realistic (not sparse-discrete-point) trail.
function addStreak(
  plane,
  x0,
  y0,
  x1,
  y1,
  peakAmplitude,
  crossSigma,
  stepPx = 0.35,
) {
  const length = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.round(length / stepPx));
  const radius = Math.ceil(3 * crossSigma);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.round(cx) + dx;
        const y = Math.round(cy) + dy;
        if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) continue;
        const ox = x - cx;
        const oy = y - cy;
        const value = peakAmplitude
          * Math.exp(-(ox * ox + oy * oy) / (2 * crossSigma * crossSigma))
          * (stepPx / crossSigma);
        plane.samples[y * plane.width + x] += value;
      }
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

function normalizeAngle(radians) {
  // Streak orientation is a line, not a vector, so angle and angle+pi
  // are the same direction; normalize into (-pi/2, pi/2] for comparison.
  let angle = radians % Math.PI;
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  return angle;
}

test('rejects malformed source dimensions', () => {
  assert.throws(
    () => detectStreakCandidates({
      width: 0,
      height: 10,
      samples: new Float32Array(0),
    }),
    InvalidStreakDetectionInput,
  );
  assert.throws(
    () => detectStreakCandidates({
      width: 10,
      height: 10,
      samples: new Float32Array(5),
    }),
    InvalidStreakDetectionInput,
  );
});

test('finds nothing on a uniform plane with no sources', () => {
  const plane = makeBlankPlane(80, 80, 0.2);
  addSeededNoise(plane, 0.02, 999);
  assert.deepEqual(detectStreakCandidates(plane), []);
});

test('rejects round point sources (stars), finding no streaks', () => {
  const plane = makeBlankPlane(80, 80, 0.1);
  addGaussianStar(plane, 20, 20, 8.0, 1.3);
  addGaussianStar(plane, 50, 60, 5.0, 1.4);
  assert.deepEqual(detectStreakCandidates(plane), []);
});

test('detects a horizontal streak with the correct orientation and centroid', () => {
  const plane = makeBlankPlane(100, 60, 0.1);
  addStreak(plane, 10, 30, 90, 30, 3.0, 1.2);
  const candidates = detectStreakCandidates(plane);
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.ok(candidate instanceof StreakCandidate);
  assert.ok(Math.abs(candidate.centroidX - 50) < 2);
  assert.ok(Math.abs(candidate.centroidY - 30) < 1);
  assert.ok(
    Math.abs(normalizeAngle(candidate.angleRadians) - 0) < 0.05,
    `expected ~0 radians (horizontal), got ${candidate.angleRadians}`,
  );
  assert.ok(candidate.length > 60); // most of the 80px streak span
  assert.ok(candidate.elongation > 0.8);
});

test('detects a vertical streak with the correct orientation', () => {
  const plane = makeBlankPlane(60, 100, 0.1);
  addStreak(plane, 30, 10, 30, 90, 3.0, 1.2);
  const candidates = detectStreakCandidates(plane);
  assert.equal(candidates.length, 1);
  const angle = normalizeAngle(candidates[0].angleRadians);
  assert.ok(
    Math.abs(Math.abs(angle) - Math.PI / 2) < 0.05,
    `expected ~+/-pi/2 radians (vertical), got ${angle}`,
  );
});

test(
  'detects a diagonal streak with the correct orientation '
  + '(regression for the eigenvector-angle numerical-instability bug)',
  () => {
    // A 45-degree streak is exactly the case where a naive
    // eigenvector-subtraction angle formula becomes numerically
    // unstable when secondXY happens to be small relative to
    // floating-point noise; more importantly, an axis-aligned streak
    // (tested above) is where secondXY is *exactly* the value that
    // formula struggles with (near zero), so both orientations are
    // covered.
    const plane = makeBlankPlane(100, 100, 0.1);
    addStreak(plane, 10, 10, 90, 90, 3.0, 1.2);
    const candidates = detectStreakCandidates(plane);
    assert.equal(candidates.length, 1);
    const angle = normalizeAngle(candidates[0].angleRadians);
    assert.ok(
      Math.abs(angle - Math.PI / 4) < 0.05,
      `expected ~pi/4 radians (45 degrees), got ${angle}`,
    );
  },
);

test('detects streaks at several intermediate angles accurately', () => {
  const degreesToTest = [10, 30, 60, 75, 100, 135, 150, 170];
  for (const degrees of degreesToTest) {
    const plane = makeBlankPlane(120, 120, 0.1);
    const radians = degrees * Math.PI / 180;
    const centerX = 60;
    const centerY = 60;
    const halfLength = 40;
    const x0 = centerX - Math.cos(radians) * halfLength;
    const y0 = centerY - Math.sin(radians) * halfLength;
    const x1 = centerX + Math.cos(radians) * halfLength;
    const y1 = centerY + Math.sin(radians) * halfLength;
    addStreak(plane, x0, y0, x1, y1, 3.0, 1.2);
    const candidates = detectStreakCandidates(plane);
    assert.equal(candidates.length, 1, `degrees=${degrees}`);
    const expected = normalizeAngle(radians);
    const actual = normalizeAngle(candidates[0].angleRadians);
    // Compare via the angular distance on a half-circle (mod pi), since
    // normalizeAngle's branch cut near +/-pi/2 can otherwise make two
    // nearly-identical orientations look far apart numerically.
    let delta = Math.abs(actual - expected);
    if (delta > Math.PI / 2) delta = Math.PI - delta;
    assert.ok(
      delta < 0.05,
      `degrees=${degrees}: expected ~${expected}, got ${actual}`,
    );
  }
});

test('endpoints stay within the region\'s actual bounding box', () => {
  const plane = makeBlankPlane(100, 60, 0.1);
  addStreak(plane, 15, 30, 85, 30, 3.0, 1.2);
  const [candidate] = detectStreakCandidates(plane);
  for (const point of candidate.endpoints) {
    assert.ok(point.x >= 10 && point.x <= 90, `endpoint x=${point.x}`);
    assert.ok(point.y >= 25 && point.y <= 35, `endpoint y=${point.y}`);
  }
  // The two endpoints should be well separated (tracing the streak's
  // extent), not collapsed to the centroid.
  const span = Math.hypot(
    candidate.endpoints[0].x - candidate.endpoints[1].x,
    candidate.endpoints[0].y - candidate.endpoints[1].y,
  );
  assert.ok(span > 50);
});

test('rejects a region below minLength even if elongated', () => {
  const plane = makeBlankPlane(60, 60, 0.1);
  addStreak(plane, 25, 30, 35, 30, 3.0, 1.2); // only ~10px long
  const candidates = detectStreakCandidates(plane, { minLength: 15 });
  assert.deepEqual(candidates, []);
});

test('rejects a large but round/diffuse blob (not elongated enough)', () => {
  const plane = makeBlankPlane(80, 80, 0.1);
  // A big, diffuse, roughly circular glow -- e.g. a soft-focus light or
  // haze -- large enough to clear minLength/minPixelCount on its own
  // extent, but not line-shaped.
  addGaussianStar(plane, 40, 40, 4.0, 12, 30);
  const candidates = detectStreakCandidates(plane, { minLength: 5 });
  assert.deepEqual(candidates, []);
});

test('caps results at maxCandidates, keeping the brightest', () => {
  const plane = makeBlankPlane(300, 300, 0.1);
  const amplitudes = [6, 5, 4, 3];
  amplitudes.forEach((amplitude, index) => {
    const y = 30 + index * 70;
    addStreak(plane, 20, y, 120, y, amplitude, 1.2);
  });
  const candidates = detectStreakCandidates(plane, { maxCandidates: 2 });
  assert.equal(candidates.length, 2);
  assert.ok(candidates[0].flux >= candidates[1].flux);
});

test('two well-separated streaks are detected as two independent regions', () => {
  const plane = makeBlankPlane(200, 200, 0.1);
  addStreak(plane, 10, 20, 90, 20, 3.0, 1.2);
  addStreak(plane, 110, 150, 190, 180, 3.0, 1.2);
  const candidates = detectStreakCandidates(plane);
  assert.equal(candidates.length, 2);
});

test('flux and pixelCount scale sensibly with a brighter streak', () => {
  const dimPlane = makeBlankPlane(100, 60, 0.1);
  addStreak(dimPlane, 15, 30, 85, 30, 2.0, 1.2);
  const brightPlane = makeBlankPlane(100, 60, 0.1);
  addStreak(brightPlane, 15, 30, 85, 30, 5.0, 1.2);
  const [dim] = detectStreakCandidates(dimPlane);
  const [bright] = detectStreakCandidates(brightPlane);
  assert.ok(bright.flux > dim.flux);
});

test(
  'the necking (width-uniformity) gate rejects two point sources bridged '
  + 'by a thin neck, reproducing a real observed failure case',
  () => {
    // Reconstructs the exact scenario from WORK42_PROGRESS.md's
    // discovered failure: two stars close enough together that their
    // Gaussian PSF wings bridge into one connected region under
    // realistic (noisy, properly thresholded) conditions, which without
    // this gate would pass the length/elongation gates and be
    // misreported as a streak candidate.
    const plane = makeBlankPlane(150, 100, 0.15);
    addGaussianStar(plane, 30, 50, 6.0, 1.2);
    addGaussianStar(plane, 38, 50, 6.0, 1.2);
    addGaussianStar(plane, 46, 50, 6.0, 1.2);
    addGaussianStar(plane, 54, 50, 6.0, 1.2);
    addSeededNoise(plane, 0.02, 777);

    const withoutGate = detectStreakCandidates(plane, {
      thresholdSigma: 5,
      minWidthUniformity: 0, // disabled, reproducing the pre-fix behavior
    });
    assert.equal(
      withoutGate.length,
      1,
      'expected the pre-fix behavior to still show the false-positive '
        + 'merge for this fixture, or the fixture no longer demonstrates '
        + 'the bug being tested',
    );

    const withGate = detectStreakCandidates(plane, { thresholdSigma: 5 });
    assert.equal(
      withGate.length,
      0,
      'the necking gate should reject the four-star chain the '
        + 'un-gated detector accepted',
    );
  },
);

test(
  'a genuine uniform-width streak is not affected by the necking gate',
  () => {
    const plane = makeBlankPlane(120, 60, 0.1);
    addStreak(plane, 10, 30, 110, 30, 4.0, 1.3);
    const candidates = detectStreakCandidates(plane, { thresholdSigma: 5 });
    assert.equal(candidates.length, 1);
  },
);

test(
  'a genuine fading (bolide-style) meteor tail is not rejected by the '
  + 'necking gate, since it only tapers near the true endpoints',
  () => {
    // A streak that's brightest at one end and smoothly fades toward
    // the other -- narrower near the fading tail's very end, which
    // must not be confused with a mid-streak neck. Uses the same
    // technique as streak_brightness_profile_reference.test.mjs's
    // equivalent fixture.
    const plane = makeBlankPlane(120, 60, 0.1);
    const x0 = 10;
    const y0 = 30;
    const x1 = 110;
    const y1 = 30;
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      const amplitude = 6.0 * (1 - 0.85 * t);
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = Math.round(cx) + dx;
          const y = Math.round(cy) + dy;
          if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) {
            continue;
          }
          const value = amplitude * Math.exp(-(dy * dy) / (2 * 1.3 * 1.3))
            * (1 / steps) * 40;
          plane.samples[y * plane.width + x] += value;
        }
      }
    }
    const candidates = detectStreakCandidates(plane, { thresholdSigma: 5 });
    assert.equal(
      candidates.length,
      1,
      'a legitimately fading meteor tail should not be rejected as a '
        + 'necking artifact',
    );
  },
);

test(
  'minWidthUniformity: 0 opts out of the necking gate entirely',
  () => {
    const plane = makeBlankPlane(150, 100, 0.15);
    addGaussianStar(plane, 30, 50, 6.0, 1.2);
    addGaussianStar(plane, 38, 50, 6.0, 1.2);
    addGaussianStar(plane, 46, 50, 6.0, 1.2);
    addGaussianStar(plane, 54, 50, 6.0, 1.2);
    addSeededNoise(plane, 0.02, 777);
    const candidates = detectStreakCandidates(plane, {
      thresholdSigma: 5,
      minWidthUniformity: 0,
    });
    assert.equal(candidates.length, 1);
  },
);

test(
  'documented residual limitation: two heavily overlapping (very close) '
  + 'point sources can still pass the necking gate',
  () => {
    // This is a known, deliberately-not-silently-hidden limitation (see
    // WORK43_PROGRESS.md): at close enough separation relative to the
    // PSF's own sigma, two merged point sources' width profile doesn't
    // dip low enough, relative to their peak width, to cross
    // minWidthUniformity's default threshold without also risking
    // false rejection of genuine streaks with natural width variation.
    // This test exists so a future change to the necking heuristic
    // shows up here as an intentional decision, not a silent behavior
    // change -- if this test starts failing because the gate got
    // stricter, that is likely a *good* change to acknowledge and
    // update this test/comment for, not a regression to revert.
    const plane = makeBlankPlane(100, 100, 0.15);
    addGaussianStar(plane, 40, 50, 6.0, 1.3);
    addGaussianStar(plane, 48, 50, 6.0, 1.3); // 8px separation
    addSeededNoise(plane, 0.02, 555);
    const candidates = detectStreakCandidates(plane, { thresholdSigma: 5 });
    assert.equal(
      candidates.length,
      1,
      'if this now correctly rejects the pair, minWidthUniformity\'s '
        + 'default became stricter -- update this test to document the '
        + 'new boundary rather than treating this as a bug',
    );
  },
);

test(
  'the width-profile multi-lobe gate independently rejects a merge the '
  + 'necking gate alone would miss',
  () => {
    // See WORK46_PROGRESS.md: countSignificantWidthLobes counts distinct
    // wide bumps rather than checking for a single deep dip, so it can
    // catch a shallow multi-bump profile even when minWidthUniformity
    // (necking, checking only whether the profile dips low *somewhere*)
    // is set loose enough, or disabled entirely, to miss it.
    const plane = makeBlankPlane(150, 100, 0.15);
    addGaussianStar(plane, 30, 50, 6.0, 1.2);
    addGaussianStar(plane, 38, 50, 6.0, 1.2);
    addGaussianStar(plane, 46, 50, 6.0, 1.2);
    addGaussianStar(plane, 54, 50, 6.0, 1.2);
    addGaussianStar(plane, 62, 50, 6.0, 1.2);
    addSeededNoise(plane, 0.02, 321);

    const neckingOnly = detectStreakCandidates(plane, {
      thresholdSigma: 5,
      maxWidthProfileLobes: Infinity, // lobe gate disabled
    });
    const bothGates = detectStreakCandidates(plane, { thresholdSigma: 5 });
    assert.ok(
      bothGates.length <= neckingOnly.length,
      'the lobe gate should never let through more candidates than '
        + 'necking alone',
    );
    assert.equal(
      bothGates.length,
      0,
      'expected the combined gates to reject this five-star chain',
    );
  },
);

test(
  'the multi-lobe gate does not false-reject a genuine diagonal streak '
  + '(regression for a real bug found while building this gate)',
  () => {
    // WORK46_PROGRESS.md: the first implementation of the lobe-counting
    // gate used topographic-prominence peak detection on the raw width
    // profile, which false-rejected a perfectly genuine 45-degree
    // streak outright (0 candidates instead of 1). The cause: a
    // discrete pixel grid projected onto a diagonal axis produces a
    // real, small, period-2 width oscillation from discretization
    // geometry alone, and a naive prominence walk measured each
    // oscillation peak's prominence against the streak's far-away
    // tapering ends rather than its immediate neighbors. Fixed by
    // switching to threshold-based run detection (reusing
    // streak_brightness_profile_reference.mjs's `findRuns` pattern),
    // which only cares whether the (smoothed) profile stays above a
    // relative threshold throughout, not about individual local
    // maxima. This test would have caught that bug immediately, and
    // guards against it recurring.
    const plane = makeBlankPlane(100, 100, 0.1);
    addStreak(plane, 10, 10, 90, 90, 3.0, 1.2);
    const candidates = detectStreakCandidates(plane, { thresholdSigma: 5 });
    assert.equal(
      candidates.length,
      1,
      'a genuine diagonal streak must not be rejected by the multi-lobe '
        + 'gate',
    );
    assert.ok(Math.abs(candidates[0].centroidX - 50) < 2);
    assert.ok(Math.abs(candidates[0].centroidY - 50) < 2);
  },
);

test(
  'maxWidthProfileLobes: Infinity opts out of the multi-lobe gate '
  + 'entirely',
  () => {
    const plane = makeBlankPlane(150, 100, 0.15);
    addGaussianStar(plane, 30, 50, 6.0, 1.2);
    addGaussianStar(plane, 38, 50, 6.0, 1.2);
    addGaussianStar(plane, 46, 50, 6.0, 1.2);
    addGaussianStar(plane, 54, 50, 6.0, 1.2);
    addGaussianStar(plane, 62, 50, 6.0, 1.2);
    addSeededNoise(plane, 0.02, 321);
    const candidates = detectStreakCandidates(plane, {
      thresholdSigma: 5,
      minWidthUniformity: 0,
      maxWidthProfileLobes: Infinity,
    });
    assert.equal(candidates.length, 1);
  },
);
