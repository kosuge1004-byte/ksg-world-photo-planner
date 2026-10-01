import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidBicubicInput,
  sampleBicubicPlane,
  sampleBicubicRgb,
} from '../bicubic_interpolation_reference.mjs';

function makePlane(width, height, fill) {
  const samples = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      samples[y * width + x] = fill(x, y);
    }
  }
  return { width, height, samples };
}

test(
  'exactly reproduces the original sample at every integer grid '
  + 'position (the defining property of an interpolating spline, not '
  + 'an approximating one)',
  () => {
    const plane = makePlane(
      10, 10, (x, y) => Math.sin(x) * Math.cos(y) + x * 0.3,
    );
    for (let y = 1; y < 9; y++) {
      for (let x = 1; x < 9; x++) {
        const interpolated = sampleBicubicPlane(plane, x, y);
        const original = plane.samples[y * plane.width + x];
        assert.ok(
          Math.abs(interpolated - original) < 1e-9,
          `(${x},${y}): expected ${original}, got ${interpolated}`,
        );
      }
    }
  },
);

test('exactly reproduces a linear ramp at any fractional position', () => {
  // A cubic spline can represent any polynomial of degree <= 3 exactly;
  // a linear ramp (degree 1) is the simplest meaningful check that the
  // formula's coefficients are correct, not just that it passes through
  // the sample points themselves.
  const plane = makePlane(10, 10, (x, y) => 2 * x + 3 * y + 5);
  for (const [x, y] of [[3.3, 4.7], [1.1, 1.1], [5.5, 5.5], [2.25, 6.75]]) {
    const interpolated = sampleBicubicPlane(plane, x, y);
    const expected = 2 * x + 3 * y + 5;
    assert.ok(
      Math.abs(interpolated - expected) < 1e-9,
      `(${x},${y}): expected ${expected}, got ${interpolated}`,
    );
  }
});

test(
  'exactly reproduces a quadratic function at any fractional position',
  () => {
    // Degree 2 is also within a cubic spline's exact-representation
    // range.
    const plane = makePlane(12, 12, (x, y) => x * x - 2 * y * y + x * y);
    for (const [x, y] of [[4.3, 3.7], [6.6, 2.2]]) {
      const interpolated = sampleBicubicPlane(plane, x, y);
      const expected = x * x - 2 * y * y + x * y;
      assert.ok(
        Math.abs(interpolated - expected) < 1e-6,
        `(${x},${y}): expected ${expected}, got ${interpolated}`,
      );
    }
  },
);

test('a constant plane interpolates to that same constant everywhere', () => {
  const plane = makePlane(8, 8, () => 4.5);
  for (const [x, y] of [[0, 0], [3.5, 3.5], [7, 7], [0.01, 6.99]]) {
    assert.ok(Math.abs(sampleBicubicPlane(plane, x, y) - 4.5) < 1e-9);
  }
});

test(
  'edge positions clamp to the nearest valid sample, not out of bounds',
  () => {
    const plane = makePlane(5, 5, (x, y) => x + y);
    // Just outside the plane on every side; should not throw and should
    // stay close to the nearest edge value (clamped neighborhood).
    const nearTopLeft = sampleBicubicPlane(plane, -0.5, -0.5);
    const nearBottomRight = sampleBicubicPlane(plane, 4.5, 4.5);
    assert.ok(Number.isFinite(nearTopLeft));
    assert.ok(Number.isFinite(nearBottomRight));
    assert.ok(nearTopLeft < 2); // near the (0,0) corner, value is low
    assert.ok(nearBottomRight > 6); // near the (4,4) corner, high
  },
);

test('sampleBicubicRgb interpolates each channel independently', () => {
  const width = 6;
  const height = 6;
  const interleavedRgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      interleavedRgb[index] = x; // R: horizontal ramp
      interleavedRgb[index + 1] = y; // G: vertical ramp
      interleavedRgb[index + 2] = 1; // B: constant
    }
  }
  const frame = { width, height, interleavedRgb };
  const [r, g, b] = sampleBicubicRgb(frame, 2.5, 3.5);
  assert.ok(Math.abs(r - 2.5) < 1e-9);
  assert.ok(Math.abs(g - 3.5) < 1e-9);
  assert.ok(Math.abs(b - 1) < 1e-9);
});

