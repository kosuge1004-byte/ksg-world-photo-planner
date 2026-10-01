import '../image/file_backed_linear_rgb_tile_store.dart';
import 'dart:math' as math;
import 'dart:typed_data';

import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../registration/invert_similarity_transform_with_local_correction.dart';
import '../registration/local_residual_correction.dart'
    show LocalResidualCorrectionField;
import '../registration/similarity_transform_math.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'cfa_drizzle.dart' show CfaDrizzleForwardTransform, CfaDrizzleResult;
import 'cfa_drizzle_tile_bounds.dart';
import 'cfa_drizzle_tiled_checkpoint.dart';
import 'drizzle_accumulator.dart';

/// The tiled, memory-bounded CFA drizzle combiner
/// `HANDOFF_WORK84_STATUS_AT_LIMIT.md` originally called for, built on
/// top of the two pieces Work86 prepared for exactly this purpose:
/// `FileBackedLinearRawMosaicStore` (region-readable raw CFA input) and
/// `cfaDrizzleSourceBounds` (per-output-tile required-source-region
/// computation). `cfa_drizzle.dart` (Work85) remains the whole-frame,
/// in-memory reference port this tiled version's per-tile splatting math
/// is directly derived from — same accumulation formulas, same rotation-
/// aware footprint handling, same per-frame weighting, just restructured
/// to read and hold only one output tile's worth of source data at a
/// time instead of every frame's full mosaic and the entire output grid
/// simultaneously.
///
/// Output representation: rather than inventing a new single-channel
/// tiled store type for the six scalar planes a three-channel drizzle
/// result technically has (value + coverage, per R/G/B), this reuses the
/// already-existing, already-tested `LinearRgbTileStore`/`LinearRgbTile`
/// machinery *twice* — once for the three channels' `value` (as if they
/// were RGB), once for their `coverage` — since both are exactly
/// "three parallel scalar planes on the same output grid," precisely
/// what `LinearRgbTileStore` already stores, and reusing it avoids
/// building and separately verifying a whole new tiled-store type for a
/// shape this project already has solid, tested infrastructure for.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it). It has no Node.js reference
/// implementation of its own distinct from `cfa_drizzle_reference.mjs`
/// (Work85's port of which already covers the actual splatting
/// mathematics this file reuses unchanged) — see `test/tiled_cfa_
/// drizzle_test.dart`, which verifies this tiled version against the
/// same whole-frame `cfaDrizzle` (Work85) on identical synthetic input,
/// confirming the tiled restructuring itself introduces no numerical
/// difference, rather than re-deriving the splatting formulas' own
/// correctness a second time from scratch.

/// One source frame for [drizzleCfaTiled]: an already-decoded, already-
/// committed raw CFA mosaic store, its registration (`null` for the
/// reference frame — the identity, no rotation or offset), and an
/// optional per-frame quality weight.
final class CfaDrizzleTiledFrame {
  const CfaDrizzleTiledFrame({
    required this.mosaicStore,
    this.transformEstimate,
    this.weight = 1,
    this.localCorrectionField,
    this.phaseScales,
  });

  final FileBackedLinearRawMosaicStore mosaicStore;

  /// `null` for the reference frame (identity transform). For any other
  /// frame, the *un-inverted* registration estimate — the same
  /// direction `AffineSamplingTransform.similarity`/
  /// [applySimilarityForward] use, i.e. what a registration pass
  /// produces directly, not [invertSimilarityTransform]'s output. This
  /// function builds both directions it needs (the source->output
  /// splatting transform via [invertSimilarityTransform], and the
  /// output->source bounds-computation transform via
  /// [applySimilarityForward]) from this single estimate internally.
  final SimilarityTransformEstimate? transformEstimate;
  final double weight;

  /// Optional multiplier for each Bayer phase (R/G1/G2/B layout order).
  /// This applies stack-wide white-balance harmonization lazily while a tile
  /// is resident, avoiding a second full-resolution mosaic per frame.
  final List<double>? phaseScales;

