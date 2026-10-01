import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStars } from '../star_centroid_detector_reference.mjs';

/// Investigates a direct question: can high-ISO sensor noise be
/// misidentified as a star? `star_centroid_detector_reference.mjs`
/// already has defenses validated against a single isolated hot pixel
/// (see its own test file's "rejects an isolated single hot pixel via
/// the sharpness gate"), but that is a narrow case: one pixel, one
/// location, zero background noise elsewhere. Real high-ISO noise is
/// none of those things -- it is many random per-pixel fluctuations
/// (read noise) covering the whole frame, plus a scattering of warm/hot
/// pixels that vary in count, brightness, and *sharpness* (a defect's
/// charge can diffuse into 1-2 neighboring pixels, not stay perfectly
/// single-pixel) from real sensor behavior that a static, camera-
/// reported defect list won't fully cover (that list only knows about
/// defects present at manufacture-time calibration, not warm pixels that
/// develop later or vary with temperature).
///
/// This file empirically measures false-positive detection rates under
/// each of those conditions separately, rather than asserting a vague
/// "it's robust" — the goal is a quantified, falsifiable answer.

function makeBlankPlane(width, height, backgroundValue) {
  return {
    width,
    height,
    samples: new Float32Array(width * height).fill(backgroundValue),
  };
}

/// Gaussian (not uniform) per-pixel read noise via the Box-Muller
/// transform, driven by a seeded uniform generator for reproducibility.
/// Uniform additive noise (as `addSeededNoise` elsewhere in this
/// project's tests uses) has no tail beyond its fixed amplitude; real
/// sensor read noise is much closer to Gaussian and does have a tail,
/// which matters here specifically because this file is testing
/// tail-driven false positives.
function addGaussianReadNoise(plane, standardDeviation, seed) {
  let state = seed;
  const nextUniform = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return Math.max(1e-9, state / 0x7fffffff);
  };
  for (let i = 0; i < plane.samples.length; i += 2) {
    const u1 = nextUniform();
    const u2 = nextUniform();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    plane.samples[i] += radius * Math.cos(angle) * standardDeviation;
    if (i + 1 < plane.samples.length) {
      plane.samples[i + 1] += radius * Math.sin(angle) * standardDeviation;
    }
  }
}

/// Scatters `count` single-pixel warm/hot pixels at random locations
/// with random amplitudes drawn uniformly from
/// `[minAmplitude, maxAmplitude]` above the local background — the
/// "perfectly sharp, single-pixel defect" case, matching real stuck/hot
/// pixel behavior.
function addRandomWarmPixels(
  plane,
  count,
  minAmplitude,
  maxAmplitude,
  seed,
) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const positions = [];
  for (let i = 0; i < count; i++) {
    const x = Math.floor(next() * plane.width);
    const y = Math.floor(next() * plane.height);
    const amplitude = minAmplitude + next() * (maxAmplitude - minAmplitude);
    plane.samples[y * plane.width + x] += amplitude;
    positions.push({ x, y, amplitude });
  }
  return positions;
}

/// Scatters `count` *blurred* warm pixels: the defect's charge diffuses
/// into a small 3x3 neighborhood with a steep but non-single-pixel
/// falloff (unlike `addRandomWarmPixels`'s perfectly sharp spike), which
/// is closer to how some real sensor defects actually look and is a
/// harder case for the sharpness gate, which specifically targets
/// flux concentrated in a single pixel.
function addBlurredWarmPixels(
  plane,
  count,
  minAmplitude,
  maxAmplitude,
  blurSigma,
  seed,
) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const positions = [];
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(next() * plane.width);
    const cy = Math.floor(next() * plane.height);
    const amplitude = minAmplitude + next() * (maxAmplitude - minAmplitude);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) continue;
        const value = amplitude
          * Math.exp(-(dx * dx + dy * dy) / (2 * blurSigma * blurSigma));
        plane.samples[y * plane.width + x] += value;
      }
    }
    positions.push({ x: cx, y: cy, amplitude });
  }
  return positions;
}

test(
  'pure Gaussian read noise, no stars and no warm pixels, produces very '
  + 'few false detections at the default threshold',
  () => {
    // A modest, deliberately "busy" plane (200x200 = 40,000 pixels) of
    // pure read noise with no real sources at all. At the default
    // thresholdSigma of 6, essentially no detections are expected from
    // a well-behaved Gaussian noise field this size (a one-tailed
    // 6-sigma Gaussian event has probability ~1e-9, so ~40,000 pixels
    // gives an expected false-positive pixel count far below 1); a
    // small nonzero count is still tolerated since real background
    // statistics estimation (median/MAD) is itself an approximation,
    // and multiple seeds are checked so a single unlucky draw can't
    // pass or fail this alone.
    const width = 200;
    const height = 200;
    let totalFalsePositives = 0;
    const seeds = [1, 2, 3, 4, 5];
    for (const seed of seeds) {
      const plane = makeBlankPlane(width, height, 0.15);
      addGaussianReadNoise(plane, 0.01, seed);
      const stars = detectStars(plane);
      totalFalsePositives += stars.length;
    }
    assert.ok(
      totalFalsePositives <= 2,
      `expected at most ~0-2 false positives across ${seeds.length} `
        + `${width}x${height} noise-only trials at the default `
        + `threshold, got ${totalFalsePositives} total`,
    );
  },
);

