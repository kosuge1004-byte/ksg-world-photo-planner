import 'milky_way_tile_combine_checkpoint.dart';
import '../stacking/foreground_region.dart';
import 'dart:async';
import 'dart:io';

import '../engine/concurrency_policy.dart';
import '../diagnostics/processing_failure_report.dart';
import '../engine/default_resource_reader.dart';
import '../engine/resource_snapshot.dart';
import '../export/export_result.dart';
import '../export/dng_final_render_profile.dart';
import '../export/output_image_format.dart';
import '../export/linear_dng_writer.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/linear_contribution_tile_store.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../meteor/streak_shape.dart';
import '../registration/star_detector.dart' show DetectedStar;
import '../registration/tile_store_star_detection.dart';
import '../registration/tiled_affine_rgb_resampler.dart'
    show ResamplingInterpolation;
import '../stacking/star_trail_edge_fade.dart';
import '../stacking/star_trail_gap_fill.dart';
import '../stacking/star_trail_gap_fill_drawer.dart';
import 'milky_way_pipeline.dart';
import 'star_trail_pipeline.dart';

/// Wires `star_trail_pipeline.dart`/`milky_way_pipeline.dart` (Work53/54)
/// together with `export_result.dart` (Work55) into two convenience
/// "run the whole thing and write a real file" functions — the concrete
/// next step Work57 identified as still missing: both pipeline modules
/// and the export module existed and were each independently tested, but
/// nothing actually called them in sequence.
///
/// Each function here disposes the intermediate [LinearRgbTileStore]
/// once the export completes (successfully or not, via `finally`) — a
/// caller using these convenience functions never needs to manage that
/// store's lifecycle itself, unlike calling `runStarTrailPipeline`/
/// `runMilkyWayPipeline` and `exportTileStoreToBmp` separately, where the
/// caller owns that responsibility (see each pipeline function's own
/// doc comment).
///
/// This still does *not* build a results/gallery screen or wire either
/// function into the actual UI (`processing_progress_screen.dart`) —
/// deliberately: that screen is complex, already-shipped Flutter widget
/// code this environment cannot execute or visually verify, and
/// integrating a new multi-frame pipeline into its existing per-file job
/// flow is a meaningfully different, riskier kind of change than adding
/// two new, independently testable functions alongside already-tested
/// pieces. These functions are what such a screen (or an interim
/// "export" action, or a debug/test harness) would call once that UI
/// work happens. See WORK58_PROGRESS.md.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it). Its own logic is thin orchestration
/// over already-tested pieces (each pipeline function, and
/// `exportTileStoreToBmp`); `test/export_pipeline_result_test.dart`
/// covers the store-disposal behavior directly using fakes, but — like
/// `runStarTrailPipeline`/`runMilkyWayPipeline` themselves — cannot
/// exercise the full `JobScheduler`-driven decode stage without a real
/// or fake decoder pipeline wired end to end (an open, explicitly-
/// acknowledged gap, not glossed over — see those functions' own doc
/// comments for the same caveat).

/// Runs [runStarTrailPipeline] end to end and writes the result to
/// [exportPath] via [exportTileStoreToBmp], disposing the intermediate
/// tile store afterward either way.
///
/// All parameters not documented here match [runStarTrailPipeline]'s own
/// (forwarded unchanged); [exportPath], [exposureScale], and
/// [whitePoint] match [exportTileStoreToBmp]'s.
Future<File> runStarTrailPipelineAndExport({
  required List<String> sourcePaths,
  required StarTrailFrameDecodingConfig decodingConfig,
  required LinearRgbTileStoreFactory outputTileStoreFactory,
  required String exportPath,
  OutputImageFormat outputFormat = OutputImageFormat.bmp8,
  LinearDngCompression linearDngCompression = LinearDngCompression.none,
  int keepHighest = 1,
  int minimumCoveringFrames = 1,
  int tileSize = 512,
  ConcurrencyPolicy concurrencyPolicy = fullFrameRawConcurrencyPolicy,
  Future<ResourceSnapshot> Function() resourceReader =
      readDefaultResourceSnapshot,
  double? exposureScale,
  double? whitePoint,
  DngFinalRenderProfile? renderProfile,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
  ProcessingStageReporter? reportStage,
}) async {
  reportStage?.call(ProcessingFailureStage.stackCombination, '比較明合成');
  final LinearRgbTileStore store = await runStarTrailPipeline(
    sourcePaths: sourcePaths,
    decodingConfig: decodingConfig,
    outputTileStoreFactory: outputTileStoreFactory,
    keepHighest: keepHighest,
    minimumCoveringFrames: minimumCoveringFrames,
    tileSize: tileSize,
    concurrencyPolicy: concurrencyPolicy,
    resourceReader: resourceReader,
    reportProgress: reportProgress,
    isCancelled: isCancelled,
  );
  try {
    reportStage?.call(
      ProcessingFailureStage.forOutput(outputFormat),
      '最終画像エンコード',
    );
    return await exportTileStoreToImage(
      tileStore: store,
      outputPath: exportPath,
      format: outputFormat,
      linearDngCompression: linearDngCompression,
      exposureScale: exposureScale,
      whitePoint: whitePoint,
      renderProfile: renderProfile,
      isCancelled: isCancelled,
    );
  } finally {
    await store.dispose();
  }
}

