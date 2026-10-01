import assert from 'node:assert/strict';
import test from 'node:test';

import { compositeAdditiveInPlace, estimateAdditiveParameters, estimateRadiant } from '../meteor_additive_composite_reference.mjs';

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { const u = r() || 1e-12; const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const W = 160; const H = 100;
const streak = { endpoints: [{ x: 20, y: 50 }, { x: 140, y: 52 }], width: 3 };

function scene() {
  const r = lcg(3);
  const bg = new Float32Array(W * H * 3); const fg = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    const x = p % W; const y = Math.floor(p / W);
    const onMeteor = x >= 20 && x <= 140 && Math.abs(y - (50 + (x - 20) / 60)) <= 1;
    for (let c = 0; c < 3; c++) {
      bg[p * 3 + c] = 0.05 + 0.001 * gauss(r) + (onMeteor ? 0.01 : 0); // faint kappa-sigma residue
      fg[p * 3 + c] = 0.052 + 0.01 * gauss(r) + (onMeteor ? 0.4 : 0);  // single frame: noisier, +0.002 sky
    }
  }
  return { bg, fg };
}

test('lighten leaves a noisy, brightened band; additive keeps the background clean', () => {
  const { bg, fg } = scene();
  const lighten = Float32Array.from(bg);
  for (let p = 0; p < W * H; p++) {
    const x = p % W; const y = Math.floor(p / W);
    if (x < 17 || x > 143 || Math.abs(y - (50 + (x - 20) / 60)) > 1.5 + 3) continue;
    for (let c = 0; c < 3; c++) lighten[p * 3 + c] = Math.max(bg[p * 3 + c], fg[p * 3 + c]);
  }
  const additive = Float32Array.from(bg);
  const params = estimateAdditiveParameters(bg, fg, W, H, streak);
  assert.ok(Math.abs(params.offset[1] - 0.002) < 0.001);
  compositeAdditiveInPlace(additive, fg, W, H, streak, params);
  // band pixels 3-4 px off the meteor line (inside the lighten mask)
  let biasL = 0; let biasA = 0; let n = 0;
  for (let x = 30; x < 130; x++) for (const dy of [-4, -3, 3, 4]) {
    const y = Math.round(50 + (x - 20) / 60) + dy; const i = (y * W + x) * 3 + 1;
    biasL += lighten[i] - 0.05; biasA += additive[i] - 0.05; n++;
  }
  assert.ok(biasL / n > 0.003, `lighten band bias ${biasL / n}`);
  assert.ok(Math.abs(biasA / n) < 0.0015, `additive band bias ${biasA / n}`);
  // meteor core: fg minus sky offset, residue not counted twice
  let core = 0; let m = 0;
  for (let x = 30; x < 130; x++) { const y = Math.round(50 + (x - 20) / 60); core += additive[(y * W + x) * 3 + 1]; m++; }
  assert.ok(Math.abs(core / m - 0.45) < 0.01, `core mean ${core / m}`);
});

test('tiled application with global parameters equals whole-image application', () => {
  const { bg, fg } = scene();
  const params = estimateAdditiveParameters(bg, fg, W, H, streak);
  const whole = Float32Array.from(bg);
  compositeAdditiveInPlace(whole, fg, W, H, streak, params);
  for (const [tx, ty, tw, th] of [[0, 0, 80, 60], [80, 0, 80, 60], [0, 60, 80, 40], [80, 60, 80, 40]]) {
    const cut = (src) => { const o = new Float32Array(tw * th * 3); for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) for (let c = 0; c < 3; c++) o[(y * tw + x) * 3 + c] = src[((y + ty) * W + x + tx) * 3 + c]; return o; };
    const d = cut(bg); compositeAdditiveInPlace(d, cut(fg), tw, th, streak, params, { x0: tx, y0: ty });
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) for (let c = 0; c < 3; c++) assert.equal(d[(y * tw + x) * 3 + c], whole[((y + ty) * W + x + tx) * 3 + c]);
  }
});

test('radiant is found and a crossing satellite is flagged inconsistent', () => {
  const radiant = { x: 2500, y: -800 };
  const r = lcg(9);
  const streaks = [];
  for (let k = 0; k < 6; k++) {
    const mx = 500 + 4000 * r(); const my = 500 + 3000 * r();
    const dx = mx - radiant.x; const dy = my - radiant.y; const l = Math.hypot(dx, dy);
    const len = 150 + 200 * r();
    streaks.push({ endpoints: [{ x: mx - dx / l * len / 2, y: my - dy / l * len / 2 }, { x: mx + dx / l * len / 2, y: my + dy / l * len / 2 }], width: 3 });
  }
  streaks.push({ endpoints: [{ x: 1000, y: 3000 }, { x: 1400, y: 3010 }], width: 3 }); // satellite
  const result = estimateRadiant(streaks);
  assert.ok(result.radiant && Math.hypot(result.radiant.x - radiant.x, result.radiant.y - radiant.y) < 150);
  assert.deepEqual(result.consistent, [true, true, true, true, true, true, false]);
  assert.equal(estimateRadiant(streaks.slice(0, 2)).radiant, null);
});
