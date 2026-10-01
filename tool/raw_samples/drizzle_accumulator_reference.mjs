/// Reference drizzle accumulator for Mobile Stack.
///
/// A color-agnostic, flux-conserving "shift-and-add with area-weighted
/// footprint splatting" accumulator: the standard drizzle algorithm
/// (Fruchter & Hook), applied here to whatever scalar values the caller
/// supplies — a single CFA color's raw samples, a demosaiced channel, or
/// anything else on a regular pixel grid. CFA-specific combination (only
/// mixing same-colored Bayer samples across frames) is a thin caller-side
/// concern: run one accumulator per color and feed it only that color's
/// samples. See `cfa_drizzle_reference.mjs` for that wrapper.
///
/// Coordinate convention, matching the rest of this project (e.g. the
/// star detector's sub-pixel centroids): integer coordinates are pixel
/// *centers*, so pixel index `i` occupies the continuous half-open
/// interval `[i - 0.5, i + 0.5)`.
///
/// Each input sample becomes a square "drop" — of half-width/half-height
/// `dropRadius` output-grid pixels — centered at the sample's computed
/// sub-pixel position on the output grid. The drop's flux is distributed
/// across every output pixel it overlaps, weighted by the exact overlap
/// area, so total flux is conserved (a drop entirely inside one output
/// pixel contributes there in full; a drop straddling a boundary splits
/// proportionally to the overlap).
///
/// Two splatting methods are available:
/// - `addDrop`: an axis-aligned square drop, using a fast closed-form
///   rectangle-vs-rectangle overlap.
/// - `addRotatedDrop`: a drop rotated to match the source frame's own
///   registration rotation, using exact polygon clipping (Sutherland-
///   Hodgman) against each output pixel's unit square. This is the
///   image-quality-correct choice whenever a frame carries a nonzero
///   rotation: a real input pixel's footprint on the output grid *is*
///   rotated by exactly that amount, and treating it as axis-aligned
///   instead measurably mis-distributes flux for any rotation large
///   enough for the drop's corners to sweep into a different output
///   pixel than the unrotated approximation would predict. `cfa_drizzle_
///   reference.mjs` always uses `addRotatedDrop`, deriving each source
///   sample's local rotation directly from its frame's own forward
///   transform (see that module) rather than assuming rotation is
///   always negligible. `addDrop` remains available as the cheaper,
///   exactly-equivalent special case when the caller already knows the
///   rotation is exactly zero (e.g. the reference frame in a drizzle
///   stack, which never needs to be transformed at all).

export class InvalidDrizzleInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDrizzleInput';
  }
}

function overlap1D(aMin, aMax, bMin, bMax) {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
}

/// Clips convex polygon `points` (an array of `[x, y]` vertices, in
/// order) against a single half-plane, keeping the side where
/// `inside(point)` is true. Standard single-edge Sutherland-Hodgman
/// step: a polygon clipped against each of a clip rectangle's 4 edges in
/// turn (see `clipPolygonToPixel`) yields the exact intersection
/// polygon, since both the input drop and the clip window are convex.
function clipPolygonHalfPlane(points, inside, intersect) {
  if (points.length === 0) return points;
  const output = [];
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const previous = points[(i - 1 + points.length) % points.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside) {
      if (!previousInside) output.push(intersect(previous, current));
      output.push(current);
    } else if (previousInside) {
      output.push(intersect(previous, current));
    }
  }
  return output;
}

function intersectVerticalLine(a, b, x) {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + t * (b[1] - a[1])];
}

function intersectHorizontalLine(a, b, y) {
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), y];
}

/// Clips convex polygon `points` against the axis-aligned rectangle
/// `[left, right] x [top, bottom]`, returning the (possibly empty)
/// intersection polygon's vertices.
function clipPolygonToPixel(points, left, right, top, bottom) {
  let clipped = points;
  clipped = clipPolygonHalfPlane(
    clipped,
    (p) => p[0] >= left,
    (a, b) => intersectVerticalLine(a, b, left),
  );
  clipped = clipPolygonHalfPlane(
    clipped,
    (p) => p[0] <= right,
    (a, b) => intersectVerticalLine(a, b, right),
  );
  clipped = clipPolygonHalfPlane(
    clipped,
    (p) => p[1] >= top,
    (a, b) => intersectHorizontalLine(a, b, top),
  );
  clipped = clipPolygonHalfPlane(
    clipped,
    (p) => p[1] <= bottom,
    (a, b) => intersectHorizontalLine(a, b, bottom),
  );
  return clipped;
}

