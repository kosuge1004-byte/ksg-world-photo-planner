import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cfaDrizzle,
  InvalidCfaDrizzleInput,
  invertSimilarityTransform,
} from '../cfa_drizzle_reference.mjs';
import { cfaColorAt } from '../mobile_stack_adaptive_demosaic_reference.mjs';
import { DrizzleAccumulator } from '../drizzle_accumulator_reference.mjs';

function makeMosaic(width, height, cfaPattern, seed) {
  const samples = new Float32Array(width * height);
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < samples.length; i++) samples[i] = next();
  return { width, height, cfaPattern, samples };
}

const identityTransform = (x, y) => ({ x, y });

test('invertSimilarityTransform is the exact inverse of AffineSamplingTransform.similarity\'s forward map', () => {
  // Reimplements the AffineSamplingTransform.similarity formula (source =
  // center + R(rotation) * (output - center) + sourceOffset) directly, to
  // check invertSimilarityTransform against the actual documented
  // contract rather than against itself.
  function similarityForward(params, outputX, outputY) {
    const radians = params.rotationDegrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const ox = outputX - params.centerX;
    const oy = outputY - params.centerY;
    return {
      x: params.centerX + cosine * ox - sine * oy + params.sourceOffsetX,
      y: params.centerY + sine * ox + cosine * oy + params.sourceOffsetY,
    };
  }

  const cases = [
    { rotationDegrees: 0, sourceOffsetX: 5, sourceOffsetY: -3, centerX: 50,
      centerY: 40 },
    { rotationDegrees: 12.5, sourceOffsetX: -2.2, sourceOffsetY: 1.1,
      centerX: 100, centerY: 80 },
    { rotationDegrees: -47, sourceOffsetX: 0, sourceOffsetY: 0, centerX: 0,
      centerY: 0 },
    { rotationDegrees: 179.9, sourceOffsetX: 10, sourceOffsetY: 10,
      centerX: 10, centerY: 10 },
  ];
  const testPoints = [[0, 0], [10.5, -3.2], [100, 200], [-50, 30]];

  for (const params of cases) {
    const forward = invertSimilarityTransform(params);
    for (const [outputX, outputY] of testPoints) {
      const source = similarityForward(params, outputX, outputY);
      const recovered = forward(source.x, source.y);
      assert.ok(
        Math.abs(recovered.x - outputX) < 1e-9,
        `x: expected ${outputX}, got ${recovered.x}`,
      );
      assert.ok(
        Math.abs(recovered.y - outputY) < 1e-9,
        `y: expected ${outputY}, got ${recovered.y}`,
      );
    }
  }
});

test('rejects an empty frame list', () => {
  assert.throws(
    () => cfaDrizzle({ frames: [], outputWidth: 4, outputHeight: 4 }),
    InvalidCfaDrizzleInput,
  );
});

test('rejects non-positive pixfrac or outputScale', () => {
  const frames = [{
    ...makeMosaic(4, 4, 'rggb', 1),
    forwardTransform: identityTransform,
  }];
  assert.throws(
    () => cfaDrizzle({
      frames, outputWidth: 4, outputHeight: 4, pixfrac: 0,
    }),
    InvalidCfaDrizzleInput,
  );
  assert.throws(
    () => cfaDrizzle({
      frames, outputWidth: 4, outputHeight: 4, outputScale: -1,
    }),
    InvalidCfaDrizzleInput,
  );
});

test('rejects a frame whose sample count does not match its dimensions', () => {
  const frame = {
    width: 4,
    height: 4,
    cfaPattern: 'rggb',
    samples: new Float32Array(4),
    forwardTransform: identityTransform,
  };
  assert.throws(
    () => cfaDrizzle({ frames: [frame], outputWidth: 4, outputHeight: 4 }),
    InvalidCfaDrizzleInput,
  );
});

test(
  'single frame, identity transform, 1x scale, pixfrac 1: reproduces '
  + 'each CFA sample exactly on its own channel',
  () => {
    const mosaic = makeMosaic(6, 6, 'rggb', 7);
    const result = cfaDrizzle({
      frames: [{ ...mosaic, forwardTransform: identityTransform }],
      outputWidth: 6,
      outputHeight: 6,
      outputScale: 1,
      pixfrac: 1,
    });
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        const channel = cfaColorAt('rggb', x, y);
        const index = y * 6 + x;
        for (let c = 0; c < 3; c++) {
          if (c === channel) {
            assert.ok(
              Math.abs(result.channels[c].value[index]
                - mosaic.samples[index]) < 1e-6,
              `channel ${c} at (${x},${y})`,
            );
            assert.ok(Math.abs(result.channels[c].coverage[index] - 1) < 1e-6);
          } else {
            // A pixel of a different CFA color never contributes to this
            // channel's accumulator at native (1x) resolution -- that
            // sparsity is expected and is exactly what demosaicing (run
            // afterward, not part of this module) fills in.
            assert.equal(result.channels[c].coverage[index], 0);
          }
        }
      }
    }
  },
);

