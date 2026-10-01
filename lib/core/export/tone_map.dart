import 'dart:math' as math;
import 'dart:typed_data';

import '../color/linear_rgb_color_transform.dart';
import 'dng_profile_hue_sat_map.dart';
import 'dng_profile_look_table.dart';
import 'dng_profile_tone_curve.dart';
import 'local_tone_adaptation.dart';

/// Dart port of `tool/raw_samples/tone_map_reference.mjs`.
///
/// Converts the linear-light, unbounded-range FP32 RGB a stacked result
/// carries (star cores can exceed 1.0 many times over; the sky
/// background sits near, but rarely exactly at, 0) into a display-
/// referred 8-bit sRGB image — the step every previous stage of this
/// project's pipeline (demosaic, registration, drizzle, stacking) has
/// been building toward but that, until now, nothing in this project
/// implemented at all.
///
/// This module deliberately does not just clip at 1.0 and gamma-encode:
/// naive clipping turns every star brighter than middle gray into a flat
/// white disk with no color or shape information, a serious, avoidable
/// image-quality loss for exactly the subject matter (bright point
/// sources against a dark sky) this app exists to photograph. It uses a
/// smooth exponential ("Habitat"-style) tone curve instead — see
/// [_exponentialToneCurve]'s doc comment, and WORK55_PROGRESS.md, for
/// why this specific curve was chosen over the "extended Reinhard"
/// operator this module's first implementation attempt used, and the
/// real, test-caught problems with that formula that motivated switching
/// away from it.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage. Run
/// `test/tone_map_test.dart` (mirroring the Node fixtures) before
/// relying on this in production.

class InvalidToneMapInput extends ArgumentError {
  InvalidToneMapInput(super.message);
}

/// The sRGB opto-electronic transfer function (OETF): converts a linear
/// light value in `[0, 1]` to a display-referred (gamma-encoded) value
/// in `[0, 1]`. Values outside `[0, 1]` are clamped first — this
/// function is meant to be applied *after* tone mapping has already
/// compressed the unbounded HDR range into `[0, 1]`, not applied
/// directly to raw HDR data.
double srgbEncode(double linearValue) {
  final double clamped = math.min(1, math.max(0, linearValue));
  if (clamped <= 0.0031308) {
    return clamped * 12.92;
  }
  return 1.055 * math.pow(clamped, 1 / 2.4) - 0.055;
}

/// The inverse of [srgbEncode]: converts a display-referred sRGB value
/// in `[0, 1]` back to linear light. Exported for completeness and for
/// round-trip testing, not used elsewhere in this module's own pipeline
/// (encoding is one-way for final output).
double srgbDecode(double encodedValue) {
  final double clamped = math.min(1, math.max(0, encodedValue));
  if (clamped <= 0.04045) {
    return clamped / 12.92;
  }
  return math.pow((clamped + 0.055) / 1.055, 2.4).toDouble();
}

/// Exponential ("Habitat"-style) tone curve: maps a non-negative linear
/// luminance [value] (unbounded above) into `[0, 1)`, with [whitePoint]
/// (must be `> 0`) the luminance at which the curve reaches about 90% of
/// its way to white — chosen so [whitePoint] has an intuitive meaning
/// ("roughly where highlights start reading as close to pure white")
/// without needing any output clamping.
///
/// `f(value) = 1 - exp(-rate * value / whitePoint)`, with `rate =
/// ln(10)` chosen so `f(whitePoint) ≈ 0.9` — deliberately not closer to
/// 1 (an initial version of this function used `rate = ln(100)`,
/// reaching `f(whitePoint) ≈ 0.99`, but that compresses far too
/// aggressively in the lower half of the range: `f(whitePoint / 2)` was
/// already `≈ 0.9`, the same as this version's value *at* the white
/// point — found via the Node reference's own tests, not just reasoned
/// about, see WORK55_PROGRESS.md). Leaving deliberate headroom above the
/// estimated white point also better matches how real highlight rolloff
/// generally behaves: there is normally still a little more room for a
/// genuinely more extreme highlight above whatever value drove the
/// white-point estimate.
///
/// This function is naturally, algebraically bounded in `[0, 1)` for any
/// finite non-negative [value] (since `exp(-x) > 0` always for finite
/// `x`) — no explicit clamp is needed, unlike this module's first
/// implementation attempt, which used the "extended Reinhard" formula
/// `v*(1+v/w^2)/(1+v)`. That formula reaches exactly 1 at `value ==
/// whitePoint` as intended, but then *keeps increasing past 1* for
/// `value > whitePoint` instead of leveling off there, and also
/// saturates almost whitePoint-independently for any `value` much
/// greater than 1 — exactly the wrong behavior for this project's actual
/// value range, where star cores can be hundreds to thousands of times
/// brighter than the sky background.
double _exponentialToneCurve(double value, double whitePoint) {
  final double rate = math.log(10);
  return 1 - math.exp((-rate * value) / whitePoint);
}