test(
  'increasing read noise alone (no warm pixels) does not blow up the '
  + 'false-positive rate, because the threshold is derived from that '
  + 'same noise\'s own robust sigma estimate',
  () => {
    // The detector estimates its own background sigma from the image,
    // so a noisier image should get a proportionally higher absolute
    // threshold, keeping the false-positive *rate* roughly stable even
    // as the noise level itself increases -- this is the core reason a
    // fixed-sigma-multiple threshold (rather than a fixed absolute
    // value) is the right design for handling varying ISO/noise levels
    // without per-ISO tuning.
    const width = 150;
    const height = 150;
    for (const readNoiseStd of [0.005, 0.02, 0.05, 0.1]) {
      let falsePositives = 0;
      for (const seed of [10, 20, 30]) {
        const plane = makeBlankPlane(width, height, 0.15);
        addGaussianReadNoise(plane, readNoiseStd, seed);
        falsePositives += detectStars(plane).length;
      }
      assert.ok(
        falsePositives <= 3,
        `readNoiseStd=${readNoiseStd}: expected a low false-positive `
          + `count across 3 trials, got ${falsePositives}`,
      );
    }
  },
);

test(
  'many scattered single-pixel warm/hot pixels are correctly rejected '
  + 'by the sharpness gate, not just one isolated example',
  () => {
    // Work36's own test covers exactly one hot pixel in an otherwise
    // clean frame. Real high-ISO frames can have dozens of scattered
    // warm pixels at once; this checks the gate holds up under that
    // denser, more realistic load, not just the single-instance case.
    const width = 200;
    const height = 200;
    const plane = makeBlankPlane(width, height, 0.15);
    addGaussianReadNoise(plane, 0.01, 999);
    const warmPixels = addRandomWarmPixels(plane, 60, 3.0, 15.0, 4242);
    const stars = detectStars(plane);

    // None of the detections should sit on (or very near) a synthetic
    // single-pixel warm pixel's location.
    for (const star of stars) {
      const nearestWarmPixelDistance = warmPixels.reduce(
        (best, warm) => Math.min(
          best,
          Math.hypot(star.x - warm.x, star.y - warm.y),
        ),
        Infinity,
      );
      assert.ok(
        nearestWarmPixelDistance > 1.5,
        `a detected "star" at (${star.x.toFixed(2)}, `
          + `${star.y.toFixed(2)}) sits on top of a synthetic warm `
          + 'pixel, with sharpness '
          + `${star.sharpness.toFixed(3)}`,
      );
    }
  },
);

test(
  'a blurred (multi-pixel, not perfectly sharp) warm pixel is a harder '
  + 'case: characterizes where the sharpness gate stops catching it',
  () => {
    // This is the honest, quantified answer to "could noise ever be
    // mistaken for a star": not a single sharp defect (well covered
    // above), but a defect whose charge has diffused into a few
    // neighboring pixels enough to resemble a small, dim star's PSF.
    // Sweeps blur sigma to find where the sharpness gate's protection
    // degrades, rather than asserting a single pass/fail that hides
    // that boundary.
    const width = 150;
    const height = 150;
    const results = [];
    for (const blurSigma of [0.3, 0.5, 0.7, 0.9, 1.1, 1.3]) {
      const plane = makeBlankPlane(width, height, 0.15);
      addGaussianReadNoise(plane, 0.01, 1000);
      const warmPixels = addBlurredWarmPixels(
        plane, 10, 4.0, 10.0, blurSigma, 5000,
      );
      const stars = detectStars(plane);
      let caughtCount = 0;
      for (const warm of warmPixels) {
        const matched = stars.some(
          (star) => Math.hypot(star.x - warm.x, star.y - warm.y) < 1.5,
        );
        if (matched) caughtCount += 1;
      }
      results.push({ blurSigma, falsePositiveCount: caughtCount });
    }

    // At the sharpest end (blurSigma 0.3, barely spread beyond a single
    // pixel), essentially none should slip through.
    assert.equal(
      results[0].falsePositiveCount,
      0,
      `blurSigma=${results[0].blurSigma}: expected the sharpness gate `
        + 'to catch all near-single-pixel defects',
    );

    // Report (via the assertion message, always visible on failure, and
    // deliberately also on an artificial always-passing check so the
    // measured boundary is visible in normal test output too) where
    // detections start slipping through, rather than silently hiding
    // it. This is expected to happen at some blur width, since a
    // sufficiently spread-out defect is, by design, exactly what the
    // sharpness gate cannot distinguish from a real, dim, compact star
    // -- see WORK44_PROGRESS.md for the measured boundary and what (if
    // anything) mitigates it.
    // eslint-disable-next-line no-console
    console.log(
      'blurred warm-pixel sharpness-gate boundary:',
      JSON.stringify(results),
    );
  },
);

test(
  'a dim, compact real star is not accidentally rejected by the same '
  + 'gates that catch warm-pixel noise (the gates must not overcorrect)',
  () => {
    // The flip side of this whole investigation: tightening noise
    // rejection is only useful if it doesn't also start rejecting real,
    // legitimate faint stars. A dim star with a normal stellar PSF
    // (sigma ~1.2-1.5, typical for realistic optics/pixel scale) must
    // still be found even amid realistic background noise.
    const width = 150;
    const height = 150;
    const plane = makeBlankPlane(width, height, 0.15);
    addGaussianReadNoise(plane, 0.01, 7777);
    const trueX = 75.3;
    const trueY = 82.7;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const x = Math.round(trueX) + dx;
        const y = Math.round(trueY) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const ox = x - trueX;
        const oy = y - trueY;
        plane.samples[y * width + x] += 3.5
          * Math.exp(-(ox * ox + oy * oy) / (2 * 1.3 * 1.3));
      }
    }
    const stars = detectStars(plane);
    const nearest = stars.reduce(
      (best, star) => Math.min(
        best,
        Math.hypot(star.x - trueX, star.y - trueY),
      ),
      Infinity,
    );
    assert.ok(
      nearest < 0.3,
      `expected to find the real dim star near (${trueX}, ${trueY}), `
        + `nearest detection was ${nearest.toFixed(3)}px away`,
    );
  },
);
