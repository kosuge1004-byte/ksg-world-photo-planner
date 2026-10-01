import '../background/durable_decoded_frame_cache.dart';
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../registration/affine_sampling_transform.dart';
import '../registration/tiled_affine_rgb_resampler.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'focus_aligned_frame.dart';
import 'focus_blend_tile_checkpoint.dart';
import 'focus_blender.dart';
import 'focus_photometric_normalization.dart';
import 'focus_blend_weights.dart';
import 'focus_pyramid_blend.dart';

/// Work354: final focus composite method.
/// [depthMap] is the historical per-pixel blend (default, bit-identical).
/// [pyramid] applies Laplacian-pyramid (multi-band) blending to the same
/// per-pixel weights to hide seams along winner-map boundaries.
enum FocusBlendMethod { depthMap, pyramid }

FocusBlendMethod focusBlendMethodFromName(String? name) =>
    FocusBlendMethod.values.firstWhere(
      (FocusBlendMethod value) => value.name == name,
      orElse: () => FocusBlendMethod.depthMap,
    );

/// One pyramid-blended output tile (core region only).
Future<({Float32List rgb, Uint8List coverage})> _pyramidBlendTile({
  required List<LinearRgbTileStore> stores,
  required List<AffineSamplingTransform> samplingTransforms,
  required FileBackedFocusWinnerMap winners,
  required OverlappedTile tile,
  required int imageWidth,
  required int imageHeight,
  required TiledAffineRgbResampler resampler,
  List<FocusFrameGain>? frameGains,
  bool Function()? isCancelled,
}) async {
  final ({int x, int y, int width, int height}) region = focusPyramidRegion(
    tileX: tile.outputX,
    tileY: tile.outputY,
    tileWidth: tile.outputWidth,
    tileHeight: tile.outputHeight,
    imageWidth: imageWidth,
    imageHeight: imageHeight,
  );
  final int pixels = region.width * region.height;
  final OverlappedTile extended = OverlappedTile(
    outputX: region.x,
    outputY: region.y,
    outputWidth: region.width,
    outputHeight: region.height,
    inputX: region.x,
    inputY: region.y,
    inputWidth: region.width,
    inputHeight: region.height,
  );
  final List<FocusAlignedFrame> frames = <FocusAlignedFrame>[];
  for (int frame = 0; frame < stores.length; frame++) {
    if (frame == 0) {
      final LinearRgbTile reference = await stores[0].readRegion(
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      );
      frames.add(FocusAlignedFrame(
        width: region.width,
        height: region.height,
        interleavedRgb: reference.interleavedRgb,
        coverage: Uint8List(pixels)..fillRange(0, pixels, 1),
      ));
    } else {
      final CoveredLinearRgbTile sampled = await resampler.sampleTile(
        source: stores[frame],
        outputTile: extended,
        outputImageWidth: imageWidth,
        outputImageHeight: imageHeight,
        transform: samplingTransforms[frame],
        isCancelled: isCancelled,
      );
      if (frameGains != null) {
        applyFocusFrameGainInPlace(
          sampled.tile.interleavedRgb,
          frameGains[frame],
        );
      }
      frames.add(FocusAlignedFrame(
        width: region.width,
        height: region.height,
        interleavedRgb: sampled.tile.interleavedRgb,
        coverage: sampled.coverage,
      ));
    }
  }
  final FocusWinnerRegion winnerRegion = await winners.readRegion(
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  );
  final FocusBlendWeightComputer computer = FocusBlendWeightComputer(
    frames: frames,
    winners: FocusWinnerMap(
      width: region.width,
      height: region.height,
      frameIndices: winnerRegion.frameIndices,
      confidence: winnerRegion.confidence,
    ),
  );
  final int frameCount = frames.length;
  final Float32List weights = Float32List(pixels * frameCount);
  // Depth-map result on the extended region: defines coverage and fills
  // pixels a frame does not cover, so that no frame contributes a coverage
  // edge (zeros) to any pyramid band.
  final Float32List depthMap = Float32List(pixels * 3);
  final Uint8List depthCoverage = Uint8List(pixels);
  for (int pixel = 0; pixel < pixels; pixel++) {
    final int wBase = pixel * frameCount;
    computer.writePixel(
      pixel: pixel,
      destination: weights,
      destinationOffset: wBase,
    );
    double r = 0, g = 0, b = 0, used = 0;
    for (int f = 0; f < frameCount; f++) {
      final double w = weights[wBase + f];
      if (!(w > 0)) continue;
      if (frames[f].coverage[pixel] == 0) {
        weights[wBase + f] = 0;
        continue;
      }
      final int base = pixel * 3;
      r += frames[f].interleavedRgb[base] * w;
      g += frames[f].interleavedRgb[base + 1] * w;
      b += frames[f].interleavedRgb[base + 2] * w;
      used += w;
    }
    if (used > 0) {
      final double inverse = 1 / used;
      depthMap[pixel * 3] = r * inverse;
      depthMap[pixel * 3 + 1] = g * inverse;
      depthMap[pixel * 3 + 2] = b * inverse;
      depthCoverage[pixel] = 1;
      for (int f = 0; f < frameCount; f++) {
        weights[wBase + f] = weights[wBase + f] * inverse;
      }
    } else {
      // No covered contributor: keep the pixel neutral for the pyramid by
      // giving the reference full weight; the output pixel is masked below.
      for (int f = 0; f < frameCount; f++) {
        weights[wBase + f] = f == 0 ? 1 : 0;
      }
    }
  }
  final List<Float32List> rgb = <Float32List>[];
  for (final FocusAlignedFrame frame in frames) {
    final Float32List filled = frame.interleavedRgb;
    for (int pixel = 0; pixel < pixels; pixel++) {
      if (frame.coverage[pixel] != 0) continue;
      final int base = pixel * 3;
      filled[base] = depthMap[base];
      filled[base + 1] = depthMap[base + 1];
      filled[base + 2] = depthMap[base + 2];
    }
    rgb.add(filled);
  }
  final Float32List blended = focusPyramidBlend(
    width: region.width,
    height: region.height,
    interleavedRgb: rgb,
    interleavedWeights: weights,
  );
  final int coreWidth = tile.outputWidth;
  final int coreHeight = tile.outputHeight;
  final Float32List coreRgb = Float32List(coreWidth * coreHeight * 3);
  final Uint8List coreCoverage = Uint8List(coreWidth * coreHeight);
  for (int y = 0; y < coreHeight; y++) {
    final int sourceRow = (tile.outputY - region.y + y) * region.width +
        (tile.outputX - region.x);
    for (int x = 0; x < coreWidth; x++) {
      final int source = sourceRow + x;
      final int target = y * coreWidth + x;
      if (depthCoverage[source] == 0) continue;
      coreCoverage[target] = 1;
      for (int c = 0; c < 3; c++) {
        final double v = blended[source * 3 + c];
        if (!v.isFinite) {
          throw StateError('Focus pyramid blending produced a non-finite pixel.');
        }
        // Band recombination can ring slightly below zero next to very
        // strong edges; negative linear light is not physical.
        coreRgb[target * 3 + c] = v < 0 ? 0 : v;
      }
    }
  }
  return (rgb: coreRgb, coverage: coreCoverage);
}
import 'focus_winner_map.dart';
import 'file_backed_focus_winner_map.dart';
import 'file_backed_focus_coverage_mask.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';

