import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../registration/tiled_affine_rgb_resampler.dart';
import '../tiles/overlapped_tile_plan.dart';

/// Reads one frame's covered RGB data for a given output region.
///
/// Reuses `tiled_kappa_sigma_combiner.dart`'s `CoveredRgbRegionReader`
/// typedef shape deliberately (same signature, redeclared here rather
/// than imported, so this file has no compile-time dependency on the
/// kappa-sigma combiner): both combiners need exactly the same "give me
/// frame N's data for this output region" capability, differing only in
/// how they combine what comes back.
typedef CoveredRgbRegionReader = Future<CoveredLinearRgbTile> Function(
  int frameIndex,
  OverlappedTile outputRegion,
);

class TiledLightenBlendCancelled implements Exception {
  const TiledLightenBlendCancelled();

  @override
  String toString() => 'Tiled lighten-blend stacking was cancelled.';
}

/// Combined RGB plus the exact per-pixel covering-frame count.
final class LightenBlendStackedRgbTile {
  LightenBlendStackedRgbTile({
    required this.tile,
    required Uint32List coverage,
  }) : coverage = coverage {
    if (coverage.length != tile.width * tile.height) {
      throw ArgumentError('Coverage length does not match the RGB tile.');
    }
  }

  final LinearRgbTile tile;
  final Uint32List coverage;
}

/// Tiled "lighten blend" (比較明合成) stacking for Mobile Stack's star
/// trail mode, mirroring `TiledKappaSigmaCombiner`'s architecture (same
/// `CoveredRgbRegionReader`-style pull-based frame reading, same banded
/// processing bounded by [maximumPixelsPerBand]) but using
/// `lightenBlendCombineCoveredRgb` (`lighten_blend_combiner.dart`) as
/// the per-band combination step instead of iterative kappa-sigma
/// rejection.
///
/// Unlike kappa-sigma stacking, lighten blend needs only a single pass
/// over the frames per band (no iterative outlier-rejection statistics
/// pass), so [combineTile] reads every frame for a band once and
/// combines directly — no `historicalMeans`/`historicalThresholds`-style
/// state carried between passes.
///
/// Star trail mode performs no frame registration of its own (frames
/// come from a stationary tripod; see `lighten_blend_combiner.dart`'s
/// doc comment), so [readFrame] is expected to return each frame's
/// already-demosaiced RGB region directly — typically a `LinearRgbTile
/// Store.readRegion` call per frame per band, with a full-coverage mask
/// (every pixel valid), not a registration-resampled `CoveredLinearRgbTile`
/// the way the Milky Way pipeline's `TiledAffineRgbResampler` produces
/// one.
final class TiledLightenBlendCombiner {
  const TiledLightenBlendCombiner({
    this.keepHighest = 1,
    this.minimumCoveringFrames = 1,
    this.maximumPixelsPerBand = 65536,
    this.maximumOutputTilePixels = 1048576,
  })  : assert(keepHighest > 0),
        assert(minimumCoveringFrames > 0),
        assert(maximumPixelsPerBand > 0),
        assert(maximumOutputTilePixels > 0);

  /// See `lighten_blend_combiner.dart`'s `lightenBlendCombineCoveredRgb`
  /// for the meaning of [keepHighest] and [minimumCoveringFrames]; both
  /// are forwarded unchanged to that function for every band.
  final int keepHighest;
  final int minimumCoveringFrames;
  final int maximumPixelsPerBand;
  final int maximumOutputTilePixels;

