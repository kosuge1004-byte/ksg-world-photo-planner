import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStars } from '../star_centroid_detector_reference.mjs';
import { estimateSimilarityTransform }
  from '../star_similarity_transform_estimator_reference.mjs';
import { detectStreakCandidates }
  from '../streak_candidate_detector_reference.mjs';
import { classifyStreakPersistence }
  from '../streak_persistence_classifier_reference.mjs';

/// Full-pipeline integration test for the sky-motion-consistency signal:
/// real star detection -> real sky-transform estimation -> real streak
/// detection -> classification, on synthetic frames containing three
/// distinct kinds of feature, each meant to end up in a different
/// category:
///
/// - A point-source star field (for the registration pass only; too
///   round to ever appear in the streak detector's own output).
/// - A "star trail" streak that moves between frames exactly as the
///   point-star field itself rotates -- expected category: skyMotion.
/// - A "satellite" streak that moves by a fixed, sky-unrelated amount
///   between frames -- expected category: independentMotion.
/// - A "meteor" streak that appears in exactly one frame -- expected
///   category: isolated.
///
/// This is the strongest test in this project of the sky-motion
/// direction handling (previous vs. next, forward vs. inverted
/// transform) and of the whole feature working correctly end to end
/// rather than only against hand-built fixtures.

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
  'full pipeline: star trail, satellite, and isolated meteor are '
  + 'correctly separated using real registration data',
  () => {
    const width = 260;
    const height = 220;
    const centerX = width / 2;
    const centerY = height / 2;
    const rotationPerFrame = 2.0; // degrees, cumulative
    const driftDxPerFrame = 3.0;
    const driftDyPerFrame = -1.5;

    const starTruth = seededRandomStarField(22, 4653, width, height, 20);
    // Verify the chosen star field has no accidentally-close pairs that
    // could bridge together into a spurious elongated connected
    // component under the streak detector's flood fill (a real,
    // documented failure mode -- see WORK42_PROGRESS.md -- not
    // something to silently work around by picking a lucky seed without
    // also guarding against it recurring).
    for (let i = 0; i < starTruth.length; i++) {
      for (let j = i + 1; j < starTruth.length; j++) {
        const distance = Math.hypot(
          starTruth[i].x - starTruth[j].x,
          starTruth[i].y - starTruth[j].y,
        );
        assert.ok(
          distance > 15,
          `fixture stars ${i} and ${j} are only ${distance.toFixed(2)}px `
            + 'apart, which risks an accidental connected-component merge '
            + 'in the streak detector; regenerate the seed',
        );
      }
    }

    // A "star trail" streak's own two endpoints, defined in frame 0's
    // coordinate system, which will be sky-transformed frame to frame
    // exactly like the point-star field itself.
    const trailEndpointsFrame0 = [
      { x: 70, y: 60 },
      { x: 85, y: 68 },
    ];
    // A "satellite" streak moving by a large, sky-unrelated fixed
    // amount each frame (not tied to the star field's rotation at all).
    const satelliteEndpointsFrame0 = [
      { x: 40, y: 170 },
      { x: 75, y: 178 },
    ];
    const satelliteDriftPerFrame = { dx: 45, dy: 3 };

    function renderFrame(frameIndex) {
      const plane = makePlane(width, height, 0.12);
      for (const star of starTruth) {
        const moved = rotatePoint(
          star.x, star.y, rotationPerFrame * frameIndex, centerX, centerY,
          driftDxPerFrame * frameIndex, driftDyPerFrame * frameIndex,
        );
        addGaussianStar(plane, moved.x, moved.y, star.peak, 1.3);
      }

      const [ta, tb] = trailEndpointsFrame0;
      const movedTa = rotatePoint(
        ta.x, ta.y, rotationPerFrame * frameIndex, centerX, centerY,
        driftDxPerFrame * frameIndex, driftDyPerFrame * frameIndex,
      );
      const movedTb = rotatePoint(
        tb.x, tb.y, rotationPerFrame * frameIndex, centerX, centerY,
        driftDxPerFrame * frameIndex, driftDyPerFrame * frameIndex,
      );
      addStreak(plane, movedTa.x, movedTa.y, movedTb.x, movedTb.y, 4.0, 1.3);

      const [sa, sb] = satelliteEndpointsFrame0;
      const satDx = satelliteDriftPerFrame.dx * frameIndex;
      const satDy = satelliteDriftPerFrame.dy * frameIndex;
      addStreak(
        plane, sa.x + satDx, sa.y + satDy, sb.x + satDx, sb.y + satDy,
        4.0, 1.3,
      );

      if (frameIndex === 1) {
        // The meteor: present only in frame 1, at a position unrelated
        // to anything else in the scene.
        addStreak(plane, 150, 30, 220, 55, 5.0, 1.3);
      }

      return plane;
    }

    const frameCount = 3;
    const planes = [];
    for (let index = 0; index < frameCount; index++) {
      planes.push(renderFrame(index));
    }

    // Real star detection, for the registration pass.
    const starDetections = planes.map(
      (plane) => detectStars(plane, { thresholdSigma: 5 }),
    );
    for (const stars of starDetections) {
      assert.ok(
        stars.length >= starTruth.length - 4,
        `expected close to ${starTruth.length} star detections, got `
          + `${stars.length}`,
      );
    }

    // Real sky-transform estimation between each consecutive pair.
    const skyTransforms = [];
    for (let index = 0; index < frameCount - 1; index++) {
      const estimate = estimateSimilarityTransform(
        starDetections[index], starDetections[index + 1],
      );
      assert.ok(
        Math.abs(estimate.rotationDegrees - rotationPerFrame) < 0.05,
        `pair ${index}->${index + 1}: expected rotation near `
          + `${rotationPerFrame}, got ${estimate.rotationDegrees}`,
      );
      skyTransforms.push(estimate);
    }

    // Real streak detection on each frame.
    const framesInOrder = planes.map((plane, frameIndex) => ({
      frameIndex,
      streaks: detectStreakCandidates(plane, { thresholdSigma: 5 }),
    }));
    // Every frame should show exactly the trail and the satellite (2
    // streaks); frame 1 additionally shows the meteor (3). An exact
    // count, not just a lower bound, catches any accidental extra
    // detection (e.g. a spurious merge among the point-star field, the
    // failure mode this fixture's minimum-separation check above guards
    // against) immediately as a test failure rather than letting a
    // nearest-match lookup silently pick the wrong streak.
    for (const frame of framesInOrder) {
      const expectedCount = frame.frameIndex === 1 ? 3 : 2;
      assert.equal(
        frame.streaks.length,
        expectedCount,
        `frame ${frame.frameIndex}: expected exactly ${expectedCount} `
          + `streak detections, got ${frame.streaks.length} `
          + `(${frame.streaks.map((s) => `(${s.centroidX.toFixed(1)},`
            + `${s.centroidY.toFixed(1)})`).join(', ')})`,
      );
    }

    const results = classifyStreakPersistence(framesInOrder, {
      skyTransforms,
      skyMotionToleranceRadius: 10,
      maxEndpointGap: 60,
    });

    // Identify each streak by its approximate expected region rather
    // than assuming array order, since detection order depends on flux
    // ranking, not scene semantics.
    function nearestResultTo(frameIndex, approxX, approxY) {
      const candidates = results.filter((r) => r.frameIndex === frameIndex);
      return candidates.reduce((best, candidate) => {
        const distance = Math.hypot(
          candidate.streak.centroidX - approxX,
          candidate.streak.centroidY - approxY,
        );
        const bestDistance = best
          ? Math.hypot(
            best.streak.centroidX - approxX,
            best.streak.centroidY - approxY,
          )
          : Infinity;
        return distance < bestDistance ? candidate : best;
      }, null);
    }

    // Star trail, frame 0: near (77.5, 64) (the midpoint of its frame-0
    // endpoints).
    const trailResult = nearestResultTo(0, 77.5, 64);
    assert.ok(trailResult !== null);
    assert.equal(
      trailResult.category,
      'skyMotion',
      `star trail: expected skyMotion, got ${trailResult.category}`,
    );

    // Satellite, frame 0: near (57.5, 174).
    const satelliteResult = nearestResultTo(0, 57.5, 174);
    assert.ok(satelliteResult !== null);
    assert.equal(
      satelliteResult.category,
      'independentMotion',
      `satellite: expected independentMotion, got `
        + `${satelliteResult.category}`,
    );

    // Meteor, frame 1: near (185, 42.5).
    const meteorResult = nearestResultTo(1, 185, 42.5);
    assert.ok(meteorResult !== null);
    assert.equal(
      meteorResult.category,
      'isolated',
      `meteor: expected isolated, got ${meteorResult.category}`,
    );
  },
);
