import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidLightenBlendInput,
  lightenBlendCombineCoveredRgb,
  LightenBlendCancelled,
} from '../lighten_blend_reference.mjs';

function makeFrame(pixelTriples, coverage) {
  return {
    rgb: Float32Array.from(pixelTriples.flat()),
    coverage: Uint8Array.from(coverage),
  };
}

test('rejects an empty frame list', () => {
  assert.throws(
    () => lightenBlendCombineCoveredRgb({ frames: [] }),
    InvalidLightenBlendInput,
  );
});

test('rejects mismatched RGB sample counts between frames', () => {
  const frameA = makeFrame([[1, 1, 1], [2, 2, 2]], [1, 1]);
  const frameB = makeFrame([[1, 1, 1]], [1]);
  assert.throws(
    () => lightenBlendCombineCoveredRgb({ frames: [frameA, frameB] }),
    InvalidLightenBlendInput,
  );
});

test('rejects a coverage array of the wrong length', () => {
  const badFrame = {
    rgb: Float32Array.from([1, 1, 1, 2, 2, 2]),
    coverage: Uint8Array.from([1]), // should be length 2
  };
  assert.throws(
    () => lightenBlendCombineCoveredRgb({ frames: [badFrame] }),
    InvalidLightenBlendInput,
  );
});

test('a single frame passes through unchanged', () => {
  const frame = makeFrame([[10, 20, 30], [1, 2, 3]], [1, 1]);
  const result = lightenBlendCombineCoveredRgb({ frames: [frame] });
  assert.deepEqual(Array.from(result.rgb), [10, 20, 30, 1, 2, 3]);
  assert.deepEqual(Array.from(result.coverage), [1, 1]);
});

test('takes the per-channel maximum across frames (standard lighten blend)', () => {
  const frameA = makeFrame([[10, 5, 100]], [1]);
  const frameB = makeFrame([[3, 50, 20]], [1]);
  const frameC = makeFrame([[7, 8, 9]], [1]);
  const result = lightenBlendCombineCoveredRgb({
    frames: [frameA, frameB, frameC],
  });
  // Each channel's maximum is taken independently, not "pick the
  // brightest frame as a whole" -- this is what makes a star trail
  // trace correctly even as different stars cross the same pixel at
  // different times across the sequence.
  assert.deepEqual(Array.from(result.rgb), [10, 50, 100]);
  assert.deepEqual(Array.from(result.coverage), [3]);
});

test('simulates a star sweeping across three pixels over three frames', () => {
  // Pixel 0 lit in frame 1 only, pixel 1 in frame 2 only, pixel 2 in
  // frame 3 only -- a minimal model of a point source's trail. Lighten
  // blend should trace out the full trail (every pixel keeps its one
  // bright frame), not average it away to a dim streak.
  const background = 0.1;
  const starValue = 5.0;
  const frame1 = makeFrame(
    [[starValue, starValue, starValue],
      [background, background, background],
      [background, background, background]],
    [1, 1, 1],
  );
  const frame2 = makeFrame(
    [[background, background, background],
      [starValue, starValue, starValue],
      [background, background, background]],
    [1, 1, 1],
  );
  const frame3 = makeFrame(
    [[background, background, background],
      [background, background, background],
      [starValue, starValue, starValue]],
    [1, 1, 1],
  );
  const result = lightenBlendCombineCoveredRgb({
    frames: [frame1, frame2, frame3],
  });
  for (let pixel = 0; pixel < 3; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(
        Math.abs(result.rgb[pixel * 3 + channel] - starValue) < 1e-9,
        `pixel ${pixel} channel ${channel} should show the star's peak`,
      );
    }
  }
});

test('a pixel uncovered by any frame reports zero coverage and value', () => {
  const frameA = makeFrame([[10, 10, 10], [5, 5, 5]], [1, 0]);
  const frameB = makeFrame([[20, 20, 20], [8, 8, 8]], [1, 0]);
  const result = lightenBlendCombineCoveredRgb({ frames: [frameA, frameB] });
  assert.deepEqual(Array.from(result.rgb.slice(0, 3)), [20, 20, 20]);
  assert.equal(result.coverage[0], 2);
  assert.deepEqual(Array.from(result.rgb.slice(3, 6)), [0, 0, 0]);
  assert.equal(result.coverage[1], 0);
});

test('minimumCoveringFrames zeroes out under-covered pixels', () => {
  const frameA = makeFrame([[10, 10, 10], [5, 5, 5]], [1, 1]);
  const frameB = makeFrame([[20, 20, 20], [8, 8, 8]], [1, 0]); // pixel 1 only in frame A
  const result = lightenBlendCombineCoveredRgb({
    frames: [frameA, frameB],
    minimumCoveringFrames: 2,
  });
  assert.deepEqual(Array.from(result.rgb.slice(0, 3)), [20, 20, 20]);
  assert.equal(result.coverage[0], 2);
  // Pixel 1 was only covered once, below the threshold of 2.
  assert.deepEqual(Array.from(result.rgb.slice(3, 6)), [0, 0, 0]);
  assert.equal(result.coverage[1], 0);
});