double _percentile(List<double> sortedValues, double fraction) {
  if (sortedValues.isEmpty) return 0;
  final int index = math.min(
    sortedValues.length - 1,
    math.max(0, (fraction * (sortedValues.length - 1)).round()),
  );
  return sortedValues[index];
}

/// The result of [estimateAutoToneParameters].
final class AutoToneParameters {
  const AutoToneParameters({
    required this.exposureScale,
    required this.whitePoint,
  });

  final double exposureScale;
  final double whitePoint;
}

AutoToneParameters compensateAutoToneForBaselineExposure(
  AutoToneParameters auto,
  double baselineExposureEv,
) {
  if (!baselineExposureEv.isFinite ||
      baselineExposureEv < -32 ||
      baselineExposureEv > 32) {
    throw InvalidToneMapInput(
      'baselineExposureEv must be finite and between -32 and 32 EV.',
    );
  }
  final double baselineScale = math.pow(2, baselineExposureEv).toDouble();
  if (!baselineScale.isFinite || baselineScale <= 0) {
    throw InvalidToneMapInput(
      'Baseline exposure scale must remain finite and positive.',
    );
  }
  // Auto exposure is documented to place the measured background at the
  // requested target *after all linear exposure multipliers are applied*.
  // BaselineExposure is one of those multipliers.  Compensate the user/auto
  // exposure component here so toneMapToDisplayRgb* can still apply the DNG
  // BaselineExposure normally without shifting the auto-exposed median by the
  // same EV a second time.  whitePoint is left unchanged because the combined
  // linear scale (auto / baselineScale) * baselineScale is exactly the scale
  // used when it was estimated.
  return AutoToneParameters(
    exposureScale: auto.exposureScale / baselineScale,
    whitePoint: auto.whitePoint,
  );
}

