import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeLocalStructure,
  DemosaicCancelled,
  cfaColorAt,
  demosaicAdaptiveTile,
} from '../mobile_stack_adaptive_demosaic_reference.mjs';

function mosaicFromRgb(width, height, value) {
  const samples = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      samples[y * width + x] = value(x, y, cfaColorAt('rggb', x, y));
    }
  }
  return { width, height, cfaPattern: 'rggb', samples };
}

function channelAt(tile, x, y, channel) {
  return tile.interleavedRgb[(y * tile.width + x) * 3 + channel];
}

function bilinear(mosaic) {
  const output = new Float32Array(mosaic.width * mosaic.height * 3);
  for (let y = 0; y < mosaic.height; y += 1) {
    for (let x = 0; x < mosaic.width; x += 1) {
      for (let target = 0; target < 3; target += 1) {
        const outputIndex = (y * mosaic.width + x) * 3 + target;
        if (cfaColorAt(mosaic.cfaPattern, x, y) === target) {
          output[outputIndex] = mosaic.samples[y * mosaic.width + x];
          continue;
        }
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const px = Math.max(0, Math.min(mosaic.width - 1, x + dx));
            const py = Math.max(0, Math.min(mosaic.height - 1, y + dy));
            if (cfaColorAt(mosaic.cfaPattern, px, py) === target) {
              sum += mosaic.samples[py * mosaic.width + px];
              count += 1;
            }
          }
        }
        output[outputIndex] = count === 0
          ? mosaic.samples[y * mosaic.width + x]
          : sum / count;
      }
    }
  }
  return output;
}

function mseAgainstTruth(width, height, truthFunction) {
  const truth = new Float32Array(width * height * 3);
  const mosaic = mosaicFromRgb(width, height, (x, y, color) => {
    const rgb = truthFunction(x, y);
    truth.set(rgb, (y * width + x) * 3);
    return rgb[color];
  });
  const actual = demosaicAdaptiveTile(mosaic).interleavedRgb;
  let squaredError = 0;
  let compared = 0;
  for (let y = 4; y < height - 4; y += 1) {
    for (let x = 4; x < width - 4; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const index = (y * width + x) * 3 + channel;
        squaredError += (actual[index] - truth[index]) ** 2;
        compared += 1;
      }
    }
  }
  return squaredError / compared;
}

test('reconstructs constant channel differences through mirrored borders', () => {
  const mosaic = mosaicFromRgb(6, 6, (_x, _y, color) =>
    [0.8, 0.5, 0.2][color]);
  const tile = demosaicAdaptiveTile(mosaic);

  for (let y = 0; y < tile.height; y += 1) {
    for (let x = 0; x < tile.width; x += 1) {
      assert.ok(Math.abs(channelAt(tile, x, y, 0) - 0.8) < 1e-6);
      assert.ok(Math.abs(channelAt(tile, x, y, 1) - 0.5) < 1e-6);
      assert.ok(Math.abs(channelAt(tile, x, y, 2) - 0.2) < 1e-6);
    }
  }
});

test('preserves native negative and above-one CFA samples', () => {
  const mosaic = mosaicFromRgb(6, 6, (x, y, color) => {
    if (x === 2 && y === 2) return 2;
    if (x === 3 && y === 3) return -0.25;
    return [0.8, 0.5, 0.2][color];
  });
  const tile = demosaicAdaptiveTile(mosaic);

  assert.equal(channelAt(tile, 2, 2, 0), 2);
  assert.equal(channelAt(tile, 3, 3, 2), -0.25);
});

test('limits false color around an achromatic vertical edge', () => {
  const mosaic = mosaicFromRgb(12, 8, (x) => x < 6 ? 0.1 : 0.9);
  const tile = demosaicAdaptiveTile(mosaic);

  for (let y = 2; y < 6; y += 1) {
    for (let x = 4; x < 8; x += 1) {
      const red = channelAt(tile, x, y, 0);
      const green = channelAt(tile, x, y, 1);
      const blue = channelAt(tile, x, y, 2);
      assert.ok(Math.abs(red - green) < 0.25);
      assert.ok(Math.abs(blue - green) < 0.25);
    }
  }
  assert.ok(channelAt(tile, 3, 3, 1) < channelAt(tile, 8, 3, 1));
});

