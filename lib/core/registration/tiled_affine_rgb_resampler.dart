import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'affine_sampling_transform.dart';
import 'local_residual_correction.dart';

/// One output tile plus a per-pixel validity mask.
///
/// A zero coverage value means that the inverse transform mapped the output
/// pixel outside the source frame. Later stacking and drizzle stages must not
/// treat the zero-filled RGB channels at those pixels as real observations.
final class CoveredLinearRgbTile {
  CoveredLinearRgbTile({required this.tile, required Uint8List coverage})
      : coverage = coverage {
    if (coverage.length != tile.width * tile.height) {
      throw ArgumentError('Coverage length does not match the RGB tile.');
    }
    if (coverage.any((int value) => value != 0 && value != 1)) {
      throw ArgumentError(
        'Coverage must be binary: 0 for invalid, 1 for fully valid.',
      );
    }
  }

  final LinearRgbTile tile;
  final Uint8List coverage;

  bool isCoveredAt(int localX, int localY) {
    if (localX < 0 ||
        localX >= tile.width ||
        localY < 0 ||
        localY >= tile.height) {
      throw RangeError('Coverage coordinate is outside the tile.');
    }
    return coverage[localY * tile.width + localX] != 0;
  }
}

class AffineRgbResamplingCancelled implements Exception {
  const AffineRgbResamplingCancelled();

  @override
  String toString() => 'Affine RGB tile resampling was cancelled.';
}

/// Which interpolation kernel [TiledAffineRgbResampler.sampleTile] uses
/// when resampling a source frame onto the output grid.
enum ResamplingInterpolation {
  /// The original, default method: 2x2-neighborhood bilinear
  /// interpolation. Fast, and adequate for most content, but measurably
  /// softens sharp point sources — see [bicubic]'s doc comment.
  bilinear,

  /// 4x4-neighborhood bicubic (Catmull-Rom) interpolation. Preserves a
  /// star's PSF sharpness meaningfully better than [bilinear] — a
  /// synthetic Gaussian star (PSF sigma 1.3px) resampled at the
  /// worst-case sub-pixel offset (centered exactly between four pixels)
  /// showed its FWHM widen to only ~103% of the true value under
  /// bicubic, versus ~107% under bilinear, in the measurement that
  /// motivated adding this option (see WORK57_PROGRESS.md and
  /// `bicubic_interpolation_reference.mjs`, the Node reference this
  /// Dart implementation is ported from). Costs somewhat more per pixel
  /// (a 4x4 neighborhood and cubic weights, instead of 2x2 and linear
  /// weights) and requires a 1-pixel-wider source read margin around
  /// each output tile.
  bicubic,
}

/// Reads only the source rectangle needed for one output tile and applies a
/// fused affine inverse map with bilinear interpolation.
///
/// No full-resolution RGB buffer is materialized. Rotation and translation
/// share one interpolation pass, and out-of-frame samples are marked invalid
/// instead of duplicating edge pixels into the stack.
final class TiledAffineRgbResampler {
  const TiledAffineRgbResampler({
    this.interpolation = ResamplingInterpolation.bilinear,
  });

  /// See [ResamplingInterpolation]. Defaults to [ResamplingInterpolation.
  /// bilinear] — the original, already-shipped, already-tested behavior
  /// — for backward compatibility; every existing caller (including
  /// `milky_way_pipeline.dart`'s `registerAndCombineDecodedFrames`) is
  /// unaffected unless it explicitly opts into
  /// [ResamplingInterpolation.bicubic].
  final ResamplingInterpolation interpolation;

