// Synthetic fixed-tripod night-sky sequence (Work351 test fixture).
//
// Stars are random directions on the celestial sphere. Every frame rotates
// them about the celestial pole (sidereal rate) and projects them through a
// rectilinear lens (focal length in pixels) with one radial distortion term
// k1, which is the physically correct image-plane motion for a camera fixed
// on a tripod. Centroid noise, per-frame detection dropout and an optional
// starless foreground band are simulated. Each detected star keeps its
// catalogue `id`, which tests use as ground truth. Deterministic.

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { const u = r() || 1e-12; const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function rotateAboutAxis(axis, angle) {
  const [x, y, z] = axis; const c = Math.cos(angle); const s = Math.sin(angle); const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}
function apply(M, v) { return M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]); }

export function makeFixedTripodSkySequence({
  width = 6000, height = 4000, focalPx = 2333, latitudeDeg = 35, altitudeDeg = 25, azimuthDeg = 160,
  starCount = 6000, frames = 40, intervalSec = 20, k1 = -0.02, centroidNoise = 0.15, dropout = 0.1,
  foregroundFraction = 0, seed = 7,
} = {}) {
  const r = rng(seed);
  const alt = altitudeDeg * Math.PI / 180; const az = azimuthDeg * Math.PI / 180;
  const forward = [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
  const right = [Math.cos(az), -Math.sin(az), 0];
  const up = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];
  const lat = latitudeDeg * Math.PI / 180;
  const pole = [0, Math.cos(lat), Math.sin(lat)];
  const catalogue = [];
  for (let i = 0; i < starCount; i++) {
    let v = [gauss(r), gauss(r), gauss(r)]; const n = Math.hypot(...v); v = v.map((x) => x / n);
    catalogue.push({ v, flux: Math.exp(-3 * r()) * r() * r() });
  }
  const sequence = [];
  for (let f = 0; f < frames; f++) {
    const R = rotateAboutAxis(pole, -(f * intervalSec) * 2 * Math.PI / 86164);
    const stars = [];
    catalogue.forEach((star, id) => {
      const w = apply(R, star.v);
      const cz = w[0] * forward[0] + w[1] * forward[1] + w[2] * forward[2];
      if (cz <= 0.1) return;
      const cx = w[0] * right[0] + w[1] * right[1] + w[2] * right[2];
      const cy = -(w[0] * up[0] + w[1] * up[1] + w[2] * up[2]);
      let xn = cx / cz; let yn = cy / cz;
      const rr = (xn * xn + yn * yn) * focalPx * focalPx / ((width / 2) ** 2);
      if (rr > 2.5) return;
      const d = 1 + k1 * rr; xn *= d; yn *= d;
      const x = width / 2 + focalPx * xn + centroidNoise * gauss(r);
      const y = height / 2 + focalPx * yn + centroidNoise * gauss(r);
      if (x < 8 || y < 8 || x > width - 9 || y > height * (1 - foregroundFraction) - 9) return;
      if (r() < dropout) return;
      stars.push({ x, y, flux: star.flux * (1 + 0.1 * gauss(r)), id });
    });
    stars.sort((a, b) => b.flux - a.flux);
    sequence.push(stars);
  }
  return sequence;
}
