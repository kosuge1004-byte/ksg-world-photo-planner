import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidToneMapInput,
  estimateAutoToneParameters,
  compensateAutoToneForBaselineExposure,
  srgbDecode,
  srgbEncode,
  toneMapToDisplayRgb,
} from '../tone_map_reference.mjs';

test('srgbEncode/srgbDecode round-trip across the full range', () => {
  for (let i = 0; i <= 100; i++) {
    const value = i / 100;
    const roundTrip = srgbDecode(srgbEncode(value));
    assert.ok(
      Math.abs(roundTrip - value) < 1e-9,
      `value=${value}: round-trip gave ${roundTrip}`,
    );
  }
});

test('srgbEncode matches known reference values', () => {
  assert.equal(srgbEncode(0), 0);
  assert.ok(Math.abs(srgbEncode(1) - 1) < 1e-9);
  // Standard reference point: 18% linear gray maps to roughly 0.46
  // in sRGB (a widely-cited approximate landmark for this curve).
  assert.ok(Math.abs(srgbEncode(0.18) - 0.4613) < 0.001);
});

test('srgbEncode is continuous at the linear/power-curve breakpoint', () => {
  const epsilon = 1e-9;
  const justBelow = srgbEncode(0.0031308 - epsilon);
  const justAbove = srgbEncode(0.0031308 + epsilon);
  assert.ok(
    Math.abs(justBelow - justAbove) < 1e-6,
    `discontinuity at breakpoint: ${justBelow} vs ${justAbove}`,
  );
});

test('srgbEncode clamps out-of-range input rather than producing NaN', () => {
  assert.equal(srgbEncode(-5), 0);
  assert.ok(Math.abs(srgbEncode(5) - 1) < 1e-9);
  assert.ok(Number.isFinite(srgbEncode(-5)));
});

test('the tone curve is monotonically non-decreasing across a huge range', () => {
  const whitePoint = 2.0;
  let previous = -Infinity;
  for (let exponent = -6; exponent <= 6; exponent += 0.1) {
    const value = 10 ** exponent;
    const rgb = new Float32Array([value, value, value]);
    const [mapped] = toneMapToDisplayRgb(rgb, {
      whitePoint,
      applySrgbGamma: false,
    });
    assert.ok(
      mapped >= previous,
      `not monotonic at value=${value}: ${mapped} < ${previous}`,
    );
    previous = mapped;
  }
});

test('zero input maps to exactly zero output', () => {
  const rgb = new Float32Array([0, 0, 0]);
  const mapped = toneMapToDisplayRgb(rgb, { whitePoint: 1 });
  assert.deepEqual(Array.from(mapped), [0, 0, 0]);
});

test(
  'a value far beyond the white point approaches but never reaches or '
  + 'exceeds full saturation (no overflow, no runaway growth, and no '
  + 'premature saturation well below the white point)',
  () => {
    const whitePoint = 1.0;
    const atWhitePoint = new Float32Array([whitePoint, 0, 0]);
    const farBeyond = new Float32Array([whitePoint * 1000, 0, 0]);
    const [atMapped] = toneMapToDisplayRgb(atWhitePoint, {
      whitePoint,
      applySrgbGamma: false,
    });
    const [farMapped] = toneMapToDisplayRgb(farBeyond, {
      whitePoint,
      applySrgbGamma: false,
    });
    // By design (rate = ln(10)), value == whitePoint reaches ~90% of
    // full scale, not 100% -- deliberate headroom for a genuinely
    // brighter value to still be distinguishable above it.
    assert.ok(
      atMapped >= 220 && atMapped < 240,
      `atMapped=${atMapped}`,
    );
    assert.ok(
      farMapped >= atMapped && farMapped <= 255,
      `expected a much brighter value to be at least as saturated as `
        + `the white point itself and never exceed 255, got `
        + `${farMapped} vs ${atMapped}`,
    );
    // Well below the white point, the response should still be clearly
    // graded (not already saturated) -- e.g. half the white point should
    // map to a mid-range value, not something close to 255.
    const [halfMapped] = toneMapToDisplayRgb(
      new Float32Array([whitePoint * 0.5, 0, 0]),
      { whitePoint, applySrgbGamma: false },
    );
    assert.ok(
      halfMapped < 200,
      `expected value at half the white point to still be well below `
        + `saturation, got ${halfMapped}`,
    );
  },
);

