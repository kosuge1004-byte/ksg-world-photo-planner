// Guided whole-field star registration (Work351) — Node reference.
//
// Why: estimateSimilarityTransform's global model is rigid (rotation +
// translation). For a fixed tripod the diurnal sky motion seen through a
// rectilinear lens is a homography (K R K^-1) plus lens distortion. With a
// 3 px acceptance radius the rigid fit only explains a narrow band of the
// field, so as the time distance to the reference grows the inlier set
// collapses to that band (Work350 device log: 6-12 matches, 1 quadrant,
// matchSpanY 0.3-9 %). The degree-2 local correction then never has its 24
// required matches, and the corners are resampled with multi-pixel error.
//
// What: starting from the rigid estimate, grow the correspondence set over
// the whole field with progressively more capable models (affine ->
// homography -> homography + quadratic residual) and progressively tighter
// radii. Radii wider than the caller's strict radius are only used together
// with a nearest/second-nearest ratio test. The returned match set is always
// selected with the strict `toleranceRadius`, so every downstream quality
// gate keeps its thresholds. The returned global model is the homography;
// the remaining lens-distortion residual is left to the existing degree-2
// local residual correction (same resampler, same safety checks).

export class GuidedFieldRegistrationFailed extends Error {
  constructor(message) { super(message); this.name = 'GuidedFieldRegistrationFailed'; }
}

export class InvalidGuidedFieldRegistrationInput extends Error {
  constructor(message) { super(message); this.name = 'InvalidGuidedFieldRegistrationInput'; }
}

