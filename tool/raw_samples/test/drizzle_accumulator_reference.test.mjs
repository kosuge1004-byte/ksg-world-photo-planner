import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DrizzleAccumulator,
  InvalidDrizzleInput,
} from '../drizzle_accumulator_reference.mjs';

test('rejects non-positive or non-integer dimensions', () => {
  assert.throws(
    () => new DrizzleAccumulator({ width: 0, height: 10 }),
    InvalidDrizzleInput,
  );
  assert.throws(
    () => new DrizzleAccumulator({ width: 10.5, height: 10 }),
    InvalidDrizzleInput,
  );
});

test(
  'pixfrac 1, no sub-pixel shift, 1x scale: reproduces the input exactly',
  () => {
    const accumulator = new DrizzleAccumulator({ width: 4, height: 4 });
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        accumulator.addDrop(x, y, (y * 4 + x) + 1, { dropRadius: 0.5 });
      }
    }
    const result = accumulator.finalize();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const index = y * 4 + x;
        assert.ok(
          Math.abs(result.value[index] - ((y * 4 + x) + 1)) < 1e-12,
          `pixel (${x},${y}): expected ${(y * 4 + x) + 1}, got `
            + `${result.value[index]}`,
        );
        assert.ok(Math.abs(result.coverage[index] - 1) < 1e-12);
      }
    }
  },
);

test('splits a horizontally straddled drop proportionally to overlap', () => {
  // A drop centered exactly between two pixel centers (0 and 1) with
  // full pixfrac (dropRadius 0.5) covers [0.25, 1.25) in x -- 0.25 of
  // pixel 0's cell width [ -0.5, 0.5) and 0.75 of pixel 1's cell width
  // [0.5, 1.5). Vertically centered on pixel 0 with full overlap.
  const accumulator = new DrizzleAccumulator({ width: 3, height: 1 });
  accumulator.addDrop(0.75, 0, 8, { dropRadius: 0.5 });
  const result = accumulator.finalize();
  // Overlap with pixel 0 ([-0.5,0.5)): drop spans [0.25,1.25), overlap
  // = 0.5-0.25 = 0.25. Overlap with pixel 1 ([0.5,1.5)): overlap =
  // 1.25-0.5 = 0.75. Total area 1.0 (matches a unit-area drop), so the
  // area-weighted value at each covered pixel equals the input value (8)
  // since finalize() normalizes by accumulated weight.
  assert.ok(Math.abs(result.value[0] - 8) < 1e-12);
  assert.ok(Math.abs(result.value[1] - 8) < 1e-12);
  assert.ok(Math.abs(result.coverage[0] - 0.25) < 1e-12);
  assert.ok(Math.abs(result.coverage[1] - 0.75) < 1e-12);
  assert.equal(result.coverage[2], 0);
});

test('averages two frames with complementary sub-pixel offsets', () => {
  // Two drops of equal value straddling the same boundary from opposite
  // sides should average back to the same value at both pixels, with
  // combined coverage summing to 1 at each (a common dithered-pair
  // sanity check: symmetric dithers should reconstruct a flat field
  // flatly).
  const accumulator = new DrizzleAccumulator({ width: 3, height: 1 });
  accumulator.addDrop(0.75, 0, 10, { dropRadius: 0.5 });
  accumulator.addDrop(0.25, 0, 10, { dropRadius: 0.5 });
  const result = accumulator.finalize();
  assert.ok(Math.abs(result.value[0] - 10) < 1e-12);
  assert.ok(Math.abs(result.value[1] - 10) < 1e-12);
  assert.ok(Math.abs(result.coverage[0] - 1) < 1e-12); // 0.75 + 0.25
  assert.ok(Math.abs(result.coverage[1] - 1) < 1e-12); // 0.25 + 0.75
});

