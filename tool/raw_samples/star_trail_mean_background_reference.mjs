// Star-trail mean background + maximum trails (Work356) — Node reference.
//
// A per-pixel maximum over N noisy frames lifts the sky to the upper tail of
// the noise (about +2.5 sigma at N=100) and keeps single-frame noise
// texture, while the per-pixel mean has sqrt(N)-times lower noise. Given
// the rolling maximum M and the mean A, the excess e = M - A is small and
// noise-like on the sky and large on trails. The combination
//   out = A + w(e) * (M - A)
// keeps M on trails (w = 1) and A on the sky (w = 0). w ramps smoothly
// from 0 to 1 between thresholds derived from the excess distribution of
// pixels at a similar mean level (median + 3 / + 6 robust sigmas), so the
// rule adapts to shot noise without a noise model. One w per pixel (from
// luminance) keeps trail colours intact.

function median(v) { const s = Float64Array.from(v).sort(); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }

/// mean, max: Float32Array interleaved RGB. Returns {bins: [{lo, hi, med, sigma}], edges}.
export function excessStatistics(mean, max, { bins = 32, stride = 4, minPerBin = 50 } = {}) {
  const lum = []; const ex = [];
  const pixels = mean.length / 3;
  for (let p = 0; p < pixels; p += stride) {
    const a = (mean[p * 3] + mean[p * 3 + 1] + mean[p * 3 + 2]) / 3;
    const m = (max[p * 3] + max[p * 3 + 1] + max[p * 3 + 2]) / 3;
    lum.push(a); ex.push(m - a);
  }
  const order = lum.map((_, i) => i).sort((i, j) => lum[i] - lum[j]);
  const per = Math.max(minPerBin, Math.ceil(order.length / bins));
  const out = [];
  for (let start = 0; start < order.length; start += per) {
    const idx = order.slice(start, start + per);
    if (idx.length < minPerBin && out.length > 0) { // merge tail into previous bin
      const prev = out[out.length - 1]; prev.members.push(...idx); continue;
    }
    out.push({ members: [...idx] });
  }
  return out.map((b) => {
    const e = b.members.map((i) => ex[i]);
    const med = median(e);
    const sigma = Math.max(1e-9, 1.4826 * median(e.map((v) => Math.abs(v - med))));
    return { lo: lum[b.members[0]], med, sigma };
  });
}

function binFor(stats, a) {
  let k = 0;
  while (k + 1 < stats.length && a >= stats[k + 1].lo) k++;
  return stats[k];
}

export function rampWeight(e, med, sigma, lowK = 3, highK = 6) {
  const t = (e - (med + lowK * sigma)) / ((highK - lowK) * sigma);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

export function combineMeanAndMax(mean, max, stats, opts = {}) {
  const out = new Float32Array(mean.length);
  for (let p = 0; p < mean.length / 3; p++) {
    const a = (mean[p * 3] + mean[p * 3 + 1] + mean[p * 3 + 2]) / 3;
    const m = (max[p * 3] + max[p * 3 + 1] + max[p * 3 + 2]) / 3;
    const b = binFor(stats, a);
    const w = rampWeight(m - a, b.med, b.sigma, opts.lowK, opts.highK);
    for (let c = 0; c < 3; c++) out[p * 3 + c] = mean[p * 3 + c] + w * (max[p * 3 + c] - mean[p * 3 + c]);
  }
  return out;
}