/// Runs [runMilkyWayPipeline] end to end and writes the result to
/// [exportPath] via [exportTileStoreToBmp], disposing the intermediate
/// tile store afterward either way. The frame-inclusion/registration
/// [MilkyWayFrameDiagnostics] from the pipeline run are discarded here
/// (this function returns only the exported [File]); a caller that needs
/// them (e.g. to show the user which frames were used) should call
/// [runMilkyWayPipeline] and [exportTileStoreToBmp] separately instead of
/// this convenience wrapper.
///
/// All parameters not documented here match [runMilkyWayPipeline]'s own
/// (forwarded unchanged); [exportPath], [exposureScale], and
/// [whitePoint] match [exportTileStoreToBmp]'s.
Future<File> runMilkyWayPipelineAndExport({
  required List<String> sourcePaths,
  required MilkyWayFrameDecodingConfig decodingConfig,
  required LinearRgbTileStoreFactory outputTileStoreFactory,
  required String exportPath,
  OutputImageFormat outputFormat = OutputImageFormat.bmp8,
  LinearDngCompression linearDngCompression = LinearDngCompression.none,
  double kappa = 2.5,
  int maximumIterations = 3,
  int tileSize = 512,
  double starDetectorThresholdSigma = 6,
  double transformToleranceRadius = 3,
  int minRegisteredFrames = 2,
  double residualHalfWeightRadius = 1.5,
  double minimumRegistrationWeight = 0.05,
  bool enableLocalRegistration = true,
  double localRegistrationMinimumMatchesPerCoefficient = 4,
  double localRegistrationMaximumCorrectionMagnitude = 3,
  ResamplingInterpolation interpolation = ResamplingInterpolation.bicubic,
  bool preserveStaticForeground = true,
  bool enableMovingObjectRemoval = true,
  int? referenceIndex,
  ConcurrencyPolicy concurrencyPolicy = fullFrameRawConcurrencyPolicy,
  Future<ResourceSnapshot> Function() resourceReader =
      readDefaultResourceSnapshot,
  double? exposureScale,
  double? whitePoint,
  DngFinalRenderProfile? renderProfile,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
  ProcessingStageReporter? reportStage,
}) async {
  final MilkyWayPipelineResult result = await runMilkyWayPipeline(
    sourcePaths: sourcePaths,
    decodingConfig: decodingConfig,
    outputTileStoreFactory: outputTileStoreFactory,
    kappa: kappa,
    maximumIterations: maximumIterations,
    tileSize: tileSize,
    starDetectorThresholdSigma: starDetectorThresholdSigma,
    transformToleranceRadius: transformToleranceRadius,
    minRegisteredFrames: minRegisteredFrames,
    residualHalfWeightRadius: residualHalfWeightRadius,
    minimumRegistrationWeight: minimumRegistrationWeight,
    enableLocalRegistration: enableLocalRegistration,
    localRegistrationMinimumMatchesPerCoefficient:
        localRegistrationMinimumMatchesPerCoefficient,
    localRegistrationMaximumCorrectionMagnitude:
        localRegistrationMaximumCorrectionMagnitude,
    interpolation: interpolation,
    preserveStaticForeground: preserveStaticForeground,
    enableMovingObjectRemoval: enableMovingObjectRemoval,
    referenceIndex: referenceIndex,
    concurrencyPolicy: concurrencyPolicy,
    resourceReader: resourceReader,
    reportProgress: reportProgress,
    isCancelled: isCancelled,
    reportStage: reportStage,
  );
  try {
    reportStage?.call(
      ProcessingFailureStage.forOutput(outputFormat),
      '最終画像エンコード',
    );
    return await exportTileStoreToImage(
      tileStore: result.tileStore,
      outputPath: exportPath,
      format: outputFormat,
      linearDngCompression: linearDngCompression,
      exposureScale: exposureScale,
      whitePoint: whitePoint,
      renderProfile: renderProfile,
      contributionStore: result.contributionStore,
      isCancelled: isCancelled,
    );
  } finally {
    try {
      await result.tileStore.dispose();
    } finally {
      await result.contributionStore?.dispose();
    }
  }
}

