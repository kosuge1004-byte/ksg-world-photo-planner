/// Reference tone mapping for Mobile Stack's final output stage.
///
/// Converts the linear-light, unbounded-range FP32 RGB a stacked result
/// carries (star cores can exceed 1.0 many times over; the sky
/// background sits near, but rarely exactly at, 0) into a display-
/// referred 8-bit sRGB image, the step every previous stage of this
/// project's pipeline (demosaic, registration, drizzle, stacking) has
/// been building toward but that, until now, nothing in this project
/// implemented at all.
///
/// This module deliberately does not just clip at 1.0 and gamma-encode:
/// naive clipping turns every star brighter than middle gray into a flat
/// white disk with no color or shape information, which is a serious,
/// avoidable image-quality loss for exactly the subject matter (bright
/// point sources against a dark sky) this app exists to photograph. It
/// implements a smooth exponential ("Habitat"-style) tone curve instead:
/// values compress gradually toward white as they approach a
/// configurable "white point" rather than clipping hard at 1.0, so a
/// very bright star fades gracefully rather than blowing out to a
/// featureless disk, while still allowing genuine highlights to read as
/// visually white. See `exponentialToneCurve`'s own doc comment for why
/// this specific curve was chosen over the "extended Reinhard" operator
/// (Reinhard, Stark, Shirley & Ferwerda, 2002) this module's first
/// implementation attempt used, and the real, test-caught problems with
/// that formula that motivated switching away from it.

export class InvalidToneMapInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidToneMapInput';
  }
}

/// The sRGB opto-electronic transfer function (OETF): converts a linear
/// light value in `[0, 1]` to a display-referred (gamma-encoded) value in
/// `[0, 1]`. Values outside `[0, 1]` are clamped first — this function is
/// meant to be applied *after* tone mapping has already compressed the
/// unbounded HDR range into `[0, 1]`, not applied directly to raw HDR
/// data.
export function srgbEncode(linearValue) {
  const clamped = Math.min(1, Math.max(0, linearValue));
  if (clamped <= 0.0031308) {
    return clamped * 12.92;
  }
  return 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/// The inverse of {@link srgbEncode}: converts a display-referred sRGB
/// value in `[0, 1]` back to linear light. Exported for completeness and
/// for round-trip testing, not used elsewhere in this module's own
/// pipeline (encoding is one-way for final output).
export function srgbDecode(encodedValue) {
  const clamped = Math.min(1, Math.max(0, encodedValue));
  if (clamped <= 0.04045) {
    return clamped / 12.92;
  }
  return Math.pow((clamped + 0.055) / 1.055, 2.4);
}

/// Exponential ("Habitat"-style) tone curve: maps a non-negative linear
/// luminance `value` (unbounded above) into `[0, 1)`, with `whitePoint`
/// (must be `> 0`) the luminance at which the curve reaches about 99% of
/// its way to white — chosen so `whitePoint` has an intuitive meaning
/// ("roughly where highlights become indistinguishable from pure white")
/// without needing any output clamping, unlike an earlier version of
/// this function.
///
/// `f(value) = 1 - exp(-rate * value / whitePoint)`, with `rate =
/// ln(10)` chosen so `f(whitePoint) ≈ 0.9` — deliberately not closer to
/// 1 (an initial version of this function used `rate = ln(100)`,
/// reaching `f(whitePoint) ≈ 0.99`, but that compresses far too
/// aggressively in the lower half of the range: `f(whitePoint / 2)` was
/// already `≈ 0.9`, the same as this version's value *at* the white
/// point — found via this module's own tests, not just reasoned about,
/// see WORK55_PROGRESS.md). Leaving deliberate headroom above the
/// estimated white point (rather than treating it as "already
/// essentially pure white") also better matches how real highlight
/// rolloff generally behaves: there is normally still a little more room
/// for a genuinely more extreme highlight above whatever value drove the
/// white-point estimate.
///
/// This function is naturally, algebraically bounded in `[0, 1)` for any
/// finite non-negative `value` (since `exp(-x) > 0` always for finite
/// `x`) — no explicit clamp is needed, unlike this module's first
/// implementation attempt, which used the "extended Reinhard" formula
/// `v*(1+v/w^2)/(1+v)`. That formula reaches exactly 1 at `value ==
/// whitePoint` as intended, but then *keeps increasing past 1* for
/// `value > whitePoint` instead of leveling off there — an error only
/// caught by this module's own tests actually exercising values well
/// beyond the white point, not by inspecting the algebra alone (see
/// WORK55_PROGRESS.md). That formula also saturates almost
/// whitePoint-independently for any `value` much greater than 1 (its
/// `value / (1 + value)` term alone already approaches 1 by value ~20,
/// regardless of how large `whitePoint` is), which is exactly the wrong
/// behavior for this project's actual value range — a stacked linear
/// image can have star cores hundreds to thousands of times brighter
/// than the sky background, and every one of them collapsed to a nearly
/// identical near-white value under that formula regardless of their
/// true relative brightness, discovered via this module's own
/// end-to-end synthetic-star-field test, not simply reasoned about in
/// advance. The exponential curve used here does not have either
/// problem: it is well-behaved for any non-negative `value`/`whitePoint`
/// combination.
function exponentialToneCurve(value, whitePoint) {
  const rate = Math.log(10);
  return 1 - Math.exp((-rate * value) / whitePoint);
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round(fraction * (sortedValues.length - 1))),
  );
  return sortedValues[index];
}