final class FocusStoredBlendResult {
  const FocusStoredBlendResult({
    required this.width,
    required this.height,
    required this.rgbStore,
    required this.coverage,
  });

  final int width;
  final int height;
  final LinearRgbTileStore rgbStore;
  final Uint8List coverage;
}

final class FocusFileBackedStoredBlendResult {
  const FocusFileBackedStoredBlendResult({
    required this.width,
    required this.height,
    required this.rgbStore,
    required this.coverageMask,
  });

  final int width;
  final int height;
  final LinearRgbTileStore rgbStore;
  final FileBackedFocusCoverageMask coverageMask;
}

/// Same blending semantics as [blendRegisteredFocusStoresMemoryBounded], but
/// writes the final RGB tiles directly into [outputStore]. This avoids keeping
/// an additional full-resolution Float32 RGB image in resident memory.
Future<FocusStoredBlendResult> blendRegisteredFocusStoresToStoreMemoryBounded({
  required List<LinearRgbTileStore> stores,
  required List<AffineSamplingTransform> samplingTransforms,
  required FocusWinnerMap winners,
  required LinearRgbTileStore outputStore,
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  if (stores.length < 2 || samplingTransforms.length != stores.length) {
    throw ArgumentError(
      'Focus stores and transforms must contain at least two frames.',
    );
  }
  if (tileSize < 32 || tileSize > 4096) {
    throw ArgumentError.value(tileSize, 'tileSize');
  }
  for (final LinearRgbTileStore store in stores) {
    if (store.width != winners.width || store.height != winners.height) {
      throw ArgumentError('Focus stores must match winner-map dimensions.');
    }
  }
  if (outputStore.width != winners.width ||
      outputStore.height != winners.height ||
      outputStore.isCommitted ||
      outputStore.completedTileCount != 0) {
    throw ArgumentError(
      'Output focus RGB store must be empty, writable, and match the winner map.',
    );
  }

  final int width = winners.width;
  final int height = winners.height;
  final int pixels = width * height;
  final Uint8List outputCoverage = Uint8List(pixels);
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: ResamplingInterpolation.bicubic,
  );

  try {
    for (final OverlappedTile tile in plan.tiles) {
      if (isCancelled?.call() ?? false) {
        throw const AffineRgbResamplingCancelled();
      }
      final int tilePixels = tile.outputWidth * tile.outputHeight;
      final List<FocusAlignedFrame> tileFrames = <FocusAlignedFrame>[];
      for (int frame = 0; frame < stores.length; frame++) {
        if (frame == 0) {
          final LinearRgbTile reference = await stores[frame].readRegion(
            x: tile.outputX,
            y: tile.outputY,
            width: tile.outputWidth,
            height: tile.outputHeight,
          );
          final Uint8List coverage = Uint8List(tilePixels)
            ..fillRange(0, tilePixels, 1);
          tileFrames.add(
            FocusAlignedFrame(
              width: tile.outputWidth,
              height: tile.outputHeight,
              interleavedRgb: reference.interleavedRgb,
              coverage: coverage,
            ),
          );
          continue;
        }
        final CoveredLinearRgbTile sampled = await resampler.sampleTile(
          source: stores[frame],
          outputTile: tile,
          outputImageWidth: width,
          outputImageHeight: height,
          transform: samplingTransforms[frame],
          isCancelled: isCancelled,
        );
        tileFrames.add(
          FocusAlignedFrame(
            width: tile.outputWidth,
            height: tile.outputHeight,
            interleavedRgb: sampled.tile.interleavedRgb,
            coverage: sampled.coverage,
          ),
        );
      }

      final Int32List tileLabels = Int32List(tilePixels);
      final Float32List tileConfidence = Float32List(tilePixels);
      for (int localY = 0; localY < tile.outputHeight; localY++) {
        final int globalStart = (tile.outputY + localY) * width + tile.outputX;
        final int localStart = localY * tile.outputWidth;
        tileLabels.setRange(
          localStart,
          localStart + tile.outputWidth,
          winners.frameIndices,
          globalStart,
        );
        tileConfidence.setRange(
          localStart,
          localStart + tile.outputWidth,
          winners.confidence,
          globalStart,
        );
      }
      final FocusBlendResult blended = blendAlignedFocusFramesMemoryBounded(
        frames: tileFrames,
        winners: FocusWinnerMap(
          width: tile.outputWidth,
          height: tile.outputHeight,
          frameIndices: tileLabels,
          confidence: tileConfidence,
        ),
      );
      await outputStore.writeTile(
        LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: blended.interleavedRgb,
        ),
      );
      for (int localY = 0; localY < tile.outputHeight; localY++) {
        final int globalPixel = (tile.outputY + localY) * width + tile.outputX;
        final int localPixel = localY * tile.outputWidth;
        outputCoverage.setRange(
          globalPixel,
          globalPixel + tile.outputWidth,
          blended.coverage,
          localPixel,
        );
      }
    }
    await outputStore.commit();
  } catch (_) {
    await outputStore.abort();
    rethrow;
  }

  return FocusStoredBlendResult(
    width: width,
    height: height,
    rgbStore: outputStore,
    coverage: outputCoverage,
  );
}

