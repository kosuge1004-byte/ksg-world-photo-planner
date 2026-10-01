import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStreakCandidates } from '../streak_candidate_detector_reference.mjs';

/// Parallel investigation to `star_detector_noise_robustness.test.mjs`
/// (see WORK44_PROGRESS.md), but for the meteor mode's streak detector:
/// can realistic sensor noise be misidentified as a streak candidate?
///
/// This detector has no direct equivalent of the star detector's
/// `sharpness` gate (streaks are supposed to be elongated, so a
/// concentration-in-3x3 metric doesn't apply the same way), so the
/// specific failure mode explored here is different: whether scattered
/// above-threshold noise pixels can, via the connected-component flood
/// fill (`labelConnectedComponents`), chain together by chance into a
/// region that accidentally clears `minLength`, `minElongation`,
/// `minPixelCount`, and the Work43 necking gate all at once.

function makeBlankPlane(width, height, backgroundValue) {
  return {
    width,
    height,
    samples: new Float32Array(width * height).fill(backgroundValue),
  };
}

/// Same Gaussian (Box-Muller) read-noise model as
/// `star_detector_noise_robustness.test.mjs`, duplicated deliberately
/// rather than imported — see `streak_candidate_detector_reference.mjs`'s
/// own note on duplicating the background-statistics helper for the same
/// reason: keeping each detector's noise-robustness tests independently
/// tunable without coupling.
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

function addRandomWarmPixels(plane, count, minAmplitude, maxAmplitude, seed) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) {
    const x = Math.floor(next() * plane.width);
    const y = Math.floor(next() * plane.height);
    const amplitude = minAmplitude + next() * (maxAmplitude - minAmplitude);
    plane.samples[y * plane.width + x] += amplitude;
  }
}

test(
  'pure Gaussian read noise, no streaks and no warm pixels, produces no '
  + 'false streak candidates',
  () => {
    const width = 200;
    const height = 200;
    let totalFalsePositives = 0;
    const seeds = [1, 2, 3, 4, 5];
    for (const seed of seeds) {
      const plane = makeBlankPlane(width, height, 0.15);
      addGaussianReadNoise(plane, 0.01, seed);
      totalFalsePositives += detectStreakCandidates(plane).length;
    }
    assert.equal(
      totalFalsePositives,
      0,
      `expected zero false streak candidates across ${seeds.length} `
        + `${width}x${height} noise-only trials, got `
        + `${totalFalsePositives}`,
    );
  },
);

test(
  'many scattered single-pixel warm/hot pixels do not chain into a '
  + 'false streak, across a range of warm-pixel densities',
  () => {
    // Sweeps warm-pixel count, since the risk this test targets (random
    // pixels happening to chain into an elongated connected component)
    // is inherently density-dependent -- a single density either
    // passing or failing wouldn't characterize where, if anywhere, the
    // risk actually starts.
    const width = 200;
    const height = 200;
    for (const warmPixelCount of [20, 60, 150, 400]) {
      let falsePositives = 0;
      for (const seed of [10, 20, 30]) {
        const plane = makeBlankPlane(width, height, 0.15);
        addGaussianReadNoise(plane, 0.01, seed);
        addRandomWarmPixels(
          plane, warmPixelCount, 3.0, 15.0, seed * 7919,
        );
        falsePositives += detectStreakCandidates(plane).length;
      }
      assert.equal(
        falsePositives,
        0,
        `warmPixelCount=${warmPixelCount}: expected zero false streak `
          + `candidates across 3 trials, got ${falsePositives}`,
      );
    }
  },
);

test(
  'even a very dense field of SINGLE-PIXEL warm pixels stays safe -- a '
  + 'lone pixel spike is too small to bridge into a 15px+ elongated '
  + 'region no matter how many are scattered (contrast with the '
  + 'BLURRED-defect finding below)',
  () => {
    // Pushes warm-pixel density much higher (order of a percent of all
    // pixels) to find where, if anywhere, this risk actually manifests,
    // rather than only testing densities already known to be safe. High
    // densities are not entirely unrealistic for a severely
    // under-cooled sensor at extreme ISO, though most real astro
    // photography would apply dark-frame subtraction before this stage
    // even reaches such conditions.
    const width = 150;
    const height = 150;
    const results = [];
    for (const warmPixelCount of [500, 1000, 2000, 4000]) {
      let falsePositives = 0;
      for (const seed of [100, 200]) {
        const plane = makeBlankPlane(width, height, 0.15);
        addGaussianReadNoise(plane, 0.01, seed);
        addRandomWarmPixels(plane, warmPixelCount, 3.0, 15.0, seed * 13);
        falsePositives += detectStreakCandidates(plane).length;
      }
      const density = warmPixelCount / (width * height);
      results.push({ warmPixelCount, density, falsePositives });
    }
    // eslint-disable-next-line no-console
    console.log(
      'streak detector false-positive rate vs. warm-pixel density:',
      JSON.stringify(results),
    );
    // At the densities tested here (up to ~18% of all pixels being warm
    // -- already far beyond any plausible real sensor condition prior
    // to dark-frame calibration), the connected-component approach
    // should not produce a meaningful false-positive rate, since random
    // warm pixels this sparse relative to a 15px minLength requirement
    // are extremely unlikely to chain into a sufficiently long, thin,
    // uniform-width run by chance. This is reported for visibility
    // rather than silently passed, so a future change to the detector's
    // gates that shifts this boundary is noticed.
    for (const result of results) {
      assert.ok(
        result.falsePositives <= 2,
        `density=${(result.density * 100).toFixed(1)}%: expected a low `
          + `false-positive count, got ${result.falsePositives}`,
      );
    }
  },
);

