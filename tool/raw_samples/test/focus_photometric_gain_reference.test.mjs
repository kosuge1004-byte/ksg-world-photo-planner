import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateFocusFrameGain, focusGainBlockCentres, InvalidFocusGainInput } from '../focus_photometric_gain_reference.mjs';

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function makeScene(width, height, seed) {
  const r = lcg(seed);
  const img = new Float32Array(width * height * 3);
  // smooth colour gradient + random texture patches (in-focus detail)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    const t = 0.15 + 0.4 * (x / width) + 0.15 * Math.sin(y / 37);
    img[i] = t * (0.9 + 0.2 * r()); img[i + 1] = t * 0.8 * (0.9 + 0.2 * r()); img[i + 2] = t * 0.6 * (0.9 + 0.2 * r());
  }
  return img;
}

function boxBlur(img, width, height, radius) {
  const out = new Float32Array(img.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    let s = 0; let n = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = Math.min(width - 1, Math.max(0, x + dx)); const yy = Math.min(height - 1, Math.max(0, y + dy));
      s += img[(yy * width + xx) * 3 + c]; n++;
    }
    out[(y * width + x) * 3 + c] = s / n;
  }
  return out;
}

function blockMeans(img, width, centres, blockSize) {
  return centres.map(({ x, y }) => {
    const m = [0, 0, 0]; let n = 0;
    for (let yy = y - blockSize / 2; yy < y + blockSize / 2; yy++) for (let xx = x - blockSize / 2; xx < x + blockSize / 2; xx++) {
      for (let c = 0; c < 3; c++) m[c] += img[(yy * width + xx) * 3 + c]; n++;
    }
    return m.map((v) => v / n);
  });
}

test('recovers per-channel gain of a defocused, differently exposed frame', () => {
  const w = 480; const h = 320;
  const ref = makeScene(w, h, 3);
  const blurred = boxBlur(ref, w, h, 3);
  const gain = [1 / 1.06, 1 / 0.97, 1 / 1.03];
  const frame = blurred.map((v, i) => v / gain[i % 3]);
  const centres = focusGainBlockCentres(w, h, { columns: 12, rows: 8, blockSize: 32 });
  const result = estimateFocusFrameGain(blockMeans(ref, w, centres, 32), blockMeans(frame, w, centres, 32), { minValid: 20 });
  assert.equal(result.applied, true);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(result.gain[c] - gain[c]) / gain[c] < 0.005, `channel ${c}: ${result.gain[c]} vs ${gain[c]}`);
});

test('identical frames give unit gain', () => {
  const means = Array.from({ length: 50 }, (_, i) => [0.1 + i * 0.01, 0.2, 0.3]);
  const result = estimateFocusFrameGain(means, means.map((m) => [...m]));
  assert.deepEqual(result.gain, [1, 1, 1]);
  assert.equal(result.applied, true);
});

test('dark, saturated and insufficient blocks fall back to unit gain', () => {
  const dark = Array.from({ length: 100 }, () => [0.001, 0.001, 0.001]);
  assert.equal(estimateFocusFrameGain(dark, dark).applied, false);
  const clipped = Array.from({ length: 100 }, () => [0.95, 0.95, 0.95]);
  assert.equal(estimateFocusFrameGain(clipped, clipped).applied, false);
  const few = Array.from({ length: 10 }, () => [0.3, 0.3, 0.3]);
  assert.deepEqual(estimateFocusFrameGain(few, few).gain, [1, 1, 1]);
});

test('implausible gains are rejected', () => {
  const ref = Array.from({ length: 50 }, () => [0.6, 0.6, 0.6]);
  const frame = Array.from({ length: 50 }, () => [0.2, 0.6, 0.6]);
  const result = estimateFocusFrameGain(ref, frame);
  assert.equal(result.applied, false);
  assert.deepEqual(result.gain, [1, 1, 1]);
});

test('invalid input is rejected', () => {
  assert.throws(() => estimateFocusFrameGain([[1, 1, 1]], []), InvalidFocusGainInput);
  assert.throws(() => estimateFocusFrameGain([], [], { low: 0.5, high: 0.4 }), InvalidFocusGainInput);
});

test('block centres stay inside the image', () => {
  const centres = focusGainBlockCentres(6000, 4000);
  assert.ok(centres.length > 1400);
  for (const { x, y } of centres) assert.ok(x >= 16 && y >= 16 && x <= 5984 && y <= 3984);
});