/// Applies the already-estimated focus alignment and blends one output tile at
/// a time. Full-resolution aligned RGB frames and blend-weight planes are
/// never retained; only the final RGB result is image-sized.
Future<FocusBlendResult> blendRegisteredFocusStoresMemoryBounded({
  required List<LinearRgbTileStore> stores,
  required List<AffineSamplingTransform> samplingTransforms,
  required FocusWinnerMap winners,
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  if (stores.length < 2 || samplingTransforms.length != stores.length) {
    throw ArgumentError(
      'Focus stores and transforms must contain at least two frames.',
    );
  }
  if (tileSize < 32 || tileSize > 4096) {
    throw ArgumentError.value(tileSize, 'tileSize');
  }
  for (final LinearRgbTileStore store in stores) {
    if (store.width != winners.width || store.height != winners.height) {
      throw ArgumentError('Focus stores must match winner-map dimensions.');
    }
  }

  final int width = winners.width;
  final int height = winners.height;
  final int pixels = width * height;
  final Float32List output = Float32List(pixels * 3);
  final Uint8List outputCoverage = Uint8List(pixels);
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: ResamplingInterpolation.bicubic,
  );

  for (final OverlappedTile tile in plan.tiles) {
    if (isCancelled?.call() ?? false) {
      throw const AffineRgbResamplingCancelled();
    }
    final int tilePixels = tile.outputWidth * tile.outputHeight;
    final List<FocusAlignedFrame> tileFrames = <FocusAlignedFrame>[];
    for (int frame = 0; frame < stores.length; frame++) {
      if (frame == 0) {
        final LinearRgbTile reference = await stores[frame].readRegion(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
        );
        final Uint8List coverage = Uint8List(tilePixels)
          ..fillRange(0, tilePixels, 1);
        tileFrames.add(
          FocusAlignedFrame(
            width: tile.outputWidth,
            height: tile.outputHeight,
            interleavedRgb: reference.interleavedRgb,
            coverage: coverage,
          ),
        );
        continue;
      }
      final CoveredLinearRgbTile sampled = await resampler.sampleTile(
        source: stores[frame],
        outputTile: tile,
        outputImageWidth: width,
        outputImageHeight: height,
        transform: samplingTransforms[frame],
        isCancelled: isCancelled,
      );
      tileFrames.add(
        FocusAlignedFrame(
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: sampled.tile.interleavedRgb,
          coverage: sampled.coverage,
        ),
      );
    }

    final Int32List tileLabels = Int32List(tilePixels);
    final Float32List tileConfidence = Float32List(tilePixels);
    for (int localY = 0; localY < tile.outputHeight; localY++) {
      final int globalStart = (tile.outputY + localY) * width + tile.outputX;
      final int localStart = localY * tile.outputWidth;
      tileLabels.setRange(
        localStart,
        localStart + tile.outputWidth,
        winners.frameIndices,
        globalStart,
      );
      tileConfidence.setRange(
        localStart,
        localStart + tile.outputWidth,
        winners.confidence,
        globalStart,
      );
    }
    final FocusBlendResult blended = blendAlignedFocusFramesMemoryBounded(
      frames: tileFrames,
      winners: FocusWinnerMap(
        width: tile.outputWidth,
        height: tile.outputHeight,
        frameIndices: tileLabels,
        confidence: tileConfidence,
      ),
    );
    for (int localY = 0; localY < tile.outputHeight; localY++) {
      final int globalPixel = (tile.outputY + localY) * width + tile.outputX;
      final int localPixel = localY * tile.outputWidth;
      output.setRange(
        globalPixel * 3,
        (globalPixel + tile.outputWidth) * 3,
        blended.interleavedRgb,
        localPixel * 3,
      );
      outputCoverage.setRange(
        globalPixel,
        globalPixel + tile.outputWidth,
        blended.coverage,
        localPixel,
      );
    }
  }

  return FocusBlendResult(
    width: width,
    height: height,
    interleavedRgb: output,
    coverage: outputCoverage,
  );
}