test('conserves total flux across a fractional sub-pixel shift', () => {
  const accumulator = new DrizzleAccumulator({ width: 5, height: 5 });
  let totalInputValue = 0;
  const dropRadius = 0.5;
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 20; i++) {
    const x = 1 + next() * 2; // stays inside the grid with margin
    const y = 1 + next() * 2;
    const value = 1 + next() * 9;
    accumulator.addDrop(x, y, value, { dropRadius });
    totalInputValue += value; // each drop has unit area (dropRadius=0.5)
  }
  const result = accumulator.finalize();
  let totalOutputFlux = 0;
  for (let index = 0; index < result.value.length; index++) {
    totalOutputFlux += result.value[index] * result.coverage[index];
  }
  // valueSum (pre-normalization) is exactly conserved; finalize()
  // re-derives it as value*coverage, so this checks the same identity
  // the accumulator guarantees by construction.
  assert.ok(
    Math.abs(totalOutputFlux - totalInputValue) < 1e-9,
    `expected total flux ${totalInputValue}, got ${totalOutputFlux}`,
  );
});

test('a drop entirely outside the grid contributes nothing, silently', () => {
  const accumulator = new DrizzleAccumulator({ width: 4, height: 4 });
  accumulator.addDrop(-10, -10, 99, { dropRadius: 0.5 });
  accumulator.addDrop(100, 100, 99, { dropRadius: 0.5 });
  const result = accumulator.finalize();
  for (let index = 0; index < result.value.length; index++) {
    assert.equal(result.value[index], 0);
    assert.equal(result.coverage[index], 0);
  }
});

test('a drop straddling the grid edge only contributes its in-bounds part', () => {
  const accumulator = new DrizzleAccumulator({ width: 2, height: 2 });
  // Centered on the top-left pixel's outer corner: half the drop's area
  // is outside the grid entirely.
  accumulator.addDrop(-0.5, -0.5, 4, { dropRadius: 0.5 });
  const result = accumulator.finalize();
  // Only 1/4 of the unit-area drop overlaps pixel (0,0): the quadrant
  // [-0.5,0)x[-0.5,0) intersected with the drop's [-1,0)x[-1,0) extent.
  assert.ok(Math.abs(result.coverage[0] - 0.25) < 1e-12);
  assert.ok(Math.abs(result.value[0] - 4) < 1e-12); // still the input value
  assert.equal(result.coverage[1], 0);
  assert.equal(result.coverage[2], 0);
  assert.equal(result.coverage[3], 0);
});

test('smaller pixfrac (dropRadius) leaves gaps for a single sparse frame', () => {
  const accumulator = new DrizzleAccumulator({ width: 3, height: 3 });
  // A small drop (pixfrac 0.4 -> dropRadius 0.2) centered exactly on a
  // pixel leaves the neighboring pixels completely uncovered by this one
  // sample, unlike a full pixfrac-1 drop which would abut them.
  accumulator.addDrop(1, 1, 7, { dropRadius: 0.2 });
  const result = accumulator.finalize();
  assert.ok(Math.abs(result.value[1 * 3 + 1] - 7) < 1e-12);
  assert.ok(Math.abs(result.coverage[1 * 3 + 1] - 0.16) < 1e-12); // (0.4)^2
  for (let index = 0; index < result.coverage.length; index++) {
    if (index === 1 * 3 + 1) continue;
    assert.equal(result.coverage[index], 0);
  }
});

test('quality weight scales both value and coverage contribution', () => {
  const accumulator = new DrizzleAccumulator({ width: 2, height: 1 });
  accumulator.addDrop(0, 0, 10, { dropRadius: 0.5, weight: 1 });
  accumulator.addDrop(0, 0, 20, { dropRadius: 0.5, weight: 3 });
  const result = accumulator.finalize();
  // Weighted average: (10*1 + 20*3) / (1+3) = 70/4 = 17.5
  assert.ok(Math.abs(result.value[0] - 17.5) < 1e-12);
  assert.ok(Math.abs(result.coverage[0] - 4) < 1e-12);
});

