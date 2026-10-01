/// Reference "lighten blend" (比較明合成) stacking for Mobile Stack's
/// star trail mode.
///
/// Unlike the Milky Way mode's registered stacking (`mobile_stack_
/// adaptive_demosaic_reference.mjs` + the star registration/drizzle
/// modules), star trail mode intentionally performs *no* frame
/// alignment: consecutive frames from a stationary tripod are combined
/// by taking, at each pixel, the brightest value seen across all frames.
/// Stars sweep across the sensor as the sky rotates, so their brightest
/// contribution traces out a trail; the (unmoving) foreground and sky
/// background are unaffected since they don't change between frames.
///
/// Frame shape matches `tiled_kappa_sigma_reference.mjs` for consistency
/// with the rest of this project's stacking modules: `{ rgb: Float32Array
/// (interleaved RGB), coverage: array, 0 = uncovered/invalid }`, as
/// produced by `TiledAffineRgbResampler`'s `CoveredLinearRgbTile` (star
/// trail mode has no resampling step of its own, but reuses the same
/// covered-tile shape so it can share downstream tile-store plumbing).

export class InvalidLightenBlendInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidLightenBlendInput';
  }
}

export class LightenBlendCancelled extends Error {
  constructor() {
    super('Lighten-blend stacking was cancelled.');
    this.name = 'LightenBlendCancelled';
  }
}

function validate(frames, minimumCoveringFrames) {
  if (!Array.isArray(frames) || frames.length === 0
      || frames.length > 65535) {
    throw new InvalidLightenBlendInput('One to 65535 frames are required.');
  }
  const sampleCount = frames[0]?.rgb?.length;
  if (!Number.isInteger(sampleCount) || sampleCount <= 0
      || sampleCount % 3 !== 0) {
    throw new InvalidLightenBlendInput('Invalid RGB sample count.');
  }
  for (const frame of frames) {
    if (!(frame.rgb instanceof Float32Array)
        || frame.rgb.length !== sampleCount) {
      throw new InvalidLightenBlendInput(
        'Every frame must have the same RGB sample count.',
      );
    }
    if (frame.coverage.length !== sampleCount / 3) {
      throw new InvalidLightenBlendInput(
        'Coverage length must match the pixel count.',
      );
    }
  }
  if (!Number.isInteger(minimumCoveringFrames) || minimumCoveringFrames < 1) {
    throw new InvalidLightenBlendInput(
      'minimumCoveringFrames must be a positive integer.',
    );
  }
}