test(
  'keepHighest=2 rejects a single-frame outlier spike that standard '
  + 'lighten blend would keep forever',
  () => {
    const background = 0.2;
    // Five ordinary frames with a modest trail value, plus one frame
    // with an extreme single-frame spike (a stand-in for a cosmic-ray
    // hit or transient hot pixel the defect-pixel stage missed).
    const ordinary = () => makeFrame([[0.5, 0.5, 0.5]], [1]);
    const spike = makeFrame([[99, 99, 99]], [1]);
    const frames = [ordinary(), ordinary(), spike, ordinary(), ordinary(),
      ordinary()];

    const standard = lightenBlendCombineCoveredRgb({ frames });
    assert.deepEqual(Array.from(standard.rgb), [99, 99, 99]);

    const robust = lightenBlendCombineCoveredRgb({
      frames,
      keepHighest: 2,
      minimumCoveringFrames: 2,
    });
    // The 2nd-highest value across the six frames is the ordinary 0.5,
    // not the one-off 99 spike.
    assert.deepEqual(Array.from(robust.rgb), [0.5, 0.5, 0.5]);
    void background;
  },
);

test('keepHighest still traces a trail that persists across >= keepHighest frames', () => {
  // A trail segment elevated in three consecutive frames (a slower-
  // moving or longer-dwelling trail) should still show its peak with
  // keepHighest=2, since two of the three elevated frames support it.
  const frames = [
    makeFrame([[0.1, 0.1, 0.1]], [1]),
    makeFrame([[4.0, 4.0, 4.0]], [1]),
    makeFrame([[4.2, 4.2, 4.2]], [1]),
    makeFrame([[4.1, 4.1, 4.1]], [1]),
    makeFrame([[0.1, 0.1, 0.1]], [1]),
  ];
  const result = lightenBlendCombineCoveredRgb({
    frames,
    keepHighest: 2,
    minimumCoveringFrames: 2,
  });
  // 2nd-highest of {0.1, 4.0, 4.2, 4.1, 0.1} sorted desc: 4.2, 4.1, 4.0,
  // 0.1, 0.1 -> 2nd highest is 4.1.
  for (const value of result.rgb) {
    assert.ok(Math.abs(value - 4.1) < 1e-5, `expected ~4.1, got ${value}`);
  }
});

test('rejects a non-positive or non-integer keepHighest', () => {
  const frame = makeFrame([[1, 1, 1]], [1]);
  assert.throws(
    () => lightenBlendCombineCoveredRgb({ frames: [frame], keepHighest: 0 }),
    InvalidLightenBlendInput,
  );
  assert.throws(
    () => lightenBlendCombineCoveredRgb({
      frames: [frame], keepHighest: 1.5,
    }),
    InvalidLightenBlendInput,
  );
});

test('is cancellable between frames', () => {
  const frame = makeFrame([[1, 1, 1]], [1]);
  let calls = 0;
  assert.throws(
    () => lightenBlendCombineCoveredRgb({
      frames: [frame, frame, frame],
      isCancelled: () => { calls += 1; return calls > 1; },
    }),
    LightenBlendCancelled,
  );
});

test('large synthetic sequence: flat background stays flat, trail traces correctly', () => {
  const width = 20;
  const height = 20;
  const pixelCount = width * height;
  const frameCount = 30;
  const background = 0.15;

  function makeBackgroundFrame() {
    const rgb = new Float32Array(pixelCount * 3).fill(background);
    const coverage = new Uint8Array(pixelCount).fill(1);
    return { rgb, coverage };
  }

  const frames = [];
  const trailPixels = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const frame = makeBackgroundFrame();
    // A star sweeps diagonally across the frame, one pixel per frame.
    const x = frameIndex % width;
    const y = Math.floor(frameIndex / width) % height;
    const pixel = y * width + x;
    trailPixels.push(pixel);
    frame.rgb[pixel * 3] = 3.0;
    frame.rgb[pixel * 3 + 1] = 3.0;
    frame.rgb[pixel * 3 + 2] = 3.0;
    frames.push(frame);
  }

  const result = lightenBlendCombineCoveredRgb({ frames });
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const onTrail = trailPixels.includes(pixel);
    const expected = onTrail ? 3.0 : background;
    assert.ok(
      Math.abs(result.rgb[pixel * 3] - expected) < 1e-5,
      `pixel ${pixel}: expected ${expected}, got ${result.rgb[pixel * 3]}`,
    );
    assert.equal(result.coverage[pixel], frameCount);
  }
});
