import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyStreakPersistence,
  InvalidStreakLinkingInput,
} from '../streak_persistence_classifier_reference.mjs';

function makeStreak(x0, y0, x1, y1) {
  const angleRadians = Math.atan2(y1 - y0, x1 - x0);
  return {
    endpoints: [{ x: x0, y: y0 }, { x: x1, y: y1 }],
    angleRadians,
    centroidX: (x0 + x1) / 2,
    centroidY: (y0 + y1) / 2,
  };
}

function makeSkyTransform(rotationDegrees, dx, dy, centerX, centerY) {
  return {
    rotationDegrees,
    sourceOffsetX: dx,
    sourceOffsetY: dy,
    centerX,
    centerY,
  };
}

/// Applies a sky transform the same way `estimateSimilarityTransform`'s
/// output is meant to be used (matching `AffineSamplingTransform.
/// similarity`'s convention), for building test fixtures whose motion is
/// *exactly* consistent with a given transform.
function applyForward(transform, x, y) {
  const radians = transform.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const ox = x - transform.centerX;
  const oy = y - transform.centerY;
  return {
    x: transform.centerX + cosine * ox - sine * oy + transform.sourceOffsetX,
    y: transform.centerY + sine * ox + cosine * oy + transform.sourceOffsetY,
  };
}

/// Builds a streak in the *next* frame that is exactly what `streak`
/// (in the current frame) would look like if it moved purely with the
/// sky transform: both endpoints (and therefore the centroid and
/// orientation) are mapped forward.
function propagateStreakWithSky(streak, transform) {
  const [a, b] = streak.endpoints;
  const mappedA = applyForward(transform, a.x, a.y);
  const mappedB = applyForward(transform, b.x, b.y);
  return makeStreak(mappedA.x, mappedA.y, mappedB.x, mappedB.y);
}

test('rejects an empty frame list', () => {
  assert.throws(
    () => classifyStreakPersistence([]),
    InvalidStreakLinkingInput,
  );
});

test('rejects a frame missing frameIndex or streaks', () => {
  assert.throws(
    () => classifyStreakPersistence([{ streaks: [] }]),
    InvalidStreakLinkingInput,
  );
  assert.throws(
    () => classifyStreakPersistence([{ frameIndex: 0 }]),
    InvalidStreakLinkingInput,
  );
});

test('a single isolated streak in one frame is not persistent', () => {
  const frames = [
    { frameIndex: 0, streaks: [makeStreak(10, 10, 50, 10)] },
  ];
  const results = classifyStreakPersistence(frames);
  assert.equal(results.length, 1);
  assert.equal(results[0].persistentAcrossFrames, false);
  assert.deepEqual(results[0].linkedFrameIndices, []);
});

test(
  'a streak with no counterpart in the adjacent frames is not persistent '
  + '(the classic single-frame meteor pattern)',
  () => {
    const frames = [
      { frameIndex: 0, streaks: [] },
      { frameIndex: 1, streaks: [makeStreak(10, 10, 60, 40)] }, // meteor
      { frameIndex: 2, streaks: [] },
    ];
    const results = classifyStreakPersistence(frames);
    assert.equal(results.length, 1);
    assert.equal(results[0].frameIndex, 1);
    assert.equal(results[0].persistentAcrossFrames, false);
  },
);

test(
  'a satellite-like streak continuing collinearly into the next frame is '
  + 'marked persistent',
  () => {
    const frames = [
      { frameIndex: 0, streaks: [makeStreak(10, 10, 50, 10)] },
      // Continues the same horizontal line, picking up a short gap away
      // from where the previous segment ended.
      { frameIndex: 1, streaks: [makeStreak(55, 10, 95, 10)] },
      { frameIndex: 2, streaks: [makeStreak(100, 10, 140, 10)] },
    ];
    const results = classifyStreakPersistence(frames);
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(
        result.persistentAcrossFrames,
        true,
        `frame ${result.frameIndex} should be linked`,
      );
    }
    // The middle frame's streak should be linked to both neighbors.
    const middle = results.find((r) => r.frameIndex === 1);
    assert.deepEqual(middle.linkedFrameIndices.sort(), [0, 2]);
    // The first frame's streak only has a "next" neighbor.
    const first = results.find((r) => r.frameIndex === 0);
    assert.deepEqual(first.linkedFrameIndices, [1]);
  },
);

test('a large orientation mismatch is not linked, even if endpoints are close', () => {
  const frames = [
    { frameIndex: 0, streaks: [makeStreak(10, 10, 50, 10)] }, // horizontal
    { frameIndex: 1, streaks: [makeStreak(50, 10, 50, 50)] }, // vertical, touching
  ];
  const results = classifyStreakPersistence(frames, {
    maxAngleDifferenceRadians: 10 * Math.PI / 180,
  });
  for (const result of results) {
    assert.equal(result.persistentAcrossFrames, false);
  }
});