test('addDrops batches multiple samples and skips non-finite entries', () => {
  const accumulator = new DrizzleAccumulator({ width: 3, height: 3 });
  accumulator.addDrops([
    { outputX: 1, outputY: 1, value: 5 },
    { outputX: NaN, outputY: 1, value: 5 }, // skipped
    { outputX: 1, outputY: 1, value: Infinity }, // skipped
    { outputX: 1, outputY: 1, value: 3, weight: 2 },
  ], { dropRadius: 0.5 });
  const result = accumulator.finalize();
  // Two valid unit-area, unit-weight-and-weight-2 drops of the same
  // pixel: (5*1 + 3*2) / (1+2) = 11/3.
  assert.ok(Math.abs(result.value[1 * 3 + 1] - 11 / 3) < 1e-12);
  assert.ok(Math.abs(result.coverage[1 * 3 + 1] - 3) < 1e-12);
});

test('a non-positive dropRadius is skipped rather than throwing', () => {
  const accumulator = new DrizzleAccumulator({ width: 2, height: 2 });
  accumulator.addDrop(0, 0, 5, { dropRadius: 0 });
  accumulator.addDrop(0, 0, 5, { dropRadius: -1 });
  const result = accumulator.finalize();
  for (let index = 0; index < result.coverage.length; index++) {
    assert.equal(result.coverage[index], 0);
  }
});

test(
  'addRotatedDrop with rotationRadians=0 exactly reproduces addDrop, '
  + 'pixel by pixel',
  () => {
    // The image-quality-motivated addRotatedDrop path must be a strict
    // superset of addDrop's behavior at zero rotation, not just
    // approximately similar -- callers switching between the two based
    // on whether a frame's rotation is exactly zero must see identical
    // results.
    let seed = 99;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const width = 6;
    const height = 6;
    const axisAligned = new DrizzleAccumulator({ width, height });
    const rotatedAtZero = new DrizzleAccumulator({ width, height });
    for (let i = 0; i < 15; i++) {
      const x = 1 + next() * (width - 2);
      const y = 1 + next() * (height - 2);
      const value = 1 + next() * 9;
      const dropRadius = 0.3 + next() * 0.4;
      axisAligned.addDrop(x, y, value, { dropRadius });
      rotatedAtZero.addRotatedDrop(x, y, value, {
        rotationRadians: 0, dropRadius,
      });
    }
    const expected = axisAligned.finalize();
    const actual = rotatedAtZero.finalize();
    for (let index = 0; index < expected.value.length; index++) {
      assert.ok(
        Math.abs(expected.coverage[index] - actual.coverage[index]) < 1e-9,
        `pixel ${index}: coverage differs (${expected.coverage[index]} `
          + `vs ${actual.coverage[index]})`,
      );
      assert.ok(
        Math.abs(expected.value[index] - actual.value[index]) < 1e-9,
        `pixel ${index}: value differs (${expected.value[index]} vs `
          + `${actual.value[index]})`,
      );
    }
  },
);

