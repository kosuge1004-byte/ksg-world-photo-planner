import assert from 'node:assert/strict';
import test from 'node:test';

import { combineMeanAndMax, excessStatistics, rampWeight } from '../star_trail_mean_background_reference.mjs';

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { const u = r() || 1e-12; const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const W = 200; const H = 120; const N = 100; const SIGMA = 0.01;

function stack() {
  const r = lcg(5);
  const sum = new Float64Array(W * H * 3); const max = new Float32Array(W * H * 3).fill(-Infinity);
  const trailRow = 60;
  for (let f = 0; f < N; f++) {
    for (let p = 0; p < W * H; p++) {
      const x = p % W; const y = Math.floor(p / W);
      const sky = 0.05 + 0.1 * (y / H); // gradient: shot noise grows with level
      const noise = SIGMA * Math.sqrt(sky / 0.1);
      const starX = 2 * f;
      const star = (Math.abs(y - trailRow) <= 1 && Math.abs(x - starX) <= 1) ? 0.3 : 0;
      for (let c = 0; c < 3; c++) {
        const v = sky + star * (c === 2 ? 0.8 : 1) + noise * gauss(r);
        sum[p * 3 + c] += v; max[p * 3 + c] = Math.max(max[p * 3 + c], v);
      }
    }
  }
  return { mean: Float32Array.from(sum, (v) => v / N), max, trailRow };
}

test('sky takes the mean (low noise, no upward bias); trails keep the maximum', () => {
  const { mean, max, trailRow } = stack();
  const stats = excessStatistics(mean, max);
  const out = combineMeanAndMax(mean, max, stats);
  // sky rows away from the trail
  let biasMax = 0; let biasOut = 0; let n = 0; let varOut = 0;
  for (let y = 10; y < 40; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 3 + 1; const truth = 0.05 + 0.1 * (y / H);
    biasMax += max[p] - truth; biasOut += out[p] - truth; varOut += (out[p] - truth) ** 2; n++;
  }
  biasMax /= n; biasOut /= n;
  assert.ok(biasMax > 0.015, `max lifts the sky: ${biasMax}`);
  assert.ok(Math.abs(biasOut) < 0.002, `combined sky unbiased: ${biasOut}`);
  assert.ok(Math.sqrt(varOut / n) < 0.004, `combined sky noise ${Math.sqrt(varOut / n)}`);
  // trail pixels keep the maximum
  let worst = 0;
  for (let x = 4; x < 2 * (N - 2); x++) {
    const p = (trailRow * W + x) * 3;
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[p + c] - max[p + c]));
  }
  assert.ok(worst < 1e-6, `trail difference ${worst}`);
});

test('ramp is monotone and saturates', () => {
  assert.equal(rampWeight(0, 0, 1), 0);
  assert.equal(rampWeight(10, 0, 1), 1);
  assert.ok(rampWeight(4, 0, 1) > 0 && rampWeight(4, 0, 1) < rampWeight(5, 0, 1));
});