/// Combines `frames` (see the module doc comment for the shape) by
/// taking, independently per RGB sample, the `keepHighest`-th highest
/// value seen across all frames that cover that pixel.
///
/// - `keepHighest` (default 1): `1` is a standard lighten blend (the
///   single brightest value survives at every pixel — the literal
///   meaning of 比較明合成). Values greater than 1 use the Nth-highest
///   value instead, which is more robust to a single-frame outlier (a
///   cosmic-ray hit, or a transient hot pixel the defect-pixel correction
///   stage didn't already know about) at the cost of slightly dimming or
///   truncating thin, fast-moving trail segments that only elevate a
///   given pixel for one frame's worth of dwell time. Left at the
///   default unless a specific artifact is observed, since real star
///   trails frequently *do* only cross a given pixel for a single frame,
///   especially at typical few-second exposures.
/// - `minimumCoveringFrames` (default 1): a pixel covered by fewer than
///   this many frames is reported as uncovered in the output (`coverage
///   === 0`) rather than returning a lighten-blend result derived from
///   too few samples to be meaningful. When using `keepHighest > 1`,
///   consider setting this to at least `keepHighest`: a pixel covered by
///   fewer frames than `keepHighest` still produces a result (the lowest
///   value among however many frames did cover it, as the best available
///   stand-in for "the Nth highest"), which may not be the robustness
///   guarantee the caller expects from a higher `keepHighest`.
/// - `isCancelled`: polled between frames.
///
/// Returns `{ rgb: Float32Array, coverage: Uint32Array }`, where
/// `coverage[pixel]` is the number of frames that covered that pixel (not
/// just 0/1), letting callers see thin coverage even where a result was
/// still produced.
export function lightenBlendCombineCoveredRgb({
  frames,
  keepHighest = 1,
  minimumCoveringFrames = 1,
  isCancelled = () => false,
}) {
  validate(frames, minimumCoveringFrames);
  if (!Number.isInteger(keepHighest) || keepHighest < 1) {
    throw new InvalidLightenBlendInput(
      'keepHighest must be a positive integer.',
    );
  }
  if (isCancelled()) throw new LightenBlendCancelled();

  const sampleCount = frames[0].rgb.length;
  const pixelCount = sampleCount / 3;
  const coverage = new Uint32Array(pixelCount);

  if (keepHighest === 1) {
    // Fast path: track a running max directly, one pass over the
    // frames, without retaining a top-K buffer per sample.
    const rgb = new Float32Array(sampleCount).fill(-Infinity);
    for (const frame of frames) {
      if (isCancelled()) throw new LightenBlendCancelled();
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (frame.coverage[pixel] === 0) continue;
        coverage[pixel] += 1;
        const base = pixel * 3;
        if (frame.rgb[base] > rgb[base]) rgb[base] = frame.rgb[base];
        if (frame.rgb[base + 1] > rgb[base + 1]) {
          rgb[base + 1] = frame.rgb[base + 1];
        }
        if (frame.rgb[base + 2] > rgb[base + 2]) {
          rgb[base + 2] = frame.rgb[base + 2];
        }
      }
    }
    finalizeUncoveredAndSparse(rgb, coverage, pixelCount, minimumCoveringFrames);
    return { rgb, coverage };
  }

  // keepHighest > 1: maintain a small per-sample top-K buffer. K is
  // typically tiny (2-3), so a linear insert is fine and avoids pulling
  // in a heap for what is, per pixel, a handful of comparisons.
  const topValues = new Float32Array(sampleCount * keepHighest)
    .fill(-Infinity);
  for (const frame of frames) {
    if (isCancelled()) throw new LightenBlendCancelled();
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (frame.coverage[pixel] === 0) continue;
      coverage[pixel] += 1;
      const base = pixel * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const sampleIndex = base + channel;
        const value = frame.rgb[sampleIndex];
        const topBase = sampleIndex * keepHighest;
        if (value <= topValues[topBase + keepHighest - 1]) continue;
        let insertAt = keepHighest - 1;
        while (insertAt > 0 && topValues[topBase + insertAt - 1] < value) {
          topValues[topBase + insertAt] = topValues[topBase + insertAt - 1];
          insertAt -= 1;
        }
        topValues[topBase + insertAt] = value;
      }
    }
  }
  const rgb = new Float32Array(sampleCount);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const pixel = (sampleIndex / 3) | 0;
    const framesSeen = coverage[pixel];
    const rank = Math.min(keepHighest, framesSeen) - 1;
    rgb[sampleIndex] = rank >= 0
      ? topValues[sampleIndex * keepHighest + rank]
      : -Infinity;
  }
  finalizeUncoveredAndSparse(rgb, coverage, pixelCount, minimumCoveringFrames);
  return { rgb, coverage };
}

function finalizeUncoveredAndSparse(
  rgb,
  coverage,
  pixelCount,
  minimumCoveringFrames,
) {
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (coverage[pixel] < minimumCoveringFrames) {
      const base = pixel * 3;
      rgb[base] = 0;
      rgb[base + 1] = 0;
      rgb[base + 2] = 0;
      coverage[pixel] = 0;
    } else if (coverage[pixel] === 0) {
      const base = pixel * 3;
      rgb[base] = 0;
      rgb[base + 1] = 0;
      rgb[base + 2] = 0;
    }
  }
}