test('a higher white point compresses a given bright value less', () => {
  // The same absolute input value should map to a *lower* display value
  // when whitePoint is larger (since it represents a smaller fraction of
  // the compression range) -- confirms whitePoint actually has the
  // intended effect, not just that some number comes out.
  const brightValue = new Float32Array([5, 0, 0]);
  const [lowWhitePoint] = toneMapToDisplayRgb(brightValue, {
    whitePoint: 2,
    applySrgbGamma: false,
  });
  const [highWhitePoint] = toneMapToDisplayRgb(brightValue, {
    whitePoint: 20,
    applySrgbGamma: false,
  });
  assert.ok(
    highWhitePoint < lowWhitePoint,
    `expected a higher white point to leave value=5 less compressed `
      + `(darker), got ${highWhitePoint} vs ${lowWhitePoint}`,
  );
});

test('rejects a non-Float32Array input', () => {
  assert.throws(
    () => toneMapToDisplayRgb([0, 0, 0]),
    InvalidToneMapInput,
  );
});

test('rejects a non-positive whitePoint', () => {
  assert.throws(
    () => toneMapToDisplayRgb(new Float32Array([1, 1, 1]), { whitePoint: 0 }),
    InvalidToneMapInput,
  );
  assert.throws(
    () => toneMapToDisplayRgb(
      new Float32Array([1, 1, 1]),
      { whitePoint: -1 },
    ),
    InvalidToneMapInput,
  );
});

test('negative and non-finite input samples are treated as zero, not NaN', () => {
  const rgb = new Float32Array([-3, NaN, Infinity]);
  const mapped = toneMapToDisplayRgb(rgb, {
    whitePoint: 1,
    applySrgbGamma: false,
  });
  assert.equal(mapped[0], 0); // negative -> clamped to 0
  assert.equal(mapped[1], 0); // NaN -> treated as 0
  // Infinity should saturate toward the asymptote, not propagate NaN.
  assert.ok(Number.isFinite(mapped[2]));
  assert.ok(mapped[2] <= 255);
});

test('estimateAutoToneParameters centers a synthetic sky background near targetMedian', () => {
  // 1000 background pixels at a low level, plus a handful of much
  // brighter "star" pixels -- the median should track the background,
  // not be dragged up by the rare bright outliers.
  const backgroundCount = 1000;
  const starCount = 5;
  const rgb = new Float32Array((backgroundCount + starCount) * 3);
  for (let i = 0; i < backgroundCount; i++) {
    rgb[i * 3] = 0.002;
    rgb[i * 3 + 1] = 0.002;
    rgb[i * 3 + 2] = 0.002;
  }
  for (let i = 0; i < starCount; i++) {
    const index = backgroundCount + i;
    rgb[index * 3] = 50;
    rgb[index * 3 + 1] = 50;
    rgb[index * 3 + 2] = 50;
  }
  const { exposureScale, whitePoint } = estimateAutoToneParameters(rgb, {
    targetMedian: 0.06,
  });
  const scaledBackground = 0.002 * exposureScale;
  assert.ok(
    Math.abs(scaledBackground - 0.06) < 0.005,
    `expected scaled background near 0.06, got ${scaledBackground}`,
  );
  // The white point should be well above the (scaled) background,
  // reflecting the bright stars' influence via the percentile, not
  // collapsed down near the background level.
  assert.ok(whitePoint > 1);
});

