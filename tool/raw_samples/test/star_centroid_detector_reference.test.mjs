import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DetectedStar,
  detectStars,
  InvalidStarDetectionInput,
} from '../star_centroid_detector_reference.mjs';

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

function addHotPixel(plane, x, y, value) {
  plane.samples[y * plane.width + x] = value;
}

function addSmearedTrail(
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
        // Each step contributes a thin cross-sectional Gaussian slice;
        // overlapping slices at a fine step spacing sum into a smooth,
        // continuous streak, unlike single discrete points along the
        // path which would each look like an isolated round source.
        const value = peakAmplitude
          * Math.exp(-(ox * ox + oy * oy) / (2 * crossSigma * crossSigma))
          * (stepPx / crossSigma);
        plane.samples[y * plane.width + x] += value;
      }
    }
  }
}

test('rejects malformed source dimensions', () => {
  assert.throws(
    () => detectStars({ width: 0, height: 10, samples: new Float32Array(0) }),
    InvalidStarDetectionInput,
  );
  assert.throws(
    () => detectStars({
      width: 10,
      height: 10,
      samples: new Float32Array(5),
    }),
    InvalidStarDetectionInput,
  );
});

test('returns no stars for a tiny plane smaller than the window', () => {
  const plane = makeBlankPlane(4, 4);
  assert.deepEqual(detectStars(plane, { windowRadius: 4 }), []);
});

test('finds a single bright Gaussian star near its true center', () => {
  const plane = makeBlankPlane(64, 64, 0.1);
  addGaussianStar(plane, 32.3, 28.7, 5.0, 1.4);
  const stars = detectStars(plane, { thresholdSigma: 5 });
  assert.equal(stars.length, 1);
  assert.ok(stars[0] instanceof DetectedStar);
  assert.ok(Math.abs(stars[0].x - 32.3) < 0.15);
  assert.ok(Math.abs(stars[0].y - 28.7) < 0.15);
});

test('finds multiple stars and ranks them by descending flux', () => {
  const plane = makeBlankPlane(96, 96, 0.1);
  addGaussianStar(plane, 20, 20, 8.0, 1.3); // brightest
  addGaussianStar(plane, 70, 60, 4.0, 1.3); // dimmer
  addGaussianStar(plane, 50, 15, 2.5, 1.1); // dimmest
  const stars = detectStars(plane, { thresholdSigma: 5 });
  assert.equal(stars.length, 3);
  assert.ok(stars[0].flux > stars[1].flux);
  assert.ok(stars[1].flux > stars[2].flux);
  const nearest = (x, y) => stars.reduce(
    (best, star) => {
      const distance = Math.hypot(star.x - x, star.y - y);
      return distance < best.distance ? { star, distance } : best;
    },
    { star: null, distance: Infinity },
  );
  assert.ok(nearest(20, 20).distance < 0.3);
  assert.ok(nearest(70, 60).distance < 0.3);
  assert.ok(nearest(50, 15).distance < 0.3);
});

test('stays close to true centroids under moderate photon-style noise', () => {
  const plane = makeBlankPlane(80, 80, 0.2);
  const trueStars = [
    [15.4, 12.6],
    [60.1, 55.9],
    [40.0, 70.2],
  ];
  for (const [x, y] of trueStars) {
    addGaussianStar(plane, x, y, 6.0, 1.5);
  }
  addSeededNoise(plane, 0.05, 12345);
  const stars = detectStars(plane, { thresholdSigma: 5 });
  assert.equal(stars.length, trueStars.length);
  for (const [tx, ty] of trueStars) {
    const nearest = stars.reduce(
      (best, star) => Math.min(best, Math.hypot(star.x - tx, star.y - ty)),
      Infinity,
    );
    assert.ok(nearest < 0.3, `expected a match near (${tx}, ${ty})`);
  }
});

test('rejects an isolated single hot pixel via the sharpness gate', () => {
  const plane = makeBlankPlane(48, 48, 0.1);
  addGaussianStar(plane, 24, 24, 5.0, 1.4);
  addHotPixel(plane, 10, 10, 50.0);
  const stars = detectStars(plane, { thresholdSigma: 5 });
  assert.equal(stars.length, 1);
  assert.ok(Math.abs(stars[0].x - 24) < 0.2);
  assert.ok(Math.abs(stars[0].y - 24) < 0.2);
});