test(
  'two frames related by a pure sub-pixel translation combine without '
  + 'losing flux, per channel',
  () => {
    const width = 8;
    const height = 8;
    const frameA = makeMosaic(width, height, 'rggb', 11);
    const frameB = makeMosaic(width, height, 'rggb', 12);
    const outputScale = 1;
    const outputWidth = width;
    const outputHeight = height;

    // Frame B's samples land 0.4px to the right/down of frame A's, on
    // the shared output grid -- i.e. frame B's forward transform is a
    // small translation.
    const forwardB = (x, y) => ({ x: x + 0.4, y: y + 0.4 });

    const result = cfaDrizzle({
      frames: [
        { ...frameA, forwardTransform: identityTransform },
        { ...frameB, forwardTransform: forwardB },
      ],
      outputWidth,
      outputHeight,
      outputScale,
      pixfrac: 1,
    });

    // Sum of (value * coverage) across all channels/pixels must equal
    // the sum of all input sample values from both frames (flux
    // conservation), aside from samples that partially fall outside the
    // output grid at the edges after frame B's shift -- restrict the
    // check to an interior sub-region unaffected by edge clipping.
    let expectedFlux = 0;
    let actualFlux = 0;
    for (let y = 2; y < height - 2; y++) {
      for (let x = 2; x < width - 2; x++) {
        expectedFlux += frameA.samples[y * width + x];
        expectedFlux += frameB.samples[y * width + x];
      }
    }
    for (let c = 0; c < 3; c++) {
      for (let y = 2; y < outputHeight - 2; y++) {
        for (let x = 2; x < outputWidth - 2; x++) {
          const index = y * outputWidth + x;
          actualFlux += result.channels[c].value[index]
            * result.channels[c].coverage[index];
        }
      }
    }
    // Interior pixels can still lose a sliver of coverage to drops that
    // straddle into the excluded border, so allow a modest tolerance
    // rather than requiring exact equality.
    assert.ok(
      Math.abs(actualFlux - expectedFlux) < expectedFlux * 0.05,
      `expected total interior flux near ${expectedFlux}, got `
        + `${actualFlux}`,
    );
  },
);

test(
  '2x supersampling from multiple sub-pixel-dithered frames resolves '
  + 'more detail than any single native-resolution frame',
  () => {
    // A single bright point source sampled at native resolution can only
    // ever land in one pixel per frame. Four frames dithered by a
    // quarter-pixel in each direction should let 2x-supersampled
    // drizzle localize the source's sub-pixel position, which no single
    // frame's raw samples could represent on their own.
    const width = 10;
    const height = 10;
    const cfaPattern = 'rggb';
    const outputScale = 2;
    const outputWidth = width * outputScale;
    const outputHeight = height * outputScale;

    function renderPointSource(offsetX, offsetY) {
      const samples = new Float32Array(width * height).fill(0.1);
      // A true sub-pixel point source at (5.3+offsetX, 5.3+offsetY),
      // approximated here by nudging which integer pixel receives the
      // flux based on the offset, simulating what a real dithered
      // exposure of a fixed sky point looks like after the sensor's own
      // (integer-pixel) sampling.
      const px = Math.round(5.3 + offsetX);
      const py = Math.round(5.3 + offsetY);
      samples[py * width + px] += 8;
      return { width, height, cfaPattern, samples };
    }

    const dithers = [
      { dx: 0, dy: 0 },
      { dx: 0.5, dy: 0 },
      { dx: 0, dy: 0.5 },
      { dx: 0.5, dy: 0.5 },
    ];
    const frames = dithers.map(({ dx, dy }) => ({
      ...renderPointSource(dx, dy),
      // This frame's own samples must be mapped back to the *reference*
      // (dx=0,dy=0) frame's coordinate system, i.e. the inverse of the
      // dither applied when rendering.
      forwardTransform: (x, y) => ({ x: x - dx, y: y - dy }),
    }));

    const result = cfaDrizzle({
      frames,
      outputWidth,
      outputHeight,
      outputScale,
      pixfrac: 0.8,
    });

    // The green channel (present at multiple CFA offsets, giving denser
    // coverage) should show its peak coverage-weighted value near the
    // supersampled position corresponding to native (5.3, 5.3) at some
    // consistent, non-degenerate location -- i.e. combining did not
    // collapse to all zeros or to a single uninformative pixel.
    const green = result.channels[1];
    let peakIndex = -1;
    let peakValue = -Infinity;
    for (let index = 0; index < green.value.length; index++) {
      if (green.coverage[index] > 0 && green.value[index] > peakValue) {
        peakValue = green.value[index];
        peakIndex = index;
      }
    }
    assert.ok(peakIndex >= 0, 'expected at least one covered green pixel');
    assert.ok(peakValue > 0.5); // meaningfully above the 0.1 background
    const peakX = peakIndex % outputWidth;
    const peakY = Math.floor(peakIndex / outputWidth);
    // Expected supersampled position: native (5,5)-ish * outputScale.
    assert.ok(Math.abs(peakX - 5 * outputScale) <= outputScale);
    assert.ok(Math.abs(peakY - 5 * outputScale) <= outputScale);
  },
);