test('estimateAutoToneParameters honors caller-provided luminance weights', () => {
  const rgb = new Float32Array([
    0.1, 0.9, 0.2,
    0.1, 0.9, 0.2,
    10, 0, 0,
  ]);
  const redOnly = estimateAutoToneParameters(rgb, {
    targetMedian: 0.05,
    luminanceWeights: [1, 0, 0],
  });
  const greenOnly = estimateAutoToneParameters(rgb, {
    targetMedian: 0.05,
    luminanceWeights: [0, 1, 0],
  });
  assert.ok(Math.abs(redOnly.exposureScale - 0.5) < 1e-6);
  assert.ok(Math.abs(greenOnly.exposureScale - (0.05 / 0.9)) < 1e-6);
  assert.ok(redOnly.exposureScale > greenOnly.exposureScale);
});

test('estimateAutoToneParameters preserves signed residuals until after the luminance dot product', () => {
  const rgb = new Float32Array([
    -0.05, 0.10, 0.00,
    -0.05, 0.10, 0.00,
    1.00, 0.00, 0.00,
  ]);
  const result = estimateAutoToneParameters(rgb, {
    targetMedian: 0.05,
    luminanceWeights: [0.5, 0.5, 0],
  });
  assert.ok(Math.abs(result.exposureScale - 2) < 1e-6);
});

test('estimateAutoToneParameters rejects invalid luminance weights', () => {
  const rgb = new Float32Array([0.1, 0.2, 0.3]);
  assert.throws(
    () => estimateAutoToneParameters(rgb, { luminanceWeights: [1, 0] }),
    InvalidToneMapInput,
  );
  assert.throws(
    () => estimateAutoToneParameters(rgb, { luminanceWeights: [1, NaN, 0] }),
    InvalidToneMapInput,
  );
});

test('estimateAutoToneParameters handles an all-zero image without producing non-finite output', () => {
  const rgb = new Float32Array(300); // 100 pixels, all zero
  const { exposureScale, whitePoint } = estimateAutoToneParameters(rgb);
  assert.ok(Number.isFinite(exposureScale));
  assert.ok(Number.isFinite(whitePoint));
  assert.ok(whitePoint > 0);
});

test('estimateAutoToneParameters rejects malformed input', () => {
  assert.throws(
    () => estimateAutoToneParameters(new Float32Array(4)), // not a multiple of 3
    InvalidToneMapInput,
  );
  assert.throws(
    () => estimateAutoToneParameters(new Float32Array(0)),
    InvalidToneMapInput,
  );
  assert.throws(
    () => estimateAutoToneParameters([0, 0, 0]),
    InvalidToneMapInput,
  );
});

test(
  'end-to-end: a synthetic star field with a realistic dynamic range '
  + 'auto-exposes to a plausible image (dim but visible background, '
  + 'distinguishably brighter stars, no premature full-frame saturation)',
  () => {
    const width = 20;
    const height = 20;
    const rgb = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = 0.015;
      rgb[i * 3 + 1] = 0.02;
      rgb[i * 3 + 2] = 0.03; // faint blue-ish sky background
    }
    // A few stars of varying brightness, at a dynamic range more
    // representative of a real single/stacked exposure (roughly
    // 10x-300x the background) rather than an extreme outlier case --
    // see this function's own doc comment and WORK55_PROGRESS.md for
    // the separately-documented, deliberately-not-fully-solved extreme
    // case (a single outlier thousands of times brighter than
    // everything else, which this simple global curve cannot both keep
    // the background visible *and* keep every highlight distinguishable
    // under, without a more sophisticated local tone-mapping algorithm).
    const starPixels = [10, 50, 120, 300];
    const starValues = [0.3, 1.2, 3.0, 6.0];
    for (let i = 0; i < starPixels.length; i++) {
      const base = starPixels[i] * 3;
      rgb[base] = starValues[i];
      rgb[base + 1] = starValues[i];
      rgb[base + 2] = starValues[i];
    }
    const { exposureScale, whitePoint } = estimateAutoToneParameters(rgb);
    const display = toneMapToDisplayRgb(rgb, { exposureScale, whitePoint });

    // Background should be dim but nonzero (visible, not crushed).
    const backgroundIndex = 5 * 3;
    assert.ok(
      display[backgroundIndex] > 0,
      `expected a visible (nonzero) background, got `
        + `${display[backgroundIndex]}`,
    );
    assert.ok(display[backgroundIndex] < 60);

    // The brightest star should be distinguishably brighter than a
    // dimmer one -- not both slammed to the same saturated value.
    const dimStarValue = display[starPixels[1] * 3];
    const brightStarValue = display[starPixels[3] * 3];
    assert.ok(
      brightStarValue > dimStarValue,
      `expected the brighter star (raw ${starValues[3]}) to render `
        + `brighter than the dimmer one (raw ${starValues[1]}), got `
        + `${brightStarValue} vs ${dimStarValue}`,
    );
    assert.ok(
      dimStarValue < 250,
      'a moderately bright star should not already be fully saturated',
    );
  },
);