/// The shoelace formula: exact area of a simple polygon from its
/// vertices, in either winding order (hence the `Math.abs`).
function polygonArea(points) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export class DrizzleAccumulator {
  constructor({ width, height }) {
    if (!Number.isInteger(width) || !Number.isInteger(height)
        || width <= 0 || height <= 0) {
      throw new InvalidDrizzleInput(
        'Drizzle accumulator dimensions must be positive integers.',
      );
    }
    this.width = width;
    this.height = height;
    this.valueSum = new Float64Array(width * height);
    this.weightSum = new Float64Array(width * height);
  }

  /// Splats one input sample onto the output grid.
  ///
  /// - `outputX`, `outputY`: the sample's sub-pixel position on the
  ///   output grid (pixel-center convention, as above).
  /// - `value`: the sample's scalar value (raw CFA intensity, a
  ///   demosaiced channel value, etc).
  /// - `dropRadius` (default 0.5): half-width/half-height of the square
  ///   drop footprint, in output-grid pixels. The standard drizzle
  ///   "pixfrac" parameter `p` (0 < p <= 1, the drop's size as a
  ///   fraction of one *input* pixel projected onto the output grid)
  ///   corresponds to `dropRadius = 0.5 * p * outputScale`, where
  ///   `outputScale` is the output-grid pixels per input pixel (e.g. 2
  ///   for 2x supersampling). A `dropRadius` of exactly `0.5 *
  ///   outputScale` (pixfrac 1) makes adjacent same-position drops
  ///   exactly tile the output grid with no gaps and no overlap.
  /// - `weight` (default 1): an additional per-sample quality weight
  ///   (e.g. lower for a noisier frame), multiplied into both the value
  ///   and coverage accumulation.
  ///
  /// A drop entirely outside the output grid contributes nothing (not an
  /// error) — this is the expected, common case for samples near a
  /// tile's or frame's edge after a nonzero registration shift.
  addDrop(outputX, outputY, value, {
    dropRadius = 0.5,
    weight = 1,
  } = {}) {
    if (!Number.isFinite(outputX) || !Number.isFinite(outputY)
        || !Number.isFinite(value) || !Number.isFinite(weight)
        || weight < 0 || !Number.isFinite(dropRadius)
        || !(dropRadius > 0)) {
      return; // silently skip non-finite/degenerate input; see addDrops
    }
    const dropLeft = outputX - dropRadius;
    const dropRight = outputX + dropRadius;
    const dropTop = outputY - dropRadius;
    const dropBottom = outputY + dropRadius;

    // A generous integer pixel-index margin around the drop's float
    // bounds; overlap1D naturally contributes zero area for any pixel
    // this loop visits that the drop doesn't actually reach, so the
    // margin only costs a few harmless extra iterations, not
    // correctness.
    const iMin = Math.max(0, Math.floor(dropLeft - 0.5));
    const iMax = Math.min(this.width - 1, Math.ceil(dropRight + 0.5));
    const jMin = Math.max(0, Math.floor(dropTop - 0.5));
    const jMax = Math.min(this.height - 1, Math.ceil(dropBottom + 0.5));

    for (let j = jMin; j <= jMax; j++) {
      const pixelTop = j - 0.5;
      const pixelBottom = j + 0.5;
      const overlapY = overlap1D(dropTop, dropBottom, pixelTop, pixelBottom);
      if (overlapY <= 0) continue;
      for (let i = iMin; i <= iMax; i++) {
        const pixelLeft = i - 0.5;
        const pixelRight = i + 0.5;
        const overlapX = overlap1D(
          dropLeft,
          dropRight,
          pixelLeft,
          pixelRight,
        );
        if (overlapX <= 0) continue;
        const area = overlapX * overlapY;
        const index = j * this.width + i;
        this.valueSum[index] += value * area * weight;
        this.weightSum[index] += area * weight;
      }
    }
  }

  /// Splats one input sample onto the output grid using a *rotated*
  /// square drop — the image-quality-correct choice whenever the source
  /// frame carries a nonzero rotation (see the module doc comment for
  /// why). Exact overlap area is computed via polygon clipping
  /// (Sutherland-Hodgman) between the rotated drop and each candidate
  /// output pixel's unit square, not an approximation.
  ///
  /// - `outputX`, `outputY`, `value`, `weight`: as `addDrop`.
  /// - `rotationRadians`: the drop's rotation, in the same convention as
  ///   `AffineSamplingTransform.similarity`/`star_similarity_transform_
  ///   estimator_reference.mjs` (a standard CCW rotation matrix `[[cos,
  ///   -sin], [sin, cos]]`). `0` produces results identical to `addDrop`
  ///   (see this module's tests for the regression check).
  /// - `halfWidth`, `halfHeight` (default `dropRadius` for both, i.e. a
  ///   square drop, matching `addDrop`'s shape): half-extents of the
  ///   drop *before* rotation is applied, in output-grid pixels.
  ///   Exposed separately (not just `dropRadius`) in case a future
  ///   caller needs a non-square footprint; `cfa_drizzle_reference.mjs`
  ///   always passes equal values.
  addRotatedDrop(outputX, outputY, value, {
    rotationRadians = 0,
    dropRadius = 0.5,
    halfWidth,
    halfHeight,
    weight = 1,
  } = {}) {
    const effectiveHalfWidth = halfWidth ?? dropRadius;
    const effectiveHalfHeight = halfHeight ?? dropRadius;
    if (!Number.isFinite(outputX) || !Number.isFinite(outputY)
        || !Number.isFinite(value) || !Number.isFinite(weight)
        || weight < 0 || !Number.isFinite(rotationRadians)
        || !Number.isFinite(effectiveHalfWidth)
        || !Number.isFinite(effectiveHalfHeight)
        || !(effectiveHalfWidth > 0) || !(effectiveHalfHeight > 0)) {
      return; // silently skip non-finite/degenerate input; see addDrops
    }

    const cosine = Math.cos(rotationRadians);
    const sine = Math.sin(rotationRadians);
    const localCorners = [
      [-effectiveHalfWidth, -effectiveHalfHeight],
      [effectiveHalfWidth, -effectiveHalfHeight],
      [effectiveHalfWidth, effectiveHalfHeight],
      [-effectiveHalfWidth, effectiveHalfHeight],
    ];
    const dropPolygon = localCorners.map(([lx, ly]) => [
      outputX + lx * cosine - ly * sine,
      outputY + lx * sine + ly * cosine,
    ]);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of dropPolygon) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const iMin = Math.max(0, Math.floor(minX - 0.5));
    const iMax = Math.min(this.width - 1, Math.ceil(maxX + 0.5));
    const jMin = Math.max(0, Math.floor(minY - 0.5));
    const jMax = Math.min(this.height - 1, Math.ceil(maxY + 0.5));

    for (let j = jMin; j <= jMax; j++) {
      const pixelTop = j - 0.5;
      const pixelBottom = j + 0.5;
      for (let i = iMin; i <= iMax; i++) {
        const pixelLeft = i - 0.5;
        const pixelRight = i + 0.5;
        const clipped = clipPolygonToPixel(
          dropPolygon, pixelLeft, pixelRight, pixelTop, pixelBottom,
        );
        const area = polygonArea(clipped);
        if (area <= 0) continue;
        const index = j * this.width + i;
        this.valueSum[index] += value * area * weight;
        this.weightSum[index] += area * weight;
      }
    }
  }

  /// Splats every entry of `samples` (each `{outputX, outputY, value,
  /// dropRadius?, weight?}`), skipping (not throwing on) any entry with
  /// invalid numeric entries or a non-positive `dropRadius`. Finite drops
  /// outside the output grid naturally contribute zero overlap. Negative
  /// weights are skipped so scientific coverage can never be subtracted.
  addDrops(samples, { dropRadius = 0.5, weight = 1 } = {}) {
    for (const sample of samples) {
      this.addDrop(sample.outputX, sample.outputY, sample.value, {
        dropRadius: sample.dropRadius ?? dropRadius,
        weight: sample.weight ?? weight,
      });
    }
  }

  /// Produces the final composite: `value[i] = valueSum[i] /
  /// weightSum[i]` where `weightSum[i] > 0`, else `0` with `coverage[i]
  /// === 0`. `coverage` is the raw accumulated weight (not normalized to
  /// [0, 1]), letting callers distinguish "one thin-overlap drop touched
  /// this pixel" from "many full-overlap drops did".
  finalize() {
    const { width, height } = this;
    const value = new Float64Array(width * height);
    const coverage = new Float64Array(width * height);
    for (let index = 0; index < value.length; index++) {
      const weight = this.weightSum[index];
      coverage[index] = weight;
      value[index] = weight > 0 ? this.valueSum[index] / weight : 0;
    }
    return { width, height, value, coverage };
  }
}