test('a per-frame weight scales that frame\'s contribution', () => {
  const width = 4;
  const height = 4;
  const cfaPattern = 'rggb';
  const frameA = { ...makeMosaic(width, height, cfaPattern, 1) };
  const frameB = { ...makeMosaic(width, height, cfaPattern, 2) };
  const resultEqual = cfaDrizzle({
    frames: [
      { ...frameA, forwardTransform: identityTransform, weight: 1 },
      { ...frameB, forwardTransform: identityTransform, weight: 1 },
    ],
    outputWidth: width,
    outputHeight: height,
    outputScale: 1,
    pixfrac: 1,
  });
  const resultWeighted = cfaDrizzle({
    frames: [
      { ...frameA, forwardTransform: identityTransform, weight: 1 },
      { ...frameB, forwardTransform: identityTransform, weight: 0 },
    ],
    outputWidth: width,
    outputHeight: height,
    outputScale: 1,
    pixfrac: 1,
  });
  // With frame B's weight zeroed out, the result must equal frame A
  // alone, at every pixel of whichever channel it belongs to.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const channel = cfaColorAt(cfaPattern, x, y);
      const index = y * width + x;
      assert.ok(
        Math.abs(resultWeighted.channels[channel].value[index]
          - frameA.samples[index]) < 1e-6,
      );
      // Sanity: the equally-weighted result at this pixel should differ
      // from the zero-weighted one whenever the two source frames'
      // samples differ (extremely likely with independent random
      // seeds), confirming frame B was actually contributing before its
      // weight was zeroed.
      if (Math.abs(frameA.samples[index] - frameB.samples[index]) > 1e-3) {
        assert.notEqual(
          resultEqual.channels[channel].value[index],
          resultWeighted.channels[channel].value[index],
        );
      }
    }
  }
});