/// Estimates a reasonable automatic exposure scale and white point from
/// `rgb` (an interleaved linear RGB Float32Array), so a stacked result
/// with an arbitrary, uncalibrated absolute brightness (a function of
/// exposure count, ISO, aperture, and this project's own internal
/// linear-light units) maps to a sensible-looking image without the
/// caller needing to hand-tune every stack.
///
/// - `exposureScale`: chosen so the median pixel luminance (background
///   sky, for a typical night-sky frame — stars are a small minority of
///   pixels, so the median is robust to them) lands at `targetMedian`
///   (default 0.06, a dim-but-not-crushed background level) after
///   scaling, before the tone curve is applied.
/// - `whitePoint`: chosen from a percentile *within the population of
///   pixels meaningfully brighter than the background* (those exceeding
///   `highlightThresholdMultiplier` times the scaled median), not a
///   percentile of the whole image. A real night-sky frame is
///   overwhelmingly background pixels — a real capture can easily have
///   well under 0.1% of its area covered by stars — so a percentile
///   taken across *all* pixels (an earlier version of this function did
///   exactly that) can land back inside the background population
///   itself instead of ever reaching the stars, especially on smaller
///   images; this was caught by this module's own end-to-end test
///   during development, not merely reasoned about (see
///   WORK55_PROGRESS.md). Restricting the percentile to the highlight
///   population specifically is scale-invariant with respect to how
///   sparse the stars are or how large the image is. If no pixel clears
///   the highlight threshold at all (a blank or near-blank frame), falls
///   back to the single brightest pixel in the whole image.
///
///   The result is additionally capped at `maximumWhitePointMultiplier`
///   (default 500) times the scaled median: an extreme single outlier
///   (a bright planet or satellite glint sharing the frame with a much
///   dimmer sky, or literally any capture with several orders of
///   magnitude between its darkest and brightest content) can otherwise
///   push the white point so high that `exponentialToneCurve`'s rate
///   becomes too shallow to keep the *background* visibly above zero
///   after 8-bit quantization — a real failure mode this function's own
///   tests found (a synthetic star roughly 130,000x brighter than the
///   background crushed the background to literal 0), not a
///   theoretical concern. This cap is a deliberate, disclosed trade-off,
///   not a complete fix: beyond this cap, the very brightest highlights
///   compress somewhat more aggressively than the percentile alone would
///   choose, in exchange for keeping the background reliably visible. A
///   proper fix for extreme-dynamic-range scenes would need a
///   local/adaptive tone-mapping algorithm, not a single global curve —
///   out of scope for this first version (see WORK55_PROGRESS.md's
///   "What's still not done").
///
/// This is a starting point for a "reasonable default" preview/export,
/// not a substitute for user-adjustable exposure controls — see
/// WORK55_PROGRESS.md's "What's still not done".

export function compensateAutoToneForBaselineExposure(auto, baselineExposureEv) {
  if (!auto || !Number.isFinite(auto.exposureScale)
      || !Number.isFinite(auto.whitePoint)) {
    throw new InvalidToneMapInput(
      'auto must contain finite exposureScale and whitePoint values.',
    );
  }
  if (!Number.isFinite(baselineExposureEv)
      || baselineExposureEv < -32 || baselineExposureEv > 32) {
    throw new InvalidToneMapInput(
      'baselineExposureEv must be finite and between -32 and 32 EV.',
    );
  }
  const baselineScale = 2 ** baselineExposureEv;
  if (!Number.isFinite(baselineScale) || baselineScale <= 0) {
    throw new InvalidToneMapInput(
      'Baseline exposure scale must remain finite and positive.',
    );
  }
  return {
    exposureScale: auto.exposureScale / baselineScale,
    whitePoint: auto.whitePoint,
  };
}

