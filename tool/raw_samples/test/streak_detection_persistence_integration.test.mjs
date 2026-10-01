import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStreakCandidates }
  from '../streak_candidate_detector_reference.mjs';
import { classifyStreakPersistence }
  from '../streak_persistence_classifier_reference.mjs';

/// Integration test: runs the actual streak detector on synthetic
/// rendered frames (not hand-built streak objects) and feeds its output
/// into the persistence classifier, checking the handoff between the two
/// modules -- in particular, that the detector's `angleRadians` and
/// `endpoints` fields are exactly what the classifier expects.

function makeBlankPlane(width, height, backgroundValue = 0.1) {
  return {
    width,
    height,
    samples: new Float32Array(width * height).fill(backgroundValue),
  };
}

function addStreak(plane, x0, y0, x1, y1, peakAmplitude, crossSigma) {
  const stepPx = 0.35;
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

test(
  'detector + classifier: a real meteor stays isolated, a real '
  + 'satellite pass is flagged persistent, end to end on rendered frames',
  () => {
    const width = 240;
    const height = 200;

    // Frame 0: a satellite segment heading right-and-down.
    const frame0 = makeBlankPlane(width, height, 0.12);
    addStreak(frame0, 20, 20, 100, 60, 3.0, 1.2);

    // Frame 1: the meteor appears here only, unrelated position/angle,
    // plus the satellite's segment continuing collinearly from frame 0.
    const frame1 = makeBlankPlane(width, height, 0.12);
    addStreak(frame1, 105, 63, 185, 103, 3.0, 1.2); // satellite continues
    addStreak(frame1, 30, 160, 210, 140, 4.0, 1.3); // the meteor

    // Frame 2: the satellite continues once more; no meteor.
    const frame2 = makeBlankPlane(width, height, 0.12);
    addStreak(frame2, 190, 106, 230, 128, 3.0, 1.2);

    const framesInOrder = [
      { frameIndex: 0, streaks: detectStreakCandidates(frame0) },
      { frameIndex: 1, streaks: detectStreakCandidates(frame1) },
      { frameIndex: 2, streaks: detectStreakCandidates(frame2) },
    ];
    for (const frame of framesInOrder) {
      assert.ok(
        frame.streaks.length >= 1,
        `frame ${frame.frameIndex}: expected at least one detection`,
      );
    }

    const results = classifyStreakPersistence(framesInOrder, {
      maxEndpointGap: 15,
    });

    const meteorLike = results.filter(
      (r) => r.frameIndex === 1 && !r.persistentAcrossFrames,
    );
    assert.ok(
      meteorLike.length >= 1,
      'expected at least one non-persistent (meteor-like) candidate in '
        + 'frame 1',
    );
    // The meteor-like candidate should be the one near the actual meteor
    // streak's position (y around 140-160), not the satellite segment.
    assert.ok(
      meteorLike.some((r) => r.streak.centroidY > 120),
      'expected the isolated candidate to be near the meteor, not the '
        + 'satellite',
    );

    const persistentCount = results.filter(
      (r) => r.persistentAcrossFrames,
    ).length;
    assert.ok(
      persistentCount >= 2,
      'expected the satellite segments to be flagged persistent across '
        + 'at least two frames',
    );
  },
);
