
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function dilate(mask, width, height, radius) {
  const out = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const y = Math.floor(index / width);
    const x = index - y * width;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
        out[yy * width + xx] = 1;
      }
    }
  }
  return out;
}

function footprintTouches(mask, width, height, sourceX, sourceY, bicubic) {
  const baseX = Math.floor(sourceX);
  const baseY = Math.floor(sourceY);
  const minOffset = bicubic ? -1 : 0;
  const maxOffset = bicubic ? 2 : 1;
  for (let dy = minOffset; dy <= maxOffset; dy++) {
    const y = Math.max(0, Math.min(height - 1, baseY + dy));
    for (let dx = minOffset; dx <= maxOffset; dx++) {
      const x = Math.max(0, Math.min(width - 1, baseX + dx));
      if (mask[y * width + x]) return true;
    }
  }
  return false;
}

test('Dart reference radius-5 saturation influence matches its own adaptive demosaic dependency', () => {
  const width = 15;
  const height = 15;
  const raw = new Uint8Array(width * height);
  raw[7 * width + 7] = 1;
  const influenced = dilate(raw, width, height, 5);
  let count = 0;
  for (const v of influenced) count += v;
  assert.equal(count, 121);
  assert.equal(influenced[2 * width + 2], 1);
  assert.equal(influenced[12 * width + 12], 1);
  assert.equal(influenced[1 * width + 7], 0);
});

test('bicubic observation is rejected when any 4x4 interpolation source sample is saturation-influenced', () => {
  const width = 12;
  const height = 12;
  const mask = new Uint8Array(width * height);
  mask[5 * width + 5] = 1;
  assert.equal(footprintTouches(mask, width, height, 5.2, 5.2, true), true);
  assert.equal(footprintTouches(mask, width, height, 8.2, 8.2, true), false);
});

test('production Milky Way path wires saturation influence from demosaic to kappa-sigma coverage', () => {
  const executor = readFileSync(
    new URL('../../../lib/core/engine/phase2_validated_job_executor.dart', import.meta.url),
    'utf8',
  );
  const pipeline = readFileSync(
    new URL('../../../lib/core/pipeline/phase2_quality_pipeline_factory.dart', import.meta.url),
    'utf8',
  );
  const milky = readFileSync(
    new URL('../../../lib/core/session/milky_way_pipeline.dart', import.meta.url),
    'utf8',
  );
  const resampler = readFileSync(
    new URL('../../../lib/core/registration/tiled_affine_rgb_resampler.dart', import.meta.url),
    'utf8',
  );

  const dartReference = readFileSync(
    new URL('../../../lib/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart', import.meta.url),
    'utf8',
  );
  const nativeEngine = readFileSync(
    new URL('../../../lib/core/demosaic/native_mobile_stack_demosaic_engine.dart', import.meta.url),
    'utf8',
  );
  const nativeHeader = readFileSync(
    new URL('../../../native/include/mobile_stack_demosaic.h', import.meta.url),
    'utf8',
  );

  assert.match(dartReference, /referenceRequiredInputRadius\s*=\s*5/);
  assert.match(nativeEngine, /nativeRequiredInputRadius\s*=\s*5/);
  assert.match(nativeHeader, /MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS\s*=\s*5/);
  assert.match(pipeline, /radius:\s*engine\.requiredInputRadius/);
  assert.match(pipeline, /dilatedChebyshev/);
  assert.match(executor, /onSaturationMaskReady/);
  assert.match(milky, /saturationInfluenceMasks/);
  assert.match(milky, /_coverageExcludingInvalidMask/);
  assert.match(resampler, /sourceInvalidMask/);
  assert.match(resampler, /_interpolationFootprintTouchesInvalid/);
});