test(
  "addRotatedDrop's overlap area matches an independent numerical "
  + 'integration, at several rotation angles (not a hand-derived '
  + 'geometric shortcut, which is easy to get wrong for a rotated '
  + 'shape -- see WORK49_PROGRESS.md)',
  () => {
    // Independently estimates each touched pixel's overlap fraction
    // with the rotated square by dense point sampling (membership test
    // in *local* drop coordinates: a point is inside the drop iff its
    // rotation-undone offset from the drop center has |x'| <= halfWidth
    // and |y'| <= halfHeight), then compares against the polygon-
    // clipping-based addRotatedDrop's computed coverage. This avoids
    // relying on manually derived diamond-vertex geometry, which this
    // test file's own earlier draft got wrong twice in a row.
    function numericalOverlapArea(
      pixelX, pixelY, dropX, dropY, rotationRadians, halfWidth, halfHeight,
    ) {
      const cosine = Math.cos(rotationRadians);
      const sine = Math.sin(rotationRadians);
      const samplesPerAxis = 200;
      let insideCount = 0;
      for (let sy = 0; sy < samplesPerAxis; sy++) {
        const y = pixelY - 0.5 + (sy + 0.5) / samplesPerAxis;
        for (let sx = 0; sx < samplesPerAxis; sx++) {
          const x = pixelX - 0.5 + (sx + 0.5) / samplesPerAxis;
          const dx = x - dropX;
          const dy = y - dropY;
          // Undo the rotation to test membership in the drop's own
          // (axis-aligned) local frame.
          const localX = dx * cosine + dy * sine;
          const localY = -dx * sine + dy * cosine;
          if (Math.abs(localX) <= halfWidth
              && Math.abs(localY) <= halfHeight) {
            insideCount += 1;
          }
        }
      }
      return insideCount / (samplesPerAxis * samplesPerAxis);
    }

    const width = 6;
    const height = 6;
    const dropX = 3;
    const dropY = 3;
    const halfWidth = 0.8;
    const halfHeight = 0.8;
    for (const rotationDegrees of [0, 20, 45, 63, 90]) {
      const accumulator = new DrizzleAccumulator({ width, height });
      accumulator.addRotatedDrop(dropX, dropY, 1, {
        rotationRadians: rotationDegrees * Math.PI / 180,
        halfWidth,
        halfHeight,
      });
      const result = accumulator.finalize();
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const numerical = numericalOverlapArea(
            x, y, dropX, dropY,
            rotationDegrees * Math.PI / 180, halfWidth, halfHeight,
          );
          const exact = result.coverage[y * width + x];
          assert.ok(
            Math.abs(numerical - exact) < 0.01,
            `rotation=${rotationDegrees}deg, pixel (${x},${y}): `
              + `numerical estimate ${numerical.toFixed(4)} vs exact `
              + `polygon-clip result ${exact.toFixed(4)}`,
          );
        }
      }
    }
  },
);

test(
  'addRotatedDrop at 45 degrees spreads flux beyond the center pixel '
  + "(a real geometric effect, not a bug): the drop's corners reach "
  + 'dropRadius * sqrt(2) from center once rotated, which exceeds a '
  + 'single pixel half-width for dropRadius=0.5',
  () => {
    const accumulator = new DrizzleAccumulator({ width: 5, height: 5 });
    accumulator.addRotatedDrop(2, 2, 8, {
      rotationRadians: Math.PI / 4,
      dropRadius: 0.5,
    });
    const result = accumulator.finalize();
    const at = (x, y) => result.coverage[y * 5 + x];
    // The center and its four edge-adjacent neighbors should each
    // receive some of the diamond's area (by the corner-distance
    // argument in this test's title); the four *diagonal* neighbors
    // should not, since the diamond's reach (0.5*sqrt(2) =~ 0.707) does
    // not extend far enough to reach a diagonal pixel's nearest corner
    // (at Chebyshev distance sqrt(2) =~ 1.414 for dropRadius=0.5's
    // shape).
    assert.ok(at(2, 2) > 0, 'center pixel should have coverage');
    for (const [x, y] of [[1, 2], [3, 2], [2, 1], [2, 3]]) {
      assert.ok(at(x, y) > 0, `edge-adjacent pixel (${x},${y})`);
    }
    for (const [x, y] of [[1, 1], [3, 1], [1, 3], [3, 3]]) {
      assert.ok(
        at(x, y) < 1e-9,
        `diagonal pixel (${x},${y}) should receive no coverage`,
      );
    }
    // By 4-fold rotational symmetry (the drop is square, the rotation
    // is exactly 45 degrees, and the pixel grid is centered on the
    // drop), all four edge-adjacent pixels must receive identical
    // coverage.
    assert.ok(Math.abs(at(1, 2) - at(3, 2)) < 1e-9);
    assert.ok(Math.abs(at(1, 2) - at(2, 1)) < 1e-9);
    assert.ok(Math.abs(at(1, 2) - at(2, 3)) < 1e-9);
    // Total flux still conserved: (2*0.5)^2 = 1 unit of area, value 8.
    let totalFlux = 0;
    for (let index = 0; index < result.value.length; index++) {
      totalFlux += result.value[index] * result.coverage[index];
    }
    assert.ok(Math.abs(totalFlux - 8) < 1e-9);
  },
);