test('rejects an elongated satellite-style trail via the roundness gate', () => {
  const plane = makeBlankPlane(64, 64, 0.1);
  addGaussianStar(plane, 32, 32, 5.0, 1.4);
  // A diagonal streak, well clear of the star, that would look round
  // under a naive axis-aligned (x-variance vs y-variance) elongation
  // metric but is genuinely elongated once the covariance term is
  // accounted for.
  addSmearedTrail(plane, 2, 2, 60, 20, 4.0, 1.2);
  const stars = detectStars(plane, { thresholdSigma: 5 });
  assert.equal(stars.length, 1);
  assert.ok(Math.abs(stars[0].x - 32) < 0.2);
  assert.ok(Math.abs(stars[0].y - 32) < 0.2);
});

test('detects elongation along a diagonal, not just axis-aligned', () => {
  // A source elongated at 45 degrees can have secondX == secondY (equal
  // axis-aligned variances) while still being highly elongated; only the
  // covariance (cross) term reveals it. This directly regresses against
  // an axis-aligned-only roundness formula, which would score this as
  // round.
  const plane = makeBlankPlane(64, 64, 0.1);
  addSmearedTrail(plane, 12, 12, 52, 52, 5.0, 1.0);
  const stars = detectStars(plane, {
    thresholdSigma: 5,
    maxRoundness: 1, // accept everything so we can inspect the metric
    minSeparation: 20,
  });
  assert.ok(stars.length >= 1);
  const mostElongated = stars.reduce(
    (best, star) => (star.roundness > best.roundness ? star : best),
  );
  assert.ok(
    mostElongated.roundness > 0.6,
    `expected high roundness for a diagonal trail, got ${mostElongated.roundness}`,
  );
});

test('enforces minimum separation between close peaks', () => {
  const plane = makeBlankPlane(64, 64, 0.1);
  // Two heavily overlapping stars only ~2px apart should collapse into
  // one accepted centroid under default separation, rather than two
  // spurious detections from noise-level bumps in the shared wing.
  addGaussianStar(plane, 30, 32, 5.0, 1.4);
  addGaussianStar(plane, 32, 32, 5.0, 1.4);
  const stars = detectStars(plane, { thresholdSigma: 5, minSeparation: 8 });
  assert.equal(stars.length, 1);
});

test('caps the result at maxStars, keeping the brightest', () => {
  const plane = makeBlankPlane(200, 200, 0.1);
  const amplitudes = [9, 8, 7, 6, 5, 4, 3];
  amplitudes.forEach((amplitude, index) => {
    addGaussianStar(plane, 20 + index * 25, 20 + index * 20, amplitude, 1.2);
  });
  const stars = detectStars(plane, { thresholdSigma: 5, maxStars: 3 });
  assert.equal(stars.length, 3);
  assert.ok(stars[0].flux >= stars[1].flux);
  assert.ok(stars[1].flux >= stars[2].flux);
});

test('returns nothing on a uniform plane with no sources', () => {
  const plane = makeBlankPlane(50, 50, 0.3);
  addSeededNoise(plane, 0.02, 999);
  const stars = detectStars(plane, { thresholdSigma: 6 });
  assert.equal(stars.length, 0);
});

test('is robust to a nonzero background level', () => {
  const plane = makeBlankPlane(64, 64, 1.75);
  addGaussianStar(plane, 32, 32, 4.0, 1.4);
  const stars = detectStars(plane, { thresholdSigma: 5 });
  assert.equal(stars.length, 1);
  assert.ok(Math.abs(stars[0].x - 32) < 0.2);
  assert.ok(Math.abs(stars[0].y - 32) < 0.2);
});


test('star detection rejects NaN/Inf luminance instead of corrupting MAD/centroiding', () => {
  const plane = makeBlankPlane(16, 16);
  plane.samples[5] = Number.NaN;
  assert.throws(
    () => detectStars(plane),
    /finite luminance samples/,
  );

  const plane2 = makeBlankPlane(16, 16);
  plane2.samples[7] = Number.POSITIVE_INFINITY;
  assert.throws(
    () => detectStars(plane2),
    /finite luminance samples/,
  );
});

test('star detection rejects non-finite and invalid runtime parameters', () => {
  const plane = makeBlankPlane(16, 16);
  assert.throws(
    () => detectStars(plane, { thresholdSigma: Number.NaN }),
    /parameters must be finite/,
  );
  assert.throws(
    () => detectStars(plane, { noiseFloorSigma: Number.POSITIVE_INFINITY }),
    /parameters must be finite/,
  );
  assert.throws(
    () => detectStars(plane, { windowRadius: 0 }),
    /parameters must be finite/,
  );
  assert.throws(
    () => detectStars(plane, { minSeparation: -1 }),
    /parameters must be finite/,
  );
});