test(
  'quantified precision improvement over bilinear: a synthetic '
  + "Gaussian star's FWHM widens less under bicubic resampling at the "
  + 'worst-case sub-pixel offset (this is the measurement that '
  + 'motivated adding this module -- see WORK57_PROGRESS.md)',
  () => {
    function bilinearSample(plane, x, y) {
      const { width, height, samples } = plane;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = x - x0;
      const fy = y - y0;
      const v00 = samples[y0 * width + x0];
      const v10 = samples[y0 * width + x1];
      const v01 = samples[y1 * width + x0];
      const v11 = samples[y1 * width + x1];
      return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy)
        + v01 * (1 - fx) * fy + v11 * fx * fy;
    }

    function renderGaussianStar(width, height, cx, cy, sigma) {
      return makePlane(width, height, (x, y) => {
        const dx = x - cx;
        const dy = y - cy;
        return Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      });
    }

    function measureFwhm(sampleFn, plane, peakX, peakY, peakValue) {
      const halfMax = peakValue / 2;
      let leftEdge = peakX;
      let rightEdge = peakX;
      for (let d = 0; d < 10; d += 0.01) {
        if (sampleFn(plane, peakX - d, peakY) < halfMax) {
          leftEdge = peakX - d;
          break;
        }
      }
      for (let d = 0; d < 10; d += 0.01) {
        if (sampleFn(plane, peakX + d, peakY) < halfMax) {
          rightEdge = peakX + d;
          break;
        }
      }
      return rightEdge - leftEdge;
    }

    function findPeak(sampleFn, plane, roughX, roughY) {
      let peakValue = -Infinity;
      let peakX = roughX;
      let peakY = roughY;
      for (let sy = roughY - 5; sy <= roughY + 5; sy += 0.05) {
        for (let sx = roughX - 5; sx <= roughX + 5; sx += 0.05) {
          const v = sampleFn(plane, sx, sy);
          if (v > peakValue) {
            peakValue = v;
            peakX = sx;
            peakY = sy;
          }
        }
      }
      return { peakValue, peakX, peakY };
    }

    const width = 40;
    const height = 40;
    const sigma = 1.3;
    // Worst-case offset: the star centered exactly between four pixels,
    // where bilinear interpolation's smoothing effect is strongest.
    const cx = 20.5;
    const cy = 20.5;
    const plane = renderGaussianStar(width, height, cx, cy, sigma);
    const theoreticalFwhm = 2 * Math.sqrt(2 * Math.log(2)) * sigma;

    const bilinearPeak = findPeak(bilinearSample, plane, 20, 20);
    const bilinearFwhm = measureFwhm(
      bilinearSample, plane, bilinearPeak.peakX, bilinearPeak.peakY,
      bilinearPeak.peakValue,
    );

    const bicubicPeak = findPeak(sampleBicubicPlane, plane, 20, 20);
    const bicubicFwhm = measureFwhm(
      sampleBicubicPlane, plane, bicubicPeak.peakX, bicubicPeak.peakY,
      bicubicPeak.peakValue,
    );

    const bilinearError = Math.abs(bilinearFwhm - theoreticalFwhm);
    const bicubicError = Math.abs(bicubicFwhm - theoreticalFwhm);

    assert.ok(
      bicubicError < bilinearError,
      `expected bicubic FWHM error (${bicubicError.toFixed(4)}) to be `
        + `smaller than bilinear's (${bilinearError.toFixed(4)})`,
    );
    // The measured improvement at development time was roughly a 4x
    // reduction in FWHM widening (107% -> 103% of the true value);
    // require at least a 2x reduction here to leave headroom for minor
    // floating-point/implementation differences while still confirming
    // the improvement is real and substantial, not marginal.
    assert.ok(
      bicubicError < bilinearError / 2,
      `expected at least a 2x reduction in FWHM error; got `
        + `bilinear=${bilinearError.toFixed(4)}, `
        + `bicubic=${bicubicError.toFixed(4)}`,
    );
  },
);

test('rejects invalid plane dimensions', () => {
  assert.throws(
    () => sampleBicubicPlane(
      { width: 0, height: 5, samples: new Float32Array(0) },
      0,
      0,
    ),
    InvalidBicubicInput,
  );
  assert.throws(
    () => sampleBicubicPlane(
      { width: 3, height: 3, samples: new Float32Array(5) },
      0,
      0,
    ),
    InvalidBicubicInput,
  );
});

test('rejects non-finite coordinates', () => {
  const plane = makePlane(5, 5, () => 1);
  assert.throws(
    () => sampleBicubicPlane(plane, NaN, 1),
    InvalidBicubicInput,
  );
  assert.throws(
    () => sampleBicubicPlane(plane, 1, Infinity),
    InvalidBicubicInput,
  );
});

test('rejects invalid RGB frame dimensions', () => {
  assert.throws(
    () => sampleBicubicRgb(
      { width: 2, height: 2, interleavedRgb: new Float32Array(5) },
      0,
      0,
    ),
    InvalidBicubicInput,
  );
});
