import 'dart:typed_data';

import '../image/linear_rgb_tile_store.dart';
import '../registration/affine_sampling_transform.dart';
import '../registration/luminance_plane.dart';
import '../registration/tiled_affine_rgb_resampler.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'focus_aligned_frame.dart';
import 'focus_correspondence_pipeline.dart';
import 'focus_measure.dart';

final class FocusAlignedMeasureResult {
  const FocusAlignedMeasureResult({
    required this.alignedFrame,
    required this.focusMeasure,
    required this.correspondence,
  });

  final FocusAlignedFrame alignedFrame;
  final FocusMeasurePlane focusMeasure;
  final FocusCorrespondenceResult correspondence;
}

/// The marking-only alignment product. It deliberately retains one green
/// luminance sample per output pixel instead of a three-channel RGB frame.
final class FocusAlignedLuminanceResult {
  const FocusAlignedLuminanceResult({
    required this.luminance,
    required this.coverage,
    required this.correspondence,
  });

  final LuminancePlane luminance;
  final Uint8List coverage;

  /// Null exactly when this result came from
  /// [resampleFocusLuminanceForMarking]'s `transform:` path (a checkpoint
  /// restart resuming from an already-recorded sampling transform, with no
  /// feature/match data to attach). No caller reads this field today; it is
  /// kept for diagnostics wherever a real correspondence is available.
  final FocusCorrespondenceResult? correspondence;
}

final class _FocusAlignmentResult {
  const _FocusAlignmentResult({
    required this.alignedFrame,
    required this.alignedLuminance,
    required this.coverage,
    required this.correspondence,
  });

  final FocusAlignedFrame? alignedFrame;
  final LuminancePlane? alignedLuminance;
  final Uint8List coverage;
  final FocusCorrespondenceResult correspondence;
}

enum _FocusAlignmentOutput { rgb, greenLuminance }

/// Aligns a source frame for focus marking without allocating either the full
/// RGB output or the focus map that the marking pipeline does not consume.
Future<FocusAlignedLuminanceResult> alignFocusLuminanceForMarking({
  required LinearRgbTileStore sourceRgb,
  required LuminancePlane referenceLuminance,
  required LuminancePlane sourceLuminance,
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  final _FocusAlignmentResult result = await _alignFocusFrame(
    sourceRgb: sourceRgb,
    referenceLuminance: referenceLuminance,
    sourceLuminance: sourceLuminance,
    tileSize: tileSize,
    isCancelled: isCancelled,
    output: _FocusAlignmentOutput.greenLuminance,
  );
  return FocusAlignedLuminanceResult(
    luminance: result.alignedLuminance!,
    coverage: result.coverage,
    correspondence: result.correspondence,
  );
}

/// Resamples only the aligned green plane after correspondence has already been
/// estimated. This lets callers release a full-resolution source luminance
/// plane before allocating the equally large aligned plane. The sampling
/// transform and bicubic interpolation are exactly the same as the combined
/// alignment path above.
Future<FocusAlignedLuminanceResult> resampleFocusLuminanceForMarking({
  required LinearRgbTileStore sourceRgb,
  FocusCorrespondenceResult? correspondence,
  // Lets a durable checkpoint resume directly from a previously recorded
  // sampling transform (six finite doubles) without needing to reconstruct
  // or fake a whole FocusCorrespondenceResult, whose feature/match lists are
  // not stably serializable and are not consumed by this function anyway
  // (see the single read of `.alignment` this replaces below). Exactly one
  // of `correspondence` or `transform` must be supplied.
  AffineSamplingTransform? transform,
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  if (tileSize < 32 || tileSize > 4096) {
    throw ArgumentError.value(tileSize, 'tileSize');
  }
  if ((correspondence == null) == (transform == null)) {
    throw ArgumentError(
      'Exactly one of correspondence or transform must be provided.',
    );
  }
  final AffineSamplingTransform resolvedTransform =
      transform ?? correspondence!.alignment.toSamplingTransform();

  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: sourceRgb.width,
    imageHeight: sourceRgb.height,
    tileSize: tileSize,
    overlap: 0,
  );
  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: ResamplingInterpolation.bicubic,
  );
  final int pixels = sourceRgb.width * sourceRgb.height;
  final Float32List outputSamples = Float32List(pixels);
  final Uint8List coverage = Uint8List(pixels);

  for (final OverlappedTile tile in plan.tiles) {
    if (isCancelled?.call() ?? false) {
      throw const AffineRgbResamplingCancelled();
    }
    final CoveredLinearRgbTile sampled = await resampler.sampleTile(
      source: sourceRgb,
      outputTile: tile,
      outputImageWidth: sourceRgb.width,
      outputImageHeight: sourceRgb.height,
      transform: resolvedTransform,
      isCancelled: isCancelled,
    );
    for (int localY = 0; localY < tile.outputHeight; localY++) {
      final int globalY = tile.outputY + localY;
      for (int localX = 0; localX < tile.outputWidth; localX++) {
        final int globalX = tile.outputX + localX;
        final int localPixel = localY * tile.outputWidth + localX;
        final int globalPixel = globalY * sourceRgb.width + globalX;
        coverage[globalPixel] = sampled.coverage[localPixel];
        if (sampled.coverage[localPixel] == 0) continue;
        outputSamples[globalPixel] =
            sampled.tile.interleavedRgb[localPixel * 3 + 1];
      }
    }
  }

  return FocusAlignedLuminanceResult(
    luminance: LuminancePlane(
      width: sourceRgb.width,
      height: sourceRgb.height,
      samples: outputSamples,
    ),
    coverage: coverage,
    correspondence: correspondence,
  );
}