  Future<CoveredLinearRgbTile> sampleTile({
    required LinearRgbTileStore source,
    required OverlappedTile outputTile,
    required int outputImageWidth,
    required int outputImageHeight,
    required AffineSamplingTransform transform,
    LocalResidualCorrectionField? localCorrectionField,
    RawSaturationMask? sourceInvalidMask,
    bool Function()? isCancelled,
  }) async {
    _validateOutputTile(outputTile, outputImageWidth, outputImageHeight);
    if (sourceInvalidMask != null &&
        sourceInvalidMask.pixelCount != source.width * source.height) {
      throw ArgumentError(
          'Source invalid-mask dimensions do not match RGB source.');
    }
    if (isCancelled?.call() ?? false) {
      throw const AffineRgbResamplingCancelled();
    }
    final int outputWidth = outputTile.outputWidth;
    final int outputHeight = outputTile.outputHeight;
    final Float32List output = Float32List(outputWidth * outputHeight * 3);
    final Uint8List coverage = Uint8List(outputWidth * outputHeight);
    final _SourceBounds? bounds = _sourceBounds(
      sourceWidth: source.width,
      sourceHeight: source.height,
      outputX: outputTile.outputX,
      outputY: outputTile.outputY,
      outputWidth: outputWidth,
      outputHeight: outputHeight,
      transform: transform,
      marginPixels: (interpolation == ResamplingInterpolation.bicubic ? 1 : 0) +
          (localCorrectionField?.maximumCorrectionMagnitude.ceil() ?? 0),
    );
    if (bounds == null) {
      return CoveredLinearRgbTile(
        tile: LinearRgbTile(
          x: outputTile.outputX,
          y: outputTile.outputY,
          width: outputWidth,
          height: outputHeight,
          interleavedRgb: output,
        ),
        coverage: coverage,
      );
    }

    final LinearRgbTile input = await source.readRegion(
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    );
    if (input.x != bounds.x ||
        input.y != bounds.y ||
        input.width != bounds.width ||
        input.height != bounds.height) {
      throw StateError('RGB tile store returned an unexpected region.');
    }
    if (input.interleavedRgb.any((double value) => !value.isFinite)) {
      throw StateError('RGB tile store returned a non-finite sample.');
    }
    for (int localY = 0; localY < outputHeight; localY++) {
      if (isCancelled?.call() ?? false) {
        throw const AffineRgbResamplingCancelled();
      }
      final double outputY = (outputTile.outputY + localY).toDouble();
      for (int localX = 0; localX < outputWidth; localX++) {
        final double outputX = (outputTile.outputX + localX).toDouble();
        final LocalResidualCorrection localCorrection =
            localCorrectionField?.evaluate(outputX, outputY) ??
                const LocalResidualCorrection(dx: 0, dy: 0);
        final double sourceX =
            transform.sourceX(outputX, outputY) + localCorrection.dx;
        final double sourceY =
            transform.sourceY(outputX, outputY) + localCorrection.dy;
        if (sourceX < 0 ||
            sourceY < 0 ||
            sourceX > source.width - 1 ||
            sourceY > source.height - 1) {
          continue;
        }
        if (sourceInvalidMask != null &&
            _interpolationFootprintTouchesInvalid(
              sourceX: sourceX,
              sourceY: sourceY,
              sourceWidth: source.width,
              sourceHeight: source.height,
              invalidMask: sourceInvalidMask,
            )) {
          continue;
        }
        final int outputPixel = localY * outputWidth + localX;
        final int outputBase = outputPixel * 3;
        if (interpolation == ResamplingInterpolation.bicubic) {
          _writeBicubicPixel(
            input: input,
            bounds: bounds,
            sourceX: sourceX,
            sourceY: sourceY,
            output: output,
            outputBase: outputBase,
          );
        } else {
          _writeBilinearPixel(
            input: input,
            bounds: bounds,
            sourceX: sourceX,
            sourceY: sourceY,
            sourceWidth: source.width,
            sourceHeight: source.height,
            output: output,
            outputBase: outputBase,
          );
        }
        if (!output[outputBase].isFinite ||
            !output[outputBase + 1].isFinite ||
            !output[outputBase + 2].isFinite) {
          throw StateError(
            'RGB resampling produced a non-finite covered sample.',
          );
        }
        coverage[outputPixel] = 1;
      }
    }
    return CoveredLinearRgbTile(
      tile: LinearRgbTile(
        x: outputTile.outputX,
        y: outputTile.outputY,
        width: outputWidth,
        height: outputHeight,
        interleavedRgb: output,
      ),
      coverage: coverage,
    );
  }