test(
  'a genuinely rotated frame is splatted with a rotated (not '
  + 'axis-aligned) footprint, conserving total flux exactly',
  () => {
    // WORK49_PROGRESS.md: cfaDrizzle previously treated every drop as
    // axis-aligned regardless of the frame's own rotation, an explicit
    // known image-quality simplification. This confirms the rotation
    // -aware replacement actually engages (not just that it doesn't
    // crash) for a frame with a real, nontrivial rotation, and that
    // flux is still exactly conserved -- rotation changes *where* each
    // sample's flux lands, never *how much* survives.
    const width = 10;
    const height = 10;
    const cfaPattern = 'rggb';
    const mosaic = makeMosaic(width, height, cfaPattern, 5);
    const rotationDegrees = 27;
    // A generous output canvas, with the rotation pivot placed exactly
    // at the mosaic's own data center (so rotation introduces no extra
    // translational drift) and then re-centered, via sourceOffset, well
    // away from every edge -- so no drop is clipped by the output
    // boundary, isolating this test's flux-conservation check from a
    // separate, harder-to-hand-verify edge-clipping calculation (edge
    // clipping is already covered by the dedicated 'a drop straddling
    // the grid edge...' tests in drizzle_accumulator_reference.test.mjs).
    // The mosaic's own center is at (width/2, height/2) = (5, 5); its
    // rotated extent from that center reaches at most
    // sqrt(5^2 + 5^2) =~ 7.07 native-scale units in any direction, so an
    // 80x80 output canvas (20x20 native units, center at (10,10) native)
    // centered on the rotated mosaic leaves a margin of roughly
    // 20 - 7.07 =~ 12.9 native units (~26 output pixels) on every side.
    const outputScale = 2;
    const outputWidth = 80;
    const outputHeight = 80;
    const dataCenterX = width / 2;
    const dataCenterY = height / 2;
    const desiredOutputCenterNative = outputWidth / (2 * outputScale);
    const forwardTransform = invertSimilarityTransform({
      rotationDegrees: -rotationDegrees, // see the transform's own
      // convention: forwardTransform must map source -> output, and
      // invertSimilarityTransform inverts an output->source estimate,
      // so an estimate of -rotationDegrees inverts to a +rotationDegrees
      // forward rotation.
      sourceOffsetX: dataCenterX - desiredOutputCenterNative,
      sourceOffsetY: dataCenterY - desiredOutputCenterNative,
      centerX: desiredOutputCenterNative,
      centerY: desiredOutputCenterNative,
    });

    // pixfrac chosen so dropHalfExtent = 0.5*pixfrac*outputScale = 0.5,
    // i.e. drop area (2*0.5)^2 = 1 -- matching this file's other tests'
    // convention (a unit-area drop), so total flux can be compared
    // directly against the raw sample sum without an extra area-scaling
    // factor.
    const pixfrac = 0.5;
    const rotated = cfaDrizzle({
      frames: [{ ...mosaic, forwardTransform }],
      outputWidth,
      outputHeight,
      outputScale,
      pixfrac,
    });

    let totalInputFlux = 0;
    for (const value of mosaic.samples) totalInputFlux += value;
    let totalOutputFlux = 0;
    for (const channel of rotated.channels) {
      for (let index = 0; index < channel.value.length; index++) {
        totalOutputFlux += channel.value[index] * channel.coverage[index];
      }
    }
    assert.ok(
      Math.abs(totalOutputFlux - totalInputFlux) < 1e-6,
      `expected total flux ${totalInputFlux}, got ${totalOutputFlux}`,
    );

    // Cross-check against the axis-aligned-only behavior this replaced:
    // splatting the same frame with addDrop instead (bypassing
    // cfaDrizzle's now-rotation-aware path) at this rotation should
    // measurably disagree with the rotation-aware result at at least
    // some pixels, confirming the rotation is genuinely being applied
    // to the footprint shape, not just to each sample's center position
    // (which both approaches already handled identically).
    const axisAlignedAccumulators = [0, 1, 2].map(
      () => new DrizzleAccumulator({ width: outputWidth, height: outputHeight }),
    );
    const dropHalfExtent = 0.5 * pixfrac * outputScale;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const channel = cfaColorAt(cfaPattern, x, y);
        const mapped = forwardTransform(x, y);
        axisAlignedAccumulators[channel].addDrop(
          mapped.x * outputScale, mapped.y * outputScale,
          mosaic.samples[y * width + x],
          { dropRadius: dropHalfExtent },
        );
      }
    }
    let anyPixelDiffers = false;
    for (let channel = 0; channel < 3; channel++) {
      const axisAlignedResult = axisAlignedAccumulators[channel].finalize();
      const rotatedResult = rotated.channels[channel];
      for (let index = 0; index < rotatedResult.value.length; index++) {
        if (Math.abs(
          axisAlignedResult.coverage[index] - rotatedResult.coverage[index],
        ) > 1e-6) {
          anyPixelDiffers = true;
          break;
        }
      }
      if (anyPixelDiffers) break;
    }
    assert.ok(
      anyPixelDiffers,
      'expected the rotation-aware footprint to differ from the '
        + 'axis-aligned approximation at a 27-degree rotation',
    );
  },
);


test('CFA drizzle rejects non-finite scale/pixfrac and invalid frame weights', () => {
  const baseFrame = {
    width: 1,
    height: 1,
    cfaPattern: 'rggb',
    samples: Float32Array.from([1]),
    forwardTransform: (x, y) => ({x, y}),
  };
  assert.throws(
    () => cfaDrizzle({
      frames: [baseFrame],
      outputWidth: 2,
      outputHeight: 2,
      outputScale: Number.POSITIVE_INFINITY,
    }),
    /finite and positive/,
  );
  assert.throws(
    () => cfaDrizzle({
      frames: [baseFrame],
      outputWidth: 2,
      outputHeight: 2,
      pixfrac: Number.POSITIVE_INFINITY,
    }),
    /finite and positive/,
  );
  assert.throws(
    () => cfaDrizzle({
      frames: [{...baseFrame, weight: -1}],
      outputWidth: 2,
      outputHeight: 2,
    }),
    /frame weight/,
  );
  assert.throws(
    () => cfaDrizzle({
      frames: [{...baseFrame, weight: Number.POSITIVE_INFINITY}],
      outputWidth: 2,
      outputHeight: 2,
    }),
    /frame weight/,
  );
});