test('addRotatedDrop conserves total flux under rotation, at several angles', () => {
  const dropRadius = 0.5;
  for (const rotationDegrees of [0, 15, 30, 45, 60, 90, 137]) {
    const accumulator = new DrizzleAccumulator({ width: 6, height: 6 });
    let seed = Math.round(rotationDegrees) + 1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let totalInputValue = 0;
    for (let i = 0; i < 10; i++) {
      const x = 1.5 + next() * 3;
      const y = 1.5 + next() * 3;
      const value = 1 + next() * 9;
      accumulator.addRotatedDrop(x, y, value, {
        rotationRadians: rotationDegrees * Math.PI / 180,
        dropRadius,
      });
      totalInputValue += value; // unit-area drop (dropRadius=0.5)
    }
    const result = accumulator.finalize();
    let totalOutputFlux = 0;
    for (let index = 0; index < result.value.length; index++) {
      totalOutputFlux += result.value[index] * result.coverage[index];
    }
    assert.ok(
      Math.abs(totalOutputFlux - totalInputValue) < 1e-9,
      `rotation=${rotationDegrees}deg: expected total flux `
        + `${totalInputValue}, got ${totalOutputFlux}`,
    );
  }
});

test('addRotatedDrop skips non-finite or degenerate input silently', () => {
  const accumulator = new DrizzleAccumulator({ width: 3, height: 3 });
  accumulator.addRotatedDrop(NaN, 1, 5, { rotationRadians: 0.3 });
  accumulator.addRotatedDrop(1, 1, Infinity, { rotationRadians: 0.3 });
  accumulator.addRotatedDrop(1, 1, 5, {
    rotationRadians: NaN, dropRadius: 0.5,
  });
  accumulator.addRotatedDrop(1, 1, 5, { rotationRadians: 0.3, halfWidth: 0 });
  const result = accumulator.finalize();
  for (let index = 0; index < result.coverage.length; index++) {
    assert.equal(result.coverage[index], 0);
  }
});

test(
  'addRotatedDrop with a rotated drop entirely outside the grid '
  + 'contributes nothing',
  () => {
    const accumulator = new DrizzleAccumulator({ width: 4, height: 4 });
    accumulator.addRotatedDrop(-20, -20, 99, {
      rotationRadians: Math.PI / 6,
      dropRadius: 0.5,
    });
    const result = accumulator.finalize();
    for (let index = 0; index < result.value.length; index++) {
      assert.equal(result.value[index], 0);
      assert.equal(result.coverage[index], 0);
    }
  },
);


test('negative weights never subtract scientific Drizzle coverage', () => {
  const accumulator = new DrizzleAccumulator({ width: 3, height: 3 });
  accumulator.addDrop(1, 1, 10, { weight: -1 });
  accumulator.addRotatedDrop(1, 1, 10, { weight: -2 });
  const result = accumulator.finalize();
  assert.ok(Array.from(result.coverage).every((value) => value === 0));
  assert.ok(Array.from(result.value).every((value) => value === 0));
});

test('infinite Drizzle footprint sizes are skipped safely', () => {
  const accumulator = new DrizzleAccumulator({ width: 3, height: 3 });
  accumulator.addDrop(1, 1, 10, { dropRadius: Infinity });
  accumulator.addRotatedDrop(1, 1, 10, {
    halfWidth: Infinity,
    halfHeight: 0.5,
  });
  const result = accumulator.finalize();
  assert.ok(Array.from(result.coverage).every((value) => value === 0));
});
