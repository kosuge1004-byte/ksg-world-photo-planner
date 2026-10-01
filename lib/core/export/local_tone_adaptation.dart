import 'dart:math' as math;
import 'dart:typed_data';

/// Dart port of `tool/raw_samples/local_tone_adaptation_reference.mjs`.
///
/// Addresses a real, previously-documented image-quality gap:
/// `tone_map.dart`'s own exponential curve applies a single *global*
/// exposure scale to every pixel, which cannot simultaneously keep a
/// dim foreground/background visible and preserve detail in a bright
/// star core or the Milky Way's own dense core (see WORK55_PROGRESS.md's
/// own documented residual limitation).
///
/// This module computes a *per-pixel* exposure gain from each pixel's
/// own *local* surroundings, intended to be applied to the linear RGB
/// data *before* `tone_map.dart`'s existing global curve — reusing that
/// already-tested curve unchanged for the final compression step, with
/// this module responsible only for evening out large-scale brightness
/// differences across the frame first.
///
/// See the Node reference's own doc comment for the full design
/// rationale, including a documented real design mistake this module's
/// own test caught before shipping: an early version referenced the
/// surround's plain *median* as the reference brightness level, but a
/// typical astrophotography frame is mostly dim sky background, so the
/// median itself is approximately equal to the background level,
/// giving background pixels a gain of essentially `1` — no boost at
/// all. Referencing a high percentile ([referencePercentile], default
/// `0.85`) instead fixes this: the dim majority sits below that level
/// and receives a real boost, while the bright minority (stars) sits at
/// or above it and is protected from further amplification.
///
/// At `strength = 0`, [applyLocalToneAdaptation] is a numeric no-op
/// (every gain is exactly `1`) — it can always be inserted into the
/// pipeline without changing existing behavior unless a caller actively
/// opts in with `strength > 0`.
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/local_tone_adaptation_test.dart`
/// before relying on this in production.

class InvalidLocalToneAdaptationInput extends ArgumentError {
  InvalidLocalToneAdaptationInput(String super.message);
}

const List<double> bt709LinearLuminanceWeights = <double>[
  0.2126,
  0.7152,
  0.0722,
];

/// Y row of the linear ProPhoto RGB (D50/RIMM) -> XYZ D50 matrix.
/// Use these weights when local tone operates directly in DNG profile space.
const List<double> linearProPhotoD50LuminanceWeights = <double>[
  0.288040238,
  0.711874097,
  0.000085665,
];

void _validateRgb(Float32List rgb, int width, int height) {
  if (width <= 0 || height <= 0) {
    throw InvalidLocalToneAdaptationInput(
      'width and height must be positive.',
    );
  }
  if (rgb.length != width * height * 3) {
    throw InvalidLocalToneAdaptationInput(
      'rgb length does not match width * height * 3.',
    );
  }
}

/// Computes a luminance plane (length `width * height`) from
/// interleaved RGB [rgb] (length `width * height * 3`), via ITU-R
/// BT.709 weighting. Negative or non-finite input samples are treated
/// as `0`.
Float64List computeLuminance(
  Float32List rgb,
  int width,
  int height, {
  List<double> luminanceWeights = bt709LinearLuminanceWeights,
}) {
  _validateRgb(rgb, width, height);
  if (luminanceWeights.length != 3 ||
      luminanceWeights.any((double value) => !value.isFinite)) {
    throw InvalidLocalToneAdaptationInput(
      'luminanceWeights must contain exactly three finite values.',
    );
  }
  final int pixelCount = width * height;
  final Float64List luminance = Float64List(pixelCount);
  double finiteOrZero(double value) => value.isFinite ? value : 0;
  for (int pixel = 0; pixel < pixelCount; pixel++) {
    final double r = rgb[pixel * 3];
    final double g = rgb[pixel * 3 + 1];
    final double b = rgb[pixel * 3 + 2];
    // Keep signed linear residuals until after the luminance dot product.
    // Per-channel clipping here would undo the calibration pipeline's
    // intentional preservation of negative background-noise residuals and
    // would bias the local-tone surround estimate upward.
    final double weighted = luminanceWeights[0] * finiteOrZero(r) +
        luminanceWeights[1] * finiteOrZero(g) +
        luminanceWeights[2] * finiteOrZero(b);
    luminance[pixel] = weighted.isFinite ? math.max(0, weighted) : 0;
  }
  return luminance;
}

Float64List _boxBlur1d(
  Float64List input,
  int width,
  int height,
  int radius, {
  required bool horizontal,
}) {
  final Float64List output = Float64List(width * height);
  if (horizontal) {
    for (int y = 0; y < height; y++) {
      final int rowStart = y * width;
      for (int x = 0; x < width; x++) {
        double sum = 0;
        int count = 0;
        for (int dx = -radius; dx <= radius; dx++) {
          final int sampleX = (x + dx).clamp(0, width - 1);
          sum += input[rowStart + sampleX];
          count += 1;
        }
        output[rowStart + x] = sum / count;
      }
    }
  } else {
    for (int x = 0; x < width; x++) {
      for (int y = 0; y < height; y++) {
        double sum = 0;
        int count = 0;
        for (int dy = -radius; dy <= radius; dy++) {
          final int sampleY = (y + dy).clamp(0, height - 1);
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
/// given [radius] (a `(2*radius+1)` window on each axis), edge-clamped.
///
/// Throws [InvalidLocalToneAdaptationInput] if [radius] is negative, or
/// [plane]'s length does not match `width * height`.
///
/// Unlike the Node reference (which additionally validates [radius] is
/// an integer), this Dart port has no such check: [radius] is itself
/// typed `int` — the same "Node-level validation made unreachable by
/// Dart's own type system" situation this project's other ports have
/// documented before.
Float64List boxBlur(Float64List plane, int width, int height, int radius) {
  if (width <= 0 || height <= 0) {
    throw InvalidLocalToneAdaptationInput(
      'width and height must be positive.',
    );
  }
  if (plane.length != width * height) {
    throw InvalidLocalToneAdaptationInput(
      'plane length does not match width * height.',
    );
  }
  if (radius < 0) {
    throw InvalidLocalToneAdaptationInput(
      'radius must be a non-negative integer.',
    );
  }
  if (radius == 0) {
    return Float64List.fromList(plane);
  }
  final Float64List horizontallyBlurred = _boxBlur1d(
    plane,
    width,
    height,
    radius,
    horizontal: true,
  );
  return _boxBlur1d(
    horizontallyBlurred,
    width,
    height,
    radius,
    horizontal: false,
  );
}

double _percentile(Float64List values, double fraction) {
  final List<double> sorted = List<double>.of(values)..sort();
  final double position = fraction * (sorted.length - 1);
  final int lowerIndex = position.floor();
  final int upperIndex = position.ceil();
  if (lowerIndex == upperIndex) {
    return sorted[lowerIndex];
  }
  final double weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

/// Computes a per-pixel gain (length `width * height`, matching
/// [surround]'s own shape) from a blurred luminance surround plane
/// [surround] (see [boxBlur]/[computeLuminance]).
///
/// `gain = clamp((referenceSurround / (surround + epsilon)) ^ strength,
/// minGain, maxGain)`, where `referenceSurround` is the
/// [referencePercentile]-th percentile (linear interpolation between the
/// two nearest ranks) of [surround]'s own values.
///
/// Throws [InvalidLocalToneAdaptationInput] if [strength] is negative,
/// [epsilon] is not positive, [referencePercentile] is outside
/// `[0, 1]`, or [minGain]/[maxGain] are not positive with
/// `minGain <= maxGain`.
Float64List computeLocalGain(
  Float64List surround, {
  double strength = 0.5,
  double referencePercentile = 0.85,
  double minGain = 0.25,
  double maxGain = 4,
  double epsilon = 1e-6,
}) {
  if (surround.isEmpty) {
    throw InvalidLocalToneAdaptationInput('surround must not be empty.');
  }
  if (surround.any((double value) => !value.isFinite || value < 0)) {
    throw InvalidLocalToneAdaptationInput(
      'surround must contain only finite non-negative values.',
    );
  }
  if (!strength.isFinite || strength < 0) {
    throw InvalidLocalToneAdaptationInput(
      'strength must be finite and non-negative.',
    );
  }
  if (!epsilon.isFinite || epsilon <= 0) {
    throw InvalidLocalToneAdaptationInput(
      'epsilon must be finite and positive.',
    );
  }
  if (!referencePercentile.isFinite ||
      referencePercentile < 0 ||
      referencePercentile > 1) {
    throw InvalidLocalToneAdaptationInput(
      'referencePercentile must be in [0, 1].',
    );
  }
  if (!minGain.isFinite ||
      !maxGain.isFinite ||
      minGain <= 0 ||
      maxGain <= 0 ||
      minGain > maxGain) {
    throw InvalidLocalToneAdaptationInput(
      'minGain and maxGain must be positive with minGain <= maxGain.',
    );
  }
  final double referenceSurround = _percentile(surround, referencePercentile);
  final Float64List gain = Float64List(surround.length);
  for (int pixel = 0; pixel < surround.length; pixel++) {
    final double ratio = referenceSurround / (surround[pixel] + epsilon);
    final double raw = math.pow(ratio, strength).toDouble();
    gain[pixel] = math.min(maxGain, math.max(minGain, raw));
  }
  return gain;
}

/// Multiplies interleaved RGB [rgb] by [gain] (one gain value applied
/// uniformly across a pixel's R, G, and B), returning a new
/// [Float32List] of the same length; [rgb] itself is not modified.
///
/// Throws [InvalidLocalToneAdaptationInput] if [gain]'s length does not
/// match `rgb.length / 3`.
Float32List applyLocalGain(Float32List rgb, Float64List gain) {
  if (gain.length * 3 != rgb.length) {
    throw InvalidLocalToneAdaptationInput(
      "gain's length does not match rgb's pixel count.",
    );
  }
  if (gain.any((double value) => !value.isFinite || value < 0)) {
    throw InvalidLocalToneAdaptationInput(
      'gain must contain only finite non-negative values.',
    );
  }
  final Float32List result = Float32List(rgb.length);
  for (int pixel = 0; pixel < gain.length; pixel++) {
    final double g = gain[pixel];
    result[pixel * 3] = rgb[pixel * 3] * g;
    result[pixel * 3 + 1] = rgb[pixel * 3 + 1] * g;
    result[pixel * 3 + 2] = rgb[pixel * 3 + 2] * g;
  }
  return result;
}

/// Convenience wrapper: computes luminance, blurs it by [blurRadius],
/// derives a local gain (see [computeLocalGain] for
/// [strength]/[referencePercentile]/[minGain]/[maxGain]/[epsilon]), and
/// applies it to [rgb] — the full local tone adaptation pipeline in one
/// call.
///
/// At `strength = 0`, every gain is exactly `1` and this function
/// returns [rgb] numerically unchanged (still a new array, not the same
/// reference).
Float32List applyLocalToneAdaptation(
  Float32List rgb,
  int width,
  int height, {
  int blurRadius = 32,
  double strength = 0.5,
  double referencePercentile = 0.85,
  double minGain = 0.25,
  double maxGain = 4,
  double epsilon = 1e-6,
  List<double> luminanceWeights = bt709LinearLuminanceWeights,
}) {
  final Float64List luminance = computeLuminance(
    rgb,
    width,
    height,
    luminanceWeights: luminanceWeights,
  );
  final Float64List surround = boxBlur(luminance, width, height, blurRadius);
  final Float64List gain = computeLocalGain(
    surround,
    strength: strength,
    referencePercentile: referencePercentile,
    minGain: minGain,
    maxGain: maxGain,
    epsilon: epsilon,
  );
  return applyLocalGain(rgb, gain);
}