  /// Optional local (spatially-varying) residual correction on top of
  /// [transformEstimate]'s own global similarity transform (Work119-121,
  /// addressing S5 of the quality specification — mild lens distortion,
  /// gentle optical-system flexure). `null` (the default) means no local
  /// correction is applied, exactly matching this project's existing
  /// behavior before this field existed.
  ///
  /// Meaningless (ignored) when [transformEstimate] is `null` (the
  /// reference frame — there is no residual to correct against its own
  /// identity transform). Applied via
  /// `invertSimilarityTransformWithLocalCorrection`'s own fixed-point
  /// iteration (Work121) instead of [invertSimilarityTransform]'s
  /// closed-form inverse whenever it is non-null.
  final LocalResidualCorrectionField? localCorrectionField;
}

final class CfaDrizzleFrameGeometry {
  const CfaDrizzleFrameGeometry({
    required this.forwardTransform,
    required this.rotationRadians,
    required this.spatiallyVarying,
  });

  final CfaDrizzleForwardTransform forwardTransform;
  final double rotationRadians;
  final bool spatiallyVarying;
}

CfaDrizzleFrameGeometry prepareCfaDrizzleFrameGeometry(
  CfaDrizzleTiledFrame frame,
) {
  final List<double>? phaseScales = frame.phaseScales;
  if (!frame.weight.isFinite || frame.weight < 0) {
    throw ArgumentError(
        'CFA drizzle frame weight must be finite and non-negative.');
  }
  if (phaseScales != null &&
      (phaseScales.length != 4 ||
          phaseScales.any((double value) => !value.isFinite))) {
    throw ArgumentError(
        'CFA drizzle phase scales must contain four finite values.');
  }
  final CfaDrizzleForwardTransform forwardTransform =
      frame.transformEstimate == null
          ? (double x, double y) => (x: x, y: y)
          : frame.localCorrectionField == null
              ? invertSimilarityTransform(frame.transformEstimate!)
              : invertSimilarityTransformWithLocalCorrection(
                  frame.transformEstimate!,
                  frame.localCorrectionField!,
                  invertSimilarityTransform(frame.transformEstimate!),
                );
  return CfaDrizzleFrameGeometry(
    forwardTransform: forwardTransform,
    rotationRadians: _deriveRotationRadians(forwardTransform),
    spatiallyVarying: frame.localCorrectionField?.fitted ?? false,
  );
}

/// [drizzleCfaTiled]'s result: two [LinearRgbTileStore]s on the same
/// `outputWidth` x `outputHeight` grid — [valueStore] holding each
/// channel's drizzled value (R/G/B, matching `CfaColor.index`) and
/// [coverageStore] holding each channel's raw accumulated coverage
/// weight (not normalized to `[0, 1]` — see `DrizzleAccumulator.
/// finalize`'s own doc comment for why that is useful downstream, e.g.
/// for a later demosaic step to know how much real data landed at a
/// given position versus how thin the coverage was there).
final class CfaDrizzleTiledResult {
  const CfaDrizzleTiledResult({
    required this.valueStore,
    required this.coverageStore,
    this.saturationCoverageStore,
  });

  final LinearRgbTileStore valueStore;
  final LinearRgbTileStore coverageStore;
  final LinearRgbTileStore? saturationCoverageStore;
}

/// Thrown by [drizzleCfaTiled] when its `isCancelled` callback reports
/// cancellation.
class CfaDrizzleTiledCancelled implements Exception {
  const CfaDrizzleTiledCancelled();
}