/// File-backed winner-map counterpart of
/// [blendRegisteredFocusStoresToStoreMemoryBounded].
Future<FocusStoredBlendResult>
    blendRegisteredFocusStoresFromFileBackedWinnersToStore({
  required List<LinearRgbTileStore> stores,
  required List<AffineSamplingTransform> samplingTransforms,
  required FileBackedFocusWinnerMap winners,
  required LinearRgbTileStore outputStore,
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  if (stores.length < 2 || samplingTransforms.length != stores.length) {
    throw ArgumentError(
      'Focus stores and transforms must contain at least two frames.',
    );
  }
  for (final LinearRgbTileStore store in stores) {
    if (store.width != winners.width || store.height != winners.height) {
      throw ArgumentError('Focus stores must match winner-map dimensions.');
    }
  }
  if (outputStore.width != winners.width ||
      outputStore.height != winners.height ||
      outputStore.isCommitted ||
      outputStore.completedTileCount != 0) {
    throw ArgumentError(
      'Output focus RGB store must be empty, writable, and match the winner map.',
    );
  }

  final int width = winners.width;
  final int height = winners.height;
  final Uint8List outputCoverage = Uint8List(width * height);
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: ResamplingInterpolation.bicubic,
  );

  try {
    for (final OverlappedTile tile in plan.tiles) {
      if (isCancelled?.call() ?? false) {
        throw const AffineRgbResamplingCancelled();
      }
      final int tilePixels = tile.outputWidth * tile.outputHeight;
      final List<FocusAlignedFrame> tileFrames = <FocusAlignedFrame>[];
      for (int frame = 0; frame < stores.length; frame++) {
        if (frame == 0) {
          final LinearRgbTile reference = await stores[frame].readRegion(
            x: tile.outputX,
            y: tile.outputY,
            width: tile.outputWidth,
            height: tile.outputHeight,
          );
          final Uint8List coverage = Uint8List(tilePixels)
            ..fillRange(0, tilePixels, 1);
          tileFrames.add(
            FocusAlignedFrame(
              width: tile.outputWidth,
              height: tile.outputHeight,
              interleavedRgb: reference.interleavedRgb,
              coverage: coverage,
            ),
          );
        } else {
          final CoveredLinearRgbTile sampled = await resampler.sampleTile(
            source: stores[frame],
            outputTile: tile,
            outputImageWidth: width,
            outputImageHeight: height,
            transform: samplingTransforms[frame],
            isCancelled: isCancelled,
          );
          tileFrames.add(
            FocusAlignedFrame(
              width: tile.outputWidth,
              height: tile.outputHeight,
              interleavedRgb: sampled.tile.interleavedRgb,
              coverage: sampled.coverage,
            ),
          );
        }
      }

      final FocusWinnerRegion winnerRegion = await winners.readRegion(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
      );
      final FocusBlendResult blended = blendAlignedFocusFramesMemoryBounded(
        frames: tileFrames,
        winners: FocusWinnerMap(
          width: tile.outputWidth,
          height: tile.outputHeight,
          frameIndices: winnerRegion.frameIndices,
          confidence: winnerRegion.confidence,
        ),
      );
      await outputStore.writeTile(
        LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: blended.interleavedRgb,
        ),
      );
      for (int localY = 0; localY < tile.outputHeight; localY++) {
        final int globalPixel = (tile.outputY + localY) * width + tile.outputX;
        final int localPixel = localY * tile.outputWidth;
        outputCoverage.setRange(
          globalPixel,
          globalPixel + tile.outputWidth,
          blended.coverage,
          localPixel,
        );
      }
    }
    await outputStore.commit();
  } catch (_) {
    await outputStore.abort();
    rethrow;
  }
  return FocusStoredBlendResult(
    width: width,
    height: height,
    rgbStore: outputStore,
    coverage: outputCoverage,
  );
}