test('matches full-image output across independent output tiles', () => {
  const mosaic = mosaicFromRgb(20, 8, (x, y, color) => {
    const luminance = 0.05 + x * 0.02 + y * 0.01;
    return [luminance * 1.2, luminance, luminance * 0.7][color];
  });
  const full = demosaicAdaptiveTile(mosaic);
  const parts = [
    { outputX: 0, outputY: 0, outputWidth: 8, outputHeight: 8 },
    { outputX: 8, outputY: 0, outputWidth: 8, outputHeight: 8 },
    { outputX: 16, outputY: 0, outputWidth: 4, outputHeight: 8 },
  ];

  for (const requested of parts) {
    const part = demosaicAdaptiveTile({ ...mosaic, tile: requested });
    for (let y = 0; y < part.height; y += 1) {
      for (let x = 0; x < part.width; x += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
          assert.equal(
            channelAt(part, x, y, channel),
            channelAt(full, requested.outputX + x, y, channel),
          );
        }
      }
    }
  }
});

test('honors cancellation before processing a row', () => {
  const mosaic = mosaicFromRgb(4, 4, () => 0.5);
  assert.throws(
    () => demosaicAdaptiveTile({ ...mosaic, isCancelled: () => true }),
    DemosaicCancelled,
  );
});

test('beats bilinear MSE on a synthetic color edge with known truth', () => {
  const width = 32;
  const height = 24;
  const truth = new Float32Array(width * height * 3);
  const mosaic = mosaicFromRgb(width, height, (x, y, color) => {
    const edge = x < 16 ? 0.12 : 0.72;
    const texture = 0.004 * x + 0.003 * y;
    const rgb = [
      (edge + texture) * (0.9 + 0.08 * Math.sin(y * 0.3)),
      edge + texture,
      (edge + texture) * (0.65 + 0.07 * Math.cos(x * 0.25)),
    ];
    const base = (y * width + x) * 3;
    truth[base] = rgb[0];
    truth[base + 1] = rgb[1];
    truth[base + 2] = rgb[2];
    return rgb[color];
  });
  const adaptive = demosaicAdaptiveTile(mosaic).interleavedRgb;
  const baseline = bilinear(mosaic);
  let adaptiveSquaredError = 0;
  let baselineSquaredError = 0;
  for (let index = 0; index < truth.length; index += 1) {
    adaptiveSquaredError += (adaptive[index] - truth[index]) ** 2;
    baselineSquaredError += (baseline[index] - truth[index]) ** 2;
  }

  assert.ok(
    adaptiveSquaredError < baselineSquaredError * 0.85,
    `adaptive=${adaptiveSquaredError} baseline=${baselineSquaredError}`,
  );
});

test('does not leak an isolated color-difference speckle into neighbors', () => {
  const mosaic = mosaicFromRgb(12, 10, (x, y) => {
    const base = 0.5;
    return x === 5 && y === 4 ? base + 0.3 : base;
  });
  const tile = demosaicAdaptiveTile(mosaic);

  assert.ok(Math.abs(channelAt(tile, 4, 4, 0) - 0.5) < 1e-3);
  assert.ok(Math.abs(channelAt(tile, 4, 4, 2) - 0.5) < 1e-3);
});

test('does not dim an isolated bright point source', () => {
  const mosaic = mosaicFromRgb(14, 10, (x, y) =>
    x === 6 && y === 5 ? 1.0 : 0.05);
  const tile = demosaicAdaptiveTile(mosaic);

  assert.ok(channelAt(tile, 6, 5, 0) > 0.95);
  assert.ok(channelAt(tile, 6, 5, 2) > 0.95);
});

