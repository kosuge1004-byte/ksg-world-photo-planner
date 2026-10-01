import '../image/file_backed_linear_rgb_tile_store.dart';
import 'dart:io';

import '../color/linear_rgb_color_transform.dart';
import '../color/tiled_linear_rgb_color_transform.dart';
import '../demosaic/demosaic_algorithm.dart';
import '../demosaic/demosaic_engine.dart';
import '../demosaic/demosaic_reconstructed_mosaic.dart';
import '../demosaic/demosaic_registry.dart';
import '../drizzle/tiled_drizzle_gap_fill.dart';
import '../drizzle/tiled_reconstruct_native_cfa_from_drizzle.dart';
import '../export/cfa_drizzle_dng_validity.dart';
import '../export/export_result.dart';
import '../export/local_tone_adaptation.dart';
import '../export/linear_dng_writer.dart';
import '../export/output_image_format.dart';
import '../export/tiled_local_tone_adaptation.dart';
import '../image/linear_rgb_tile_store.dart';
import 'cfa_drizzle_milky_way_pipeline.dart';

/// Closes the loop Work84 opened: composites a
/// [CfaDrizzleMilkyWayResult] (Work90's `registerAndDrizzleCalibrated
/// Mosaics`/`runCfaDrizzleMilkyWayPipeline`) into a normal dense RGB
/// image (via `fillDrizzleTiledGaps`, Work92) and exports it to a file
/// (via `exportTileStoreToImage`, already existing) — the same "select
/// RAWs -> analyze/combine -> export" shape this project's other two
/// modes already have (`export_pipeline_result.dart`, Work58, and
/// `meteor_composite_result.dart`, Work61-63), completing it for the
/// CFA-domain-drizzle-based Milky Way pipeline (Work84-92).
///
/// With this, the full chain — decode and calibrate every frame without
/// demosaicing (Work89), register on a green-channel proxy extracted
/// straight from the raw mosaic (Work88), combine in raw CFA space via
/// tiled, memory-bounded drizzle (Work87), fill each channel's own
/// sparse gaps (Work91/92), tone-map, and encode to BMP or TIFF16 — is
/// wired together end to end for the first time. This pipeline is still
/// not connected to the app's UI (see `cfa_drizzle_milky_way_pipeline.
/// dart`'s own doc comment for why it exists as a second, alternative
/// Milky Way pipeline rather than replacing the one already wired into
/// `processing_progress_screen.dart`).
///
/// This file has not been executed against the Dart SDK. Its own logic
/// is thin orchestration over already-tested pieces (`fillDrizzleTiled
/// Gaps`, already validated in `tiled_drizzle_gap_fill_test.dart`, and
/// `exportTileStoreToImage`, already existing); `test/cfa_drizzle_milky_
/// way_export_test.dart` covers this file's own new logic (disposing
/// the intermediate drizzle stores after gap-filling, forwarding
/// arguments correctly) directly.