test(
  'a moderate density of BLURRED (not single-pixel) warm pixels is a '
  + 'real, only partially-mitigated risk -- characterized honestly, not '
  + 'hidden behind a reassuring pass',
  () => {
    // The single-pixel warm-pixel tests above stay clean at any tested
    // density because a lone pixel spike is too small, on its own, to
    // ever satisfy minPixelCount/minLength even chained together --
    // there simply isn't enough connected area. A *blurred* defect
    // (charge diffused into a small neighborhood, matching Work44's
    // finding that this is realistic sensor behavior, not a
    // contrivance) is a different story: several of them, at a specific
    // density band, chain into elongated multi-lobe regions that are
    // wide enough and long enough to pass minLength/minElongation, and
    // whose necks (per Work43's gate) are not always thin enough
    // relative to the lobes to be rejected outright.
    //
    // A density sweep (not committed here, but summarized in
    // WORK45_PROGRESS.md) found the worst band around 0.9%-3.1% pixel
    // density of blurSigma=1.0 defects: very low density rarely bridges
    // at all, and very high density over-merges into large, roughly
    // round blobs that the elongation gate itself rejects -- the
    // vulnerability is specifically in between.
    const width = 150;
    const height = 150;
    const blurredWarmPixelCount = 500; // ~2.2% density, near the worst band
    let withoutGateCount = 0;
    let withGateCount = 0;
    for (const seed of [1, 2, 3]) {
      const plane = makeBlankPlane(width, height, 0.15);
      addGaussianReadNoise(plane, 0.01, seed);
      addBlurredWarmPixels(
        plane, blurredWarmPixelCount, 4.0, 10.0, 1.0, seed * 17,
      );
      withoutGateCount += detectStreakCandidates(plane, {
        minWidthUniformity: 0,
      }).length;
      withGateCount += detectStreakCandidates(plane).length;
    }
    // The necking gate must provide *some* real mitigation (this is not
    // a "the gate does nothing here" finding)...
    assert.ok(
      withGateCount < withoutGateCount,
      'expected the necking gate to reduce the false-positive count at '
        + `this density; got ${withGateCount} with the gate vs. `
        + `${withoutGateCount} without it`,
    );
    // ...but this test intentionally does NOT assert withGateCount is
    // low or zero: at this density, it isn't, and asserting otherwise
    // would either make this test flaky (masking the real variance
    // across seeds) or require tuning minWidthUniformity/minLength
    // tighter without real-photo data to justify the new boundary (see
    // Work43's identical judgment call for the two-point-source case).
    // eslint-disable-next-line no-console
    console.log(
      `blurred-warm-pixel moderate-density false positives: `
        + `${withGateCount} with the necking gate, ${withoutGateCount} `
        + 'without it (out of 3 seeded trials)',
    );
  },
);

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
  }
}

test(
  'a genuine dim streak is still found amid realistic background noise '
  + '(the gates must not overcorrect)',
  () => {
    const width = 150;
    const height = 60;
    const plane = makeBlankPlane(width, height, 0.15);
    addGaussianReadNoise(plane, 0.01, 555);
    const x0 = 15;
    const y0 = 30;
    const x1 = 135;
    const y1 = 34;
    const stepPx = 0.35;
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(length / stepPx));
    const crossSigma = 1.2;
    const radius = Math.ceil(3 * crossSigma);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = Math.round(cx) + dx;
          const y = Math.round(cy) + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const ox = x - cx;
          const oy = y - cy;
          const value = 2.5
            * Math.exp(-(ox * ox + oy * oy) / (2 * crossSigma * crossSigma))
            * (stepPx / crossSigma);
          plane.samples[y * width + x] += value;
        }
      }
    }
    const candidates = detectStreakCandidates(plane);
    assert.equal(
      candidates.length,
      1,
      'expected the genuine dim streak to still be found amid realistic '
        + 'background noise',
    );
    assert.ok(Math.abs(candidates[0].centroidX - 75) < 3);
  },
);
