import 'dart:math' as math;
import 'dart:typed_data';

import '../registration/tiled_affine_rgb_resampler.dart'
    show CoveredLinearRgbTile;

/// Dart port of `tool/raw_samples/lighten_blend_reference.mjs`.
///
/// "Lighten blend" (比較明合成) stacking for Mobile Stack's star trail
/// mode. Unlike the Milky Way mode's registered stacking, star trail mode
/// intentionally performs *no* frame alignment: consecutive frames from a
/// stationary tripod are combined by taking, at each pixel, the
/// brightest value seen across all frames. Stars sweep across the sensor
/// as the sky rotates, so their brightest contribution traces out a
/// trail; the (unmoving) foreground and sky background are unaffected
/// since they don't change between frames.
///
/// Frame shape reuses [CoveredLinearRgbTile] (the same type
/// `TiledAffineRgbResampler` produces for the Milky Way pipeline) even
/// though star trail mode has no resampling step of its own, so it can
/// share downstream tile-store plumbing.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage. Run
/// `test/lighten_blend_combiner_test.dart` (mirroring the Node fixtures)
/// before relying on this in production.

class InvalidLightenBlendInput extends ArgumentError {
  InvalidLightenBlendInput(super.message);
}

class LightenBlendCancelled implements Exception {
  const LightenBlendCancelled();

  @override
  String toString() =>
      'LightenBlendCancelled: Lighten-blend stacking was cancelled.';
}

/// The result of [lightenBlendCombineCoveredRgb]: an interleaved RGB
/// plane plus a per-pixel coverage count (not just 0/1 — the number of
/// frames that covered that pixel), letting callers see thin coverage
/// even where a result was still produced.
final class LightenBlendResult {
  const LightenBlendResult({required this.rgb, required this.coverage});

  final Float32List rgb;
  final Uint32List coverage;
}

void _validate(
  List<CoveredLinearRgbTile> frames,
  int minimumCoveringFrames,
) {
  if (frames.isEmpty || frames.length > 65535) {
    throw InvalidLightenBlendInput('One to 65535 frames are required.');
  }
  final int sampleCount = frames[0].tile.interleavedRgb.length;
  if (sampleCount <= 0 || sampleCount % 3 != 0) {
    throw InvalidLightenBlendInput('Invalid RGB sample count.');
  }
  for (final CoveredLinearRgbTile frame in frames) {
    if (frame.tile.interleavedRgb.length != sampleCount) {
      throw InvalidLightenBlendInput(
        'Every frame must have the same RGB sample count.',
      );
    }
    if (frame.coverage.length != sampleCount ~/ 3) {
      throw InvalidLightenBlendInput(
        'Coverage length must match the pixel count.',
      );
    }
  }
  if (minimumCoveringFrames < 1) {
    throw InvalidLightenBlendInput(
      'minimumCoveringFrames must be a positive integer.',
    );
  }
}