/// Estimates a reasonable automatic exposure scale and white point from
/// [rgb] (an interleaved linear RGB [Float32List]), so a stacked result
/// with an arbitrary, uncalibrated absolute brightness (a function of
/// exposure count, ISO, aperture, and this project's own internal
/// linear-light units) maps to a sensible-looking image without the
/// caller needing to hand-tune every stack.
///
/// - `exposureScale`: chosen so the median pixel luminance (background
///   sky, for a typical night-sky frame — stars are a small minority of
///   pixels, so the median is robust to them) lands at [targetMedian]
///   (default 0.06, a dim-but-not-crushed background level) after
///   scaling, before the tone curve is applied.
/// - `whitePoint`: chosen from a percentile *within the population of
///   pixels meaningfully brighter than the background* (those exceeding
///   [highlightThresholdMultiplier] times the scaled median), not a
///   percentile of the whole image. A real night-sky frame is
///   overwhelmingly background pixels — a real capture can easily have
///   well under 0.1% of its area covered by stars — so a percentile
///   taken across *all* pixels (an earlier version of this function did
///   exactly that) can land back inside the background population
///   itself instead of ever reaching the stars, especially on smaller
///   images; this was caught by the Node reference's own end-to-end test
///   during development, not merely reasoned about (see
///   WORK55_PROGRESS.md). Restricting the percentile to the highlight
///   population specifically is scale-invariant with respect to how
///   sparse the stars are or how large the image is. If no pixel clears
///   the highlight threshold at all (a blank or near-blank frame), falls
///   back to the single brightest pixel in the whole image.
///
///   The result is additionally capped at [maximumWhitePointMultiplier]
///   (default 500) times the scaled median: an extreme single outlier
///   can otherwise push the white point so high that
///   [_exponentialToneCurve]'s rate becomes too shallow to keep the
///   *background* visibly above zero after 8-bit quantization — a real
///   failure mode the Node reference's own tests found, not a
///   theoretical concern. This cap is a deliberate, disclosed trade-off:
///   beyond it, the very brightest highlights compress somewhat more
///   aggressively than the percentile alone would choose, in exchange
///   for keeping the background reliably visible.
///
/// This is a starting point for a "reasonable default" preview/export,
/// not a substitute for user-adjustable exposure controls — see
/// WORK55_PROGRESS.md's "What's still not done".
AutoToneParameters estimateAutoToneParameters(
  Float32List rgb, {
  double targetMedian = 0.06,
  double highlightPercentile = 0.99,
  double highlightThresholdMultiplier = 3,
  double minimumWhitePoint = 0.5,
  double maximumWhitePointMultiplier = 500,
  List<double> luminanceWeights = bt709LinearLuminanceWeights,
}) {
  if (rgb.isEmpty || rgb.length % 3 != 0) {
    throw InvalidToneMapInput(
      'rgb must be a non-empty Float32List of interleaved RGB triples.',
    );
  }
  if (!targetMedian.isFinite || targetMedian <= 0 || targetMedian > 1) {
    throw InvalidToneMapInput('targetMedian must be finite and in (0, 1].');
  }
  if (!highlightPercentile.isFinite ||
      highlightPercentile < 0 ||
      highlightPercentile > 1) {
    throw InvalidToneMapInput(
      'highlightPercentile must be finite and in [0, 1].',
    );
  }
  if (!highlightThresholdMultiplier.isFinite ||
      highlightThresholdMultiplier <= 0) {
    throw InvalidToneMapInput(
      'highlightThresholdMultiplier must be finite and positive.',
    );
  }
  if (!minimumWhitePoint.isFinite || minimumWhitePoint <= 0) {
    throw InvalidToneMapInput(
      'minimumWhitePoint must be finite and positive.',
    );
  }
  if (!maximumWhitePointMultiplier.isFinite ||
      maximumWhitePointMultiplier <= 0) {
    throw InvalidToneMapInput(
      'maximumWhitePointMultiplier must be finite and positive.',
    );
  }
  if (luminanceWeights.length != 3 ||
      luminanceWeights.any((double value) => !value.isFinite)) {
    throw InvalidToneMapInput(
      'luminanceWeights must contain exactly three finite values.',
    );
  }
  final int pixelCount = rgb.length ~/ 3;
  final Float64List luminance = Float64List(pixelCount);
  double finiteOrZero(double value) => value.isFinite ? value : 0;
  for (int pixel = 0; pixel < pixelCount; pixel++) {
    final int base = pixel * 3;
    // Luminance weights must describe the RGB space held by [rgb]. For
    // normal linear-sRGB input the default BT.709 weights are correct.
    // Camera-RGB callers that later apply a DNG color transform can pass
    // output-space Y weights projected back through that transform, so
    // auto exposure is based on the same physical luminance axis as the
    // final render instead of treating camera RGB as if it were sRGB.
    // Preserve signed linear residuals through the luminance dot product.
    // Dark subtraction and black-level calibration deliberately retain
    // negative noise residuals; clipping each RGB channel before weighting
    // would bias the background upward and break that zero-mean property.
    // Only the scalar luminance result is clamped because exposure statistics
    // require a non-negative brightness domain.
    final double weighted = luminanceWeights[0] * finiteOrZero(rgb[base]) +
        luminanceWeights[1] * finiteOrZero(rgb[base + 1]) +
        luminanceWeights[2] * finiteOrZero(rgb[base + 2]);
    luminance[pixel] = weighted.isFinite ? math.max(0, weighted) : 0;
  }
  final List<double> sortedLuminance = luminance.toList()..sort();
  final double median = _percentile(sortedLuminance, 0.5);
  final double exposureScale = median > 1e-9 ? targetMedian / median : 1;

  final List<double> scaledLuminance = sortedLuminance
      .map((double value) => math.max(0, value) * exposureScale)
      .toList();
  final double scaledMedian = math.max(0, median) * exposureScale;
  final double highlightThreshold = math.max(
    scaledMedian * highlightThresholdMultiplier,
    1e-6,
  );
  // scaledLuminance is already sorted ascending, so the highlight
  // population (everything above the threshold) is exactly its tail --
  // no need to re-filter-and-resort.
  final int firstHighlightIndex = scaledLuminance.indexWhere(
    (double value) => value > highlightThreshold,
  );
  final List<double> highlightPopulation = firstHighlightIndex == -1
      ? const <double>[]
      : scaledLuminance.sublist(firstHighlightIndex);

  final double whitePoint = highlightPopulation.isNotEmpty
      ? math.max(
          minimumWhitePoint,
          _percentile(highlightPopulation, highlightPercentile),
        )
      : math.max(
          minimumWhitePoint,
          scaledLuminance.isNotEmpty ? scaledLuminance.last : 0,
        );
  final double cappedWhitePoint = math.min(
    whitePoint,
    math.max(minimumWhitePoint, scaledMedian * maximumWhitePointMultiplier),
  );
  return AutoToneParameters(
    exposureScale: exposureScale,
    whitePoint: cappedWhitePoint,
  );
}

