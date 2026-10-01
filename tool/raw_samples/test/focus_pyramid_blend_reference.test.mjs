import assert from 'node:assert/strict';
import test from 'node:test';

import { pyramidBlend, pyramidRegion, pyramidDependencyRadius } from '../focus_pyramid_blend_reference.mjs';

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const plane = (w, h, f) => { const d = new Float64Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = f(x, y); return { w, h, data: d }; };
const crop = (p, x0, y0, w, h) => plane(w, h, (x, y) => p.data[(y + y0) * p.w + x + x0]);

function scene(w, h, seed, offset) {
  const r = lcg(seed);
  const noise = Array.from({ length: w * h }, () => r());
  return [0, 1, 2].map((c) => plane(w, h, (x, y) => offset + 0.2 + 0.1 * c + 0.3 * noise[y * w + x] * (x > w / 2 ? 1 : 0.2)));
}

function winnerWeights(w, h, frames, winnerOf) {
  return Array.from({ length: frames }, (_, f) => plane(w, h, (x, y) => (winnerOf(x, y) === f ? 1 : 0)));
}

test('one-hot weights on a single frame reproduce that frame', () => {
  const w = 96; const h = 80; const levels = 4;
  const frames = [scene(w, h, 1, 0), scene(w, h, 2, 0.05)];
  const out = pyramidBlend(frames, winnerWeights(w, h, 2, () => 1), levels);
  for (let c = 0; c < 3; c++) for (let i = 0; i < w * h; i++) assert.ok(Math.abs(out[c].data[i] - frames[1][c].data[i]) < 1e-9);
});

test('constant images stay constant for arbitrary weights (weights sum to one)', () => {
  const w = 64; const h = 64; const levels = 3;
  const frames = [0.3, 0.3].map((v) => [0, 1, 2].map(() => plane(w, h, () => v)));
  const out = pyramidBlend(frames, winnerWeights(w, h, 2, (x, y) => ((x * 7 + y * 3) % 5 === 0 ? 0 : 1)), levels);
  for (const p of out) for (const v of p.data) assert.ok(Math.abs(v - 0.3) < 1e-9);
});

test('tiled processing with aligned margins equals whole-image processing', () => {
  const W = 200; const H = 150; const levels = 3; const margin = pyramidDependencyRadius(levels) + 8;
  const frames = [scene(W, H, 3, 0), scene(W, H, 4, 0.1), scene(W, H, 5, -0.05)];
  const winner = (x, y) => (x + 2 * y) % 3 === 0 ? 0 : (x < 90 ? 1 : 2);
  const weights = winnerWeights(W, H, 3, winner);
  const whole = pyramidBlend(frames, weights, levels);
  const tile = 64;
  let worst = 0;
  for (let ty = 0; ty < H; ty += tile) for (let tx = 0; tx < W; tx += tile) {
    const tw = Math.min(tile, W - tx); const th = Math.min(tile, H - ty);
    const r = pyramidRegion(tx, ty, tw, th, W, H, levels, margin);
    const out = pyramidBlend(
      frames.map((f) => f.map((p) => crop(p, r.x, r.y, r.w, r.h))),
      weights.map((p) => crop(p, r.x, r.y, r.w, r.h)), levels);
    for (let c = 0; c < 3; c++) for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const a = out[c].data[(y + ty - r.y) * r.w + x + tx - r.x];
      const b = whole[c].data[(y + ty) * W + x + tx];
      worst = Math.max(worst, Math.abs(a - b));
    }
  }
  assert.ok(worst < 1e-12, `max tile difference ${worst}`);
});

test('a brightness step at a winner boundary becomes a smooth transition', () => {
  const w = 128; const h = 32; const levels = 4;
  const a = [0, 1, 2].map(() => plane(w, h, () => 0.40));
  const b = [0, 1, 2].map(() => plane(w, h, () => 0.44));
  const out = pyramidBlend([a, b], winnerWeights(w, h, 2, (x) => (x < 64 ? 0 : 1)), levels);
  let maxStep = 0;
  for (let x = 1; x < w; x++) maxStep = Math.max(maxStep, Math.abs(out[1].data[16 * w + x] - out[1].data[16 * w + x - 1]));
  assert.ok(maxStep < 0.04 / 4, `max step ${maxStep} vs hard 0.04`);
  assert.ok(Math.abs(out[1].data[16 * w + 2] - 0.40) < 1e-3 && Math.abs(out[1].data[16 * w + 125] - 0.44) < 1e-3);
});

test('fine detail of the winning frame is preserved (no softening of the in-focus band)', () => {
  const w = 128; const h = 64; const levels = 4;
  const r = lcg(9);
  const detail = Array.from({ length: w * h }, () => 0.2 * r());
  const sharp = [0, 1, 2].map(() => plane(w, h, (x, y) => 0.4 + detail[y * w + x]));
  const blurred = [0, 1, 2].map(() => plane(w, h, () => 0.5));
  const out = pyramidBlend([sharp, blurred], winnerWeights(w, h, 2, (x) => (x < 64 ? 0 : 1)), levels);
  let err = 0; let n = 0;
  for (let y = 0; y < h; y++) for (let x = 4; x < 40; x++) { err += Math.abs(out[0].data[y * w + x] - sharp[0].data[y * w + x]); n++; }
  assert.ok(err / n < 0.01, `mean abs error in sharp region ${err / n}`);
});
