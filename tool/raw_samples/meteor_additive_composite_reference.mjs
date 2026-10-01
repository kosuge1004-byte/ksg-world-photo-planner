// Meteor additive compositing and radiant consistency (Work357) — reference.
//
// The existing compositor takes a per-channel max of the single registered
// meteor frame and the multi-frame background inside a padded mask. Within
// that mask every sky pixel becomes max(background, single-frame noise),
// i.e. a brighter, single-frame-noise band around each meteor; stars in the
// mask double where registration is imperfect.
//
// Additive mode: out = bg + f(d) * shrink(fg - bg - offset)
//  - offset: per-channel median of fg - bg in a ring just outside the mask
//    (sky-level difference between the single frame and the stack);
//  - sigma: per-channel robust spread of the same ring difference;
//  - shrink(e) = e * smoothstep((e - sigma) / (2 sigma)) removes noise-level
//    excess and keeps the meteor (e >> sigma) unchanged;
//  - f(d): 1 within the streak core (half-width + 1 px), smoothly 0 at the
//    padded radius — no hard mask edge.
// Because the excess is taken against the background itself, any faint
// meteor residue that kappa-sigma left in the background is not counted
// twice: in the core out ~= fg - offset.
//
// Parameters are estimated once per streak (global coordinates), so tiled
// application is identical to whole-image application.

function median(v) { const s = Float64Array.from(v).sort(); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px; const qy = ay + t * dy - py; return qx * qx + qy * qy;
}
function smooth(t) { if (t <= 0) return 0; if (t >= 1) return 1; return t * t * (3 - 2 * t); }

/// bg, fg: Float32Array interleaved for a region with origin (x0,y0) and
/// size w x h. streak: {endpoints:[{x,y},{x,y}], width}. Returns
/// {offset:[3], sigma:[3], samples}.
export function estimateAdditiveParameters(bg, fg, w, h, streak, { x0 = 0, y0 = 0, padding = 3, ringWidth = 6, coverage = null } = {}) {
  const [a, b] = streak.endpoints; const R = streak.width / 2 + padding;
  const diffs = [[], [], []];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (coverage && coverage[y * w + x] === 0) continue;
    const d = Math.sqrt(segDist2(x + x0, y + y0, a.x, a.y, b.x, b.y));
    if (d <= R || d > R + ringWidth) continue;
    for (let c = 0; c < 3; c++) diffs[c].push(fg[(y * w + x) * 3 + c] - bg[(y * w + x) * 3 + c]);
  }
  if (diffs[0].length < 20) return { offset: [0, 0, 0], sigma: [Infinity, Infinity, Infinity], samples: diffs[0].length };
  const offset = diffs.map(median);
  const sigma = diffs.map((v, c) => Math.max(1e-9, 1.4826 * median(v.map((e) => Math.abs(e - offset[c])))));
  return { offset, sigma, samples: diffs[0].length };
}

/// In place on dest (bg copy). params from estimateAdditiveParameters.
export function compositeAdditiveInPlace(dest, fg, w, h, streak, params, { x0 = 0, y0 = 0, padding = 3, coverage = null } = {}) {
  const [a, b] = streak.endpoints; const R = streak.width / 2 + padding; const core = streak.width / 2 + 1;
  if (!params.sigma.every(Number.isFinite)) return;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (coverage && coverage[y * w + x] === 0) continue;
    const d = Math.sqrt(segDist2(x + x0, y + y0, a.x, a.y, b.x, b.y));
    if (d > R) continue;
    const f = d <= core ? 1 : 1 - smooth((d - core) / (R - core));
    for (let c = 0; c < 3; c++) {
      const i = (y * w + x) * 3 + c;
      const e = fg[i] - dest[i] - params.offset[c];
      const s = e * smooth((e - params.sigma[c]) / (2 * params.sigma[c]));
      dest[i] += f * s;
    }
  }
}

/// Radiant from streak lines (rectilinear projection maps meteor paths to
/// straight lines through the radiant). RANSAC over pairwise intersections;
/// a streak is consistent when the angle between its line and the direction
/// from its midpoint to the radiant is <= toleranceDeg. Returns
/// {radiant:{x,y}|null, consistent:[bool]}; null unless >= minConsistent.
export function estimateRadiant(streaks, { toleranceDeg = 3, minConsistent = 3 } = {}) {
  const lines = streaks.map((s) => {
    const [a, b] = s.endpoints; const dx = b.x - a.x; const dy = b.y - a.y; const l = Math.hypot(dx, dy);
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ux: dx / l, uy: dy / l };
  });
  const tol = Math.sin(toleranceDeg * Math.PI / 180);
  const consistentWith = (px, py) => lines.map((L) => {
    const vx = px - L.mx; const vy = py - L.my; const dist = Math.hypot(vx, vy);
    if (dist < 1e-9) return true;
    return Math.abs(vx * L.uy - vy * L.ux) / dist <= tol; // |sin(angle)|
  });
  let best = null; let bestCount = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i]; const B = lines[j];
    const den = A.ux * B.uy - A.uy * B.ux;
    if (Math.abs(den) < 1e-6) continue;
    const t = ((B.mx - A.mx) * B.uy - (B.my - A.my) * B.ux) / den;
    const px = A.mx + t * A.ux; const py = A.my + t * A.uy;
    const count = consistentWith(px, py).filter(Boolean).length;
    if (count > bestCount) { bestCount = count; best = { x: px, y: py }; }
  }
  if (!best || bestCount < minConsistent) return { radiant: null, consistent: lines.map(() => false) };
  return { radiant: best, consistent: consistentWith(best.x, best.y) };
}