/// Tone-maps [rgb] (an interleaved linear RGB [Float32List]) into a new
/// [Uint8List] of the same length. Signed finite components are preserved
/// through purely linear color transforms; non-negativity is enforced only at
/// HSV/LUT or final display boundaries.
/// holding display-referred 8-bit sRGB values ready to write into an
/// image file.
///
/// - [exposureScale] (default 1): a linear multiplier applied before the
///   tone curve; see [estimateAutoToneParameters] for computing a
///   sensible value automatically rather than guessing one.
/// - [whitePoint] (default 1): forwarded to the tone curve; likewise
///   usually supplied via [estimateAutoToneParameters] rather than a
///   fixed constant.
/// - [applySrgbGamma] (default true): applies [srgbEncode] after the
///   tone curve. The tone curve alone only guarantees the result lands
///   in `[0, 1)`; it does not itself apply a display gamma.
///
/// Non-finite samples are sanitized. Negative linear residuals are legitimate
/// after calibration and matrix conversion, so they are not clipped between
/// linear transforms; they are clamped only before a non-linear profile stage
/// that requires a non-negative domain or before the final tone curve.
Uint8List toneMapToDisplayRgb(
  Float32List rgb, {
  double exposureScale = 1,
  double baselineExposureEv = 0,
  double whitePoint = 1,
  bool applySrgbGamma = true,
  LinearRgbColorTransform? linearColorTransform,
  LinearRgbColorTransform? postProfileColorTransform,
  DngProfileHueSatMap? profileHueSatMap,
  DngProfileLookTable? profileLookTable,
  DngProfileToneCurve? profileToneCurve,
}) {
  if (!whitePoint.isFinite || whitePoint <= 0) {
    throw InvalidToneMapInput('whitePoint must be finite and positive.');
  }
  if (!exposureScale.isFinite || exposureScale < 0) {
    throw InvalidToneMapInput('exposureScale must be finite and non-negative.');
  }
  final double effectiveExposureScale =
      _effectiveExposureScale(exposureScale, baselineExposureEv);
  if ((linearColorTransform != null ||
          postProfileColorTransform != null ||
          profileHueSatMap != null ||
          profileLookTable != null) &&
      rgb.length % 3 != 0) {
    throw InvalidToneMapInput(
      'DNG profile tables require complete interleaved RGB triples.',
    );
  }
  final Uint8List output = Uint8List(rgb.length);
  final Float64List colorTransformed = Float64List(3);
  final Float64List transformed = Float64List(3);
  final Float64List looked = Float64List(3);
  final Float64List outputColor = Float64List(3);
  for (int base = 0; base < rgb.length; base += 3) {
    final int end = math.min(base + 3, rgb.length);
    if (linearColorTransform != null) {
      linearColorTransform.transformPixel(
        rgb[base],
        rgb[base + 1],
        rgb[base + 2],
        colorTransformed,
      );
    } else {
      // No color transform does not mean this is a non-linear boundary.
      // Preserve signed finite residuals here as well: CFA drizzle / other
      // pre-converted linear RGB can legitimately contain small negative
      // out-of-gamut or calibration residuals that a later linear
      // postProfileColorTransform may cancel. Clamp only immediately before
      // HSV/LUT/profile-tone or final display processing.
      for (int index = base; index < end; index++) {
        colorTransformed[index - base] = _safeFinite(rgb[index]);
      }
    }
    if (profileHueSatMap != null) {
      // DNG HueSatMap operates in HSV-like profile space and therefore needs
      // a non-negative RGB triplet. Clamp only at this non-linear boundary.
      profileHueSatMap.transformPixel(
        _safeNonnegative(colorTransformed[0]),
        _safeNonnegative(colorTransformed[1]),
        _safeNonnegative(colorTransformed[2]),
        transformed,
      );
    } else {
      // Keep signed, finite linear values while we remain in purely linear
      // color space. Matrix transforms legitimately produce negative
      // out-of-gamut components; clipping them between two matrices changes
      // the final color because clamp(M1*x) followed by M2 is not equivalent
      // to M2*M1*x. A later HSV/LUT boundary or the final display stage is
      // where non-negativity becomes required.
      for (int index = base; index < end; index++) {
        transformed[index - base] = _safeFinite(colorTransformed[index - base]);
      }
    }
    for (int index = base; index < end; index++) {
      transformed[index - base] *= effectiveExposureScale;
    }
    if (profileLookTable != null) {
      // LookTable shares the DNG HueSatMap HSV kernel, so non-negative input
      // is required here even when no HueSatMap preceded it.
      profileLookTable.transformPixel(
        _safeNonnegative(transformed[0]),
        _safeNonnegative(transformed[1]),
        _safeNonnegative(transformed[2]),
        looked,
      );
    }
    final Float64List workingColor =
        profileLookTable == null ? transformed : looked;
    if (postProfileColorTransform != null) {
      postProfileColorTransform.transformPixel(
        workingColor[0],
        workingColor[1],
        workingColor[2],
        outputColor,
      );
    }
    for (int index = base; index < end; index++) {
      final double exposed = postProfileColorTransform == null
          ? workingColor[index - base]
          : outputColor[index - base];
      // DNG ProfileToneCurve is defined in linear gamma and is the camera
      // profile's default tone rendering -- a starting point for later user /
      // display adjustments. Apply it to the exposed linear value before this
      // app's own global highlight-compression curve. Feeding the already
      // non-linear exponential result into ProfileToneCurve would violate the
      // tag's linear-gamma input contract and reverse the intended order.
      final double linearProfiled = profileToneCurve?.evaluate(
            _safeNonnegative(exposed),
          ) ??
          _safeNonnegative(exposed);
      final double mapped = _exponentialToneCurve(
        _safeNonnegative(linearProfiled),
        whitePoint,
      );
      final double display = applySrgbGamma ? srgbEncode(mapped) : mapped;
      output[index] = (display * 255).round().clamp(0, 255);
    }
  }
  return output;
}