/// Fills [result]'s drizzle gaps and exports the result to
/// [exportPath].
///
/// - [result]: typically `registerAndDrizzleCalibratedMosaics`'s or
///   `runCfaDrizzleMilkyWayPipeline`'s own return value.
/// - [gapFillOutputStoreFactory]: builds the intermediate, gap-filled
///   dense RGB store, and (when [localToneStrength] > 0, see below)
///   also the intermediate local-tone-adapted store — both are just
///   "temporary dense RGB store" needs of the same shape, so this one
///   factory serves both rather than requiring a second, near-identical
///   parameter for the uncommon case. Both intermediate stores are
///   disposed automatically once the final export is produced,
///   regardless of success or failure.
/// - [format], [exposureScale], [whitePoint]: forwarded to
///   `exportTileStoreToImage`.
/// - [kernelRadius], [minimumCoverage]: forwarded to
///   `fillDrizzleTiledGaps`.
/// - [localToneStrength] (Work101, default `0`): when greater than `0`,
///   `applyLocalToneAdaptationTiled` (Work101) is inserted between gap-
///   filling and export, addressing the same "single global tone curve
///   can't balance background visibility with highlight detail" gap
///   `export_result.dart`'s own `localToneStrength` parameter addresses
///   for the in-memory export path (Work100) — this is that same
///   capability's tiled, memory-bounded counterpart, appropriate for
///   this pipeline's own tiled, memory-bounded stores. At the default
///   `0`, this step is skipped entirely (not merely a no-op pass — the
///   whole extra read/write pass is avoided), leaving existing behavior
///   completely unchanged.
/// - [localToneBlurRadius], [localToneReferencePercentile],
///   [localToneMinGain], [localToneMaxGain], [localToneStripHeight]:
///   forwarded to `applyLocalToneAdaptationTiled`.
/// - [useRealDemosaic] (Work112, default `false`): when `true`,
///   [result]'s sparse per-channel drizzle output is reconstructed into
///   a single native-resolution raw mosaic
///   (`reconstructNativeCfaMosaicFromDrizzleTiled`) and run through this
///   project's real, structure-tensor-based adaptive demosaic engine
///   (`demosaicReconstructedMosaic`) instead of `fillDrizzleTiledGaps`'s
///   own same-channel-only local average — addressing the CFA drizzle
///   pipeline's own most consequential remaining quality gap (see
///   `reconstruct_native_cfa_from_drizzle.dart`'s own doc comment for
///   the full rationale). This path **requires
///   `result.outputScale == 1`** (no supersampling — a supersampled
///   grid has no well-defined native CFA phase at every position, see
///   that same doc comment) and [demosaicRegistry]; an
///   [ArgumentError] is thrown at the top of this function, before any
///   work happens, if either condition is not met. At the default
///   `false`, this path is not touched at all, leaving existing
///   behavior (including at `outputScale > 1`, where this new path
///   cannot apply) completely unchanged.
/// - [demosaicRegistry]: required when [useRealDemosaic] is `true`;
///   forwarded to `demosaicReconstructedMosaic`. Ignored otherwise.
///
/// [result]'s own `valueStore`/`coverageStore` are disposed here once
/// gap-filling has read everything it needs from them, regardless of
/// success or failure — this function takes ownership of them, matching
/// the same disposal discipline `milky_way_pipeline.dart`'s own combine-
/// and-export helpers already established for their own intermediate
/// stores.
///
/// Returns the [File] that was written.
Future<File> compositeCfaDrizzleMilkyWayAndExport({
  required CfaDrizzleMilkyWayResult result,
  required LinearRgbTileStoreFactory gapFillOutputStoreFactory,
  required String exportPath,
  OutputImageFormat format = OutputImageFormat.tiff16,
  int tileSize = 512,
  int kernelRadius = 2,
  double minimumCoverage = 1e-6,
  double localToneStrength = 0,
  int localToneBlurRadius = 32,
  double localToneReferencePercentile = 0.85,
  double localToneMinGain = 0.25,
  double localToneMaxGain = 4,
  int localToneStripHeight = 128,
  LinearRgbColorTransform? colorTransform,
  bool useRealDemosaic = false,
  DemosaicRegistry? demosaicRegistry,
  double? exposureScale,
  double? whitePoint,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
  bool retainCheckpointFiles = false,
}) async {
  if (useRealDemosaic && result.outputScale != 1) {
    throw ArgumentError(
      'useRealDemosaic requires result.outputScale == 1 (got '
      '${result.outputScale}); a supersampled grid has no well-defined '
      'native CFA phase at every position — see '
      'reconstruct_native_cfa_from_drizzle.dart for why.',
    );
  }
  if (useRealDemosaic && demosaicRegistry == null) {
    throw ArgumentError('demosaicRegistry is required when useRealDemosaic '
        'is true.');
  }
  LinearRgbTileStore? gapFilledStore;
  LinearRgbTileStore? colorTransformedStore;
  LinearRgbTileStore? toneAdaptedStore;
  FileBackedReconstructedCfa? reconstructedCfa;
  LinearDngTransparencyMaskSource? linearDngTransparencyMaskSource;
  try {
    if (useRealDemosaic) {
      reconstructedCfa = await reconstructNativeCfaStoreFromDrizzleStreamed(
        valueStore: result.valueStore,
        coverageStore: result.coverageStore,
        saturationCoverageStore: result.saturationCoverageStore,
        saturationDecisionCoverageStore: result.saturationDecisionCoverageStore,
        referenceCfaPattern: result.referenceCfaPattern,
        kernelRadius: kernelRadius,
        minimumCoverage: minimumCoverage,
        isCancelled: isCancelled,
        reportProgress: reportProgress,
      );
      if (format == OutputImageFormat.linearDng) {
        final DemosaicEngine productionDemosaic =
            demosaicRegistry!.requireProduction(
          DemosaicAlgorithm.mobileStackAdaptive,
        );
        linearDngTransparencyMaskSource =
            CfaDrizzleDemosaicTransparencyMaskSource(
          coverageStore: result.coverageStore,
          referenceCfaPattern: result.referenceCfaPattern,
          minimumCoverage: minimumCoverage,
          reconstructedInvalidMask: reconstructedCfa.saturationMask,
          requiredInputRadius: productionDemosaic.requiredInputRadius,
          isCancelled: isCancelled,
        );
      }
      gapFilledStore = await demosaicFileBackedRawMosaic(
        mosaicStore: reconstructedCfa.store,
        saturationMask: reconstructedCfa.saturationMask,
        demosaicRegistry: demosaicRegistry!,
        outputStoreFactory: gapFillOutputStoreFactory,
        tileSize: tileSize,
        isCancelled: isCancelled,
        reportProgress: reportProgress,
      );
    } else {
      if (format == OutputImageFormat.linearDng) {
        linearDngTransparencyMaskSource = CfaDrizzleRgbTransparencyMaskSource(
          coverageStore: result.coverageStore,
          saturationCoverageStore: result.saturationCoverageStore,
          saturationDecisionCoverageStore:
              result.saturationDecisionCoverageStore,
          minimumCoverage: minimumCoverage,
          isCancelled: isCancelled,
        );
      }
      gapFilledStore = await fillDrizzleTiledGaps(
        valueStore: result.valueStore,
        coverageStore: result.coverageStore,
        outputStoreFactory: gapFillOutputStoreFactory,
        tileSize: tileSize,
        kernelRadius: kernelRadius,
        minimumCoverage: minimumCoverage,
        isCancelled: isCancelled,
        reportProgress: reportProgress,
      );
    }

    final LinearRgbColorTransform? effectiveColorTransform =
        colorTransform ?? result.outputColorTransform;
    final postColorRenderProfile =
        colorTransform == null ? result.postColorRenderProfile : null;
    final LinearRgbTileStore colorSource;
    if (effectiveColorTransform != null) {
      colorTransformedStore = await applyLinearRgbColorTransformTiled(
        inputStore: gapFilledStore,
        outputStoreFactory: gapFillOutputStoreFactory,
        transform: effectiveColorTransform,
        tileSize: tileSize,
        isCancelled: isCancelled,
        reportProgress: reportProgress,
      );
      colorSource = colorTransformedStore;
    } else {
      colorSource = gapFilledStore;
    }

    final LinearRgbTileStore exportSource;
    if (format != OutputImageFormat.linearDng && localToneStrength > 0) {
      toneAdaptedStore = await applyLocalToneAdaptationTiled(
        inputStore: colorSource,
        outputStoreFactory: gapFillOutputStoreFactory,
        tileSize: tileSize,
        stripHeight: localToneStripHeight,
        blurRadius: localToneBlurRadius,
        strength: localToneStrength,
        referencePercentile: localToneReferencePercentile,
        minGain: localToneMinGain,
        maxGain: localToneMaxGain,
        luminanceWeights:
            postColorRenderProfile?.postProfileColorTransform != null
                ? linearProPhotoD50LuminanceWeights
                : bt709LinearLuminanceWeights,
        isCancelled: isCancelled,
        reportProgress: reportProgress,
      );
      exportSource = toneAdaptedStore;
    } else {
      exportSource = colorSource;
    }

    return await exportTileStoreToImage(
      tileStore: exportSource,
      outputPath: exportPath,
      format: format,
      exposureScale: exposureScale,
      whitePoint: whitePoint,
      renderProfile: postColorRenderProfile,
      linearDngTransparencyMaskSource: linearDngTransparencyMaskSource,
      isCancelled: isCancelled,
    );
  } finally {
    // Attempt every owned-store cleanup even if one dispose operation fails.
    // File-backed stores are independent resources; stopping at the first
    // cleanup exception can strand the remaining temporary files.
    if (retainCheckpointFiles) {
      for (final store in [
        result.valueStore,
        result.coverageStore,
        result.saturationCoverageStore,
        result.saturationDecisionCoverageStore
      ]) {
        if (store is FileBackedLinearRgbTileStore) {
          await store.closeRetainingFile();
        }
      }
    }
    await _disposeOwnedStoresBestEffort(<LinearRgbTileStore?>[
      if (!retainCheckpointFiles) result.valueStore,
      if (!retainCheckpointFiles) result.coverageStore,
      if (!retainCheckpointFiles) result.saturationCoverageStore,
      if (!retainCheckpointFiles) result.saturationDecisionCoverageStore,
      gapFilledStore,
      colorTransformedStore,
      toneAdaptedStore,
    ]);
    await reconstructedCfa?.store.dispose();
  }
}

Future<void> _disposeOwnedStoresBestEffort(
  List<LinearRgbTileStore?> stores,
) async {
  Object? firstError;
  StackTrace? firstStackTrace;
  final Set<LinearRgbTileStore> disposed = <LinearRgbTileStore>{};
  for (final LinearRgbTileStore? store in stores) {
    if (store == null || !disposed.add(store)) continue;
    try {
      await store.dispose();
    } on Object catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
  }
  if (firstError != null) {
    Error.throwWithStackTrace(firstError, firstStackTrace!);
  }
}
