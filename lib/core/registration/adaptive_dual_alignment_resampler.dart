import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'affine_sampling_transform.dart';
import 'local_residual_correction.dart';
import 'tiled_affine_rgb_resampler.dart';

/// Selects between star-aligned and static-scene-aligned samples while
/// suppressing isolated one-pixel domain flips.
///
/// A landscape night stack contains two motion domains: the sky moves between
/// exposures while a tripod-fixed foreground does not. Applying the stellar
/// transform to the entire image therefore creates foreground double edges.
/// The raw photometric decision is still made per pixel, but WORK346 requires
/// every identity decision to have coherent neighbouring support
/// in its 8-connected neighbourhood. A two-pixel halo is evaluated around the
/// requested tile so this rule is independent of combiner band/tile borders.
/// This deliberately minimal spatial regularisation removes salt-and-pepper
/// switching without inventing a semantic sky/foreground segmentation model.
final class AdaptiveDualAlignmentResampler {
  const AdaptiveDualAlignmentResampler({
    required this.starResampler,
    this.identityAdvantageRatio = 0.5,
    this.absoluteDifferenceFloor = 0.01,
    this.relativeDifferenceFloor = 0.03,
    this.requireSpatialIdentitySupport = true,
  });

  final TiledAffineRgbResampler starResampler;
  final double identityAdvantageRatio;
  final double absoluteDifferenceFloor;
  final double relativeDifferenceFloor;

  /// When true (the production default), an identity-domain choice must have
  /// a coherent adjacent identity candidate or a third connected candidate.
  /// A two-pixel halo covers this local connectivity rule. It removes
  /// isolated decision noise while preserving thin but spatially continuous
  /// foreground structure.
  final bool requireSpatialIdentitySupport;