test('a large positional gap is not linked, even with matching orientation', () => {
  const frames = [
    { frameIndex: 0, streaks: [makeStreak(10, 10, 50, 10)] },
    { frameIndex: 1, streaks: [makeStreak(500, 10, 540, 10)] }, // same
    // orientation, but far away
  ];
  const results = classifyStreakPersistence(frames, { maxEndpointGap: 40 });
  for (const result of results) {
    assert.equal(result.persistentAcrossFrames, false);
  }
});

test('non-adjacent (array-position) frames do not link to each other', () => {
  // Frames 0 and 2 have matching collinear streaks, but frame 1 (with an
  // unrelated streak) sits between them in array order, so 0 and 2 are
  // NOT each other's neighbors and must not be linked to one another --
  // only to frame 1's candidates, which don't match.
  const frames = [
    { frameIndex: 0, streaks: [makeStreak(10, 10, 50, 10)] },
    { frameIndex: 1, streaks: [makeStreak(10, 80, 50, 95)] }, // unrelated
    { frameIndex: 2, streaks: [makeStreak(55, 10, 95, 10)] },
  ];
  const results = classifyStreakPersistence(frames);
  for (const result of results) {
    assert.equal(
      result.persistentAcrossFrames,
      false,
      `frame ${result.frameIndex} should not be linked through a gap`,
    );
  }
});

test(
  'an omitted (empty-streak) frame between two matching streaks still '
  + 'links them, since neighbors are by array position not frameIndex',
  () => {
    // frameIndex jumps 0 -> 5 (frames 1-4 produced no candidates and
    // were omitted entirely, not passed as empty entries), but they are
    // still each other's array-position neighbors.
    const frames = [
      { frameIndex: 0, streaks: [makeStreak(10, 10, 50, 10)] },
      { frameIndex: 5, streaks: [makeStreak(55, 10, 95, 10)] },
    ];
    const results = classifyStreakPersistence(frames);
    for (const result of results) {
      assert.equal(result.persistentAcrossFrames, true);
    }
  },
);

test('multiple candidates per frame are each evaluated independently', () => {
  const frames = [
    {
      frameIndex: 0,
      streaks: [
        makeStreak(10, 10, 50, 10), // will link to frame 1's first streak
        makeStreak(10, 100, 60, 130), // isolated (meteor-like)
      ],
    },
    {
      frameIndex: 1,
      streaks: [
        makeStreak(55, 10, 95, 10),
        makeStreak(200, 200, 240, 220), // unrelated to anything
      ],
    },
  ];
  const results = classifyStreakPersistence(frames);
  assert.equal(results.length, 4);
  const linkedCount = results.filter((r) => r.persistentAcrossFrames).length;
  assert.equal(linkedCount, 2); // the one matching pair, both directions
});

test('without skyTransforms, category falls back to isolated/linkedTransformUnavailable', () => {
  const frames = [
    { frameIndex: 0, streaks: [makeStreak(10, 10, 50, 10)] },
    { frameIndex: 1, streaks: [makeStreak(55, 10, 95, 10)] },
  ];
  const results = classifyStreakPersistence(frames);
  for (const result of results) {
    assert.equal(result.category, 'linkedTransformUnavailable');
    assert.deepEqual(result.skyConsistentFrameIndices, []);
    assert.deepEqual(result.independentMotionFrameIndices, []);
  }
});

test('rejects a skyTransforms array of the wrong length', () => {
  const frames = [
    { frameIndex: 0, streaks: [] },
    { frameIndex: 1, streaks: [] },
    { frameIndex: 2, streaks: [] },
  ];
  assert.throws(
    () => classifyStreakPersistence(frames, { skyTransforms: [null] }),
    InvalidStreakLinkingInput,
  );
});

test(
  'a streak whose next-frame position exactly matches the sky transform '
  + 'is classified skyMotion (a real star trail segment)',
  () => {
    const transform = makeSkyTransform(2.5, 4, -3, 100, 100);
    const starStreak = makeStreak(60, 40, 90, 55);
    const starStreakNext = propagateStreakWithSky(starStreak, transform);
    const frames = [
      { frameIndex: 0, streaks: [starStreak] },
      { frameIndex: 1, streaks: [starStreakNext] },
    ];
    const results = classifyStreakPersistence(frames, {
      skyTransforms: [transform],
    });
    for (const result of results) {
      assert.equal(result.persistentAcrossFrames, true);
      assert.equal(result.category, 'skyMotion');
      assert.equal(result.independentMotionFrameIndices.length, 0);
    }
    assert.deepEqual(results[0].skyConsistentFrameIndices, [1]);
    assert.deepEqual(results[1].skyConsistentFrameIndices, [0]);
  },
);