/// Runs [combineDecodedFrames] on already-decoded [frameStores] and
/// writes the result to [exportPath], disposing the intermediate tile
/// store afterward either way.
///
/// Unlike [runStarTrailPipelineAndExport], this does *not* perform any
/// decoding of its own (the caller already has [frameStores] ready) —
/// it wires together exactly the two pieces
/// (`star_trail_pipeline.dart`'s `combineDecodedFrames` and
/// `exportTileStoreToBmp`) that already have direct, fake-store-based
/// test coverage of their own, so this specific wrapper is itself
/// directly testable end to end, unlike the `JobScheduler`-driven
/// full-pipeline wrappers above (see this file's own doc comment).
///
/// All parameters not documented here match [combineDecodedFrames]'s own
/// (forwarded unchanged); [exportPath], [exposureScale], and
/// [whitePoint] match [exportTileStoreToBmp]'s.
Future<File> combineDecodedFramesAndExport({
  required List<LinearRgbTileStore> frameStores,
  required LinearRgbTileStoreFactory outputTileStoreFactory,
  required String exportPath,
  List<String>? sourcePaths,
  bool enableAircraftSatelliteRemoval = false,
  LinearRgbTileStore? referenceForegroundStore,
  bool preserveReferenceForeground = false,
  ForegroundRegion? foregroundRegion,
  OutputImageFormat outputFormat = OutputImageFormat.bmp8,
  LinearDngCompression linearDngCompression = LinearDngCompression.none,
  int keepHighest = 1,
  int minimumCoveringFrames = 1,
  int tileSize = 512,
  double? exposureScale,
  double? whitePoint,
  DngFinalRenderProfile? renderProfile,
  StarTrailGapFillMode gapFillMode = StarTrailGapFillMode.off,
  StarTrailFadeSettings fadeSettings = const StarTrailFadeSettings(),
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
  ProcessingStageReporter? reportStage,
  LinearRgbTileStore? resumeCombinedStore,
  Future<void> Function(LinearRgbTileStore store)? onCombinedCommitted,
  Future<void> Function()? onSourceStoresNoLongerNeeded,
  bool retainCombinedStoreOnExit = false,
}) async {
  LinearRgbTileStore store;
  bool ownsCombinedStore = false;
  if (resumeCombinedStore != null) {
    if (!resumeCombinedStore.isCommitted) {
      throw StateError('Resumed star-trail combined store is not committed.');
    }
    store = resumeCombinedStore;
  } else {
    List<List<StreakShape>>? excludedStreaksByFrame;
    if (enableAircraftSatelliteRemoval) {
      final List<String>? paths = sourcePaths;
      if (paths == null || paths.length != frameStores.length) {
        throw ArgumentError(
          'sourcePaths matching frameStores are required when '
          'aircraft/satellite removal is enabled.',
        );
      }
      reportStage?.call(
        ProcessingFailureStage.stackCombination,
        '飛行機・人工衛星の光跡解析',
      );
      excludedStreaksByFrame = await detectStarTrailNonSiderealStreaks(
        sourcePaths: paths,
        frameStores: frameStores,
        isCancelled: isCancelled,
      );
    }
    reportStage?.call(ProcessingFailureStage.stackCombination, '比較明合成');
    store = await combineDecodedFrames(
      frameStores: frameStores,
      outputTileStoreFactory: outputTileStoreFactory,
      excludedStreaksByFrame: excludedStreaksByFrame,
      referenceForegroundStore: referenceForegroundStore,
      preserveReferenceForeground: preserveReferenceForeground,
      foregroundRegion: foregroundRegion,
      keepHighest: keepHighest,
      minimumCoveringFrames: minimumCoveringFrames,
      tileSize: tileSize,
      fadeSettings: fadeSettings,
      reportProgress: reportProgress,
      isCancelled: isCancelled,
    );
    ownsCombinedStore = true;
    await onCombinedCommitted?.call(store);
  }

  LinearRgbTileStore? gapFilledStore;
  if (gapFillMode != StarTrailGapFillMode.off && frameStores.length >= 2) {
    reportStage?.call(
      ProcessingFailureStage.stackCombination,
      'シャッター間の隙間を補間',
    );
    try {
      final List<GapFillSegment> allSegments = <GapFillSegment>[];
      List<DetectedStar>? previousFrameStars;
      for (int i = 0; i < frameStores.length; i++) {
        if (isCancelled?.call() ?? false) break;
        final List<DetectedStar> currentFrameStars =
            await detectStarsFromLinearRgbTileStore(
          frameStores[i],
          isCancelled: isCancelled,
        );
        if (previousFrameStars != null) {
          final List<GapFillSegment> segments = computeGapFillSegments(
            starsBefore: previousFrameStars,
            starsAfter: currentFrameStars,
            mode: gapFillMode,
          );
          allSegments.addAll(segments);
        }
        previousFrameStars = currentFrameStars;
      }
      if (allSegments.isNotEmpty) {
        gapFilledStore = await createGapFilledStarTrailStore(
          source: store,
          outputStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
          segments: allSegments,
          tileSize: tileSize,
          isCancelled: isCancelled,
        );
      }
    } on Object {
      if (isCancelled?.call() ?? false) rethrow;
      // Gap filling remains a non-destructive enhancement. The committed
      // combined checkpoint can still be exported if this cosmetic pass fails.
    }
  }

  // All source-frame reads (including optional gap analysis) are finished.
  // Release them before encoder/native allocations begin to reduce peak RSS
  // without changing any image-processing or output setting.
  await onSourceStoresNoLongerNeeded?.call();

  try {
    reportStage?.call(
      ProcessingFailureStage.forOutput(outputFormat),
      '最終画像エンコード',
    );
    return await exportTileStoreToImage(
      tileStore: gapFilledStore ?? store,
      outputPath: exportPath,
      format: outputFormat,
      linearDngCompression: linearDngCompression,
      exposureScale: exposureScale,
      whitePoint: whitePoint,
      renderProfile: renderProfile,
      isCancelled: isCancelled,
    );
  } finally {
    try {
      await gapFilledStore?.dispose();
    } finally {
      if (ownsCombinedStore && !retainCombinedStoreOnExit) {
        await store.dispose();
      }
    }
  }
}