/// Combines [frames] by taking, independently per RGB sample, the
/// [keepHighest]-th highest value seen across all frames that cover that
/// pixel.
///
/// - [keepHighest] (default 1): `1` is a standard lighten blend (the
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
/// - [minimumCoveringFrames] (default 1): a pixel covered by fewer than
///   this many frames is reported as uncovered in the output (`coverage
///   == 0`) rather than returning a lighten-blend result derived from
///   too few samples to be meaningful. When using `keepHighest > 1`,
///   consider setting this to at least `keepHighest`: a pixel covered by
///   fewer frames than `keepHighest` still produces a result (the lowest
///   value among however many frames did cover it, as the best available
///   stand-in for "the Nth highest"), which may not be the robustness
///   guarantee the caller expects from a higher `keepHighest`.
/// - [isCancelled]: polled between frames.
///
/// Throws [LightenBlendCancelled] if cancelled.
LightenBlendResult lightenBlendCombineCoveredRgb({
  required List<CoveredLinearRgbTile> frames,
  int keepHighest = 1,
  int minimumCoveringFrames = 1,
  bool Function()? isCancelled,
}) {
  _validate(frames, minimumCoveringFrames);
  if (keepHighest < 1) {
    throw InvalidLightenBlendInput('keepHighest must be a positive integer.');
  }
  final bool Function() cancelled = isCancelled ?? (() => false);
  if (cancelled()) throw const LightenBlendCancelled();

  final int sampleCount = frames[0].tile.interleavedRgb.length;
  final int pixelCount = sampleCount ~/ 3;
  final Uint32List coverage = Uint32List(pixelCount);

  if (keepHighest == 1) {
    // Fast path: track a running max directly, one pass over the
    // frames, without retaining a top-K buffer per sample.
    final Float32List rgb = Float32List(sampleCount)
      ..fillRange(0, sampleCount, double.negativeInfinity);
    for (final CoveredLinearRgbTile frame in frames) {
      if (cancelled()) throw const LightenBlendCancelled();
      final Float32List frameRgb = frame.tile.interleavedRgb;
      for (int pixel = 0; pixel < pixelCount; pixel++) {
        if (frame.coverage[pixel] == 0) continue;
        coverage[pixel] += 1;
        final int base = pixel * 3;
        if (frameRgb[base] > rgb[base]) rgb[base] = frameRgb[base];
        if (frameRgb[base + 1] > rgb[base + 1]) {
          rgb[base + 1] = frameRgb[base + 1];
        }
        if (frameRgb[base + 2] > rgb[base + 2]) {
          rgb[base + 2] = frameRgb[base + 2];
        }
      }
    }
    _finalizeUncoveredAndSparse(
        rgb, coverage, pixelCount, minimumCoveringFrames);
    return LightenBlendResult(rgb: rgb, coverage: coverage);
  }

  // keepHighest > 1: maintain a small per-sample top-K buffer. K is
  // typically tiny (2-3), so a linear insert is fine and avoids pulling
  // in a heap for what is, per pixel, a handful of comparisons.
  final Float32List topValues = Float32List(sampleCount * keepHighest)
    ..fillRange(0, sampleCount * keepHighest, double.negativeInfinity);
  for (final CoveredLinearRgbTile frame in frames) {
    if (cancelled()) throw const LightenBlendCancelled();
    final Float32List frameRgb = frame.tile.interleavedRgb;
    for (int pixel = 0; pixel < pixelCount; pixel++) {
      if (frame.coverage[pixel] == 0) continue;
      coverage[pixel] += 1;
      final int base = pixel * 3;
      for (int channel = 0; channel < 3; channel++) {
        final int sampleIndex = base + channel;
        final double value = frameRgb[sampleIndex];
        final int topBase = sampleIndex * keepHighest;
        if (value <= topValues[topBase + keepHighest - 1]) continue;
        int insertAt = keepHighest - 1;
        while (insertAt > 0 && topValues[topBase + insertAt - 1] < value) {
          topValues[topBase + insertAt] = topValues[topBase + insertAt - 1];
          insertAt -= 1;
        }
        topValues[topBase + insertAt] = value;
      }
    }
  }
  final Float32List rgb = Float32List(sampleCount);
  for (int sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    final int pixel = sampleIndex ~/ 3;
    final int framesSeen = coverage[pixel];
    final int rank = math.min(keepHighest, framesSeen) - 1;
    rgb[sampleIndex] = rank >= 0
        ? topValues[sampleIndex * keepHighest + rank]
        : double.negativeInfinity;
  }
  _finalizeUncoveredAndSparse(rgb, coverage, pixelCount, minimumCoveringFrames);
  return LightenBlendResult(rgb: rgb, coverage: coverage);
}

void _finalizeUncoveredAndSparse(
  Float32List rgb,
  Uint32List coverage,
  int pixelCount,
  int minimumCoveringFrames,
) {
  for (int pixel = 0; pixel < pixelCount; pixel++) {
    if (coverage[pixel] < minimumCoveringFrames) {
      final int base = pixel * 3;
      rgb[base] = 0;
      rgb[base + 1] = 0;
      rgb[base + 2] = 0;
      coverage[pixel] = 0;
    } else if (coverage[pixel] == 0) {
      final int base = pixel * 3;
      rgb[base] = 0;
      rgb[base + 1] = 0;
      rgb[base + 2] = 0;
    }
  }
}