/// Drizzles one frame into one global output tile without creating a
/// full-image intermediate store. The 64-frame robust path keeps only these
/// small tile results until rejection is complete, then discards them.
Future<({CfaDrizzleResult scientific, CfaDrizzleResult? saturation})>
    drizzleCfaFrameToOutputTile({
  required CfaDrizzleTiledFrame frame,
  required OverlappedTile outputTile,
  required double outputScale,
  required double pixfrac,
  CfaDrizzleFrameGeometry? preparedGeometry,
}) async {
  final CfaDrizzleFrameGeometry geometry =
      preparedGeometry ?? prepareCfaDrizzleFrameGeometry(frame);
  final List<double>? phaseScales = frame.phaseScales;
  final CfaDrizzleSourceBounds? bounds = cfaDrizzleSourceBounds(
    sourceWidth: frame.mosaicStore.width,
    sourceHeight: frame.mosaicStore.height,
    outputTileX: outputTile.outputX,
    outputTileY: outputTile.outputY,
    outputTileWidth: outputTile.outputWidth,
    outputTileHeight: outputTile.outputHeight,
    outputScale: outputScale,
    pixfrac: pixfrac,
    transformEstimate: frame.transformEstimate,
    additionalMargin:
        frame.localCorrectionField?.maximumCorrectionMagnitude ?? 0,
  );
  final List<DrizzleAccumulator> accumulators = <DrizzleAccumulator>[
    for (int c = 0; c < 3; c++)
      DrizzleAccumulator(
        width: outputTile.outputWidth,
        height: outputTile.outputHeight,
      ),
  ];
  final List<DrizzleAccumulator>? saturationAccumulators =
      frame.mosaicStore.hasSaturatedPixels
          ? <DrizzleAccumulator>[
              for (int c = 0; c < 3; c++)
                DrizzleAccumulator(
                  width: outputTile.outputWidth,
                  height: outputTile.outputHeight,
                ),
            ]
          : null;
  if (bounds != null) {
    final Float32List sourceSamples = await frame.mosaicStore.readRegion(
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    );
    final saturationMask = saturationAccumulators == null
        ? null
        : await frame.mosaicStore.readSaturationRegion(
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          );
    final CfaDrizzleForwardTransform forwardTransform =
        geometry.forwardTransform;
    final double rotationRadians = geometry.rotationRadians;
    final bool spatial = geometry.spatiallyVarying;
    final double dropHalfExtent = 0.5 * pixfrac * outputScale;
    for (int localY = 0; localY < bounds.height; localY++) {
      final int globalY = bounds.y + localY;
      for (int localX = 0; localX < bounds.width; localX++) {
        final int globalX = bounds.x + localX;
        final int channel =
            frame.mosaicStore.cfaPattern.colorAt(globalX, globalY).index;
        final int phase = ((globalY & 1) << 1) | (globalX & 1);
        final double value = sourceSamples[localY * bounds.width + localX] *
            (phaseScales?[phase] ?? 1);
        final bool saturated = saturationMask?.isSaturatedIndex(
              localY * bounds.width + localX,
            ) ??
            false;
        if (spatial) {
          _addSpatiallyMappedDrop(
            accumulator: saturated
                ? saturationAccumulators![channel]
                : accumulators[channel],
            forwardTransform: forwardTransform,
            globalX: globalX,
            globalY: globalY,
            sourceHalfExtent: 0.5 * pixfrac,
            outputScale: outputScale,
            outputTileX: outputTile.outputX,
            outputTileY: outputTile.outputY,
            value: saturated ? 1 : value,
            weight: frame.weight,
          );
        } else {
          final ({double x, double y}) mapped =
              forwardTransform(globalX.toDouble(), globalY.toDouble());
          final double outputX = mapped.x * outputScale - outputTile.outputX;
          final double outputY = mapped.y * outputScale - outputTile.outputY;
          if (saturated) {
            saturationAccumulators![channel].addRotatedDrop(
              outputX,
              outputY,
              1,
              rotationRadians: rotationRadians,
              halfWidth: dropHalfExtent,
              halfHeight: dropHalfExtent,
              weight: frame.weight,
            );
          } else {
            accumulators[channel].addRotatedDrop(
              outputX,
              outputY,
              value,
              rotationRadians: rotationRadians,
              halfWidth: dropHalfExtent,
              halfHeight: dropHalfExtent,
              weight: frame.weight,
            );
          }
        }
      }
    }
  }
  final List<DrizzleResult> scientific = <DrizzleResult>[
    for (final DrizzleAccumulator accumulator in accumulators)
      accumulator.finalize(),
  ];
  final List<DrizzleResult>? saturation = saturationAccumulators
      ?.map((DrizzleAccumulator accumulator) => accumulator.finalize())
      .toList(growable: false);
  return (
    scientific: CfaDrizzleResult(
      width: outputTile.outputWidth,
      height: outputTile.outputHeight,
      channels: scientific,
    ),
    saturation: saturation == null
        ? null
        : CfaDrizzleResult(
            width: outputTile.outputWidth,
            height: outputTile.outputHeight,
            channels: saturation,
          ),
  );
}