Future<File> registerAndCombineDecodedFramesAndExport({
  required List<String> sourcePaths,
  required List<LinearRgbTileStore?> frameStores,
  List<RawSaturationMask?>? saturationInfluenceMasks,
  required Map<int, Object?> decodeFailures,
  required LinearRgbTileStoreFactory outputTileStoreFactory,
  LinearContributionTileStoreFactory? contributionTileStoreFactory,
  required String exportPath,
  OutputImageFormat outputFormat = OutputImageFormat.bmp8,
  LinearDngCompression linearDngCompression = LinearDngCompression.none,
  double kappa = 2.5,
  int maximumIterations = 3,
  int tileSize = 512,
  double starDetectorThresholdSigma = 6,
  double transformToleranceRadius = 3,
  int minRegisteredFrames = 2,
  double residualHalfWeightRadius = 1.5,
  double minimumRegistrationWeight = 0.05,
  bool enableLocalRegistration = true,
  double localRegistrationMinimumMatchesPerCoefficient = 4,
  double localRegistrationMaximumCorrectionMagnitude = 3,
  ResamplingInterpolation interpolation = ResamplingInterpolation.bicubic,
  bool preserveStaticForeground = true,
  bool enableMovingObjectRemoval = true,
  int? referenceIndex,
  MilkyWayRegistrationModel registrationModel =
      MilkyWayRegistrationModel.legacyRigid,
  int combineWorkerIsolates = 1,
  double? exposureScale,
  double? whitePoint,
  DngFinalRenderProfile? renderProfile,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
  ProcessingStageReporter? reportStage,
  LinearRgbTileStore? resumeCombinedStore,
  LinearContributionTileStore? resumeContributionStore,
  Future<void> Function(
    LinearRgbTileStore store,
    LinearContributionTileStore? contributionStore,
  )? onCombinedCommitted,
  Future<void> Function(List<MilkyWayFrameDiagnostics> diagnostics)?
      onFrameDiagnostics,
  Future<void> Function()? onSourceStoresNoLongerNeeded,
  bool retainCombinedStoreOnExit = false,
  MilkyWayTileCombineCheckpointStore? stageCheckpoint,
}) async {
  LinearRgbTileStore store;
  LinearContributionTileStore? contributionStore;
  bool ownsCombinedStores = false;

  if (resumeCombinedStore != null) {
    if (!resumeCombinedStore.isCommitted) {
      throw StateError('Resumed Milky Way combined store is not committed.');
    }
    if (resumeContributionStore != null &&
        !resumeContributionStore.isCommitted) {
      throw StateError('Resumed contribution store is not committed.');
    }
    store = resumeCombinedStore;
    contributionStore = resumeContributionStore;
  } else {
    final MilkyWayPipelineResult result = await registerAndCombineDecodedFrames(
      stageCheckpoint: stageCheckpoint,
      sourcePaths: sourcePaths,
      frameStores: frameStores,
      saturationInfluenceMasks: saturationInfluenceMasks,
      decodeFailures: decodeFailures,
      outputTileStoreFactory: outputTileStoreFactory,
      contributionTileStoreFactory: contributionTileStoreFactory,
      kappa: kappa,
      maximumIterations: maximumIterations,
      tileSize: tileSize,
      starDetectorThresholdSigma: starDetectorThresholdSigma,
      transformToleranceRadius: transformToleranceRadius,
      minRegisteredFrames: minRegisteredFrames,
      residualHalfWeightRadius: residualHalfWeightRadius,
      minimumRegistrationWeight: minimumRegistrationWeight,
      enableLocalRegistration: enableLocalRegistration,
      localRegistrationMinimumMatchesPerCoefficient:
          localRegistrationMinimumMatchesPerCoefficient,
      localRegistrationMaximumCorrectionMagnitude:
          localRegistrationMaximumCorrectionMagnitude,
      interpolation: interpolation,
      preserveStaticForeground: preserveStaticForeground,
      enableMovingObjectRemoval: enableMovingObjectRemoval,
      referenceIndex: referenceIndex,
      registrationModel: registrationModel,
      combineWorkerIsolates: combineWorkerIsolates,
      reportProgress: reportProgress,
      isCancelled: isCancelled,
      reportStage: reportStage,
    );
    store = result.tileStore;
    contributionStore = result.contributionStore;
    ownsCombinedStores = true;
    await onFrameDiagnostics?.call(result.frameDiagnostics);
    await onCombinedCommitted?.call(store, contributionStore);
  }

  // Registration/stacking no longer needs decoded source frames. Release them
  // before final encoding so full-resolution source buffers cannot overlap the
  // encoder's peak allocation.
  await onSourceStoresNoLongerNeeded?.call();

  try {
    reportStage?.call(
      ProcessingFailureStage.forOutput(outputFormat),
      '最終画像エンコード',
    );
    return await exportTileStoreToImage(
      tileStore: store,
      outputPath: exportPath,
      format: outputFormat,
      linearDngCompression: linearDngCompression,
      exposureScale: exposureScale,
      whitePoint: whitePoint,
      renderProfile: renderProfile,
      contributionStore: contributionStore,
      isCancelled: isCancelled,
    );
  } finally {
    if (ownsCombinedStores && !retainCombinedStoreOnExit) {
      try {
        await store.dispose();
      } finally {
        await contributionStore?.dispose();
      }
    }
  }
}