  void _writeBilinearPixel({
    required LinearRgbTile input,
    required _SourceBounds bounds,
    required double sourceX,
    required double sourceY,
    required int sourceWidth,
    required int sourceHeight,
    required Float32List output,
    required int outputBase,
  }) {
    final int x0 = sourceX.floor();
    final int y0 = sourceY.floor();
    final int x1 = math.min(x0 + 1, sourceWidth - 1);
    final int y1 = math.min(y0 + 1, sourceHeight - 1);
    final double fractionX = sourceX - x0;
    final double fractionY = sourceY - y0;
    final int localX0 = x0 - bounds.x;
    final int localX1 = x1 - bounds.x;
    final int localY0 = y0 - bounds.y;
    final int localY1 = y1 - bounds.y;
    final int input00 = (localY0 * input.width + localX0) * 3;
    final int input10 = (localY0 * input.width + localX1) * 3;
    final int input01 = (localY1 * input.width + localX0) * 3;
    final int input11 = (localY1 * input.width + localX1) * 3;
    final double weight00 = (1 - fractionX) * (1 - fractionY);
    final double weight10 = fractionX * (1 - fractionY);
    final double weight01 = (1 - fractionX) * fractionY;
    final double weight11 = fractionX * fractionY;
    for (int channel = 0; channel < 3; channel++) {
      output[outputBase + channel] =
          input.interleavedRgb[input00 + channel] * weight00 +
              input.interleavedRgb[input10 + channel] * weight10 +
              input.interleavedRgb[input01 + channel] * weight01 +
              input.interleavedRgb[input11 + channel] * weight11;
    }
  }

  /// Bicubic (Catmull-Rom) interpolation, matching `bicubic_
  /// interpolation_reference.mjs`'s `sampleBicubicRgb` exactly: a 4x4
  /// neighborhood around `(floor(sourceX), floor(sourceY))`, clamped to
  /// the *local* bounds region's own edges (not the global source
  /// frame's edges) since `bounds` is already sized, via
  /// `_sourceBounds`'s 1-pixel margin for [ResamplingInterpolation.
  /// bicubic], to contain every pixel this neighborhood could ever need
  /// for any output pixel in this tile — mirroring how the bilinear path
  /// clamps to the *global* source frame's edges instead, since bilinear
  /// only ever needs one extra pixel in each direction, already covered
  /// by [_sourceBounds]'s un-margined (bilinear-sized) region without
  /// any local clamping being necessary there.
  void _writeBicubicPixel({
    required LinearRgbTile input,
    required _SourceBounds bounds,
    required double sourceX,
    required double sourceY,
    required Float32List output,
    required int outputBase,
  }) {
    final int x1 = sourceX.floor();
    final int y1 = sourceY.floor();
    final double fractionX = sourceX - x1;
    final double fractionY = sourceY - y1;
    final int localX1 = x1 - bounds.x;
    final int localY1 = y1 - bounds.y;

    for (int channel = 0; channel < 3; channel++) {
      final List<double> rows = List<double>.filled(4, 0);
      for (int j = -1; j <= 2; j++) {
        final int localY = (localY1 + j).clamp(0, input.height - 1);
        final int rowOffset = localY * input.width;
        final double p0 = input.interleavedRgb[
            (rowOffset + (localX1 - 1).clamp(0, input.width - 1)) * 3 +
                channel];
        final double p1 = input.interleavedRgb[
            (rowOffset + localX1.clamp(0, input.width - 1)) * 3 + channel];
        final double p2 = input.interleavedRgb[
            (rowOffset + (localX1 + 1).clamp(0, input.width - 1)) * 3 +
                channel];
        final double p3 = input.interleavedRgb[
            (rowOffset + (localX1 + 2).clamp(0, input.width - 1)) * 3 +
                channel];
        rows[j + 1] = _catmullRom1d(p0, p1, p2, p3, fractionX);
      }
      output[outputBase + channel] =
          _catmullRom1d(rows[0], rows[1], rows[2], rows[3], fractionY);
    }
  }