void _addSpatiallyMappedDrop({
  required DrizzleAccumulator accumulator,
  required CfaDrizzleForwardTransform forwardTransform,
  required int globalX,
  required int globalY,
  required double sourceHalfExtent,
  required double outputScale,
  required int outputTileX,
  required int outputTileY,
  required double value,
  required double weight,
}) {
  final ({double x, double y}) mapped0 = forwardTransform(
    globalX - sourceHalfExtent,
    globalY - sourceHalfExtent,
  );
  final ({double x, double y}) mapped1 = forwardTransform(
    globalX + sourceHalfExtent,
    globalY - sourceHalfExtent,
  );
  final ({double x, double y}) mapped2 = forwardTransform(
    globalX + sourceHalfExtent,
    globalY + sourceHalfExtent,
  );
  final ({double x, double y}) mapped3 = forwardTransform(
    globalX - sourceHalfExtent,
    globalY + sourceHalfExtent,
  );
  accumulator.addQuadrilateralDrop(
    mapped0.x * outputScale - outputTileX,
    mapped0.y * outputScale - outputTileY,
    mapped1.x * outputScale - outputTileX,
    mapped1.y * outputScale - outputTileY,
    mapped2.x * outputScale - outputTileX,
    mapped2.y * outputScale - outputTileY,
    mapped3.x * outputScale - outputTileX,
    mapped3.y * outputScale - outputTileY,
    value,
    weight: weight,
  );
}