function solve(ata, atb) {
  const n = atb.length;
  const m = ata.map((row, i) => [...row, atb[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (!(Math.abs(m[p][c]) > 1e-12)) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const out = m.map((row, i) => row[n] / row[i]);
  return out.every(Number.isFinite) ? out : null;
}

function leastSquares(rows, rhs, terms) {
  const ata = Array.from({ length: terms }, () => new Array(terms).fill(0));
  const atb = new Array(terms).fill(0);
  for (let k = 0; k < rows.length; k++) {
    const a = rows[k];
    for (let i = 0; i < terms; i++) {
      atb[i] += a[i] * rhs[k];
      for (let j = i; j < terms; j++) ata[i][j] += a[i] * a[j];
    }
  }
  for (let i = 0; i < terms; i++) for (let j = 0; j < i; j++) ata[i][j] = ata[j][i];
  return solve(ata, atb);
}

// Models operate on normalized coordinates u = (x - cx)/s, v = (y - cy)/s
// for the reference and the same normalization for the target.
// kind: 'affine' | 'homography'; optional `poly` = degree-2 residual in
// normalized target units.
function normalize(frame, x, y) { return [(x - frame.cx) / frame.s, (y - frame.cy) / frame.s]; }

function predictNormalized(model, u, v) {
  const h = model.h;
  const w = h[6] * u + h[7] * v + 1;
  let pu = (h[0] * u + h[1] * v + h[2]) / w;
  let pv = (h[3] * u + h[4] * v + h[5]) / w;
  if (model.poly) {
    const b = [1, u, v, u * u, u * v, v * v];
    for (let i = 0; i < 6; i++) { pu += b[i] * model.poly.x[i]; pv += b[i] * model.poly.y[i]; }
  }
  return [pu, pv];
}

function predict(model, frame, x, y) {
  const [u, v] = normalize(frame, x, y);
  const [pu, pv] = predictNormalized(model, u, v);
  return { x: pu * frame.s + frame.cx, y: pv * frame.s + frame.cy };
}

function fitAffine(pairs) {
  const rows = pairs.map((p) => [p.u, p.v, 1]);
  const hx = leastSquares(rows, pairs.map((p) => p.tu), 3);
  const hy = leastSquares(rows, pairs.map((p) => p.tv), 3);
  if (!hx || !hy) return null;
  return { kind: 'affine', h: [hx[0], hx[1], hx[2], hy[0], hy[1], hy[2], 0, 0], poly: null };
}

// Linearized DLT with h22 = 1, then Gauss-Newton on the true reprojection
// error (3 iterations) because the linearization is weighted by w.
function fitHomography(pairs, seed) {
  const rows = []; const rhs = [];
  for (const p of pairs) {
    rows.push([p.u, p.v, 1, 0, 0, 0, -p.u * p.tu, -p.v * p.tu]); rhs.push(p.tu);
    rows.push([0, 0, 0, p.u, p.v, 1, -p.u * p.tv, -p.v * p.tv]); rhs.push(p.tv);
  }
  let h = leastSquares(rows, rhs, 8);
  if (!h) return null;
  for (let it = 0; it < 3; it++) {
    const jr = []; const rr = [];
    for (const p of pairs) {
      const w = h[6] * p.u + h[7] * p.v + 1;
      if (!(w > 0.2)) return null;
      const px = (h[0] * p.u + h[1] * p.v + h[2]) / w;
      const py = (h[3] * p.u + h[4] * p.v + h[5]) / w;
      jr.push([p.u / w, p.v / w, 1 / w, 0, 0, 0, -p.u * px / w, -p.v * px / w]); rr.push(p.tu - px);
      jr.push([0, 0, 0, p.u / w, p.v / w, 1 / w, -p.u * py / w, -p.v * py / w]); rr.push(p.tv - py);
    }
    const delta = leastSquares(jr, rr, 8);
    if (!delta) break;
    h = h.map((value, i) => value + delta[i]);
    if (Math.max(...delta.map(Math.abs)) < 1e-12) break;
  }
  if (!h.every(Number.isFinite)) return null;
  return { kind: 'homography', h, poly: null };
}

function fitPolyResidual(base, pairs) {
  const rows = pairs.map((p) => [1, p.u, p.v, p.u * p.u, p.u * p.v, p.v * p.v]);
  const bare = { ...base, poly: null };
  const res = pairs.map((p) => predictNormalized(bare, p.u, p.v));
  const x = leastSquares(rows, pairs.map((p, i) => p.tu - res[i][0]), 6);
  const y = leastSquares(rows, pairs.map((p, i) => p.tv - res[i][1]), 6);
  if (!x || !y) return null;
  return { ...base, poly: { x, y } };
}

function residualPx(model, frame, p) {
  const [pu, pv] = predictNormalized(model, p.u, p.v);
  return Math.hypot(pu - p.tu, pv - p.tv) * frame.s;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function robust(fit, pairs, frame, { residualFloorPx, minKeep }) {
  let active = pairs;
  let model = null;
  for (let iteration = 0; iteration < 4; iteration++) {
    if (active.length < minKeep) return null;
    model = fit(active);
    if (!model) return null;
    const res = active.map((p) => residualPx(model, frame, p));
    const med = median(res);
    const mad = median(res.map((r) => Math.abs(r - med)));
    const limit = Math.max(residualFloorPx, med + 3 * 1.4826 * mad);
    const kept = active.filter((p, i) => res[i] <= limit);
    if (kept.length === active.length) break;
    active = kept;
  }
  return model;
}

function buildGrid(stars, cell) {
  const grid = new Map();
  stars.forEach((s, i) => {
    const key = `${Math.floor(s.x / cell)}:${Math.floor(s.y / cell)}`;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(i);
  });
  return grid;
}

function nearestTwo(grid, cell, stars, x, y, radius) {
  const reach = Math.ceil(radius / cell);
  const gx = Math.floor(x / cell); const gy = Math.floor(y / cell);
  let best = -1; let bestD = Infinity; let secondD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const bucket = grid.get(`${gx + dx}:${gy + dy}`);
      if (!bucket) continue;
      for (const i of bucket) {
        const d = Math.hypot(stars[i].x - x, stars[i].y - y);
        if (d < bestD || (d === bestD && i < best)) { secondD = bestD; bestD = d; best = i; } else if (d < secondD) { secondD = d; }
      }
    }
  }
  return { index: best, distance: bestD, secondDistance: secondD };
}

function guidedMatch(model, frame, referenceStars, targetStars, grid, cell, radius, ratio) {
  const byTarget = new Map();
  referenceStars.forEach((r, referenceIndex) => {
    const q = predict(model, frame, r.x, r.y);
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return;
    const n = nearestTwo(grid, cell, targetStars, q.x, q.y, radius);
    if (n.index < 0 || n.distance > radius) return;
    if (ratio < 1 && !(n.distance <= ratio * n.secondDistance)) return;
    const prev = byTarget.get(n.index);
    if (!prev || n.distance < prev.distance || (n.distance === prev.distance && referenceIndex < prev.referenceIndex)) {
      byTarget.set(n.index, { referenceIndex, targetIndex: n.index, distance: n.distance });
    }
  });
  return [...byTarget.values()].sort((a, b) => a.referenceIndex - b.referenceIndex);
}

function spanOk(pairs, frame, fraction) {
  if (pairs.length === 0) return false;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const p of pairs) { minX = Math.min(minX, p.rx); maxX = Math.max(maxX, p.rx); minY = Math.min(minY, p.ry); maxY = Math.max(maxY, p.ry); }
  return maxX - minX >= fraction * frame.width && maxY - minY >= fraction * frame.height;
}

function rigidModel(initial, frame) {
  const t = initial.rotationDegrees * Math.PI / 180;
  const c = Math.cos(t); const s = Math.sin(t);
  const m02 = initial.centerX - c * initial.centerX + s * initial.centerY + initial.sourceOffsetX;
  const m12 = initial.centerY - s * initial.centerX - c * initial.centerY + initial.sourceOffsetY;
  return { kind: 'affine', h: pixelAffineToNormalized({ m00: c, m01: -s, m02, m10: s, m11: c, m12 }, frame), poly: null };
}

function pixelAffineToNormalized(a, frame) {
  // x' = m00 x + m01 y + m02 with x = s u + cx; u' = (x' - cx)/s.
  return [
    a.m00, a.m01, (a.m00 * frame.cx + a.m01 * frame.cy + a.m02 - frame.cx) / frame.s,
    a.m10, a.m11, (a.m10 * frame.cx + a.m11 * frame.cy + a.m12 - frame.cy) / frame.s,
    0, 0,
  ];
}

/// Converts a normalized homography into pixel coordinates:
/// sourceX = (p00 x + p01 y + p02) / (p20 x + p21 y + 1), etc.
export function normalizedHomographyToPixel(h, frame) {
  // T maps pixels -> normalized: [1/s,0,-cx/s; 0,1/s,-cy/s; 0,0,1].
  // H_pix = T^-1 * H * T, then scale so that p22 = 1.
  const s = frame.s; const cx = frame.cx; const cy = frame.cy;
  const H = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  const T = [[1 / s, 0, -cx / s], [0, 1 / s, -cy / s], [0, 0, 1]];
  const Ti = [[s, 0, cx], [0, s, cy], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((acc, a, k) => acc + a * B[k][j], 0)));
  const P = mul(mul(Ti, H), T);
  const z = P[2][2];
  return {
    m00: P[0][0] / z, m01: P[0][1] / z, m02: P[0][2] / z,
    m10: P[1][0] / z, m11: P[1][1] / z, m12: P[1][2] / z,
    p20: P[2][0] / z, p21: P[2][1] / z,
  };
}