test(
  'a streak that is linked but moves independently of the sky transform '
  + 'is classified independentMotion (a satellite/aircraft candidate)',
  () => {
    const transform = makeSkyTransform(2.5, 4, -3, 100, 100);
    // The star field rotates by ~2.5 degrees + a few px of drift, but
    // this streak instead just translates by a large, unrelated amount
    // -- consistent with an object crossing the frame under its own
    // motion, not tied to the sky's rotation. Still close enough in
    // orientation/position to satisfy the *linking* check (so it's
    // meaningfully testing "linked but not sky-consistent", not merely
    // "not linked at all").
    const satelliteStreak = makeStreak(20, 150, 60, 165);
    const satelliteStreakNext = makeStreak(55, 152, 95, 167); // shifted
    // ~35px right, not matching the sky transform's rotation+drift at
    // this position at all.
    const frames = [
      { frameIndex: 0, streaks: [satelliteStreak] },
      { frameIndex: 1, streaks: [satelliteStreakNext] },
    ];
    const results = classifyStreakPersistence(frames, {
      skyTransforms: [transform],
    });
    for (const result of results) {
      assert.equal(result.persistentAcrossFrames, true);
      assert.equal(result.category, 'independentMotion');
      assert.equal(result.skyConsistentFrameIndices.length, 0);
    }
  },
);

test(
  'a null entry in skyTransforms for a specific pair yields '
  + 'linkedTransformUnavailable for links through that pair',
  () => {
    const frames = [
      { frameIndex: 0, streaks: [makeStreak(10, 10, 50, 10)] },
      { frameIndex: 1, streaks: [makeStreak(55, 10, 95, 10)] },
    ];
    const results = classifyStreakPersistence(frames, {
      skyTransforms: [null], // registration failed for this pair
    });
    for (const result of results) {
      assert.equal(result.persistentAcrossFrames, true);
      assert.equal(result.category, 'linkedTransformUnavailable');
    }
  },
);

test(
  'sky-motion direction is handled correctly for both the previous and '
  + 'next neighbor (not just symmetrically by coincidence)',
  () => {
    // Three frames with two DIFFERENT sky transforms, to catch a bug
    // where the "previous frame" direction accidentally reused the
    // "next frame" formula (or vice versa) without correctly inverting
    // it -- a symmetric single-transform test could pass by coincidence
    // even with such a bug.
    const transformAB = makeSkyTransform(1.8, 3, -2, 120, 90);
    const transformBC = makeSkyTransform(3.1, -2, 4, 120, 90);
    const streakA = makeStreak(30, 30, 70, 45);
    const streakB = propagateStreakWithSky(streakA, transformAB);
    const streakC = propagateStreakWithSky(streakB, transformBC);

    const frames = [
      { frameIndex: 0, streaks: [streakA] },
      { frameIndex: 1, streaks: [streakB] },
      { frameIndex: 2, streaks: [streakC] },
    ];
    const results = classifyStreakPersistence(frames, {
      skyTransforms: [transformAB, transformBC],
    });
    // All three should be sky-motion-consistent: frame 0 via its link
    // forward to frame 1 (transformAB, no inversion needed), frame 2 via
    // its link backward to frame 1 (transformBC, inverted), and frame 1
    // via both directions (transformAB inverted looking back at frame 0,
    // transformBC direct looking forward to frame 2).
    for (const result of results) {
      assert.equal(
        result.category,
        'skyMotion',
        `frame ${result.frameIndex} should be skyMotion`,
      );
    }
    const middle = results.find((r) => r.frameIndex === 1);
    assert.deepEqual(middle.skyConsistentFrameIndices.sort(), [0, 2]);
  },
);

test(
  'skyMotion takes priority when one neighbor matches and the other '
  + "doesn't (mixed evidence still favors the strong positive signal)",
  () => {
    const transformAB = makeSkyTransform(2.0, 2, -1, 100, 100);
    const streakA = makeStreak(40, 40, 70, 50);
    const streakB = propagateStreakWithSky(streakA, transformAB);
    // Frame 2's streak is linked to frame 1's (similar orientation,
    // close enough endpoints) but was not generated via any sky
    // transform -- an unrelated coincidental near-match.
    const streakCUnrelated = makeStreak(
      streakB.endpoints[0].x + 30,
      streakB.endpoints[0].y + 2,
      streakB.endpoints[1].x + 30,
      streakB.endpoints[1].y + 2,
    );

    const frames = [
      { frameIndex: 0, streaks: [streakA] },
      { frameIndex: 1, streaks: [streakB] },
      { frameIndex: 2, streaks: [streakCUnrelated] },
    ];
    // No transform available for the 1->2 pair, so frame 1's forward
    // link can't be tested; only its backward link (to frame 0, via
    // transformAB inverted) can be, and it should confirm skyMotion.
    const results = classifyStreakPersistence(frames, {
      skyTransforms: [transformAB, null],
    });
    const middle = results.find((r) => r.frameIndex === 1);
    assert.equal(middle.category, 'skyMotion');
    assert.deepEqual(middle.skyConsistentFrameIndices, [0]);
    assert.deepEqual(middle.independentMotionFrameIndices, []);
  },
);