  /// One-dimensional Catmull-Rom cubic Hermite spline; see
  /// `bicubic_interpolation_reference.mjs`'s `catmullRom1d` for the full
  /// derivation and the interpolation-property tests that validate this
  /// exact formula.
  static double _catmullRom1d(
    double p0,
    double p1,
    double p2,
    double p3,
    double t,
  ) {
    return 0.5 *
        ((2 * p1) +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  }

  bool _interpolationFootprintTouchesInvalid({
    required double sourceX,
    required double sourceY,
    required int sourceWidth,
    required int sourceHeight,
    required RawSaturationMask invalidMask,
  }) {
    final int baseX = sourceX.floor();
    final int baseY = sourceY.floor();
    final int minOffset =
        interpolation == ResamplingInterpolation.bicubic ? -1 : 0;
    final int maxOffset =
        interpolation == ResamplingInterpolation.bicubic ? 2 : 1;
    for (int dy = minOffset; dy <= maxOffset; dy++) {
      final int y = (baseY + dy).clamp(0, sourceHeight - 1).toInt();
      for (int dx = minOffset; dx <= maxOffset; dx++) {
        final int x = (baseX + dx).clamp(0, sourceWidth - 1).toInt();
        if (invalidMask.isSaturatedIndex(y * sourceWidth + x)) {
          return true;
        }
      }
    }
    return false;
  }

  void _validateOutputTile(
    OverlappedTile tile,
    int outputImageWidth,
    int outputImageHeight,
  ) {
    if (outputImageWidth <= 0 ||
        outputImageHeight <= 0 ||
        tile.outputX < 0 ||
        tile.outputY < 0 ||
        tile.outputWidth <= 0 ||
        tile.outputHeight <= 0 ||
        tile.outputX + tile.outputWidth > outputImageWidth ||
        tile.outputY + tile.outputHeight > outputImageHeight) {
      throw ArgumentError('Output tile is outside the output image.');
    }
  }

  _SourceBounds? _sourceBounds({
    required int sourceWidth,
    required int sourceHeight,
    required int outputX,
    required int outputY,
    required int outputWidth,
    required int outputHeight,
    required AffineSamplingTransform transform,
    int marginPixels = 0,
  }) {
    final double left = outputX.toDouble();
    final double top = outputY.toDouble();
    final double right = (outputX + outputWidth - 1).toDouble();
    final double bottom = (outputY + outputHeight - 1).toDouble();
    final List<double> sourceXs = <double>[
      transform.sourceX(left, top),
      transform.sourceX(right, top),
      transform.sourceX(left, bottom),
      transform.sourceX(right, bottom),
    ];
    final List<double> sourceYs = <double>[
      transform.sourceY(left, top),
      transform.sourceY(right, top),
      transform.sourceY(left, bottom),
      transform.sourceY(right, bottom),
    ];
    if (sourceXs.any((double value) => !value.isFinite) ||
        sourceYs.any((double value) => !value.isFinite)) {
      throw StateError('Affine transform produced a non-finite coordinate.');
    }
    final double minimumX = sourceXs.reduce(math.min);
    final double maximumX = sourceXs.reduce(math.max);
    final double minimumY = sourceYs.reduce(math.min);
    final double maximumY = sourceYs.reduce(math.max);
    if (maximumX < 0 ||
        maximumY < 0 ||
        minimumX > sourceWidth - 1 ||
        minimumY > sourceHeight - 1) {
      return null;
    }
    final int x = (minimumX.floor() - marginPixels).clamp(0, sourceWidth - 1);
    final int y = (minimumY.floor() - marginPixels).clamp(0, sourceHeight - 1);
    final int rightInclusive =
        (maximumX.floor() + 1 + marginPixels).clamp(0, sourceWidth - 1);
    final int bottomInclusive =
        (maximumY.floor() + 1 + marginPixels).clamp(0, sourceHeight - 1);
    return _SourceBounds(
      x: x,
      y: y,
      width: rightInclusive - x + 1,
      height: bottomInclusive - y + 1,
    );
  }
}

final class _SourceBounds {
  const _SourceBounds({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  final int x;
  final int y;
  final int width;
  final int height;
}