export function applyPixelHomography(t, x, y) {
  const w = t.p20 * x + t.p21 * y + 1;
  return { x: (t.m00 * x + t.m01 * y + t.m02) / w, y: (t.m10 * x + t.m11 * y + t.m12) / w };
}

/// Rejects transforms a fixed-camera sequence cannot produce: local scale
/// (Jacobian determinant) at the frame center outside [0.8, 1.25], perspective
/// terms beyond `maxTilt` per pixel, or a projective denominator outside
/// (0.5, 2) at any frame corner (fold / extreme perspective).
export function assertPlausibleFixedCameraTransform(t, width, height, maxTilt) {
  if (Math.abs(t.p20) > maxTilt || Math.abs(t.p21) > maxTilt) {
    throw new GuidedFieldRegistrationFailed('Perspective terms are implausibly large.');
  }
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    const w = t.p20 * x + t.p21 * y + 1;
    if (!(w > 0.5 && w < 2)) throw new GuidedFieldRegistrationFailed('Homography folds or explodes inside the frame.');
  }
  const cx = (width - 1) / 2; const cy = (height - 1) / 2;
  const det = jacobianDeterminant(t, cx, cy);
  if (!(det > 0.8 && det < 1.25)) {
    throw new GuidedFieldRegistrationFailed(`Center scale ${det} is implausible for a fixed-camera sequence.`);
  }
}

