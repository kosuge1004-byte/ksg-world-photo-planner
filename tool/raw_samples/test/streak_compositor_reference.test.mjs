import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStreakMask,
  compositeSelectedStreaks,
  InvalidStreakCompositeInput,
} from '../streak_compositor_reference.mjs';

function makeFlatRgb(width, height, r, g, b) {
  const rgb = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgb[pixel * 3] = r;
    rgb[pixel * 3 + 1] = g;
    rgb[pixel * 3 + 2] = b;
  }
  return { width, height, rgb };
}

function makeStreak(x0, y0, x1, y1, width = 2) {
  return { endpoints: [{ x: x0, y: y0 }, { x: x1, y: y1 }], width };
}

test('rejects mismatched dimensions between background and foreground', () => {
  const background = makeFlatRgb(10, 10, 0, 0, 0);
  const foreground = makeFlatRgb(5, 5, 0, 0, 0);
  assert.throws(
    () => compositeSelectedStreaks({
      background, foreground, streaks: [makeStreak(0, 0, 1, 1)],
    }),
    InvalidStreakCompositeInput,
  );
});

test('rejects an empty streak selection', () => {
  const background = makeFlatRgb(10, 10, 0, 0, 0);
  const foreground = makeFlatRgb(10, 10, 1, 1, 1);
  assert.throws(
    () => compositeSelectedStreaks({ background, foreground, streaks: [] }),
    InvalidStreakCompositeInput,
  );
});

test('buildStreakMask marks pixels near the segment, none elsewhere', () => {
  const width = 40;
  const height = 20;
  const streak = makeStreak(5, 10, 35, 10, 2); // horizontal, width 2
  const mask = buildStreakMask({
    width, height, streaks: [streak], paddingPixels: 1,
  });
  // radius = width/2 + padding = 1 + 1 = 2
  // A point directly on the segment must be marked.
  assert.equal(mask[10 * width + 20], 1);
  // A point 2px above the segment (within radius) must be marked.
  assert.equal(mask[8 * width + 20], 1);
  // A point far above the segment must not be marked.
  assert.equal(mask[1 * width + 20], 0);
  // A point far to the left of the segment's start must not be marked.
  assert.equal(mask[10 * width + 0], 0);
});

test('buildStreakMask unions multiple streaks without double-processing', () => {
  const width = 60;
  const height = 60;
  const streaks = [
    makeStreak(5, 5, 15, 5, 2),
    makeStreak(40, 40, 50, 50, 2),
  ];
  const mask = buildStreakMask({ width, height, streaks, paddingPixels: 1 });
  assert.equal(mask[5 * width + 10], 1); // on the first streak
  assert.equal(mask[45 * width + 45], 1); // on the second streak
  assert.equal(mask[30 * width + 30], 0); // between them, untouched
});

test(
  'composites only the masked region; background elsewhere is untouched',
  () => {
    const width = 30;
    const height = 20;
    const background = makeFlatRgb(width, height, 0.1, 0.1, 0.1);
    const foreground = makeFlatRgb(width, height, 9.0, 9.0, 9.0);
    const streak = makeStreak(5, 10, 25, 10, 2);
    const result = compositeSelectedStreaks({
      background, foreground, streaks: [streak], paddingPixels: 1,
    });

    // On the streak: the (much brighter) foreground value should win.
    const onStreak = (10 * width + 15) * 3;
    assert.ok(Math.abs(result.rgb[onStreak] - 9.0) < 1e-6);

    // Far from the streak: the background value must be unchanged.
    const farAway = (2 * width + 2) * 3;
    assert.ok(Math.abs(result.rgb[farAway] - 0.1) < 1e-6);

    // The inputs must not have been mutated.
    assert.ok(Math.abs(background.rgb[onStreak] - 0.1) < 1e-6);
  },
);

test('lighten (max) blending: a dimmer foreground never darkens the background', () => {
  const width = 20;
  const height = 20;
  const background = makeFlatRgb(width, height, 5.0, 5.0, 5.0);
  const foreground = makeFlatRgb(width, height, 0.5, 0.5, 0.5); // dimmer
  const streak = makeStreak(2, 10, 18, 10, 2);
  const result = compositeSelectedStreaks({
    background, foreground, streaks: [streak], paddingPixels: 1,
  });
  const onStreak = (10 * width + 10) * 3;
  // The brighter background value should survive, not be overwritten by
  // the dimmer foreground -- this is what makes it safe to composite a
  // streak that happens to cross a already-bright area (e.g. the Milky
  // Way core) without punching a dark hole in it.
  assert.ok(Math.abs(result.rgb[onStreak] - 5.0) < 1e-6);
});

test('per-channel blending: channels combine independently', () => {
  const width = 10;
  const height = 10;
  const background = makeFlatRgb(width, height, 9.0, 0.1, 0.1);
  const foreground = makeFlatRgb(width, height, 0.1, 9.0, 0.1);
  const streak = makeStreak(1, 5, 8, 5, 2);
  const result = compositeSelectedStreaks({
    background, foreground, streaks: [streak], paddingPixels: 1,
  });
  const onStreak = (5 * width + 4) * 3;
  assert.ok(Math.abs(result.rgb[onStreak] - 9.0) < 1e-6); // red from bg
  assert.ok(Math.abs(result.rgb[onStreak + 1] - 9.0) < 1e-6); // green from fg
  assert.ok(Math.abs(result.rgb[onStreak + 2] - 0.1) < 1e-6); // blue: tied
});

test('a zero-length streak (degenerate endpoints) still produces a small round mask', () => {
  const width = 20;
  const height = 20;
  const streak = makeStreak(10, 10, 10, 10, 4); // both endpoints identical
  const mask = buildStreakMask({
    width, height, streaks: [streak], paddingPixels: 1,
  });
  assert.equal(mask[10 * width + 10], 1);
  // radius = 4/2 + 1 = 3
  assert.equal(mask[10 * width + 13], 1);
  assert.equal(mask[10 * width + 15], 0);
});