test('classifies a hard diagonal edge separately from a smooth ramp', () => {
  const edge = mosaicFromRgb(32, 32, (x, y) =>
    x + y < 31 ? 0.08 : 0.88);
  const ramp = mosaicFromRgb(32, 32, (x, y) =>
    0.08 + 0.006 * x + 0.004 * y);
  let strongestEdge = null;
  let maximumBimodality = 0;
  for (let y = 10; y < 22; y += 1) {
    for (let x = 10; x < 22; x += 1) {
      const structure = analyzeLocalStructure(edge, x, y);
      maximumBimodality = Math.max(
        maximumBimodality,
        structure.bimodality,
      );
      if (strongestEdge === null
          || structure.energy > strongestEdge.energy) {
        strongestEdge = structure;
      }
    }
  }
  const smooth = analyzeLocalStructure(ramp, 16, 16);

  assert.ok(strongestEdge.coherence > 0.95);
  assert.ok(maximumBimodality > 0.9);
  assert.ok(strongestEdge.energy > 0.05);
  assert.ok(smooth.energy < 1e-3);
  assert.ok(smooth.bimodality < 0.1);
});

test('keeps the advanced quality envelope across edges texture and stars', () => {
  const diagonalEdge = mseAgainstTruth(48, 40, (x, y) => {
    const value = x + y < 43 ? 0.08 : 0.88;
    return [value, value, value];
  });
  const colorEdge = mseAgainstTruth(48, 40, (x, y) =>
    x - 0.72 * y < 9
      ? [0.16, 0.10, 0.06]
      : [0.78, 0.68, 0.45]);
  const smoothRamp = mseAgainstTruth(48, 40, (x, y) => {
    const luminance = 0.08 + 0.006 * x + 0.004 * y;
    return [
      luminance * (0.92 + 0.08 * Math.sin((x + y) * 0.11)),
      luminance,
      luminance * (0.72 + 0.06 * Math.cos((x - y) * 0.09)),
    ];
  });
  const periodicTexture = mseAgainstTruth(48, 40, (x, y) => {
    const wave = 0.42 + 0.25 * Math.sin((x + 1.37 * y) * 0.52);
    return [
      wave * (0.88 + 0.05 * Math.sin(y * 0.31)),
      wave,
      wave * (0.7 + 0.05 * Math.cos(x * 0.27)),
    ];
  });
  const stars = mseAgainstTruth(48, 40, (x, y) => {
    let value = 0.025;
    for (const [centerX, centerY, peak, sigma] of [
      [14.2, 13.7, 0.92, 0.75],
      [34.6, 24.4, 0.68, 1.15],
      [25.1, 33.2, 0.46, 0.62],
    ]) {
      const radiusSquared =
        (x - centerX) ** 2 + (y - centerY) ** 2;
      value += peak * Math.exp(
        -radiusSquared / (2 * sigma * sigma),
      );
    }
    return [value, value, value];
  });

  assert.ok(diagonalEdge < 1.1e-3, `diagonalEdge=${diagonalEdge}`);
  assert.ok(colorEdge < 4.5e-4, `colorEdge=${colorEdge}`);
  assert.ok(smoothRamp < 1.2e-7, `smoothRamp=${smoothRamp}`);
  assert.ok(periodicTexture < 1.1e-4,
    `periodicTexture=${periodicTexture}`);
  assert.ok(stars < 4e-5, `stars=${stars}`);
});


test('adaptive demosaic rejects non-finite CFA input instead of fabricating RGB', () => {
  const mosaic = mosaicFromRgb(6, 6, () => 0.5);
  mosaic.samples[7] = Number.NaN;
  assert.throws(
    () => demosaicAdaptiveTile(mosaic),
    /non-finite CFA sample/,
  );
});

test('adaptive demosaic preserves finite negative and >1 values', () => {
  const mosaic = mosaicFromRgb(
    6,
    6,
    (x, y, color) => {
      if (x === 2 && y === 2) return 2;
      if (x === 3 && y === 3) return -0.25;
      return color === 'r' ? 0.8 : color === 'g' ? 0.5 : 0.2;
    },
  );
  const result = demosaicAdaptiveTile(mosaic);
  const red = result.interleavedRgb[(2 * 6 + 2) * 3];
  const blue = result.interleavedRgb[(3 * 6 + 3) * 3 + 2];
  assert.equal(red, 2);
  assert.equal(blue, -0.25);
});