export function jacobianDeterminant(t, x, y) {
  const w = t.p20 * x + t.p21 * y + 1;
  const nx = t.m00 * x + t.m01 * y + t.m02;
  const ny = t.m10 * x + t.m11 * y + t.m12;
  const a = (t.m00 * w - nx * t.p20) / (w * w);
  const b = (t.m01 * w - nx * t.p21) / (w * w);
  const c = (t.m10 * w - ny * t.p20) / (w * w);
  const d = (t.m11 * w - ny * t.p21) / (w * w);
  return a * d - b * c;
}

function pixelHomographyToNormalized(t, frame) {
  // H_norm = T * H_pix * T^-1, rescaled so that h22 = 1.
  const s = frame.s; const cx = frame.cx; const cy = frame.cy;
  const P = [[t.m00, t.m01, t.m02], [t.m10, t.m11, t.m12], [t.p20, t.p21, 1]];
  const T = [[1 / s, 0, -cx / s], [0, 1 / s, -cy / s], [0, 0, 1]];
  const Ti = [[s, 0, cx], [0, s, cy], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((acc, a, k) => acc + a * B[k][j], 0)));
  const H = mul(mul(T, P), Ti);
  const z = H[2][2];
  return [H[0][0] / z, H[0][1] / z, H[0][2] / z, H[1][0] / z, H[1][1] / z, H[1][2] / z, H[2][0] / z, H[2][1] / z];
}

