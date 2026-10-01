/// Reference implementation of hot-pixel detection **from a master dark
/// frame**, closing a real, previously-dormant gap this project's own
/// defect-pixel correction stage had: `raw_defect_map.mjs`'s own
/// documented design deliberately holds only *explicitly provided*
/// defect coordinates (from camera/RAW metadata), specifically because
/// automatically detecting "unusually bright" pixels from a single
/// *light* frame risks mistaking real stars or point sources for
/// defects — a serious correctness problem for astrophotography
/// specifically, where capturing point sources of light is the entire
/// point. Because of that restriction, and because nothing in this
/// project ever actually populated a defect map from camera metadata
/// either, the defect-pixel correction pipeline stage
/// (`phase2_quality_pipeline_factory.dart`'s own `_defectPixelStage`)
/// has been present in the pipeline's architecture since early in this
/// project but has *never actually corrected anything* — `context.
/// rawDefectMap` is set to `null` on cleanup and never assigned a real
/// value anywhere else in the codebase.
///
/// A **master dark frame** (Work96's own `computeMasterDark`) sidesteps
/// the exact concern that motivated the light-frame restriction: a dark
/// frame is captured with no light reaching the sensor at all (lens cap
/// on) — there is no possible astronomical content in it to mistake for
/// a defect. Detecting unusually bright pixels in a master dark is
/// therefore safe in a way detecting them in a light frame is not, and
/// this module exists specifically to take advantage of that.
///
/// [detectHotPixelsFromMasterDark] flags a pixel as a hot pixel when its
/// own dark-current value substantially exceeds its *local* same-CFA-
/// phase neighborhood's typical level — local, rather than a single
/// whole-frame threshold, specifically to remain correct on sensors
/// with genuine "amp glow" (a real, gradual brightness gradient near one
/// corner from the sensor's own read amplifier warming up during a long
/// exposure): a single global threshold would either miss real hot
/// pixels in a sensor's cooler regions or over-flag ordinary pixels in
/// its warmer ones, while a local comparison adapts to wherever a given
/// pixel actually sits on that gradient.
///
/// A pixel must clear *both* a relative threshold (its own value is at
/// least [ratioThreshold] times its local neighborhood's median) *and*
/// an absolute threshold (its own value exceeds that median by at least
/// [absoluteThreshold]) to be flagged — two genuinely independent
/// conditions, both required. The absolute check exists because a
/// purely relative threshold breaks down near zero: in a very clean
/// region where the local median is already tiny, even ordinary read
/// noise can produce a ratio far above any reasonable relative
/// threshold despite being a physically insignificant absolute
/// difference; requiring the absolute check too prevents that from
/// alone triggering a false flag.

export class InvalidHotPixelDetectionInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidHotPixelDetectionInput';
  }
}

function isSameCfaPhase(pattern, ax, ay, bx, by) {
  // Every standard 2x2 Bayer pattern repeats with period 2 in both
  // axes, so two positions share a CFA phase exactly when they agree in
  // x-parity and y-parity — this holds regardless of which of the four
  // standard patterns (rggb/bggr/grbg/gbrg) it actually is, so this
  // function does not need the pattern value at all; it is accepted
  // only so a future caller passing a genuinely different (non-2x2)
  // pattern has a place to add that case rather than silently getting
  // wrong results.
  void pattern;
  return (ax & 1) === (bx & 1) && (ay & 1) === (by & 1);
}

function median(values) {
  const sorted = Float64Array.from(values).sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/// Detects hot pixels in [masterDark] (`{width, height, cfaPattern,
/// samples}`, already black-level-subtracted — matching
/// `prepareMasterDark`'s own output), returning an array of `{x, y}`
/// points suitable for building a `RawDefectMap`.
///
/// - [neighborhoodRadius] (default `5`): same-CFA-phase neighbors are
///   searched within a `(2*neighborhoodRadius+1)` square window
///   (Chebyshev distance), edge-clamped.
/// - [ratioThreshold] (default `5`): a pixel's own value must be at
///   least this many times its local neighborhood's median to be
///   flagged (one of two required conditions — see this module's own
///   doc comment).
/// - [absoluteThreshold] (default `0`): a pixel's own value must also
///   exceed its local neighborhood's median by at least this much to be
///   flagged (the other required condition). The default of `0` means
///   this check is trivially satisfied by any value above the median
///   unless a caller supplies a threshold appropriate to their own
///   sensor's noise floor and units.
///
/// Throws {@link InvalidHotPixelDetectionInput} if [masterDark]'s
/// sample count does not match its own declared dimensions, or if
/// [neighborhoodRadius] is not a positive integer, or [ratioThreshold]
/// is not greater than `1`, or [absoluteThreshold] is negative.
export function detectHotPixelsFromMasterDark(masterDark, {
  neighborhoodRadius = 5,
  ratioThreshold = 5,
  absoluteThreshold = 0,
} = {}) {
  const {
    width, height, cfaPattern, samples,
  } = masterDark;
  if (samples.length !== width * height) {
    throw new InvalidHotPixelDetectionInput(
      "masterDark's sample count does not match its dimensions.",
    );
  }
  if (!Number.isInteger(neighborhoodRadius) || neighborhoodRadius < 1) {
    throw new InvalidHotPixelDetectionInput(
      'neighborhoodRadius must be a positive integer.',
    );
  }
  if (!Number.isFinite(ratioThreshold) || !(ratioThreshold > 1)) {
    throw new InvalidHotPixelDetectionInput(
      'ratioThreshold must be greater than 1.',
    );
  }
  if (!Number.isFinite(absoluteThreshold) || !(absoluteThreshold >= 0)) {
    throw new InvalidHotPixelDetectionInput(
      'absoluteThreshold must be non-negative.',
    );
  }

  if ([...samples].some((value) => !Number.isFinite(value))) {
    throw new InvalidHotPixelDetectionInput(
      'Master dark must contain only finite samples.',
    );
  }

  const hotPixels = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ownValue = samples[y * width + x];
      const neighborValues = [];
      const minY = Math.max(0, y - neighborhoodRadius);
      const maxY = Math.min(height - 1, y + neighborhoodRadius);
      const minX = Math.max(0, x - neighborhoodRadius);
      const maxX = Math.min(width - 1, x + neighborhoodRadius);
      for (let ny = minY; ny <= maxY; ny++) {
        for (let nx = minX; nx <= maxX; nx++) {
          if (nx === x && ny === y) continue;
          if (!isSameCfaPhase(cfaPattern, x, y, nx, ny)) continue;
          neighborValues.push(samples[ny * width + nx]);
        }
      }
      if (neighborValues.length === 0) continue;
      const localMedian = median(neighborValues);
      const passesRatio = ownValue >= localMedian * ratioThreshold;
      const passesAbsolute = ownValue >= localMedian + absoluteThreshold;
      if (passesRatio && passesAbsolute) {
        hotPixels.push({ x, y });
      }
    }
  }
  return hotPixels;
}