/// The same display transform as [toneMapToDisplayRgb], quantized to the full
/// unsigned 16-bit range for high-bit-depth TIFF export.
Uint16List toneMapToDisplayRgb16(
  Float32List rgb, {
  double exposureScale = 1,
  double baselineExposureEv = 0,
  double whitePoint = 1,
  bool applySrgbGamma = true,
  LinearRgbColorTransform? linearColorTransform,
  LinearRgbColorTransform? postProfileColorTransform,
  DngProfileHueSatMap? profileHueSatMap,
  DngProfileLookTable? profileLookTable,
  DngProfileToneCurve? profileToneCurve,
}) {
  if (!whitePoint.isFinite || whitePoint <= 0) {
    throw InvalidToneMapInput('whitePoint must be finite and positive.');
  }
  if (!exposureScale.isFinite || exposureScale < 0) {
    throw InvalidToneMapInput('exposureScale must be finite and non-negative.');
  }
  final double effectiveExposureScale =
      _effectiveExposureScale(exposureScale, baselineExposureEv);
  if ((linearColorTransform != null ||
          postProfileColorTransform != null ||
          profileHueSatMap != null ||
          profileLookTable != null) &&
      rgb.length % 3 != 0) {
    throw InvalidToneMapInput(
      'DNG profile tables require complete interleaved RGB triples.',
    );
  }
  final Uint16List output = Uint16List(rgb.length);
  final Float64List colorTransformed = Float64List(3);
  final Float64List transformed = Float64List(3);
  final Float64List looked = Float64List(3);
  final Float64List outputColor = Float64List(3);
  for (int base = 0; base < rgb.length; base += 3) {
    final int end = math.min(base + 3, rgb.length);
    if (linearColorTransform != null) {
      linearColorTransform.transformPixel(
        rgb[base],
        rgb[base + 1],
        rgb[base + 2],
        colorTransformed,
      );
    } else {
      // No color transform does not mean this is a non-linear boundary.
      // Preserve signed finite residuals here as well: CFA drizzle / other
      // pre-converted linear RGB can legitimately contain small negative
      // out-of-gamut or calibration residuals that a later linear
      // postProfileColorTransform may cancel. Clamp only immediately before
      // HSV/LUT/profile-tone or final display processing.
      for (int index = base; index < end; index++) {
        colorTransformed[index - base] = _safeFinite(rgb[index]);
      }
    }
    if (profileHueSatMap != null) {
      // DNG HueSatMap operates in HSV-like profile space and therefore needs
      // a non-negative RGB triplet. Clamp only at this non-linear boundary.
      profileHueSatMap.transformPixel(
        _safeNonnegative(colorTransformed[0]),
        _safeNonnegative(colorTransformed[1]),
        _safeNonnegative(colorTransformed[2]),
        transformed,
      );
    } else {
      // Keep signed, finite linear values while we remain in purely linear
      // color space. Matrix transforms legitimately produce negative
      // out-of-gamut components; clipping them between two matrices changes
      // the final color because clamp(M1*x) followed by M2 is not equivalent
      // to M2*M1*x. A later HSV/LUT boundary or the final display stage is
      // where non-negativity becomes required.
      for (int index = base; index < end; index++) {
        transformed[index - base] = _safeFinite(colorTransformed[index - base]);
      }
    }
    for (int index = base; index < end; index++) {
      transformed[index - base] *= effectiveExposureScale;
    }
    if (profileLookTable != null) {
      // LookTable shares the DNG HueSatMap HSV kernel, so non-negative input
      // is required here even when no HueSatMap preceded it.
      profileLookTable.transformPixel(
        _safeNonnegative(transformed[0]),
        _safeNonnegative(transformed[1]),
        _safeNonnegative(transformed[2]),
        looked,
      );
    }
    final Float64List workingColor =
        profileLookTable == null ? transformed : looked;
    if (postProfileColorTransform != null) {
      postProfileColorTransform.transformPixel(
        workingColor[0],
        workingColor[1],
        workingColor[2],
        outputColor,
      );
    }
    for (int index = base; index < end; index++) {
      final double exposed = postProfileColorTransform == null
          ? workingColor[index - base]
          : outputColor[index - base];
      // DNG ProfileToneCurve is defined in linear gamma and is the camera
      // profile's default tone rendering -- a starting point for later user /
      // display adjustments. Apply it to the exposed linear value before this
      // app's own global highlight-compression curve. Feeding the already
      // non-linear exponential result into ProfileToneCurve would violate the
      // tag's linear-gamma input contract and reverse the intended order.
      final double linearProfiled = profileToneCurve?.evaluate(
            _safeNonnegative(exposed),
          ) ??
          _safeNonnegative(exposed);
      final double mapped = _exponentialToneCurve(
        _safeNonnegative(linearProfiled),
        whitePoint,
      );
      final double display = applySrgbGamma ? srgbEncode(mapped) : mapped;
      output[index] = (display * 65535).round().clamp(0, 65535);
    }
  }
  return output;
}

double _safeFinite(double value) => value.isFinite ? value : 0;

double _safeNonnegative(double value) =>
    value.isFinite ? math.max(0, value) : 0;

double _effectiveExposureScale(
    double exposureScale, double baselineExposureEv) {
  if (!baselineExposureEv.isFinite ||
      baselineExposureEv < -32 ||
      baselineExposureEv > 32) {
    throw InvalidToneMapInput(
      'baselineExposureEv must be finite and between -32 and 32 EV.',
    );
  }
  final double scale =
      exposureScale * math.pow(2, baselineExposureEv).toDouble();
  if (!scale.isFinite) {
    throw InvalidToneMapInput('Combined exposure scale must remain finite.');
  }
  return scale;
}
