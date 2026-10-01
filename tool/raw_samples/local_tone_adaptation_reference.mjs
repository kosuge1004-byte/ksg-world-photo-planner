/// Reference implementation of local (spatially-adaptive) tone
/// adaptation, addressing a real, previously-documented image-quality
/// gap: `tone_map_reference.mjs`'s own exponential curve applies a
/// single *global* exposure scale to every pixel, which cannot
/// simultaneously keep a dim foreground/background visible and preserve
/// detail in a bright star core or the Milky Way's own dense core —
/// raising the global exposure to see the dim parts pushes bright parts
/// further into (or past) the curve's own compression range, and
/// lowering it to protect bright parts leaves dim parts under-exposed
/// (see WORK55_PROGRESS.md's own documented residual limitation test).
///
/// This module computes a *per-pixel* exposure gain from each pixel's
/// own *local* surroundings (not the whole image's single statistic),
/// intended to be applied to the linear RGB data *before*
/// `tone_map_reference.mjs`'s existing global curve — reusing that
/// already-tested curve unchanged for the final compression step, with
/// this module responsible only for evening out large-scale brightness
/// differences across the frame first.
///
/// The approach, in three pieces:
/// - [computeLuminance]: a standard perceptual luminance from
///   interleaved RGB (ITU-R BT.709 coefficients, the same weighting
///   `estimateAutoToneParameters` already uses in `tone_map_
///   reference.mjs`, for consistency).
/// - [boxBlur]: a separable (horizontal pass, then vertical pass) box
///   blur of that luminance, with edge-clamped sampling — a fast,
///   simple way to estimate each pixel's own *local surround*
///   brightness (its neighborhood's typical level, not its own single
///   value), the same "surround" concept classic local tone-reproduction
///   operators build on. A box blur was chosen over a true Gaussian
///   specifically for its simplicity and speed (no kernel weights to
///   get subtly wrong) — the surround estimate does not need to be a
///   mathematically ideal low-pass filter, only a reasonably smooth,
///   reasonably local one, and a box blur is exactly that.
/// - [computeLocalGain]: turns the blurred surround into a per-pixel
///   multiplicative gain, self-calibrated against a **high percentile**
///   of the *image's own* surround brightness (no externally-chosen
///   "target" brightness needed, matching `estimateAutoToneParameters`'s
///   own "derive parameters from the image's own content" philosophy) —
///   `gain = clamp((referenceSurround / (surround + epsilon)) ^
///   strength, minGain, maxGain)`, where `referenceSurround` is the
///   [referencePercentile]-th percentile (default `0.85`) of every
///   pixel's own surround value. A pixel whose local surround is dimmer
///   than that reference level gets boosted; one whose surround is
///   already at or above it gets gain `<= 1`, left alone or slightly
///   reduced. At `strength = 0`, every gain is exactly `1` — local
///   adaptation is fully disabled, and this module's own output is a
///   no-op on top of the existing global-only tone mapping, so
///   [applyLocalGain] can always be inserted into the pipeline without
///   changing existing behavior unless a caller actively opts in with
///   `strength > 0`.
///
/// **Why a high percentile, not the median (a real design mistake
/// caught by this module's own test before shipping):** an early
/// version of this module used the surround's plain median as the
/// reference level, following the same instinct as
/// `estimateAutoToneParameters`'s own median-based auto-exposure. But a
/// typical astrophotography frame is *mostly* dim sky background, with
/// only a small fraction of pixels covering stars or the Milky Way's
/// own bright core — meaning the *median* surround value is itself
/// approximately equal to the background level, not some brighter
/// "typical interesting content" level. Referencing the median therefore
/// gave background pixels a gain of essentially `1` (no boost at all,
/// since the background already *is* the median), completely failing to
/// address the problem this module exists to solve. A direct end-to-end
/// test built specifically to check "does the dim background actually
/// get brighter" caught this immediately (the background's gain came
/// back at `~1.0000`, not the expected `>1`) — switching to a high
/// percentile (a level most background pixels sit *below*, and only a
/// bright minority sits at or above) fixes this: the dim majority now
/// receives a real, meaningful boost, while the bright minority is still
/// protected from further amplification, matching the module's actual
/// design intent rather than a mechanically-similar but practically
/// wrong statistic.
///
/// [minGain]/[maxGain] (defaults `0.25`/`4`) bound how far the local
/// adaptation can push any single pixel, specifically to avoid the
/// classic local-tone-mapping failure mode: an extremely dim or
/// extremely bright small region receiving an extreme gain that mostly
/// just amplifies its own noise (a dim region) or crushes it to black
/// (a bright one) rather than usefully revealing detail.

export class InvalidLocalToneAdaptationInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidLocalToneAdaptationInput';
  }
}

const LUMINANCE_RED_WEIGHT = 0.2126;
const LUMINANCE_GREEN_WEIGHT = 0.7152;
const LUMINANCE_BLUE_WEIGHT = 0.0722;

function validateRgb(rgb, width, height) {
  if (rgb.length !== width * height * 3) {
    throw new InvalidLocalToneAdaptationInput(
      'rgb length does not match width * height * 3.',
    );
  }
}

/// Computes a `Float64Array` luminance plane (length `width * height`)
/// from interleaved RGB [rgb] (length `width * height * 3`), via
/// ITU-R BT.709 weighting. Finite signed linear samples are retained
/// through the RGB-to-luminance dot product; only the resulting scalar
/// luminance is clamped to zero. This preserves zero-mean calibrated
/// background residuals instead of biasing each channel upward first.
/// Non-finite input samples are treated as `0`.
export function computeLuminance(rgb, width, height) {
  validateRgb(rgb, width, height);
  const pixelCount = width * height;
  const luminance = new Float64Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const r = rgb[pixel * 3];
    const g = rgb[pixel * 3 + 1];
    const b = rgb[pixel * 3 + 2];
    const finiteOrZero = (value) => (Number.isFinite(value) ? value : 0);
    const weighted = LUMINANCE_RED_WEIGHT * finiteOrZero(r)
      + LUMINANCE_GREEN_WEIGHT * finiteOrZero(g)
      + LUMINANCE_BLUE_WEIGHT * finiteOrZero(b);
    luminance[pixel] = Number.isFinite(weighted) ? Math.max(0, weighted) : 0;
  }
  return luminance;
}

function boxBlur1d(input, width, height, radius, horizontal) {
  const output = new Float64Array(width * height);
  if (horizontal) {
    for (let y = 0; y < height; y++) {
      const rowStart = y * width;
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const sampleX = Math.min(width - 1, Math.max(0, x + dx));
          sum += input[rowStart + sampleX];
          count += 1;
        }
        output[rowStart + x] = sum / count;
      }
    }
  } else {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        let sum = 0;
        let count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const sampleY = Math.min(height - 1, Math.max(0, y + dy));
          sum += input[sampleY * width + x];
          count += 1;
        }
        output[y * width + x] = sum / count;
      }
    }
  }
  return output;
}

/// Separable box blur of [plane] (length `width * height`) with the
/// given [radius] (a `(2*radius+1)` window on each axis), edge-clamped
/// (a neighbor position outside the plane's own bounds reuses the
/// nearest valid edge pixel, rather than treating it as zero, which
/// would incorrectly darken every blurred value near an edge or
/// corner).
///
/// Throws {@link InvalidLocalToneAdaptationInput} if [radius] is not a
/// non-negative integer, or [plane]'s length does not match
/// `width * height`.
export function boxBlur(plane, width, height, radius) {
  if (plane.length !== width * height) {
    throw new InvalidLocalToneAdaptationInput(
      'plane length does not match width * height.',
    );
  }
  if (!Number.isInteger(radius) || radius < 0) {
    throw new InvalidLocalToneAdaptationInput(
      'radius must be a non-negative integer.',
    );
  }
  if (radius === 0) {
    return Float64Array.from(plane);
  }
  const horizontallyBlurred = boxBlur1d(plane, width, height, radius, true);
  return boxBlur1d(horizontallyBlurred, width, height, radius, false);
}