  Future<CoveredLinearRgbTile> sampleTile({
    required LinearRgbTileStore reference,
    required LinearRgbTileStore source,
    required OverlappedTile outputTile,
    required int outputImageWidth,
    required int outputImageHeight,
    required AffineSamplingTransform starTransform,
    LocalResidualCorrectionField? localCorrectionField,
    RawSaturationMask? referenceInvalidMask,
    RawSaturationMask? sourceInvalidMask,
    bool Function()? isCancelled,
  }) async {
    if (!identityAdvantageRatio.isFinite ||
        identityAdvantageRatio <= 0 ||
        identityAdvantageRatio >= 1 ||
        !absoluteDifferenceFloor.isFinite ||
        absoluteDifferenceFloor < 0 ||
        !relativeDifferenceFloor.isFinite ||
        relativeDifferenceFloor < 0) {
      throw ArgumentError(
        'Adaptive dual-alignment thresholds must be finite and valid.',
      );
    }
    if (reference.width != source.width ||
        reference.height != source.height ||
        reference.width != outputImageWidth ||
        reference.height != outputImageHeight) {
      throw ArgumentError(
        'Reference/source dimensions must match the output image.',
      );
    }
    final int pixelCount = outputImageWidth * outputImageHeight;
    if (referenceInvalidMask != null &&
        referenceInvalidMask.pixelCount != pixelCount) {
      throw ArgumentError(
        'Reference invalid-mask dimensions do not match the output image.',
      );
    }
    if (sourceInvalidMask != null &&
        sourceInvalidMask.pixelCount != pixelCount) {
      throw ArgumentError(
        'Source invalid-mask dimensions do not match the output image.',
      );
    }

    // WORK346: evaluate two extra output pixels around every requested region.
    // The combiner may split a tile into smaller bands, so regularising only
    // inside the requested region would make the decision depend on an
    // implementation boundary. The halo makes neighbour support invariant at
    // those internal boundaries (image edges naturally have fewer neighbours).
    final int halo = requireSpatialIdentitySupport ? 2 : 0;
    final int expandedX = math.max(0, outputTile.outputX - halo);
    final int expandedY = math.max(0, outputTile.outputY - halo);
    final int expandedRight = math.min(
      outputImageWidth,
      outputTile.outputX + outputTile.outputWidth + halo,
    );
    final int expandedBottom = math.min(
      outputImageHeight,
      outputTile.outputY + outputTile.outputHeight + halo,
    );
    final int expandedWidth = expandedRight - expandedX;
    final int expandedHeight = expandedBottom - expandedY;
    final OverlappedTile expandedTile = OverlappedTile(
      outputX: expandedX,
      outputY: expandedY,
      outputWidth: expandedWidth,
      outputHeight: expandedHeight,
      inputX: expandedX,
      inputY: expandedY,
      inputWidth: expandedWidth,
      inputHeight: expandedHeight,
    );

    final LinearRgbTile referenceTile = await reference.readRegion(
      x: expandedX,
      y: expandedY,
      width: expandedWidth,
      height: expandedHeight,
    );
    final LinearRgbTile identityTile = await source.readRegion(
      x: expandedX,
      y: expandedY,
      width: expandedWidth,
      height: expandedHeight,
    );
    if (referenceTile.interleavedRgb.any((double value) => !value.isFinite) ||
        identityTile.interleavedRgb.any((double value) => !value.isFinite)) {
      throw StateError(
        'Adaptive dual alignment received a non-finite RGB sample.',
      );
    }

    final CoveredLinearRgbTile stellar = await starResampler.sampleTile(
      source: source,
      outputTile: expandedTile,
      outputImageWidth: outputImageWidth,
      outputImageHeight: outputImageHeight,
      transform: starTransform,
      localCorrectionField: localCorrectionField,
      sourceInvalidMask: sourceInvalidMask,
      isCancelled: isCancelled,
    );

    final Uint8List identityCandidates =
        Uint8List(expandedWidth * expandedHeight);
    for (int pixel = 0; pixel < identityCandidates.length; pixel++) {
      if (isCancelled?.call() ?? false) {
        throw const AffineRgbResamplingCancelled();
      }
      if (stellar.coverage[pixel] == 0) continue;
      final int localY = pixel ~/ expandedWidth;
      final int localX = pixel - localY * expandedWidth;
      final int globalX = expandedX + localX;
      final int globalY = expandedY + localY;
      final int globalIndex = globalY * outputImageWidth + globalX;
      final bool identityInvalid =
          sourceInvalidMask?.isSaturatedIndex(globalIndex) ?? false;
      final bool referenceInvalid =
          referenceInvalidMask?.isSaturatedIndex(globalIndex) ?? false;
      if (referenceInvalid || identityInvalid) continue;
      final int base = pixel * 3;
      if (_preferIdentity(referenceTile, identityTile, stellar.tile, base)) {
        identityCandidates[pixel] = 1;
      }
    }

    final int requestedPixelCount =
        outputTile.outputWidth * outputTile.outputHeight;
    final Float32List output = Float32List(requestedPixelCount * 3);
    final Uint8List coverage = Uint8List(requestedPixelCount);
    final int cropX = outputTile.outputX - expandedX;
    final int cropY = outputTile.outputY - expandedY;
    for (int localY = 0; localY < outputTile.outputHeight; localY++) {
      if (isCancelled?.call() ?? false) {
        throw const AffineRgbResamplingCancelled();
      }
      for (int localX = 0; localX < outputTile.outputWidth; localX++) {
        final int requestedPixel = localY * outputTile.outputWidth + localX;
        final int expandedLocalX = cropX + localX;
        final int expandedLocalY = cropY + localY;
        final int expandedPixel =
            expandedLocalY * expandedWidth + expandedLocalX;
        if (stellar.coverage[expandedPixel] == 0) {
          // Fail closed at stellar-transform coverage boundaries. Never use
          // an unregistered identity sky sample merely to fill a missing
          // transformed observation.
          continue;
        }

        final bool preferIdentity = identityCandidates[expandedPixel] != 0 &&
            (!requireSpatialIdentitySupport ||
                _hasIdentityNeighbour(
                  candidates: identityCandidates,
                  reference: referenceTile,
                  stellar: stellar.tile,
                  x: expandedLocalX,
                  y: expandedLocalY,
                  width: expandedWidth,
                  height: expandedHeight,
                ));
        final int sourceBase = expandedPixel * 3;
        final int outputBase = requestedPixel * 3;
        final Float32List selected = preferIdentity
            ? identityTile.interleavedRgb
            : stellar.tile.interleavedRgb;
        output[outputBase] = selected[sourceBase];
        output[outputBase + 1] = selected[sourceBase + 1];
        output[outputBase + 2] = selected[sourceBase + 2];
        coverage[requestedPixel] = 1;
      }
    }

    return CoveredLinearRgbTile(
      tile: LinearRgbTile(
        x: outputTile.outputX,
        y: outputTile.outputY,
        width: outputTile.outputWidth,
        height: outputTile.outputHeight,
        interleavedRgb: output,
      ),
      coverage: coverage,
    );
  }

