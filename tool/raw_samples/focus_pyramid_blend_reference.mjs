// Focus-stack multi-band (Laplacian pyramid) blending (Work354) — reference.
//
// The existing depth-map blend switches frames per pixel (hard winner, or a
// winner/neighbour mix where confidence is low). Any brightness difference
// or defocus-blur mismatch between the winning frames then shows as a seam
// or step along winner-map boundaries. Burt-Adelson multi-band blending
// combines each Laplacian band of every frame with the Gaussian-reduced
// weight map at that band: fine detail keeps the sharp per-pixel choice,
// while low frequencies transition smoothly, hiding seams.
//
// Tiling: every operation uses the finite 5-tap binomial kernel, so a
// pixel's value depends only on inputs within a bounded radius
// (< 4 * 2^levels). Processing each output tile over an extended region
// whose origin is a multiple of 2^levels (so every tile shares the same
// decimation grid) and whose margin exceeds that radius makes the core
// pixels independent of the tiling. At the image border the region is
// clipped to the image and reflected, identically for every tile.

const K = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

function reflect(i, n) {
  if (n === 1) return 0;
  while (i < 0 || i >= n) {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * (n - 1) - i;
  }
  return i;
}

// plane: {w, h, data: Float64Array}
function reduce(p) {
  const w2 = Math.ceil(p.w / 2); const h2 = Math.ceil(p.h / 2);
  const tmp = new Float64Array(w2 * p.h);
  for (let y = 0; y < p.h; y++) for (let x = 0; x < w2; x++) {
    let s = 0; for (let m = -2; m <= 2; m++) s += K[m + 2] * p.data[y * p.w + reflect(2 * x + m, p.w)];
    tmp[y * w2 + x] = s;
  }
  const out = new Float64Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    let s = 0; for (let m = -2; m <= 2; m++) s += K[m + 2] * tmp[reflect(2 * y + m, p.h) * w2 + x];
    out[y * w2 + x] = s;
  }
  return { w: w2, h: h2, data: out };
}

// Expand a coarse plane to size (w, h).
function expand(c, w, h) {
  const tmp = new Float64Array(w * c.h);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let m = -2; m <= 2; m++) {
      const t = x - m; if (t % 2 !== 0) continue;
      s += K[m + 2] * c.data[y * c.w + reflect(t / 2, c.w)];
    }
    tmp[y * w + x] = 2 * s;
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let m = -2; m <= 2; m++) {
      const t = y - m; if (t % 2 !== 0) continue;
      s += K[m + 2] * tmp[reflect(t / 2, c.h) * w + x];
    }
    out[y * w + x] = 2 * s;
  }
  return { w, h, data: out };
}

function gaussianPyramid(p, levels) {
  const g = [p];
  for (let l = 0; l < levels; l++) g.push(reduce(g[l]));
  return g;
}

/// frames: array of planes-per-channel [[r, g, b] planes] (each {w,h,data}).
/// weights: array (per frame) of weight planes summing to 1 per pixel.
/// Returns [r, g, b] planes.
export function pyramidBlend(frames, weights, levels) {
  const w = frames[0][0].w; const h = frames[0][0].h;
  const out = [];
  const wPyr = weights.map((p) => gaussianPyramid(p, levels));
  // normalization per level (sum of reduced weights; 1 up to rounding)
  const wSum = [];
  for (let l = 0; l <= levels; l++) {
    const n = wPyr[0][l].data.length; const s = new Float64Array(n);
    for (const pyr of wPyr) for (let i = 0; i < n; i++) s[i] += pyr[l].data[i];
    wSum.push(s);
  }
  for (let c = 0; c < 3; c++) {
    let acc = null;
    for (let f = 0; f < frames.length; f++) {
      const g = gaussianPyramid(frames[f][c], levels);
      const bands = [];
      for (let l = 0; l < levels; l++) {
        const e = expand(g[l + 1], g[l].w, g[l].h);
        bands.push(g[l].data.map((v, i) => v - e.data[i]));
      }
      bands.push(g[levels].data);
      if (!acc) acc = bands.map((b) => new Float64Array(b.length));
      for (let l = 0; l <= levels; l++) {
        const wl = wPyr[f][l].data; const b = bands[l]; const a = acc[l]; const s = wSum[l];
        for (let i = 0; i < a.length; i++) a[i] += (s[i] > 0 ? wl[i] / s[i] : 0) * b[i];
      }
    }
    // collapse
    const sizes = wPyr[0].map((p) => [p.w, p.h]);
    let cur = { w: sizes[levels][0], h: sizes[levels][1], data: acc[levels] };
    for (let l = levels - 1; l >= 0; l--) {
      const e = expand(cur, sizes[l][0], sizes[l][1]);
      cur = { w: sizes[l][0], h: sizes[l][1], data: e.data.map((v, i) => v + acc[l][i]) };
    }
    out.push(cur);
  }
  return out;
}

/// Extended processing region for an output tile (see file comment).
export function pyramidRegion(tileX, tileY, tileW, tileH, imageW, imageH, levels, margin) {
  const a = 2 ** levels;
  const x0 = Math.max(0, Math.floor((tileX - margin) / a) * a);
  const y0 = Math.max(0, Math.floor((tileY - margin) / a) * a);
  const x1 = Math.min(imageW, tileX + tileW + margin);
  const y1 = Math.min(imageH, tileY + tileH + margin);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/// Radius (pixels) that bounds each output pixel's dependency on inputs.
export function pyramidDependencyRadius(levels) {
  return 4 * (2 ** levels);
}