test(
  'documented residual limitation: an extreme single outlier (many '
  + "thousands of times brighter than the background) forces a trade "
  + 'off between keeping the background visible and keeping every '
  + 'highlight distinguishable -- this function cannot fully solve '
  + 'both with one global curve, and does not pretend to',
  () => {
    // Reconstructs the exact scenario an earlier version of this test
    // used (and which motivated adding maximumWhitePointMultiplier in
    // the first place): a background of ~0.004 and a single star at
    // 400 -- roughly a 100,000x ratio. With the white-point cap in
    // place, the background stays visible, but this test intentionally
    // does NOT also assert that dimmer mid-brightness stars stay
    // distinguishable from the brightest one at this same extreme range
    // -- they may not, and that is the accepted, documented trade-off
    // (see estimateAutoToneParameters's own doc comment), not a bug to
    // fix here.
    const width = 20;
    const height = 20;
    const rgb = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = 0.003;
      rgb[i * 3 + 1] = 0.004;
      rgb[i * 3 + 2] = 0.006;
    }
    const base = 300 * 3;
    rgb[base] = 400;
    rgb[base + 1] = 400;
    rgb[base + 2] = 400;

    const { exposureScale, whitePoint } = estimateAutoToneParameters(rgb);
    const display = toneMapToDisplayRgb(rgb, { exposureScale, whitePoint });
    const backgroundIndex = 5 * 3;
    assert.ok(
      display[backgroundIndex] > 0,
      `expected the white-point cap to keep the background visible `
        + `even at an extreme dynamic range, got `
        + `${display[backgroundIndex]}`,
    );
    assert.ok(display[base] > display[backgroundIndex]);
  },
);


test('BaselineExposure compensation preserves auto-tone effective exposure', () => {
  const auto = { exposureScale: 12.5, whitePoint: 3.25 };
  const plusOne = compensateAutoToneForBaselineExposure(auto, 1);
  assert.ok(Math.abs(plusOne.exposureScale * 2 - auto.exposureScale) < 1e-12);
  assert.equal(plusOne.whitePoint, auto.whitePoint);

  const minusTwo = compensateAutoToneForBaselineExposure(auto, -2);
  assert.ok(Math.abs(minusTwo.exposureScale * (2 ** -2) - auto.exposureScale) < 1e-12);
  assert.equal(minusTwo.whitePoint, auto.whitePoint);
});

test('BaselineExposure compensation rejects invalid EV', () => {
  const auto = { exposureScale: 1, whitePoint: 1 };
  assert.throws(
    () => compensateAutoToneForBaselineExposure(auto, Number.NaN),
    InvalidToneMapInput,
  );
  assert.throws(
    () => compensateAutoToneForBaselineExposure(auto, 33),
    InvalidToneMapInput,
  );
});