/// Refines an initial estimate into a whole-field homography and a strict
/// whole-field correspondence set. `initial` is either the rigid result of
/// estimateSimilarityTransform or a pixel homography `{m00..m12, p20, p21}`
/// (e.g. the already-refined model of the temporally adjacent frame).
/// See the file comment.
///
/// Options: imageWidth, imageHeight (required), toleranceRadius (3),
/// guidedRadii ([24, 12, 6]), ratioTest (0.5), minInliers (5),
/// minAffineMatches (8), minHomographyMatches (12),
/// minPolyMatches (24), minModelSpanFraction (0.35), maxGrowthIterations (4),
/// maxPerspectiveTiltPerPixel (5e-5).
export function refineGuidedFieldRegistration(referenceStars, targetStars, initial, options = {}) {
  const imageWidth = options.imageWidth;
  const imageHeight = options.imageHeight;
  const toleranceRadius = options.toleranceRadius ?? 3;
  const guidedRadii = options.guidedRadii ?? [24, 12, 6];
  const ratioTest = options.ratioTest ?? 0.5;
  const minInliers = options.minInliers ?? 5;
  const minAffineMatches = options.minAffineMatches ?? 8;
  const minHomographyMatches = options.minHomographyMatches ?? 12;
  const minPolyMatches = options.minPolyMatches ?? 24;
  const minModelSpanFraction = options.minModelSpanFraction ?? 0.35;
  const maxGrowthIterations = options.maxGrowthIterations ?? 4;
  const maxPerspectiveTiltPerPixel = options.maxPerspectiveTiltPerPixel ?? 5e-5;
  if (!Number.isInteger(imageWidth) || imageWidth <= 0 || !Number.isInteger(imageHeight) || imageHeight <= 0) {
    throw new InvalidGuidedFieldRegistrationInput('imageWidth/imageHeight must be positive integers.');
  }
  if (!(toleranceRadius > 0) || guidedRadii.length === 0 || !guidedRadii.every((r) => r > toleranceRadius)
      || !(ratioTest > 0 && ratioTest < 1) || !(minInliers >= 3)
      || !(minAffineMatches >= 4) || !(minHomographyMatches >= 8) || !(minPolyMatches >= 12)
      || !(minModelSpanFraction > 0 && minModelSpanFraction <= 1)
      || !(maxGrowthIterations >= 1) || !(maxPerspectiveTiltPerPixel > 0)) {
    throw new InvalidGuidedFieldRegistrationInput('Guided registration parameters are invalid.');
  }
  for (const list of [referenceStars, targetStars]) {
    for (const s of list) {
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) throw new InvalidGuidedFieldRegistrationInput('Star coordinates must be finite.');
    }
  }
  const seedIsProjective = initial != null && 'p20' in initial;
  const seedKeys = seedIsProjective
    ? ['m00', 'm01', 'm02', 'm10', 'm11', 'm12', 'p20', 'p21']
    : ['rotationDegrees', 'sourceOffsetX', 'sourceOffsetY', 'centerX', 'centerY'];
  for (const k of seedKeys) {
    if (!Number.isFinite(initial?.[k])) throw new InvalidGuidedFieldRegistrationInput(`initial.${k} must be finite.`);
  }

  const frame = { cx: (imageWidth - 1) / 2, cy: (imageHeight - 1) / 2, s: Math.max(imageWidth, imageHeight) / 2, width: imageWidth, height: imageHeight };
  const cell = Math.max(...guidedRadii);
  const grid = buildGrid(targetStars, cell);
  const toPairs = (matches) => matches.map((m) => {
    const r = referenceStars[m.referenceIndex]; const t = targetStars[m.targetIndex];
    const [u, v] = normalize(frame, r.x, r.y); const [tu, tv] = normalize(frame, t.x, t.y);
    return { rx: r.x, ry: r.y, u, v, tu, tv };
  });
  const floor = toleranceRadius / 3;

  let model = seedIsProjective
    ? { kind: 'homography', h: pixelHomographyToNormalized(initial, frame), poly: null }
    : rigidModel(initial, frame);
  const stages = [];
  let matches = [];
  for (const radius of [...guidedRadii, toleranceRadius]) {
    const ratio = radius > toleranceRadius ? ratioTest : 1;
    let previous = -1;
    for (let iteration = 0; iteration < maxGrowthIterations; iteration++) {
      matches = guidedMatch(model, frame, referenceStars, targetStars, grid, cell, radius, ratio);
      const pairs = toPairs(matches);
      const spread = spanOk(pairs, frame, minModelSpanFraction);
      let next = null;
      if (spread && pairs.length >= minHomographyMatches) {
        next = robust((p) => fitHomography(p), pairs, frame, { residualFloorPx: floor, minKeep: minHomographyMatches });
        if (next && spread && pairs.length >= minPolyMatches) {
          const withPoly = robust((p) => {
            const base = fitHomography(p);
            return base ? fitPolyResidual(base, p) : null;
          }, pairs, frame, { residualFloorPx: floor, minKeep: minPolyMatches });
          if (withPoly) next = withPoly;
        }
      }
      if (!next && pairs.length >= minAffineMatches) {
        next = robust((p) => fitAffine(p), pairs, frame, { residualFloorPx: floor, minKeep: minAffineMatches });
      }
      if (next) model = next;
      stages.push({ radius, iteration, matchCount: matches.length, kind: model.kind, poly: Boolean(model.poly) });
      if (matches.length === previous) break;
      previous = matches.length;
    }
  }

  matches = guidedMatch(model, frame, referenceStars, targetStars, grid, cell, toleranceRadius, 1);
  if (matches.length < minInliers) {
    throw new GuidedFieldRegistrationFailed(`Only ${matches.length} strict matches after guided refinement (need ${minInliers}).`);
  }
  const pairs = toPairs(matches);
  // Global model for resampling: homography when supported, else affine.
  let global = spanOk(pairs, frame, minModelSpanFraction) && pairs.length >= minHomographyMatches ? fitHomography(pairs) : null;
  if (!global) global = fitAffine(pairs);
  if (!global) throw new GuidedFieldRegistrationFailed('Global refit is singular.');
  const pixel = normalizedHomographyToPixel(global.h, frame);
  assertPlausibleFixedCameraTransform(pixel, imageWidth, imageHeight, maxPerspectiveTiltPerPixel);
  const rms = Math.sqrt(pairs.reduce((sum, p) => sum + residualPx(global, frame, p) ** 2, 0) / pairs.length);
  return {
    transform: pixel,
    projective: global.kind === 'homography',
    matches: matches.map((m) => ({ referenceIndex: m.referenceIndex, targetIndex: m.targetIndex, distance: m.distance })),
    inlierCount: matches.length,
    rmsResidual: rms,
    stages,
  };
}