/// Align one source frame into reference coordinates and derive a focus map.
/// Scale, rotation and translation are combined in one bicubic sampling pass,
/// avoiding a second interpolation stage that could soften source detail.
Future<FocusAlignedMeasureResult> alignAndMeasureFocusFrame({
  required LinearRgbTileStore sourceRgb,
  required LuminancePlane referenceLuminance,
  required LuminancePlane sourceLuminance,
  int tileSize = 512,
  int focusSupportRadius = 2,
  bool Function()? isCancelled,
}) async {
  final _FocusAlignmentResult result = await _alignFocusFrame(
    sourceRgb: sourceRgb,
    referenceLuminance: referenceLuminance,
    sourceLuminance: sourceLuminance,
    tileSize: tileSize,
    isCancelled: isCancelled,
    output: _FocusAlignmentOutput.rgb,
  );
  final FocusAlignedFrame alignedFrame = result.alignedFrame!;
  final FocusMeasurePlane measure =
      await computeModifiedLaplacianFocusMeasureMemoryBounded(
    alignedFrame.greenLuminance(),
    supportRadius: focusSupportRadius,
    validMask: alignedFrame.coverage,
    checkCancelled: () {
      if (isCancelled?.call() ?? false) {
        throw const AffineRgbResamplingCancelled();
      }
    },
  );
  return FocusAlignedMeasureResult(
    alignedFrame: alignedFrame,
    focusMeasure: measure,
    correspondence: result.correspondence,
  );
}

Future<_FocusAlignmentResult> _alignFocusFrame({
  required LinearRgbTileStore sourceRgb,
  required LuminancePlane referenceLuminance,
  required LuminancePlane sourceLuminance,
  required int tileSize,
  required _FocusAlignmentOutput output,
  bool Function()? isCancelled,
}) async {
  if (sourceRgb.width != referenceLuminance.width ||
      sourceRgb.height != referenceLuminance.height ||
      sourceLuminance.width != referenceLuminance.width ||
      sourceLuminance.height != referenceLuminance.height) {
    throw ArgumentError(
      'Focus alignment source/reference dimensions must match.',
    );
  }
  if (tileSize < 32 || tileSize > 4096) {
    throw ArgumentError.value(tileSize, 'tileSize');
  }

  final FocusCorrespondenceResult correspondence =
      estimateFocusAlignmentFromLuminance(
    reference: referenceLuminance,
    source: sourceLuminance,
  );

  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: sourceRgb.width,
    imageHeight: sourceRgb.height,
    tileSize: tileSize,
    overlap: 0,
  );
  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: ResamplingInterpolation.bicubic,
  );
  final int pixels = sourceRgb.width * sourceRgb.height;
  final bool luminanceOnly = output == _FocusAlignmentOutput.greenLuminance;
  final Float32List outputSamples =
      Float32List(pixels * (luminanceOnly ? 1 : 3));
  final Uint8List coverage = Uint8List(pixels);

  for (final OverlappedTile tile in plan.tiles) {
    if (isCancelled?.call() ?? false) {
      throw const AffineRgbResamplingCancelled();
    }
    final CoveredLinearRgbTile sampled = await resampler.sampleTile(
      source: sourceRgb,
      outputTile: tile,
      outputImageWidth: sourceRgb.width,
      outputImageHeight: sourceRgb.height,
      transform: correspondence.alignment.toSamplingTransform(),
      isCancelled: isCancelled,
    );
    for (int localY = 0; localY < tile.outputHeight; localY++) {
      final int globalY = tile.outputY + localY;
      for (int localX = 0; localX < tile.outputWidth; localX++) {
        final int globalX = tile.outputX + localX;
        final int localPixel = localY * tile.outputWidth + localX;
        final int globalPixel = globalY * sourceRgb.width + globalX;
        coverage[globalPixel] = sampled.coverage[localPixel];
        if (sampled.coverage[localPixel] == 0) continue;
        final int localBase = localPixel * 3;
        if (luminanceOnly) {
          outputSamples[globalPixel] =
              sampled.tile.interleavedRgb[localBase + 1];
        } else {
          final int globalBase = globalPixel * 3;
          outputSamples[globalBase] = sampled.tile.interleavedRgb[localBase];
          outputSamples[globalBase + 1] =
              sampled.tile.interleavedRgb[localBase + 1];
          outputSamples[globalBase + 2] =
              sampled.tile.interleavedRgb[localBase + 2];
        }
      }
    }
  }

  final FocusAlignedFrame? aligned = luminanceOnly
      ? null
      : FocusAlignedFrame(
          width: sourceRgb.width,
          height: sourceRgb.height,
          interleavedRgb: outputSamples,
          coverage: coverage,
        );
  final LuminancePlane? alignedLuminance = luminanceOnly
      ? LuminancePlane(
          width: sourceRgb.width,
          height: sourceRgb.height,
          samples: outputSamples,
        )
      : null;
  return _FocusAlignmentResult(
    alignedFrame: aligned,
    alignedLuminance: alignedLuminance,
    coverage: coverage,
    correspondence: correspondence,
  );
}