export function estimateAutoToneParameters(rgb, {
  targetMedian = 0.06,
  highlightPercentile = 0.99,
  highlightThresholdMultiplier = 3,
  minimumWhitePoint = 0.5,
  maximumWhitePointMultiplier = 500,
  luminanceWeights = [0.2126, 0.7152, 0.0722],
} = {}) {
  if (!(rgb instanceof Float32Array) || rgb.length === 0
      || rgb.length % 3 !== 0) {
    throw new InvalidToneMapInput(
      'rgb must be a non-empty Float32Array of interleaved RGB triples.',
    );
  }
  if (!Array.isArray(luminanceWeights) || luminanceWeights.length !== 3
      || luminanceWeights.some((value) => !Number.isFinite(value))) {
    throw new InvalidToneMapInput(
      'luminanceWeights must contain exactly three finite values.',
    );
  }
  const pixelCount = rgb.length / 3;
  const luminance = new Float64Array(pixelCount);
  const finiteOrZero = (value) => (Number.isFinite(value) ? value : 0);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const base = pixel * 3;
    // Preserve signed linear residuals through the luminance dot product;
    // clamp only the resulting brightness statistic.
    const weighted = luminanceWeights[0] * finiteOrZero(rgb[base])
      + luminanceWeights[1] * finiteOrZero(rgb[base + 1])
      + luminanceWeights[2] * finiteOrZero(rgb[base + 2]);
    luminance[pixel] = Number.isFinite(weighted) ? Math.max(0, weighted) : 0;
  }
  const sortedLuminance = Array.from(luminance).sort((a, b) => a - b);
  const median = percentile(sortedLuminance, 0.5);
  const exposureScale = median > 1e-9 ? targetMedian / median : 1;

  const scaledLuminance = sortedLuminance.map(
    (value) => Math.max(0, value) * exposureScale,
  );
  const scaledMedian = Math.max(0, median) * exposureScale;
  const highlightThreshold = Math.max(
    scaledMedian * highlightThresholdMultiplier,
    1e-6,
  );
  // scaledLuminance is already sorted ascending, so the highlight
  // population (everything above the threshold) is exactly its tail --
  // no need to re-filter-and-resort.
  const firstHighlightIndex = scaledLuminance.findIndex(
    (value) => value > highlightThreshold,
  );
  const highlightPopulation = firstHighlightIndex === -1
    ? []
    : scaledLuminance.slice(firstHighlightIndex);

  const whitePoint = highlightPopulation.length > 0
    ? Math.max(
      minimumWhitePoint,
      percentile(highlightPopulation, highlightPercentile),
    )
    : Math.max(
      minimumWhitePoint,
      scaledLuminance[scaledLuminance.length - 1] ?? 0,
    );
  const cappedWhitePoint = Math.min(
    whitePoint,
    Math.max(minimumWhitePoint, scaledMedian * maximumWhitePointMultiplier),
  );
  return { exposureScale, whitePoint: cappedWhitePoint };
}

/// Tone-maps `rgb` (an interleaved linear RGB Float32Array, any
/// non-negative range) into a new `Uint8ClampedArray` of the same
/// length, holding display-referred 8-bit sRGB values ready to write
/// into an image file.
///
/// - `exposureScale` (default 1): a linear multiplier applied before the
///   tone curve; see {@link estimateAutoToneParameters} for computing a
///   sensible value automatically rather than guessing one.
/// - `whitePoint` (default 1): forwarded to the extended Reinhard curve;
///   likewise usually supplied via {@link estimateAutoToneParameters}
///   rather than a fixed constant.
/// - `applySrgbGamma` (default true): applies {@link srgbEncode} after
///   the tone curve. The tone curve alone only guarantees the result
///   lands in `[0, 1)`; it does not itself apply a display gamma.
///
/// Negative or non-finite input values (a sign of an upstream bug — this
/// project's pipeline should never produce them, but this function does
/// not assume that) are clamped to 0 rather than propagating a NaN or
/// negative value through `Math.pow`.
export function toneMapToDisplayRgb(rgb, {
  exposureScale = 1,
  whitePoint = 1,
  applySrgbGamma = true,
} = {}) {
  if (!(rgb instanceof Float32Array)) {
    throw new InvalidToneMapInput('rgb must be a Float32Array.');
  }
  if (!(whitePoint > 0)) {
    throw new InvalidToneMapInput('whitePoint must be positive.');
  }
  if (!Number.isFinite(exposureScale)) {
    throw new InvalidToneMapInput('exposureScale must be finite.');
  }
  const output = new Uint8ClampedArray(rgb.length);
  for (let index = 0; index < rgb.length; index++) {
    const raw = rgb[index];
    const scaled = Number.isFinite(raw)
      ? Math.max(0, raw) * exposureScale
      : 0;
    const mapped = exponentialToneCurve(scaled, whitePoint);
    const display = applySrgbGamma ? srgbEncode(mapped) : mapped;
    output[index] = Math.round(display * 255);
  }
  return output;
}