/// Spatially distributed selection from a star list: the image is divided
/// into `columns` x `rows` cells; each cell contributes up to `perCellQuota`
/// of its brightest stars in round-robin rank order; any remaining budget is
/// filled by global brightness. Returned flux-sorted descending (ties by
/// input index) because estimateSimilarityTransform's hypothesis search
/// uses the brightest entries first.
export function selectSpatiallyDistributedStars(stars, { imageWidth, imageHeight, columns = 8, rows = 6, perCellQuota = 12, limit = 400 } = {}) {
  if (!Number.isInteger(imageWidth) || imageWidth <= 0 || !Number.isInteger(imageHeight) || imageHeight <= 0
      || !Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1
      || !Number.isInteger(perCellQuota) || perCellQuota < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new InvalidGuidedFieldRegistrationInput('Spatial star selection parameters are invalid.');
  }
  const order = stars.map((_, i) => i).sort((a, b) => (stars[b].flux - stars[a].flux) || (a - b));
  const cells = Array.from({ length: columns * rows }, () => []);
  for (const i of order) {
    const s = stars[i];
    const c = Math.min(columns - 1, Math.max(0, Math.floor((s.x / imageWidth) * columns)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((s.y / imageHeight) * rows)));
    cells[r * columns + c].push(i);
  }
  const chosen = new Set();
  for (let rank = 0; rank < perCellQuota && chosen.size < limit; rank++) {
    for (const cell of cells) if (rank < cell.length && chosen.size < limit) chosen.add(cell[rank]);
  }
  for (const i of order) { if (chosen.size >= limit) break; chosen.add(i); }
  return [...chosen].sort((a, b) => (stars[b].flux - stars[a].flux) || (a - b)).map((i) => stars[i]);
}

