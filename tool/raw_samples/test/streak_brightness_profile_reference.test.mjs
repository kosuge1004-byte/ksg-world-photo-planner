import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeStreakBrightnessProfile,
  InvalidBrightnessProfileInput,
} from '../streak_brightness_profile_reference.mjs';

function makeBlankPlane(width, height, backgroundValue = 0.1) {
  return {
    width,
    height,
    samples: new Float32Array(width * height).fill(backgroundValue),
  };
}

/// Renders a continuous streak (smooth brightness along its full
/// length), matching the technique already validated in the star and
/// streak detector tests.
function addContinuousStreak(
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

/// Renders a beaded (blinking-light) streak: several short bright
/// segments along the line, separated by gaps that drop back to
/// background -- the aircraft-navigation-light pattern.
function addBeadedStreak(
  plane,
  x0,
  y0,
  x1,
  y1,
  peakAmplitude,
  crossSigma,
  beadCount,
  beadFraction,
) {
  for (let bead = 0; bead < beadCount; bead++) {
    const segmentStart = bead / beadCount;
    const segmentEnd = segmentStart + (beadFraction / beadCount);
    const bx0 = x0 + (x1 - x0) * segmentStart;
    const by0 = y0 + (y1 - y0) * segmentStart;
    const bx1 = x0 + (x1 - x0) * segmentEnd;
    const by1 = y0 + (y1 - y0) * segmentEnd;
    addContinuousStreak(plane, bx0, by0, bx1, by1, peakAmplitude, crossSigma);
  }
}

function makeStreak(x0, y0, x1, y1, width = 3) {
  return { endpoints: [{ x: x0, y: y0 }, { x: x1, y: y1 }], width };
}

test('rejects malformed source dimensions', () => {
  assert.throws(
    () => analyzeStreakBrightnessProfile(
      { width: 0, height: 10, samples: new Float32Array(0) },
      makeStreak(0, 0, 5, 5),
    ),
    InvalidBrightnessProfileInput,
  );
});

test('a smooth continuous streak shows exactly one segment (not blinking)', () => {
  const plane = makeBlankPlane(120, 60, 0.1);
  addContinuousStreak(plane, 10, 30, 110, 30, 4.0, 1.3);
  const streak = makeStreak(10, 30, 110, 30, 3);
  const result = analyzeStreakBrightnessProfile(plane, streak);
  assert.equal(result.segmentCount, 1);
  assert.equal(result.likelyBlinking, false);
  assert.equal(result.longestGapFraction, 0);
  assert.ok(result.sufficientSamples);
  // The single segment should span nearly the whole streak.
  const [segment] = result.segments;
  assert.ok(segment.startFraction < 0.1);
  assert.ok(segment.endFraction > 0.9);
});

test(
  'a beaded (blinking-light) streak shows multiple segments '
  + '(the aircraft navigation-light pattern)',
  () => {
    const plane = makeBlankPlane(200, 60, 0.1);
    // Five short bright beads spread evenly, each covering 30% of its
    // own 1/5 segment of the line, i.e. clearly separated gaps.
    addBeadedStreak(plane, 10, 30, 190, 30, 5.0, 1.3, 5, 0.3);
    const streak = makeStreak(10, 30, 190, 30, 3);
    const result = analyzeStreakBrightnessProfile(plane, streak);
    assert.equal(result.segmentCount, 5);
    assert.equal(result.likelyBlinking, true);
    assert.ok(result.longestGapFraction > 0.05);
  },
);

test('a two-bead streak is still detected as blinking (the minimum case)', () => {
  const plane = makeBlankPlane(160, 60, 0.1);
  addBeadedStreak(plane, 10, 30, 150, 30, 5.0, 1.3, 2, 0.35);
  const streak = makeStreak(10, 30, 150, 30, 3);
  const result = analyzeStreakBrightnessProfile(plane, streak);
  assert.equal(result.segmentCount, 2);
  assert.equal(result.likelyBlinking, true);
});

test('a fading (bolide-style) meteor-like streak is not blinking', () => {
  // A streak that's brightest at one end and smoothly fades toward the
  // other, still fully continuous (never drops to background in the
  // middle) -- the classic meteor brightness pattern, and must not be
  // mistaken for blinking just because the brightness varies.
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
    const amplitude = 6.0 * (1 - 0.85 * t); // fades from 6.0 to 0.9
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(cx) + dx;
        const y = Math.round(cy) + dy;
        if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) continue;
        const value = amplitude * Math.exp(-(dy * dy) / (2 * 1.3 * 1.3))
          * (1 / steps) * 40;
        plane.samples[y * plane.width + x] += value;
      }
    }
  }
  const streak = makeStreak(10, 30, 110, 30, 3);
  const result = analyzeStreakBrightnessProfile(plane, streak, {
    relativeOnThreshold: 0.1, // the faded tail is much dimmer than the head
  });
  assert.equal(result.segmentCount, 1);
  assert.equal(result.likelyBlinking, false);
});

test('a very short streak reports insufficient samples, not a spurious result', () => {
  const plane = makeBlankPlane(30, 30, 0.1);
  addContinuousStreak(plane, 14, 15, 16, 15, 3.0, 1.0);
  const streak = makeStreak(14, 15, 16, 15, 2);
  const result = analyzeStreakBrightnessProfile(plane, streak, {
    stepPx: 1,
  });
  assert.equal(result.sufficientSamples, false);
  assert.equal(result.likelyBlinking, false);
});

test('a uniform (no-signal) plane produces no segments', () => {
  const plane = makeBlankPlane(100, 40, 0.2);
  const streak = makeStreak(10, 20, 90, 20, 3);
  const result = analyzeStreakBrightnessProfile(plane, streak);
  assert.equal(result.segmentCount, 0);
  assert.equal(result.likelyBlinking, false);
});

test(
  'a small dip within an otherwise continuous streak is not treated as '
  + 'a real gap (minGapPixels absorbs noise-level dips)',
  () => {
    const plane = makeBlankPlane(120, 60, 0.1);
    addContinuousStreak(plane, 10, 30, 110, 30, 4.0, 1.3);
    // Carve a single-pixel-wide dip roughly in the middle, shallow
    // enough to stay above the relative "off" threshold given a
    // generous minGapPixels, simulating minor noise rather than a true
    // navigation-light gap.
    const dipX = 60;
    for (let dy = -2; dy <= 2; dy++) {
      const y = 30 + dy;
      plane.samples[y * plane.width + dipX] *= 0.85;
    }
    const streak = makeStreak(10, 30, 110, 30, 3);
    const result = analyzeStreakBrightnessProfile(plane, streak, {
      minGapPixels: 4,
    });
    assert.equal(result.segmentCount, 1);
    assert.equal(result.likelyBlinking, false);
  },
);

test('endpoints, positions, and profile arrays stay consistent in length', () => {
  const plane = makeBlankPlane(100, 40, 0.1);
  addContinuousStreak(plane, 10, 20, 90, 20, 3.0, 1.2);
  const streak = makeStreak(10, 20, 90, 20, 3);
  const result = analyzeStreakBrightnessProfile(plane, streak, {
    stepPx: 1,
  });
  assert.equal(result.profile.length, result.positions.length);
  assert.ok(result.profile.length > 50);
  // Positions should trace from endpoint 0 toward endpoint 1.
  assert.ok(Math.abs(result.positions[0].x - 10) < 1.5);
  assert.ok(
    Math.abs(result.positions[result.positions.length - 1].x - 90) < 1.5,
  );
});