  /// Optional per-frame brightness multiplier (same order/length as
  /// `frameCount`), applied to a frame's sample before it competes for
  /// the per-pixel max. `null` (the default) is exactly equivalent to
  /// every frame having weight `1.0` — existing callers that never pass
  /// this see no behavior change. See `star_trail_edge_fade.dart`'s
  /// `computeStarTrailFadeWeights` for the intended source of these
  /// weights (fading the start/end of a star trail).
  Future<LightenBlendStackedRgbTile> combineTile({
    required int frameCount,
    required OverlappedTile outputTile,
    required CoveredRgbRegionReader readFrame,
    List<double>? frameWeights,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) async {
    _validate(frameCount, outputTile);
    if (frameWeights != null && frameWeights.length != frameCount) {
      throw ArgumentError(
        'frameWeights must have exactly frameCount entries.',
      );
    }
    final int width = outputTile.outputWidth;
    final int height = outputTile.outputHeight;
    final Float32List output = Float32List(width * height * 3);
    final Uint32List coverage = Uint32List(width * height);
    final int bandHeight = math.max(1, maximumPixelsPerBand ~/ width);
    int completedRows = 0;

    for (int startY = 0; startY < height; startY += bandHeight) {
      _throwIfCancelled(isCancelled);
      final int currentHeight = math.min(bandHeight, height - startY);
      final OverlappedTile band = OverlappedTile(
        outputX: outputTile.outputX,
        outputY: outputTile.outputY + startY,
        outputWidth: width,
        outputHeight: currentHeight,
        inputX: outputTile.outputX,
        inputY: outputTile.outputY + startY,
        inputWidth: width,
        inputHeight: currentHeight,
      );

      final int pixelCount = width * currentHeight;
      final int sampleCount = pixelCount * 3;
      final Uint32List bandCoverage = Uint32List(pixelCount);
      final Float32List bandRgb;

      if (keepHighest == 1) {
        // Standard lighten blend is associative for finite samples, so the
        // exact result can be accumulated frame-by-frame. This avoids keeping
        // every frame's band in memory simultaneously.
        bandRgb = Float32List(sampleCount)
          ..fillRange(0, sampleCount, double.negativeInfinity);
        for (int frame = 0; frame < frameCount; frame++) {
          _throwIfCancelled(isCancelled);
          final CoveredLinearRgbTile input =
              await _readValidated(frame, band, readFrame);
          final Float32List frameRgb = input.tile.interleavedRgb;
          final double weight = frameWeights?[frame] ?? 1.0;
          for (int pixel = 0; pixel < pixelCount; pixel++) {
            if (input.coverage[pixel] == 0) continue;
            bandCoverage[pixel] += 1;
            final int base = pixel * 3;
            final double r = frameRgb[base] * weight;
            final double g = frameRgb[base + 1] * weight;
            final double b = frameRgb[base + 2] * weight;
            if (r > bandRgb[base]) bandRgb[base] = r;
            if (g > bandRgb[base + 1]) bandRgb[base + 1] = g;
            if (b > bandRgb[base + 2]) bandRgb[base + 2] = b;
          }
          _throwIfCancelled(isCancelled);
        }
      } else {
        // Preserve the existing Nth-highest semantics with a bounded top-K
        // buffer per sample. Memory now depends on band size and K, not the
        // number of source frames.
        final Float32List topValues = Float32List(sampleCount * keepHighest)
          ..fillRange(
            0,
            sampleCount * keepHighest,
            double.negativeInfinity,
          );
        for (int frame = 0; frame < frameCount; frame++) {
          _throwIfCancelled(isCancelled);
          final CoveredLinearRgbTile input =
              await _readValidated(frame, band, readFrame);
          final Float32List frameRgb = input.tile.interleavedRgb;
          final double weight = frameWeights?[frame] ?? 1.0;
          for (int pixel = 0; pixel < pixelCount; pixel++) {
            if (input.coverage[pixel] == 0) continue;
            bandCoverage[pixel] += 1;
            final int base = pixel * 3;
            for (int channel = 0; channel < 3; channel++) {
              final int sampleIndex = base + channel;
              final double value = frameRgb[sampleIndex] * weight;
              final int topBase = sampleIndex * keepHighest;
              if (value <= topValues[topBase + keepHighest - 1]) continue;
              int insertAt = keepHighest - 1;
              while (
                  insertAt > 0 && topValues[topBase + insertAt - 1] < value) {
                topValues[topBase + insertAt] =
                    topValues[topBase + insertAt - 1];
                insertAt -= 1;
              }
              topValues[topBase + insertAt] = value;
            }
          }
          _throwIfCancelled(isCancelled);
        }
        bandRgb = Float32List(sampleCount);
        for (int sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
          final int pixel = sampleIndex ~/ 3;
          final int framesSeen = bandCoverage[pixel];
          final int rank = math.min(keepHighest, framesSeen) - 1;
          bandRgb[sampleIndex] = rank >= 0
              ? topValues[sampleIndex * keepHighest + rank]
              : double.negativeInfinity;
        }
      }

      for (int pixel = 0; pixel < pixelCount; pixel++) {
        if (bandCoverage[pixel] < minimumCoveringFrames) {
          final int base = pixel * 3;
          bandRgb[base] = 0;
          bandRgb[base + 1] = 0;
          bandRgb[base + 2] = 0;
          bandCoverage[pixel] = 0;
        }
      }

      final int rgbDestinationStart = startY * width * 3;
      output.setRange(
        rgbDestinationStart,
        rgbDestinationStart + bandRgb.length,
        bandRgb,
      );
      final int coverageDestinationStart = startY * width;
      coverage.setRange(
        coverageDestinationStart,
        coverageDestinationStart + bandCoverage.length,
        bandCoverage,
      );

      completedRows += currentHeight;
      reportProgress?.call(completedRows / height);
    }

    return LightenBlendStackedRgbTile(
      tile: LinearRgbTile(
        x: outputTile.outputX,
        y: outputTile.outputY,
        width: width,
        height: height,
        interleavedRgb: output,
      ),
      coverage: coverage,
    );
  }

  Future<CoveredLinearRgbTile> _readValidated(
    int frame,
    OverlappedTile band,
    CoveredRgbRegionReader reader,
  ) async {
    final CoveredLinearRgbTile input = await reader(frame, band);
    final LinearRgbTile tile = input.tile;
    if (tile.x != band.outputX ||
        tile.y != band.outputY ||
        tile.width != band.outputWidth ||
        tile.height != band.outputHeight) {
      throw StateError('Covered RGB reader returned an unexpected region.');
    }
    if (tile.interleavedRgb.any((double value) => !value.isFinite)) {
      throw StateError('Covered RGB reader returned a non-finite sample.');
    }
    return input;
  }

  void _validate(int frameCount, OverlappedTile tile) {
    if (frameCount <= 0 || frameCount > 65535) {
      throw ArgumentError.value(frameCount, 'frameCount');
    }
    if (minimumCoveringFrames > frameCount) {
      throw ArgumentError(
        'minimumCoveringFrames cannot exceed frameCount.',
      );
    }
    if (maximumPixelsPerBand <= 0 ||
        maximumOutputTilePixels <= 0 ||
        tile.outputX < 0 ||
        tile.outputY < 0 ||
        tile.outputWidth <= 0 ||
        tile.outputHeight <= 0 ||
        tile.outputWidth > maximumPixelsPerBand ||
        tile.outputWidth * tile.outputHeight > maximumOutputTilePixels) {
      throw ArgumentError('Invalid tiled lighten-blend configuration.');
    }
  }

  void _throwIfCancelled(bool Function()? isCancelled) {
    if (isCancelled?.call() ?? false) {
      throw const TiledLightenBlendCancelled();
    }
  }
}
