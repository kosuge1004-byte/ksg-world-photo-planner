// Star-trail stationary hot-pixel removal (Work355) — Node reference.
//
// In a comparison-light (per-pixel maximum) stack a hot pixel that fires in
// even one frame survives, and it fires in almost every frame of a long
// warm-sensor sequence. Registration-based stacks (Milky Way) move hot
// pixels relative to the sky so rejection removes them; a fixed-tripod
// star-trail stack has no such escape. The background worker path cannot
// use master-dark hot-pixel detection, and no defect map is ever populated.
//
// Detection is temporal: pass 1 (which already decodes every frame for the
// compact analysis) records, per frame, sharp isolated local maxima well
// above the local background. Stars move across the sensor from frame to
// frame, so a star occupies a given pixel in only a few frames; a hot pixel
// is at the same pixel in (nearly) every frame. Pixels flagged in at least
// `fraction` of the frames (and only for sequences of at least `minFrames`)
// form the hot map. Pass 2 replaces each hot pixel's 3x3 demosaic footprint
// with the per-channel median of the surrounding 16-pixel ring before the
// frame competes in the maximum.

export class InvalidHotPixelInput extends Error {
  constructor(message) { super(message); this.name = 'InvalidHotPixelInput'; }
}

function median(values) {
  const s = [...values].sort((a, b) => a - b); const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const RING = [];
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) RING.push([dx, dy]);
}

/// rgb: Float32Array interleaved (w*h*3). Returns sorted Int32Array of
/// candidate pixel indices.
export function detectStationaryPointCandidates(rgb, width, height, { sigmaK = 8, sharpness = 2.5, maxCandidates = 100000 } = {}) {
  if (rgb.length !== width * height * 3 || width < 5 || height < 5) throw new InvalidHotPixelInput('Invalid image.');
  const L = new Float32Array(width * height);
  for (let i = 0; i < L.length; i++) L[i] = Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  // Robust noise from horizontal first differences on a subsample.
  const diffs = [];
  for (let y = 0; y < height; y += 4) for (let x = 1; x < width; x += 4) diffs.push(L[y * width + x] - L[y * width + x - 1]);
  const med = median(diffs);
  const sigma = Math.max(1e-6, 1.4826 * median(diffs.map((d) => Math.abs(d - med))) / Math.SQRT2);
  const out = [];
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x; const v = L[p];
      let isMax = true; let nSum = 0;
      for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const q = L[(y + dy) * width + x + dx];
        if (q > v || (q === v && (dy < 0 || (dy === 0 && dx < 0)))) { isMax = false; break; }
        nSum += q;
      }
      if (!isMax) continue;
      const ring = RING.map(([dx, dy]) => L[(y + dy) * width + x + dx]);
      const bg = median(ring);
      const peak = v - bg;
      if (!(peak > sigmaK * sigma)) continue;
      const neighbourExcess = Math.max(0, nSum / 8 - bg);
      if (!(peak >= sharpness * neighbourExcess)) continue;
      out.push(p);
      if (out.length >= maxCandidates) return Int32Array.from(out);
    }
  }
  return Int32Array.from(out);
}

/// Hot map from per-frame candidate lists (sorted Int32Array).
export function buildStationaryHotPixelMap(perFrame, { minFrames = 20, fraction = 0.7 } = {}) {
  if (!(fraction > 0 && fraction <= 1) || !(minFrames >= 1)) throw new InvalidHotPixelInput('Invalid parameters.');
  if (perFrame.length < minFrames) return new Int32Array(0);
  const need = Math.max(3, Math.ceil(fraction * perFrame.length));
  const counts = new Map();
  for (const list of perFrame) for (const p of list) counts.set(p, (counts.get(p) ?? 0) + 1);
  const hot = [];
  for (const [p, c] of counts) if (c >= need) hot.push(p);
  hot.sort((a, b) => a - b);
  return Int32Array.from(hot);
}

/// Returns a corrected copy of `rgb` (interleaved) for an image of
/// width x height whose top-left pixel has global index origin (x0, y0) in
/// an image of `imageWidth` columns; `hot` holds global indices.
export function correctHotPixels(rgb, width, height, hot, { x0 = 0, y0 = 0, imageWidth = width } = {}) {
  const out = Float32Array.from(rgb);
  for (const g of hot) {
    const gx = g % imageWidth; const gy = Math.floor(g / imageWidth);
    const x = gx - x0; const y = gy - y0;
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
    for (let c = 0; c < 3; c++) {
      const ring = RING.map(([dx, dy]) => rgb[((y + dy) * width + x + dx) * 3 + c]);
      const m = median(ring);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out[((y + dy) * width + x + dx) * 3 + c] = m;
    }
  }
  return out;
}
