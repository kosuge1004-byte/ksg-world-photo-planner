
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function colorAtRggb(x, y) {
  const evenX = (x & 1) === 0;
  const evenY = (y & 1) === 0;
  if (evenX && evenY) return 'r';
  if (!evenX && !evenY) return 'b';
  return 'g';
}

function greenProxyInfluence({width, height, saturated}) {
  const out = new Uint8Array(width * height);
  const sat = (x, y) => saturated[y * width + x] !== 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (colorAtRggb(x, y) === 'g') {
        out[index] = sat(x, y) ? 1 : 0;
        continue;
      }
      if (x > 0 && colorAtRggb(x - 1, y) === 'g' && sat(x - 1, y)) out[index] = 1;
      if (x + 1 < width && colorAtRggb(x + 1, y) === 'g' && sat(x + 1, y)) out[index] = 1;
      if (y > 0 && colorAtRggb(x, y - 1) === 'g' && sat(x, y - 1)) out[index] = 1;
      if (y + 1 < height && colorAtRggb(x, y + 1) === 'g' && sat(x, y + 1)) out[index] = 1;
    }
  }
  return out;
}

test('green-luminance saturation mask follows the exact extraction support', () => {
  const width = 5;
  const height = 5;
  const saturated = new Uint8Array(width * height);
  // RGGB: (1,0) is green. It directly invalidates itself and the red/blue
  // proxy positions that average this orthogonal green neighbor.
  saturated[0 * width + 1] = 1;
  const influence = greenProxyInfluence({width, height, saturated});
  assert.equal(influence[0 * width + 1], 1);
  assert.equal(influence[0 * width + 0], 1);
  assert.equal(influence[0 * width + 2], 1);
  assert.equal(influence[1 * width + 1], 1);
  assert.equal(influence[2 * width + 1], 0);
});

test('saturated red site does not contaminate green proxy by itself', () => {
  const width = 5;
  const height = 5;
  const saturated = new Uint8Array(width * height);
  saturated[0] = 1; // RGGB red
  const influence = greenProxyInfluence({width, height, saturated});
  assert.equal(influence.reduce((a, b) => a + b, 0), 0);
});

test('CFA Drizzle registration filters every candidate with the green-proxy saturation mask', () => {
  const extractor = readFileSync(
    new URL('../../../lib/core/drizzle/extract_green_luminance_from_mosaic.dart', import.meta.url),
    'utf8',
  );
  const pipeline = readFileSync(
    new URL('../../../lib/core/session/cfa_drizzle_milky_way_pipeline.dart', import.meta.url),
    'utf8',
  );
  assert.match(extractor, /greenLuminanceSaturationInfluenceMask/);
  assert.match(pipeline, /_excludeSaturationInfluencedRegistrationStars/);
  assert.match(pipeline, /late final RawSaturationMask\? invalid/);
  assert.match(pipeline, /greenLuminanceSaturationInfluenceMask\(mosaic\)/);
  assert.match(pipeline, /invalidMask:\s*invalid/);
  assert.match(pipeline, /detectorWindowRadius = 4/);
});
