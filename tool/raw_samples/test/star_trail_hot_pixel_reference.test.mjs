import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStationaryHotPixelMap, correctHotPixels, detectStationaryPointCandidates } from '../star_trail_hot_pixel_reference.mjs';

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { const u = r() || 1e-12; const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const W = 160; const H = 120;

// Demosaic-like footprint of a single hot sensel on channel c.
function addHot(rgb, x, y, c, amp) {
  const k = [[0.12, 0.25, 0.12], [0.25, 1, 0.25], [0.12, 0.25, 0.12]];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) rgb[((y + dy) * W + x + dx) * 3 + c] += amp * k[dy + 1][dx + 1];
}
function addStar(rgb, cx, cy, amp, fwhm) {
  const s = fwhm / 2.3548;
  for (let y = Math.max(0, Math.floor(cy - 6)); y < Math.min(H, cy + 7); y++) for (let x = Math.max(0, Math.floor(cx - 6)); x < Math.min(W, cx + 7); x++) {
    const v = amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
    for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] += v;
  }
}

const HOT = [[20, 30, 0], [100, 60, 2], [70, 90, 1], [140, 20, 0]];

function makeSequence(frames, seed = 1) {
  const r = lcg(seed);
  const stars = Array.from({ length: 25 }, () => ({ x: 10 + r() * 140, y: 10 + r() * 100, a: 0.05 + 0.3 * r() }));
  const seq = [];
  for (let f = 0; f < frames; f++) {
    const rgb = new Float32Array(W * H * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = 0.02 + 0.002 * gauss(r);
    for (const s of stars) addStar(rgb, s.x + 2.5 * f * 0.2, s.y + 1.5 * f * 0.2, s.a, 2.4);
    addStar(rgb, 50 + 0.1 * f, 50, 0.6, 2.0); // slow pole star
    for (const [x, y, c] of HOT) addHot(rgb, x, y, c, 0.15);
    seq.push(rgb);
  }
  return seq;
}

test('stationary hot pixels are found; moving and slowly moving stars are not', () => {
  const seq = makeSequence(30);
  const perFrame = seq.map((rgb) => detectStationaryPointCandidates(rgb, W, H));
  const hot = buildStationaryHotPixelMap(perFrame);
  const expected = HOT.map(([x, y]) => y * W + x).sort((a, b) => a - b);
  assert.deepEqual([...hot], expected);
});

test('short sequences never produce a hot map', () => {
  const seq = makeSequence(10);
  const perFrame = seq.map((rgb) => detectStationaryPointCandidates(rgb, W, H));
  assert.equal(buildStationaryHotPixelMap(perFrame).length, 0);
});

test('correction removes hot pixels from the maximum stack and leaves trails intact', () => {
  const seq = makeSequence(30);
  const hot = buildStationaryHotPixelMap(seq.map((rgb) => detectStationaryPointCandidates(rgb, W, H)));
  const max = (frames) => frames.reduce((acc, f) => acc.map((v, i) => Math.max(v, f[i])));
  const raw = max(seq);
  const fixed = max(seq.map((rgb) => correctHotPixels(rgb, W, H, hot)));
  for (const [x, y, c] of HOT) {
    assert.ok(raw[(y * W + x) * 3 + c] > 0.12, 'hot pixel visible before');
    assert.ok(fixed[(y * W + x) * 3 + c] < 0.05, `hot pixel ${x},${y} removed: ${fixed[(y * W + x) * 3 + c]}`);
  }
  let changedFar = 0;
  const hotSet = HOT.map(([x, y]) => [x, y]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (hotSet.some(([hx, hy]) => Math.abs(hx - x) <= 1 && Math.abs(hy - y) <= 1)) continue;
    for (let c = 0; c < 3; c++) if (raw[(y * W + x) * 3 + c] !== fixed[(y * W + x) * 3 + c]) changedFar++;
  }
  assert.equal(changedFar, 0, 'pixels outside hot footprints are untouched');
});

test('correction is tile-invariant with a 2 px margin', () => {
  const seq = makeSequence(1);
  const hot = Int32Array.from(HOT.map(([x, y]) => y * W + x).sort((a, b) => a - b));
  const whole = correctHotPixels(seq[0], W, H, hot);
  // tile covering x 90..129, y 40..79 read with a 2 px margin
  const x0 = 88; const y0 = 38; const tw = 44; const th = 44;
  const tile = new Float32Array(tw * th * 3);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) for (let c = 0; c < 3; c++) tile[(y * tw + x) * 3 + c] = seq[0][((y + y0) * W + x + x0) * 3 + c];
  const fixed = correctHotPixels(tile, tw, th, hot, { x0, y0, imageWidth: W });
  for (let y = 2; y < th - 2; y++) for (let x = 2; x < tw - 2; x++) for (let c = 0; c < 3; c++) {
    assert.equal(fixed[(y * tw + x) * 3 + c], whole[((y + y0) * W + x + x0) * 3 + c]);
  }
});
