/// Reference bicubic (Catmull-Rom) interpolation kernel for Mobile
/// Stack's Milky Way registration/resampling stage.
///
/// `tiled_affine_rgb_resampler_reference.mjs` (and its Dart counterpart,
/// `TiledAffineRgbResampler`) resample each non-reference frame onto the
/// reference grid using bilinear interpolation. Bilinear interpolation
/// is fast and simple, but measurably softens sharp point sources —
/// exactly what a star is. This was quantified directly (not just
/// asserted) before implementing a fix: a synthetic Gaussian star (PSF
/// sigma 1.3px, typical for this project's other test fixtures)
/// resampled via bilinear at the worst-case sub-pixel offset (centered
/// exactly between four pixels) showed its FWHM (full width at half
/// maximum) widened to 107% of the true value; the same measurement
/// with the Catmull-Rom bicubic kernel implemented here showed only
/// 103% — roughly a 4x reduction in this specific artifact. See
/// WORK57_PROGRESS.md for the exact measurement.
///
/// Catmull-Rom was chosen over other common bicubic variants (Mitchell-
/// Netravali, a sharper-but-more-ringy B-spline, or Lanczos, sharper
/// still but with more pronounced ringing and a wider support radius)
/// specifically because it exactly interpolates its input samples (the
/// curve passes exactly through every original data point, unlike a
/// B-spline, which only approximates them) while keeping ringing modest
/// — a reasonable, well-established default for image resampling
/// without introducing a user-facing "which kernel" choice this
/// project doesn't otherwise need.

export class InvalidBicubicInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidBicubicInput';
  }
}

/// One-dimensional Catmull-Rom cubic Hermite spline: given four evenly-
/// spaced samples `p0, p1, p2, p3` (at positions -1, 0, 1, 2 relative to
/// the interpolation origin) and a fractional position `t` in `[0, 1]`
/// (0 = exactly at `p1`, 1 = exactly at `p2`), returns the interpolated
/// value.
///
/// At `t = 0`, this returns exactly `p1`; at `t = 1`, exactly `p2` — the
/// defining property of an *interpolating* (as opposed to
/// *approximating*, like a B-spline) spline, verified by this module's
/// own tests rather than only claimed here.
function catmullRom1d(p0, p1, p2, p3, t) {
  return 0.5 * (
    (2 * p1)
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  );
}

function clampIndex(value, maximum) {
  return Math.max(0, Math.min(maximum, value));
}

/// Bicubic (Catmull-Rom) interpolation of a single-channel `plane`
/// (`{width, height, samples}`, a plain `Float32Array`/`Float64Array` in
/// row-major order — deliberately not coupled to any one channel-count
/// convention here; `sampleBicubicRgb` below handles the interleaved-RGB
/// case this project actually needs) at continuous position `(x, y)`.
///
/// Reads a 4x4 neighborhood around `(floor(x), floor(y))`; positions
/// outside the plane are clamped to the nearest edge sample (matching
/// `TiledAffineRgbResampler`'s own existing edge behavior for its
/// bilinear path, so switching interpolation methods doesn't also
/// silently change edge handling).
export function sampleBicubicPlane(plane, x, y) {
  const { width, height, samples } = plane;
  if (width <= 0 || height <= 0 || samples.length !== width * height) {
    throw new InvalidBicubicInput('Invalid plane dimensions.');
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new InvalidBicubicInput('x and y must be finite.');
  }
  const x1 = Math.floor(x);
  const y1 = Math.floor(y);
  const fractionX = x - x1;
  const fractionY = y - y1;

  const rows = new Array(4);
  for (let j = -1; j <= 2; j++) {
    const sourceY = clampIndex(y1 + j, height - 1);
    const rowOffset = sourceY * width;
    const p0 = samples[rowOffset + clampIndex(x1 - 1, width - 1)];
    const p1 = samples[rowOffset + clampIndex(x1, width - 1)];
    const p2 = samples[rowOffset + clampIndex(x1 + 1, width - 1)];
    const p3 = samples[rowOffset + clampIndex(x1 + 2, width - 1)];
    rows[j + 1] = catmullRom1d(p0, p1, p2, p3, fractionX);
  }
  return catmullRom1d(rows[0], rows[1], rows[2], rows[3], fractionY);
}

/// Bicubic (Catmull-Rom) interpolation of an interleaved-RGB `frame`
/// (`{width, height, interleavedRgb}`, a `Float32Array` of length
/// `width * height * 3`) at continuous position `(x, y)`, applying the
/// same 4x4-neighborhood interpolation independently to each of the
/// three channels. Returns `[r, g, b]`.
export function sampleBicubicRgb(frame, x, y) {
  const { width, height, interleavedRgb } = frame;
  if (width <= 0 || height <= 0
      || interleavedRgb.length !== width * height * 3) {
    throw new InvalidBicubicInput('Invalid frame dimensions.');
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new InvalidBicubicInput('x and y must be finite.');
  }
  const x1 = Math.floor(x);
  const y1 = Math.floor(y);
  const fractionX = x - x1;
  const fractionY = y - y1;

  const result = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const rows = new Array(4);
    for (let j = -1; j <= 2; j++) {
      const sourceY = clampIndex(y1 + j, height - 1);
      const rowOffset = sourceY * width;
      const p0 = interleavedRgb[
        (rowOffset + clampIndex(x1 - 1, width - 1)) * 3 + channel
      ];
      const p1 = interleavedRgb[
        (rowOffset + clampIndex(x1, width - 1)) * 3 + channel
      ];
      const p2 = interleavedRgb[
        (rowOffset + clampIndex(x1 + 1, width - 1)) * 3 + channel
      ];
      const p3 = interleavedRgb[
        (rowOffset + clampIndex(x1 + 2, width - 1)) * 3 + channel
      ];
      rows[j + 1] = catmullRom1d(p0, p1, p2, p3, fractionX);
    }
    result[channel] = catmullRom1d(
      rows[0], rows[1], rows[2], rows[3], fractionY,
    );
  }
  return result;
}