/// Work306 production variant: keeps both final RGB and final validity mask
/// file-backed.  The per-tile blend math is unchanged.
///
/// Exactly one of [outputStore] or [stageCheckpoint] must be supplied.
/// [outputStore] (the pre-Work341 contract) is a fresh, empty, writable
/// store the caller already created; on any non-success exit it is aborted
/// (deleted) exactly as before, and the internal coverage mask is always a
/// `Directory.systemTemp` temporary, also always deleted on non-success.
/// [stageCheckpoint], when supplied instead, takes over creating (or
/// resuming) both the RGB and coverage outputs at durable, reopenable paths
/// — see `FocusBlendTileCheckpointStore` — so a process death partway
/// through the tile loop can resume from `resumeFromTileIndex` rather than
/// starting over; in that case nothing is deleted on non-success, only file
/// handles are closed, and the checkpoint is cleared only once both stores
/// have actually committed.
Future<FocusFileBackedStoredBlendResult>
    blendRegisteredFocusStoresFromFileBackedWinnersAndCoverageToStore({
  required List<LinearRgbTileStore> stores,
  required List<AffineSamplingTransform> samplingTransforms,
  required FileBackedFocusWinnerMap winners,
  LinearRgbTileStore? outputStore,
  FocusBlendTileCheckpointStore? stageCheckpoint,
  int tileSize = 512,
  bool Function()? isCancelled,
  // Work353: optional per-frame photometric gains (index-aligned with
  // [stores]; element 0 is the reference). null => unchanged behaviour.
  List<FocusFrameGain>? frameGains,
  // Work354: final composite method (depthMap = unchanged behaviour).
  FocusBlendMethod blendMethod = FocusBlendMethod.depthMap,
  // Work358: per-tile progress (pyramid path only), so the stall watchdog
  // sees advancing progress during a long multi-band blend.
  void Function(int completedTiles, int totalTiles)? onPyramidTileCompleted,
}) async {
  final bool pyramid = blendMethod == FocusBlendMethod.pyramid;
  if (frameGains != null && frameGains.length != stores.length) {
    throw ArgumentError('frameGains must match stores.');
  }
  if (stores.length < 2 || samplingTransforms.length != stores.length) {
    throw ArgumentError(
      'Focus stores and transforms must contain at least two frames.',
    );
  }
  for (final LinearRgbTileStore store in stores) {
    if (store.width != winners.width || store.height != winners.height) {
      throw ArgumentError('Focus stores must match winner-map dimensions.');
    }
  }
  if ((outputStore == null) == (stageCheckpoint == null)) {
    throw ArgumentError(
      'Exactly one of outputStore or stageCheckpoint must be provided.',
    );
  }
  if (outputStore != null &&
      (outputStore.width != winners.width ||
          outputStore.height != winners.height ||
          outputStore.isCommitted ||
          outputStore.completedTileCount != 0)) {
    throw ArgumentError(
      'Output focus RGB store must be empty, writable, and match the winner map.',
    );
  }

  final int width = winners.width;
  final int height = winners.height;
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: pyramid ? focusPyramidCoreTileSize : tileSize,
    overlap: 0,
  );

  LinearRgbTileStore resolvedOutputStore;
  FileBackedFocusCoverageMask coverageMask;
  int resumeFromTileIndex;
  if (stageCheckpoint != null) {
    stageCheckpoint.bindInputs({
      'transforms': [
        for (final x in samplingTransforms)
          [x.m00, x.m01, x.m02, x.m10, x.m11, x.m12]
      ],
      'labelsSha256':
          await DurableDecodedFrameCache.fileHash(winners.labelsFile),
      'confidenceSha256':
          await DurableDecodedFrameCache.fileHash(winners.confidenceFile),
      // Work353: bound only when used, so existing checkpoints keep their
      // fingerprint.
      // Work354: bound only for the pyramid method (different tile plan).
      if (pyramid) 'blendMethod': 'pyramid',
      if (frameGains != null)
        'frameGains': <List<double>>[
          for (final FocusFrameGain gain in frameGains)
            gain.applied ? gain.toJson() : <double>[1, 1, 1],
        ],
    });
    final FocusBlendTileCheckpointProgress progress =
        await stageCheckpoint.openOrCreate(
      width: width,
      height: height,
      plan: plan,
    );
    resolvedOutputStore = progress.rgbStore;
    coverageMask = progress.coverageMask;
    resumeFromTileIndex = progress.resumeFromTileIndex;
  } else {
    resolvedOutputStore = outputStore!;
    coverageMask = await FileBackedFocusCoverageMask.createTemporary(
      width: width,
      height: height,
    );
    resumeFromTileIndex = 0;
  }
  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: ResamplingInterpolation.bicubic,
  );

  bool rgbCommitted = false;
  bool maskCommitted = false;
  try {
    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw const AffineRgbResamplingCancelled();
      }
      if (tileIndex < resumeFromTileIndex) {
        // Already durably written by a previous process instance.
        continue;
      }
      if (pyramid) {
        final OverlappedTile coreTile = plan.tiles[tileIndex];
        final ({Float32List rgb, Uint8List coverage}) core =
            await _pyramidBlendTile(
          stores: stores,
          samplingTransforms: samplingTransforms,
          winners: winners,
          tile: coreTile,
          imageWidth: width,
          imageHeight: height,
          resampler: resampler,
          frameGains: frameGains,
          isCancelled: isCancelled,
        );
        await resolvedOutputStore.writeTile(
          LinearRgbTile(
            x: coreTile.outputX,
            y: coreTile.outputY,
            width: coreTile.outputWidth,
            height: coreTile.outputHeight,
            interleavedRgb: core.rgb,
          ),
        );
        await coverageMask.writeRegion(
          x: coreTile.outputX,
          y: coreTile.outputY,
          width: coreTile.outputWidth,
          height: coreTile.outputHeight,
          binaryCoverage: core.coverage,
        );
        await stageCheckpoint?.recordProgress(tileIndex + 1);
        onPyramidTileCompleted?.call(tileIndex + 1, plan.tiles.length);
        continue;
      }
      final OverlappedTile tile = plan.tiles[tileIndex];
      final int tilePixels = tile.outputWidth * tile.outputHeight;
      final List<FocusAlignedFrame> tileFrames = <FocusAlignedFrame>[];
      for (int frame = 0; frame < stores.length; frame++) {
        if (frame == 0) {
          final LinearRgbTile reference = await stores[frame].readRegion(
            x: tile.outputX,
            y: tile.outputY,
            width: tile.outputWidth,
            height: tile.outputHeight,
          );
          final Uint8List coverage = Uint8List(tilePixels)
            ..fillRange(0, tilePixels, 1);
          tileFrames.add(
            FocusAlignedFrame(
              width: tile.outputWidth,
              height: tile.outputHeight,
              interleavedRgb: reference.interleavedRgb,
              coverage: coverage,
            ),
          );
        } else {
          final CoveredLinearRgbTile sampled = await resampler.sampleTile(
            source: stores[frame],
            outputTile: tile,
            outputImageWidth: width,
            outputImageHeight: height,
            transform: samplingTransforms[frame],
            isCancelled: isCancelled,
          );
          if (frameGains != null) {
            applyFocusFrameGainInPlace(
              sampled.tile.interleavedRgb,
              frameGains[frame],
            );
          }
          tileFrames.add(
            FocusAlignedFrame(
              width: tile.outputWidth,
              height: tile.outputHeight,
              interleavedRgb: sampled.tile.interleavedRgb,
              coverage: sampled.coverage,
            ),
          );
        }
      }

      final FocusWinnerRegion winnerRegion = await winners.readRegion(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
      );
      final FocusBlendResult blended = blendAlignedFocusFramesMemoryBounded(
        frames: tileFrames,
        winners: FocusWinnerMap(
          width: tile.outputWidth,
          height: tile.outputHeight,
          frameIndices: winnerRegion.frameIndices,
          confidence: winnerRegion.confidence,
        ),
      );
      await resolvedOutputStore.writeTile(
        LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: blended.interleavedRgb,
        ),
      );
      await coverageMask.writeRegion(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
        binaryCoverage: blended.coverage,
      );
      await stageCheckpoint?.recordProgress(tileIndex + 1);
    }

    await resolvedOutputStore.commit();
    rgbCommitted = true;
    await coverageMask.commit();
    maskCommitted = true;
    /* Worker clears the checkpoint after durable final output. */

    return FocusFileBackedStoredBlendResult(
      width: width,
      height: height,
      rgbStore: resolvedOutputStore,
      coverageMask: coverageMask,
    );
  } catch (_) {
    if (stageCheckpoint == null) {
      // Unchanged pre-existing behavior: outputStore/coverageMask were
      // always freshly created for this one call, with no durable meaning
      // of their own, so both are always discarded on any failure.
      if (!rgbCommitted) {
        await resolvedOutputStore.abort();
      }
      if (!maskCommitted) {
        await coverageMask.dispose();
      }
    } else {
      await (resolvedOutputStore as FileBackedLinearRgbTileStore)
          .closeRetainingFile();
      await coverageMask.closeRetainingFile();
    }
    rethrow;
  }
}