function percentile(values, fraction) {
  const sorted = Float64Array.from(values).sort();
  const position = fraction * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

/// Computes a per-pixel gain `Float64Array` (length `width * height`,
/// matching [surround]'s own shape) from a blurred luminance surround
/// plane [surround] (see [boxBlur]/[computeLuminance]).
///
/// `gain = clamp((referenceSurround / (surround + epsilon)) ^ strength,
/// minGain, maxGain)`, where `referenceSurround` is the
/// [referencePercentile]-th percentile (linear interpolation between the
/// two nearest ranks) of [surround]'s own values — see this module's
/// own doc comment for the full rationale, including why a high
/// percentile rather than the median.
///
/// Throws {@link InvalidLocalToneAdaptationInput} if [strength] is
/// negative, [epsilon] is not positive, [referencePercentile] is outside
/// `[0, 1]`, or [minGain]/[maxGain] are not positive with
/// `minGain <= maxGain`.
export function computeLocalGain(surround, {
  strength = 0.5,
  referencePercentile = 0.85,
  minGain = 0.25,
  maxGain = 4,
  epsilon = 1e-6,
} = {}) {
  if (!(strength >= 0)) {
    throw new InvalidLocalToneAdaptationInput('strength must be non-negative.');
  }
  if (!(epsilon > 0)) {
    throw new InvalidLocalToneAdaptationInput('epsilon must be positive.');
  }
  if (referencePercentile < 0 || referencePercentile > 1) {
    throw new InvalidLocalToneAdaptationInput(
      'referencePercentile must be in [0, 1].',
    );
  }
  if (!(minGain > 0) || !(maxGain > 0) || minGain > maxGain) {
    throw new InvalidLocalToneAdaptationInput(
      'minGain and maxGain must be positive with minGain <= maxGain.',
    );
  }
  const referenceSurround = percentile(surround, referencePercentile);
  const gain = new Float64Array(surround.length);
  for (let pixel = 0; pixel < surround.length; pixel++) {
    const ratio = referenceSurround / (surround[pixel] + epsilon);
    const raw = ratio ** strength;
    gain[pixel] = Math.min(maxGain, Math.max(minGain, raw));
  }
  return gain;
}

/// Multiplies interleaved RGB [rgb] by [gain] (one gain value applied
/// uniformly across a pixel's R, G, and B), returning a new
/// `Float32Array` of the same length; [rgb] itself is not modified.
///
/// Throws {@link InvalidLocalToneAdaptationInput} if [gain]'s length
/// does not match `rgb.length / 3`.
export function applyLocalGain(rgb, gain) {
  if (gain.length * 3 !== rgb.length) {
    throw new InvalidLocalToneAdaptationInput(
      "gain's length does not match rgb's pixel count.",
    );
  }
  const result = new Float32Array(rgb.length);
  for (let pixel = 0; pixel < gain.length; pixel++) {
    const g = gain[pixel];
    result[pixel * 3] = rgb[pixel * 3] * g;
    result[pixel * 3 + 1] = rgb[pixel * 3 + 1] * g;
    result[pixel * 3 + 2] = rgb[pixel * 3 + 2] * g;
  }
  return result;
}

/// Convenience wrapper: computes luminance, blurs it by [blurRadius],
/// derives a local gain (see [computeLocalGain] for
/// [strength]/[minGain]/[maxGain]/[epsilon]), and applies it to [rgb] —
/// the full local tone adaptation pipeline in one call.
///
/// At `strength = 0` (not this function's own default, but a caller can
/// pass it), every gain is exactly `1` and this function returns [rgb]
/// numerically unchanged (still a new array, not the same reference) —
/// see this module's own doc comment for why that backward-compatible
/// no-op property matters.
export function applyLocalToneAdaptation(rgb, width, height, {
  blurRadius = 32,
  strength = 0.5,
  referencePercentile = 0.85,
  minGain = 0.25,
  maxGain = 4,
  epsilon = 1e-6,
} = {}) {
  const luminance = computeLuminance(rgb, width, height);
  const surround = boxBlur(luminance, width, height, blurRadius);
  const gain = computeLocalGain(surround, {
    strength, referencePercentile, minGain, maxGain, epsilon,
  });
  return applyLocalGain(rgb, gain);
}