/// Whole-field coverage gate (Work351, guided mode only).
///
/// The frame's matched reference stars must cover the part of the field in
/// which the reference frame itself has stars. This is relative to the
/// reference on purpose: a landscape foreground (no stars in the lower part
/// of the frame) must not reject every frame.
///
/// - `minimumMatches` (12): absolute floor on strict matches.
/// - `minimumSpanRatio` (0.7): matched span / reference-star span, per axis.
/// - `minimumQuadrantShare` (0.08): a quadrant is "supported" when it holds
///   at least this share of the reference stars; every supported quadrant
///   must contain at least one match.
///
/// Returns `{passed, reasons, supportedQuadrants, matchedQuadrants,
/// spanXRatio, spanYRatio}`.
export function evaluateRegistrationCoverageGate({
  matches, referenceStars, imageWidth, imageHeight,
  minimumMatches = 12, minimumSpanRatio = 0.7, minimumQuadrantShare = 0.08,
}) {
  if (!Number.isInteger(imageWidth) || imageWidth <= 0 || !Number.isInteger(imageHeight) || imageHeight <= 0
      || !Number.isInteger(minimumMatches) || minimumMatches < 1
      || !(minimumSpanRatio > 0 && minimumSpanRatio <= 1)
      || !(minimumQuadrantShare > 0 && minimumQuadrantShare < 1)) {
    throw new InvalidGuidedFieldRegistrationInput('Coverage gate parameters are invalid.');
  }
  const cx = (imageWidth - 1) * 0.5; const cy = (imageHeight - 1) * 0.5;
  const quadrantOf = (s) => (s.y >= cy ? 2 : 0) + (s.x >= cx ? 1 : 0);
  const span = (stars) => {
    if (stars.length === 0) return { x: 0, y: 0 };
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const s of stars) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y); }
    return { x: maxX - minX, y: maxY - minY };
  };
  const counts = [0, 0, 0, 0];
  for (const s of referenceStars) counts[quadrantOf(s)]++;
  const supported = [0, 1, 2, 3].filter((q) => referenceStars.length > 0 && counts[q] >= minimumQuadrantShare * referenceStars.length);
  const matched = new Set();
  const matchedStars = matches.map((m) => {
    const s = referenceStars[m.referenceIndex];
    if (!s) throw new RangeError(`match.referenceIndex ${m.referenceIndex} out of range`);
    matched.add(quadrantOf(s));
    return s;
  });
  const referenceSpan = span(referenceStars);
  const matchedSpan = span(matchedStars);
  const spanXRatio = referenceSpan.x > 0 ? matchedSpan.x / referenceSpan.x : 1;
  const spanYRatio = referenceSpan.y > 0 ? matchedSpan.y / referenceSpan.y : 1;
  const reasons = [];
  if (matches.length < minimumMatches) reasons.push(`matches ${matches.length} < ${minimumMatches}`);
  if (spanXRatio < minimumSpanRatio) reasons.push(`span X ratio ${spanXRatio.toFixed(3)} < ${minimumSpanRatio}`);
  if (spanYRatio < minimumSpanRatio) reasons.push(`span Y ratio ${spanYRatio.toFixed(3)} < ${minimumSpanRatio}`);
  const missing = supported.filter((q) => !matched.has(q));
  if (missing.length > 0) reasons.push(`no matches in supported quadrant(s) ${missing.join(',')}`);
  return { passed: reasons.length === 0, reasons, supportedQuadrants: supported, matchedQuadrants: [...matched].sort(), spanXRatio, spanYRatio };
}

/// Registration order for guided mode: outward from the reference, each
/// frame seeded by its temporally adjacent (already registered) neighbour.
/// Returns `[{index, neighbour}]` where `neighbour` is the adjacent index on
/// the reference side.
export function guidedRegistrationOrder(frameCount, referenceIndex) {
  if (!Number.isInteger(frameCount) || frameCount < 1 || !Number.isInteger(referenceIndex)
      || referenceIndex < 0 || referenceIndex >= frameCount) {
    throw new InvalidGuidedFieldRegistrationInput('Invalid registration order input.');
  }
  const order = [];
  for (let i = referenceIndex + 1; i < frameCount; i++) order.push({ index: i, neighbour: i - 1 });
  for (let i = referenceIndex - 1; i >= 0; i--) order.push({ index: i, neighbour: i + 1 });
  return order;
}

/// Guided-mode automatic reference preference: among candidates whose
/// intrinsic quality is within `qualityTolerance` (relative) of the best,
/// prefer the one closest to the temporal center of the sequence. The
/// relative order of all other candidates is preserved.
export function preferTemporalCenterReference(rankedIndices, qualityByIndex, frameCount, qualityTolerance = 0.03) {
  if (rankedIndices.length === 0) return [];
  const best = qualityByIndex.get(rankedIndices[0]);
  const center = (frameCount - 1) / 2;
  const near = rankedIndices.filter((i) => qualityByIndex.get(i) >= best * (1 - qualityTolerance));
  const rest = rankedIndices.filter((i) => !near.includes(i));
  near.sort((a, b) => (Math.abs(a - center) - Math.abs(b - center)) || (a - b));
  return [...near, ...rest];
}
