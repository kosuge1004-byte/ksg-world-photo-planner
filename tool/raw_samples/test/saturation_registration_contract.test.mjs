
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function previewWindowTouchesInvalid({
  starX,
  starY,
  width,
  height,
  invalid,
  radius,
}) {
  const centerX = Math.round(starX);
  const centerY = Math.round(starY);
  const left = Math.max(0, centerX - radius);
  const right = Math.min(width - 1, centerX + radius);
  const top = Math.max(0, centerY - radius);
  const bottom = Math.min(height - 1, centerY + radius);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (invalid[y * width + x]) return true;
    }
  }
  return false;
}

test('registration star is rejected when its radius-4 centroid/PSF window touches saturation influence', () => {
  const width = 20;
  const height = 20;
  const invalid = new Uint8Array(width * height);
  invalid[10 * width + 14] = 1;
  assert.equal(previewWindowTouchesInvalid({
    starX: 10.2,
    starY: 10.1,
    width,
    height,
    invalid,
    radius: 4,
  }), true);
  assert.equal(previewWindowTouchesInvalid({
    starX: 4.1,
    starY: 4.0,
    width,
    height,
    invalid,
    radius: 4,
  }), false);
});

test('Milky Way registration path passes each frame saturation mask into star detection', () => {
  const source = readFileSync(
    new URL('../../../lib/core/session/milky_way_pipeline.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /saturationInfluenceMask:\s*effectiveSaturationMasks\[index\]/);
  assert.match(source, /_previewWindowTouchesInvalid/);
  assert.match(source, /detectorWindowRadius = 4/);
  assert.match(source, /invalidMask\.isSaturatedIndex\(index\)/);
  assert.doesNotMatch(source, /previewInvalid = Uint8List/);
});