/// Drizzles [frames] (raw CFA mosaics, already decoded and committed to
/// [FileBackedLinearRawMosaicStore]s) onto one supersampled output grid,
/// tile by tile, reading only each frame's small required region per
/// output tile (via `cfaDrizzleSourceBounds`) rather than holding every
/// frame's full mosaic in memory at once.
///
/// Sensor-saturated CFA samples are never accumulated into the scientific
/// value/coverage planes. Their geometric footprint is recorded separately in
/// [CfaDrizzleTiledResult.saturationCoverageStore], so downstream code can
/// preserve clipping provenance without treating clipped code values as valid
/// linear signal.
///
/// - [outputWidth], [outputHeight]: output grid dimensions, already
///   scaled up from the input frame size by [outputScale].
/// - [valueStoreFactory], [coverageStoreFactory]: build the two output
///   stores (see [CfaDrizzleTiledResult]); typically both
///   `FileBackedLinearRgbTileStore.createTemporary`, but supplied
///   separately (not assumed identical) in case a caller wants different
///   backing for each — e.g. keeping coverage in memory via a fake/in-
///   memory store in a test, while value goes to a real file.
/// - [tileSize]: output tile size for both stores' own internal tiling
///   and for this function's own per-tile accumulation granularity —
///   the same parameter every other tiled combiner in this project
///   (`TiledKappaSigmaCombiner`, `TiledLightenBlendCombiner`, etc.)
///   exposes for the same reason (trading finer memory bounds against
///   more per-tile fixed overhead).
/// - [outputScale], [pixfrac]: as `cfaDrizzle`'s identically-named
///   parameters.
/// - [isCancelled]: checked before each output tile; throws
///   [CfaDrizzleTiledCancelled] if it reports cancellation, aborting both
///   output stores before rethrowing (matching every other cancellable
///   tiled combiner in this project's own disposal discipline).
///
/// Throws [ArgumentError] if [frames] is empty or [pixfrac]/[outputScale]
/// is not positive — matching `cfaDrizzle`'s own validation exactly,
/// since a tiled restructuring should never silently accept an input the
/// whole-frame version would reject.
Future<CfaDrizzleTiledResult> drizzleCfaTiled({
  required List<CfaDrizzleTiledFrame> frames,
  required int outputWidth,
  required int outputHeight,
  required LinearRgbTileStoreFactory valueStoreFactory,
  required LinearRgbTileStoreFactory coverageStoreFactory,
  int tileSize = 512,
  double outputScale = 2,
  double pixfrac = 0.7,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
  // Makes the tile loop below resumable across a process death instead of
  // always restarting from tile zero. Optional and off by default: every
  // existing caller that omits this gets exactly the same behavior as
  // before (valueStoreFactory/coverageStoreFactory create fresh, uncommitted
  // stores that are aborted — deleted — on any non-success exit), since no
  // splatting/accumulation math changes when it is present.
  //
  // When provided, it takes over creating the value/coverage/saturation
  // stores itself (so it can give them stable, reopenable paths) and
  // `valueStoreFactory`/`coverageStoreFactory` are not called at all.
  CfaDrizzleTiledCheckpointStore? stageCheckpoint,
}) async {
  if (frames.isEmpty) {
    throw ArgumentError.value(
      frames,
      'frames',
      'At least one frame is required.',
    );
  }
  if (!pixfrac.isFinite ||
      !outputScale.isFinite ||
      !(pixfrac > 0) ||
      !(outputScale > 0)) {
    throw ArgumentError('pixfrac and outputScale must be finite and positive.');
  }
  if (frames.any((CfaDrizzleTiledFrame frame) =>
      !frame.weight.isFinite || frame.weight < 0)) {
    throw ArgumentError(
        'Every CFA drizzle frame weight must be finite and non-negative.');
  }
  if (frames.any((CfaDrizzleTiledFrame frame) {
    final List<double>? scales = frame.phaseScales;
    return scales != null &&
        (scales.length != 4 || scales.any((double value) => !value.isFinite));
  })) {
    throw ArgumentError(
        'CFA drizzle phase scales must contain four finite values.');
  }

  final double dropHalfExtent = 0.5 * pixfrac * outputScale;

  // Per-frame derived values, computed once (not once per output tile):
  // the source->output splatting transform, and its constant rotation
  // (a rigid transform's rotation is the same everywhere -- see
  // cfa_drizzle.dart's _deriveRotationRadians for the same reasoning).
  final List<CfaDrizzleForwardTransform> forwardTransforms =
      <CfaDrizzleForwardTransform>[
    for (final CfaDrizzleTiledFrame frame in frames)
      if (frame.transformEstimate == null)
        (double x, double y) => (x: x, y: y)
      else if (frame.localCorrectionField == null)
        invertSimilarityTransform(frame.transformEstimate!)
      else
        invertSimilarityTransformWithLocalCorrection(
          frame.transformEstimate!,
          frame.localCorrectionField!,
          invertSimilarityTransform(frame.transformEstimate!),
        ),
  ];
  final List<double> rotationRadiansByFrame = <double>[
    for (final CfaDrizzleForwardTransform transform in forwardTransforms)
      _deriveRotationRadians(transform),
  ];

  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: outputWidth,
    imageHeight: outputHeight,
    tileSize: tileSize,
    overlap: 0,
  );
  LinearRgbTileStore? valueStore;
  LinearRgbTileStore? coverageStore;
  LinearRgbTileStore? saturationCoverageStore;
  bool committed = false;
  int resumeFromTileIndex = 0;
  try {
    final bool hasSaturatedPixels = frames.any(
      (CfaDrizzleTiledFrame frame) => frame.mosaicStore.hasSaturatedPixels,
    );
    if (stageCheckpoint != null) {
      final CfaDrizzleTiledCheckpointProgress progress =
          await stageCheckpoint.openOrCreate(
        width: outputWidth,
        height: outputHeight,
        plan: plan,
        needsSaturationStore: hasSaturatedPixels,
      );
      valueStore = progress.valueStore;
      coverageStore = progress.coverageStore;
      saturationCoverageStore = progress.saturationCoverageStore;
      resumeFromTileIndex = progress.resumeFromTileIndex;
    } else {
      valueStore = await valueStoreFactory(
        width: outputWidth,
        height: outputHeight,
        plan: plan,
      );
      coverageStore = await coverageStoreFactory(
        width: outputWidth,
        height: outputHeight,
        plan: plan,
      );
      if (hasSaturatedPixels) {
        saturationCoverageStore = await coverageStoreFactory(
          width: outputWidth,
          height: outputHeight,
          plan: plan,
        );
      }
    }
    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw const CfaDrizzleTiledCancelled();
      }
      if (tileIndex < resumeFromTileIndex) {
        // Already durably written by a previous process instance; the
        // checkpoint's openForResume already verified this file's length,
        // so nothing further to do for this tile.
        reportProgress?.call((tileIndex + 1) / plan.tiles.length);
        continue;
      }
      final OverlappedTile outputTile = plan.tiles[tileIndex];
      final List<DrizzleAccumulator> accumulators = <DrizzleAccumulator>[
        for (int c = 0; c < 3; c++)
          DrizzleAccumulator(
            width: outputTile.outputWidth,
            height: outputTile.outputHeight,
          ),
      ];
      final List<DrizzleAccumulator>? saturationAccumulators =
          saturationCoverageStore == null
              ? null
              : <DrizzleAccumulator>[
                  for (int c = 0; c < 3; c++)
                    DrizzleAccumulator(
                      width: outputTile.outputWidth,
                      height: outputTile.outputHeight,
                    ),
                ];

      for (int frameIndex = 0; frameIndex < frames.length; frameIndex++) {
        final CfaDrizzleTiledFrame frame = frames[frameIndex];
        final CfaDrizzleSourceBounds? bounds = cfaDrizzleSourceBounds(
          sourceWidth: frame.mosaicStore.width,
          sourceHeight: frame.mosaicStore.height,
          outputTileX: outputTile.outputX,
          outputTileY: outputTile.outputY,
          outputTileWidth: outputTile.outputWidth,
          outputTileHeight: outputTile.outputHeight,
          outputScale: outputScale,
          pixfrac: pixfrac,
          transformEstimate: frame.transformEstimate,
          // 局所補正場がある場合、大域変換のみから計算した境界箱は
          // 狭すぎる可能性がある(Work123で発見)。その最大変位を
          // 追加マージンとして渡し、実際に必要なsource領域を確実に
          // カバーする。
          additionalMargin:
              frame.localCorrectionField?.maximumCorrectionMagnitude ?? 0,
        );
        if (bounds == null) continue;

        final Float32List sourceSamples = await frame.mosaicStore.readRegion(
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        );
        final saturationMask = saturationAccumulators == null
            ? null
            : await frame.mosaicStore.readSaturationRegion(
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
              );
        final CfaDrizzleForwardTransform forwardTransform =
            forwardTransforms[frameIndex];
        final bool hasSpatiallyVaryingTransform =
            frame.localCorrectionField?.fitted ?? false;

        for (int localY = 0; localY < bounds.height; localY++) {
          final int globalY = bounds.y + localY;
          for (int localX = 0; localX < bounds.width; localX++) {
            final int globalX = bounds.x + localX;
            final int channel =
                frame.mosaicStore.cfaPattern.colorAt(globalX, globalY).index;
            final int phase = ((globalY & 1) << 1) | (globalX & 1);
            final double value = sourceSamples[localY * bounds.width + localX] *
                (frame.phaseScales?[phase] ?? 1);
            final bool isSaturated = saturationMask?.isSaturatedIndex(
                  localY * bounds.width + localX,
                ) ??
                false;
            if (hasSpatiallyVaryingTransform) {
              _addSpatiallyMappedDrop(
                accumulator: isSaturated
                    ? saturationAccumulators![channel]
                    : accumulators[channel],
                forwardTransform: forwardTransform,
                globalX: globalX,
                globalY: globalY,
                sourceHalfExtent: 0.5 * pixfrac,
                outputScale: outputScale,
                outputTileX: outputTile.outputX,
                outputTileY: outputTile.outputY,
                value: isSaturated ? 1 : value,
                weight: frame.weight,
              );
            } else {
              final ({double x, double y}) mapped = forwardTransform(
                globalX.toDouble(),
                globalY.toDouble(),
              );
              final double outputX =
                  mapped.x * outputScale - outputTile.outputX;
              final double outputY =
                  mapped.y * outputScale - outputTile.outputY;
              if (isSaturated) {
                saturationAccumulators![channel].addRotatedDrop(
                  outputX,
                  outputY,
                  1,
                  rotationRadians: rotationRadiansByFrame[frameIndex],
                  halfWidth: dropHalfExtent,
                  halfHeight: dropHalfExtent,
                  weight: frame.weight,
                );
              } else {
                accumulators[channel].addRotatedDrop(
                  outputX,
                  outputY,
                  value,
                  rotationRadians: rotationRadiansByFrame[frameIndex],
                  halfWidth: dropHalfExtent,
                  halfHeight: dropHalfExtent,
                  weight: frame.weight,
                );
              }
            }
          }
        }
      }

      final List<DrizzleResult> results = <DrizzleResult>[
        for (final DrizzleAccumulator accumulator in accumulators)
          accumulator.finalize(),
      ];
      final List<DrizzleResult>? saturationResults = saturationAccumulators
          ?.map((DrizzleAccumulator accumulator) => accumulator.finalize())
          .toList(growable: false);
      final int tilePixelCount =
          outputTile.outputWidth * outputTile.outputHeight;
      final Float32List valueSamples = Float32List(tilePixelCount * 3);
      final Float32List coverageSamples = Float32List(tilePixelCount * 3);
      final Float32List? saturationCoverageSamples =
          saturationResults == null ? null : Float32List(tilePixelCount * 3);
      for (int pixel = 0; pixel < tilePixelCount; pixel++) {
        for (int c = 0; c < 3; c++) {
          valueSamples[pixel * 3 + c] = results[c].value[pixel];
          coverageSamples[pixel * 3 + c] = results[c].coverage[pixel];
          if (saturationCoverageSamples != null) {
            saturationCoverageSamples[pixel * 3 + c] =
                saturationResults![c].coverage[pixel];
          }
        }
      }
      await valueStore.writeTile(
        LinearRgbTile(
          x: outputTile.outputX,
          y: outputTile.outputY,
          width: outputTile.outputWidth,
          height: outputTile.outputHeight,
          interleavedRgb: valueSamples,
        ),
      );
      await coverageStore.writeTile(
        LinearRgbTile(
          x: outputTile.outputX,
          y: outputTile.outputY,
          width: outputTile.outputWidth,
          height: outputTile.outputHeight,
          interleavedRgb: coverageSamples,
        ),
      );
      if (saturationCoverageStore != null) {
        await saturationCoverageStore.writeTile(
          LinearRgbTile(
            x: outputTile.outputX,
            y: outputTile.outputY,
            width: outputTile.outputWidth,
            height: outputTile.outputHeight,
            interleavedRgb: saturationCoverageSamples!,
          ),
        );
      }
      await stageCheckpoint?.recordProgress(tileIndex + 1);
      reportProgress?.call((tileIndex + 1) / plan.tiles.length);
    }
    await valueStore.commit();
    await coverageStore.commit();
    await saturationCoverageStore?.commit();
    committed = true;
    /* Worker clears the checkpoint after durable final output. */
    return CfaDrizzleTiledResult(
      valueStore: valueStore,
      coverageStore: coverageStore,
      saturationCoverageStore: saturationCoverageStore,
    );
  } finally {
    if (!committed && stageCheckpoint == null) {
      // Unchanged pre-existing behavior for callers that did not opt into
      // checkpointing: these were always freshly created, uncommitted
      // stores with no durable meaning of their own, so they are always
      // discarded here regardless of why the loop above did not finish.
      try {
        await valueStore?.abort();
      } finally {
        try {
          await coverageStore?.abort();
        } finally {
          await saturationCoverageStore?.abort();
        }
      }
    } else if (!committed && stageCheckpoint != null) {
      // A checkpoint is active: leave its files and manifest exactly as
      // recordProgress last left them (do not call abort(), which would
      // delete them) so a later retry with the same identity can resume
      // from `resumeFromTileIndex` instead of starting over. Only close the
      // file handles this process instance opened; the bytes stay on disk.
      try {
        await (valueStore as FileBackedLinearRgbTileStore?)
            ?.closeRetainingFile();
      } finally {
        try {
          await (coverageStore as FileBackedLinearRgbTileStore?)
              ?.closeRetainingFile();
        } finally {
          await (saturationCoverageStore as FileBackedLinearRgbTileStore?)
              ?.closeRetainingFile();
        }
      }
    }
  }
}

double _deriveRotationRadians(CfaDrizzleForwardTransform forwardTransform) {
  final ({double x, double y}) origin = forwardTransform(0, 0);
  final ({double x, double y}) alongX = forwardTransform(1, 0);
  return math.atan2(alongX.y - origin.y, alongX.x - origin.x);
}