  bool _hasIdentityNeighbour({
    required Uint8List candidates,
    required LinearRgbTile reference,
    required LinearRgbTile stellar,
    required int x,
    required int y,
    required int width,
    required int height,
  }) {
    for (int dy = -1; dy <= 1; dy++) {
      final int ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        final int nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (candidates[ny * width + nx] == 0) continue;
        // The two opposite sides of a displaced singleton are both raw
        // identity candidates. They must not validate each other as a
        // connected foreground: require coherent stellar-reference residuals.
        final int centerBase = (y * width + x) * 3;
        final int neighbourBase = (ny * width + nx) * 3;
        double dot = 0;
        for (int channel = 0; channel < 3; channel++) {
          dot += (stellar.interleavedRgb[centerBase + channel] -
                  reference.interleavedRgb[centerBase + channel]) *
              (stellar.interleavedRgb[neighbourBase + channel] -
                  reference.interleavedRgb[neighbourBase + channel]);
        }
        if (dot > 0) return true;
        // A real edge can include residuals of opposite signs. Keep it when
        // the candidate has a third connected supporter, but never let the
        // two opposite sides of a singleton support only each other.
        for (int sy = -1; sy <= 1; sy++) {
          final int thirdY = ny + sy;
          if (thirdY < 0 || thirdY >= height) continue;
          for (int sx = -1; sx <= 1; sx++) {
            final int thirdX = nx + sx;
            if (thirdX < 0 ||
                thirdX >= width ||
                (thirdX == nx && thirdY == ny) ||
                (thirdX == x && thirdY == y)) {
              continue;
            }
            if (candidates[thirdY * width + thirdX] != 0) return true;
          }
        }
      }
    }
    return false;
  }

  bool _preferIdentity(
    LinearRgbTile reference,
    LinearRgbTile identity,
    LinearRgbTile stellar,
    int base,
  ) {
    double identityError = 0;
    double stellarError = 0;
    double referenceMagnitude = 0;
    for (int channel = 0; channel < 3; channel++) {
      final double referenceValue = reference.interleavedRgb[base + channel];
      final double identityDelta =
          identity.interleavedRgb[base + channel] - referenceValue;
      final double stellarDelta =
          stellar.interleavedRgb[base + channel] - referenceValue;
      identityError += identityDelta * identityDelta;
      stellarError += stellarDelta * stellarDelta;
      referenceMagnitude = math.max(referenceMagnitude, referenceValue.abs());
    }
    final double meaningfulDifference =
        absoluteDifferenceFloor + relativeDifferenceFloor * referenceMagnitude;
    final double floorSquared = meaningfulDifference * meaningfulDifference * 3;
    return stellarError - identityError > floorSquared &&
        identityError < stellarError * identityAdvantageRatio;
  }
}
