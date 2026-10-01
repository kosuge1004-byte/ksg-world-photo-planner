import '../drizzle/cfa_drizzle_tiled_checkpoint.dart';
import 'dart:async';
import 'dart:math' as math;

import '../color/dng_d65_color_transform.dart';
import '../color/linear_rgb_color_transform.dart';
import '../color/raw_camera_color_profile.dart';
import '../drizzle/extract_green_luminance_from_mosaic.dart';
import '../drizzle/tiled_cfa_drizzle.dart';
import '../drizzle/parallel_robust_cfa_drizzle.dart';
import '../drizzle/tiled_robust_combine_cfa_drizzle.dart';
import '../engine/concurrency_policy.dart';
import '../engine/default_resource_reader.dart';
import '../engine/job_scheduler.dart';
import '../engine/prepare_master_calibration_frame.dart';
import '../engine/processing_job.dart';
import '../engine/raw_mosaic_calibration_job_executor.dart';
import '../engine/resource_snapshot.dart';
import '../export/dng_final_render_profile.dart';
import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';
import '../image/linear_rgb_tile_store.dart';
import '../models/processing_mode.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_file_probe.dart';
import '../raw/raw_metadata_probe.dart';
import '../registration/affine_sampling_transform.dart';
import '../registration/local_residual_correction.dart';
import '../registration/luminance_plane.dart';
import '../registration/star_detector.dart';
import '../registration/star_transform_estimator.dart';
import '../stacking/comprehensive_frame_quality_weight.dart';
import '../stacking/registration_quality_weight.dart';

/// Wires together every piece Work84-89 built into one working CFA-
/// domain-drizzle-based Milky Way stacking pipeline: decode and
/// calibrate every source frame *without* demosaicing
/// (`raw_mosaic_calibration_job_executor.dart`, Work89), detect stars
/// on a green-channel proxy extracted straight from each raw mosaic
/// (`extract_green_luminance_from_mosaic.dart`, Work88), register every
/// non-reference frame against the highest intrinsic-quality successfully-calibrated frame
/// (`star_detector.dart`/`star_transform_estimator.dart`, both already
/// existing), weigh each registered frame by how well it actually fit
/// (`registration_quality_weight.dart`, Work56 — built for the kappa-
/// sigma pipeline but never wired into this one until Work95, an image-
/// quality gap found and closed while reviewing this pipeline for
/// further improvements), and combine all frames — still in raw CFA
/// space, before any demosaicing — via the tiled, memory-bounded
/// drizzle combiner (`tiled_cfa_drizzle.dart`, Work87).
///
/// This is a **second, alternative Milky Way pipeline**, not a
/// replacement for `milky_way_pipeline.dart`'s existing demosaic-first,
/// kappa-sigma-combine approach — that pipeline is already wired into
/// the app's UI (`processing_progress_screen.dart`, Work65/67) and
/// remains untouched by this work. This one exists specifically to
/// exploit CFA-domain drizzle's own image-quality advantage over
/// demosaic-then-stack (see `cfa_drizzle.dart`'s own doc comment: raw
/// samples are combined once, demosaiced once, rather than demosaicing
/// every frame's own interpolation error into the stack individually)
/// — but it is not yet wired into the app UI, and its own output
/// (drizzled per-channel value/coverage planes, still needing a final
/// demosaic pass to become a normal dense RGB image) is one step short
/// of a viewable result. See "What's still not done" in
/// WORK90_PROGRESS.md.
///
/// This file has not been executed against the Dart SDK. Every module
/// it wires together already has its own dedicated test coverage; this
/// file's own new logic — the orchestration connecting them — has
/// direct test coverage in `test/cfa_drizzle_milky_way_pipeline_test.
/// dart` for the non-`JobScheduler` parts, following the same
/// testability split established in `milky_way_pipeline.dart` (Work54)
/// and its own doc comments' identical caveat about the `JobScheduler`-
/// driven decode stage.

/// Everything [runCfaDrizzleMilkyWayPipeline] needs to decode and
/// calibrate each source frame. Deliberately has no
/// `rgbTileStoreFactory`/`demosaicRegistry` fields, unlike `milky_way_
/// pipeline.dart`'s `MilkyWayFrameDecodingConfig` — this pipeline never
/// demosaics its input frames at all (see this module's own doc
/// comment).
final class CfaDrizzleMilkyWayDecodingConfig {
  const CfaDrizzleMilkyWayDecodingConfig({
    required this.decoderRegistry,
    this.probe = const RawFileProbe(),
    this.metadataProbe,
  });

  final RawDecoderRegistry decoderRegistry;
  final RawFileProbe probe;
  final RawMetadataProbe? metadataProbe;
}

/// Per-frame outcome, analogous to `milky_way_pipeline.dart`'s
/// `MilkyWayFrameDiagnostics`.
final class CfaDrizzleMilkyWayFrameDiagnostics {
  const CfaDrizzleMilkyWayFrameDiagnostics({
    required this.sourcePath,
    required this.included,
    this.excludedReason,
    this.detectedStarCount,
    this.rotationDegrees,
    this.rmsResidual,
    this.registrationWeight,
  });

  final String sourcePath;
  final bool included;
  final String? excludedReason;
  final int? detectedStarCount;
  final double? rotationDegrees;
  final double? rmsResidual;

  /// This frame's actual contribution weight during drizzle combining
  /// (Work95/190) — the reference frame has zero registration residual but
  /// still receives the same optional star-shape quality factor as every
  /// other frame; non-reference frames additionally include their measured
  /// registration residual, so a shakier registration contributes less.
  /// `null` for an excluded frame (it contributed nothing at all).
  final double? registrationWeight;
}

final class CfaDrizzleMilkyWayResult {
  const CfaDrizzleMilkyWayResult({
    required this.valueStore,
    required this.coverageStore,
    this.saturationCoverageStore,
    this.saturationDecisionCoverageStore,
    required this.frameDiagnostics,
    required this.referenceCfaPattern,
    required this.outputScale,
    this.outputColorTransform,
    this.postColorRenderProfile,
  });

  /// Drizzled per-channel value/coverage, still raw-CFA-domain output —
  /// see this module's own doc comment for why a final demosaic pass is
  /// still needed to become a normal dense RGB image, and why that pass
  /// is not yet wired in here.
  final LinearRgbTileStore valueStore;
  final LinearRgbTileStore coverageStore;
  final LinearRgbTileStore? saturationCoverageStore;

  /// In the robust-rejection path, this stores the pre-rejection
  /// non-saturated coverage used only for the saturation-fraction decision.
  /// The main [coverageStore] remains survivor-only so rejected samples do
  /// not contribute to the reconstructed signal.
  final LinearRgbTileStore? saturationDecisionCoverageStore;
  final List<CfaDrizzleMilkyWayFrameDiagnostics> frameDiagnostics;

  /// The reference frame's own CFA pattern (Work112) — needed by
  /// `reconstructNativeCfaMosaicFromDrizzle`/`...Tiled` to know which
  /// channel is "native" at each output position; only meaningful when
  /// [outputScale] is exactly `1` (see that module's own doc comment
  /// for why).
  final CfaPattern referenceCfaPattern;
  final double outputScale;
  final LinearRgbColorTransform? outputColorTransform;

  /// DNG render stages selected atomically from the same representative RAW
  /// whose camera matrix anchors [outputColorTransform]. The linear transform
  /// inside this profile is intentionally null because CFA drizzle already
  /// applies the consensus transform before export.
  final DngFinalRenderProfile? postColorRenderProfile;
}

/// Thrown when fewer than [minRegisteredFrames] frames end up usable —
/// mirroring `milky_way_pipeline.dart`'s `MilkyWayRegistrationFailed`.
class CfaDrizzleMilkyWayRegistrationFailed implements Exception {
  const CfaDrizzleMilkyWayRegistrationFailed(this.diagnostics);

  final List<CfaDrizzleMilkyWayFrameDiagnostics> diagnostics;

  @override
  String toString() {
    final int includedCount = diagnostics
        .where((CfaDrizzleMilkyWayFrameDiagnostics d) => d.included)
        .length;
    return 'CfaDrizzleMilkyWayRegistrationFailed: only $includedCount of '
        '${diagnostics.length} frames were usable.';
  }
}

/// Decodes and calibrates (but does not demosaic) every frame in
/// [sourcePaths], then hands off to [registerAndDrizzleCalibratedMosaics].
///
/// Like `milky_way_pipeline.dart`'s `runMilkyWayPipeline`, a single
/// frame's decode/calibration failure does not fail the whole batch —
/// that frame is simply excluded (recorded in
/// [CfaDrizzleMilkyWayFrameDiagnostics]).
///
/// - [masterDark] (Work97): an optional master dark frame
///   (`dark_frame_subtraction.dart`'s `computeMasterDark`, Work96) —
///   when supplied, applied to every source frame right after black-
///   level correction and before white-level normalization (see
///   `createRawMosaicCalibrationPipelineWithDarkSubtraction`'s own doc
///   comment for why that specific ordering matters). `null` (the
///   default) skips dark subtraction entirely, exactly as before this
///   parameter existed.
/// - [masterFlat] (Work98): an optional master flat frame
///   (`flat_field_calibration.dart`'s `computeMasterFlat`) — when
///   supplied, applied to every source frame right after camera white
///   balance and before defect pixel correction (see
///   `createRawMosaicCalibrationPipelineWithCorrections`'s own doc
///   comment for why). `null` (the default) skips flat-field correction
///   entirely.
/// - [darkFramePaths]/[flatFramePaths] (Work105): an alternative to
///   [masterDark]/[masterFlat] for callers that have raw dark/flat
///   *files* rather than an already-prepared [LinearRawMosaic] — these
///   are resolved into master frames via `prepareMasterDark`/
///   `prepareMasterFlat` (Work104) before any light frame decoding
///   starts, using the same [decodingConfig] (decoder registry, probe)
///   the light frames themselves use. Supplying both a direct value
///   (`masterDark`/`masterFlat`) and its corresponding paths list is an
///   [ArgumentError] — an ambiguous "which one wins" situation this
///   function refuses to silently resolve one way or the other.
/// [flatFramePaths] frames are dark-subtracted against whichever of
/// [masterDark]/[darkFramePaths] resolved to an actual master dark
/// before being combined — matching `prepareMasterFlat`'s own
/// documented caveat that flats are typically shot at different
/// exposure settings than the light frames, so this is only correct
/// when the *same* dark frame set genuinely applies to both; a caller
/// whose flats need a separately-exposed dark should prepare the master
/// flat themselves (via `prepareMasterFlat` directly) and pass it as
/// [masterFlat] instead of [flatFramePaths].

List<DetectedStar> _excludeSaturationInfluencedRegistrationStars({
  required List<DetectedStar> stars,
  required RawSaturationMask? invalidMask,
  required int width,
  required int height,
}) {
  if (invalidMask == null || invalidMask.isEmpty) return stars;
  if (invalidMask.pixelCount != width * height) {
    throw ArgumentError(
      'Registration saturation mask dimensions do not match luminance plane.',
    );
  }
  const int detectorWindowRadius = 4;
  bool touchesInvalid(DetectedStar star) {
    final int centerX = star.x.round();
    final int centerY = star.y.round();
    final int left =
        (centerX - detectorWindowRadius).clamp(0, width - 1).toInt();
    final int right =
        (centerX + detectorWindowRadius).clamp(0, width - 1).toInt();
    final int top =
        (centerY - detectorWindowRadius).clamp(0, height - 1).toInt();
    final int bottom =
        (centerY + detectorWindowRadius).clamp(0, height - 1).toInt();
    for (int y = top; y <= bottom; y++) {
      int index = y * width + left;
      for (int x = left; x <= right; x++, index++) {
        if (invalidMask.isSaturatedIndex(index)) return true;
      }
    }
    return false;
  }

  return <DetectedStar>[
    for (final DetectedStar star in stars)
      if (!touchesInvalid(star)) star,
  ];
}

Future<CfaDrizzleMilkyWayResult> runCfaDrizzleMilkyWayPipeline({
  required List<String> sourcePaths,
  required CfaDrizzleMilkyWayDecodingConfig decodingConfig,
  required LinearRgbTileStoreFactory valueStoreFactory,
  required LinearRgbTileStoreFactory coverageStoreFactory,
  LinearRawMosaic? masterDark,
  LinearRawMosaic? masterFlat,
  List<String>? darkFramePaths,
  List<String>? flatFramePaths,
  double starDetectorThresholdSigma = 6,
  double transformToleranceRadius = 3,
  int minRegisteredFrames = 2,
  int tileSize = 512,
  double outputScale = 2,
  double pixfrac = 0.7,
  double residualHalfWeightRadius = 1.5,
  double minimumRegistrationWeight = 0.05,
  bool useComprehensiveFrameWeighting = true,
  double roundnessHalfWeight = 0.3,
  double countShortfallHalfWeightFraction = 0.5,
  bool usePsfRefinement = true,
  bool enableLocalRegistration = true,
  double localRegistrationMinimumMatchesPerCoefficient = 4,
  double localRegistrationMaximumCorrectionMagnitude = 3,
  bool enableRobustRejection = true,
  double rejectionMinCoverage = 1e-6,
  int rejectionMinFramesForRejection = 4,
  double rejectionSigmaLow = 4,
  double rejectionSigmaHigh = 3,
  ConcurrencyPolicy concurrencyPolicy = fullFrameRawConcurrencyPolicy,
  Future<ResourceSnapshot> Function() resourceReader =
      readDefaultResourceSnapshot,
  void Function(double progress)? reportProgress,
  void Function({
    required String stage,
    required int current,
    required int total,
  })? reportStatus,
  bool Function()? isCancelled,
  CfaDrizzleTiledCheckpointStore? stageCheckpoint,
}) async {
  if (sourcePaths.length < 2) {
    throw ArgumentError.value(
      sourcePaths,
      'sourcePaths',
      'At least 2 frames are required for a Milky Way stack.',
    );
  }
  if (masterDark != null && darkFramePaths != null) {
    throw ArgumentError(
      'Supply either masterDark or darkFramePaths, not both.',
    );
  }
  if (masterFlat != null && flatFramePaths != null) {
    throw ArgumentError(
      'Supply either masterFlat or flatFramePaths, not both.',
    );
  }
  FileBackedLinearRawMosaicStore? effectiveMasterDarkStore;
  FileBackedLinearRawMosaicStore? effectiveMasterFlatStore;
  try {
    effectiveMasterDarkStore = darkFramePaths != null
        ? await prepareMasterDarkStore(
            sourcePaths: darkFramePaths,
            decoderRegistry: decodingConfig.decoderRegistry,
            probe: decodingConfig.probe,
            metadataProbe: decodingConfig.metadataProbe,
          )
        : null;
    effectiveMasterFlatStore = flatFramePaths != null
        ? await prepareMasterFlatStore(
            sourcePaths: flatFramePaths,
            decoderRegistry: decodingConfig.decoderRegistry,
            probe: decodingConfig.probe,
            metadataProbe: decodingConfig.metadataProbe,
            darkStoreToSubtract: effectiveMasterDarkStore,
          )
        : null;
  } on Object {
    await effectiveMasterFlatStore?.dispose();
    await effectiveMasterDarkStore?.dispose();
    rethrow;
  }
  final LinearRawMosaic? effectiveMasterDark =
      darkFramePaths == null ? masterDark : null;
  final LinearRawMosaic? effectiveMasterFlat =
      flatFramePaths == null ? masterFlat : null;
  if (isCancelled?.call() ?? false) {
    await effectiveMasterFlatStore?.dispose();
    await effectiveMasterDarkStore?.dispose();
    throw const CfaDrizzleTiledCancelled();
  }

  final List<LinearRawMosaic?> mosaics = List<LinearRawMosaic?>.filled(
    sourcePaths.length,
    null,
  );
  final List<FileBackedLinearRawMosaicStore?> mosaicStores =
      List<FileBackedLinearRawMosaicStore?>.filled(sourcePaths.length, null);
  final Map<int, Object?> decodeFailures = <int, Object?>{};
  final List<RawCameraColorProfile?> colorProfiles =
      List<RawCameraColorProfile?>.filled(sourcePaths.length, null);
  final List<RawFrameMetadata?> renderMetadata =
      List<RawFrameMetadata?>.filled(sourcePaths.length, null);

  final JobScheduler scheduler = JobScheduler(
    executor: (ProcessingJob job, void Function(double) frameProgress) async {
      final int frameIndex = int.parse(job.id.split('#').last);
      await runRawMosaicCalibrationJob(
        job,
        frameProgress,
        probe: decodingConfig.probe,
        metadataProbe: decodingConfig.metadataProbe,
        decoderRegistry: decodingConfig.decoderRegistry,
        masterDark: effectiveMasterDark,
        masterFlat: effectiveMasterFlat,
        masterDarkStore: effectiveMasterDarkStore,
        masterFlatStore: effectiveMasterFlatStore,
        preferStreamedRawCalibration: true,
        onMosaicStoreReady: (FileBackedLinearRawMosaicStore store) {
          mosaicStores[frameIndex] = store;
        },
        onMosaicReady: (LinearRawMosaic mosaic) async {
          // Compatibility fallback for RAWs that still require in-memory
          // ActiveArea/orientation normalization or defect detection.
          final FileBackedLinearRawMosaicStore store =
              await FileBackedLinearRawMosaicStore.createTemporary(
            width: mosaic.width,
            height: mosaic.height,
            cfaPattern: mosaic.cfaPattern,
          );
          try {
            await store.writeFull(mosaic);
            mosaicStores[frameIndex] = store;
          } on Object {
            await store.dispose();
            rethrow;
          }
        },
        onColorProfileReady: (RawCameraColorProfile? profile) {
          colorProfiles[frameIndex] = profile;
        },
        onRenderMetadataReady: (RawFrameMetadata metadata, CfaPattern _) {
          renderMetadata[frameIndex] = metadata;
        },
      );
      // Same completion-first rationale as Work279's tile cooldown, applied
      // to this earlier per-frame decode/calibration stage. Does not change
      // any pixel calculation.
      if (sourcePaths.length >= 8) {
        await Future<void>.delayed(
          Duration(seconds: sourcePaths.length >= 32 ? 4 : 2),
        );
      }
    },
    resourceReader: resourceReader,
    policy: concurrencyPolicy,
  );

  final List<ProcessingJob> jobs = <ProcessingJob>[
    for (int index = 0; index < sourcePaths.length; index++)
      ProcessingJob(
        id: 'cfa-drizzle-milky-way-frame#$index',
        mode: ProcessingMode.milkyWay,
        sourcePath: sourcePaths[index],
      ),
  ];
  reportStatus?.call(
    stage: 'RAW解析・較正',
    current: 0,
    total: sourcePaths.length,
  );
  scheduler.enqueueAll(jobs);
  try {
    await scheduler.waitUntilIdle();
    reportStatus?.call(
      stage: 'RAW解析・較正',
      current: sourcePaths.length,
      total: sourcePaths.length,
    );
  } finally {
    await scheduler.dispose();
    await effectiveMasterFlatStore?.dispose();
    await effectiveMasterDarkStore?.dispose();
  }

  for (int index = 0; index < jobs.length; index++) {
    final ProcessingJob job = jobs[index];
    if (job.state == ProcessingJobState.failed) {
      decodeFailures[index] = job.error;
    } else if (job.state != ProcessingJobState.completed) {
      decodeFailures[index] =
          StateError('Frame ended in unexpected state ${job.state}.');
    }
  }

  return registerAndDrizzleCalibratedMosaics(
    stageCheckpoint: stageCheckpoint,
    sourcePaths: sourcePaths,
    mosaics: mosaics,
    preparedMosaicStores: mosaicStores,
    decodeFailures: decodeFailures,
    colorProfiles: colorProfiles,
    renderMetadata: renderMetadata,
    valueStoreFactory: valueStoreFactory,
    coverageStoreFactory: coverageStoreFactory,
    starDetectorThresholdSigma: starDetectorThresholdSigma,
    transformToleranceRadius: transformToleranceRadius,
    minRegisteredFrames: minRegisteredFrames,
    tileSize: tileSize,
    outputScale: outputScale,
    pixfrac: pixfrac,
    residualHalfWeightRadius: residualHalfWeightRadius,
    minimumRegistrationWeight: minimumRegistrationWeight,
    useComprehensiveFrameWeighting: useComprehensiveFrameWeighting,
    roundnessHalfWeight: roundnessHalfWeight,
    countShortfallHalfWeightFraction: countShortfallHalfWeightFraction,
    usePsfRefinement: usePsfRefinement,
    enableLocalRegistration: enableLocalRegistration,
    localRegistrationMinimumMatchesPerCoefficient:
        localRegistrationMinimumMatchesPerCoefficient,
    localRegistrationMaximumCorrectionMagnitude:
        localRegistrationMaximumCorrectionMagnitude,
    enableRobustRejection: enableRobustRejection,
    rejectionMinCoverage: rejectionMinCoverage,
    rejectionMinFramesForRejection: rejectionMinFramesForRejection,
    rejectionSigmaLow: rejectionSigmaLow,
    rejectionSigmaHigh: rejectionSigmaHigh,
    isCancelled: isCancelled,
    reportProgress: reportProgress,
    reportStatus: reportStatus,
  );
}

/// Registers and drizzle-combines already-decoded/calibrated [mosaics]
/// (any entry may be `null`, meaning that frame failed — see
/// [decodeFailures]).
///
/// Split out from [runCfaDrizzleMilkyWayPipeline] deliberately, matching
/// `milky_way_pipeline.dart`'s `registerAndCombineDecodedFrames`: this
/// is the part with genuinely new orchestration logic worth testing
/// directly against hand-built fake mosaics, independent of
/// `JobScheduler`-driven decode orchestration.
Future<CfaDrizzleMilkyWayResult> registerAndDrizzleCalibratedMosaics({
  required List<String> sourcePaths,
  required List<LinearRawMosaic?> mosaics,
  List<FileBackedLinearRawMosaicStore?>? preparedMosaicStores,
  required Map<int, Object?> decodeFailures,
  List<RawCameraColorProfile?>? colorProfiles,
  List<RawFrameMetadata?>? renderMetadata,
  required LinearRgbTileStoreFactory valueStoreFactory,
  required LinearRgbTileStoreFactory coverageStoreFactory,
  double starDetectorThresholdSigma = 6,
  double transformToleranceRadius = 3,
  int minRegisteredFrames = 2,
  int tileSize = 512,
  double outputScale = 2,
  double pixfrac = 0.7,
  double residualHalfWeightRadius = 1.5,
  double minimumRegistrationWeight = 0.05,
  bool useComprehensiveFrameWeighting = false,
  double roundnessHalfWeight = 0.3,
  double countShortfallHalfWeightFraction = 0.5,
  bool usePsfRefinement = false,
  bool enableLocalRegistration = true,
  double localRegistrationMinimumMatchesPerCoefficient = 4,
  double localRegistrationMaximumCorrectionMagnitude = 3,
  bool enableRobustRejection = false,
  double rejectionMinCoverage = 1e-6,
  int rejectionMinFramesForRejection = 4,
  double rejectionSigmaLow = 4,
  double rejectionSigmaHigh = 3,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
  void Function({
    required String stage,
    required int current,
    required int total,
  })? reportStatus,
  CfaDrizzleTiledCheckpointStore? stageCheckpoint,
}) async {
  if (sourcePaths.length != mosaics.length) {
    throw ArgumentError(
      'sourcePaths and mosaics must have the same length.',
    );
  }
  if (preparedMosaicStores != null &&
      preparedMosaicStores.length != mosaics.length) {
    throw ArgumentError(
      'preparedMosaicStores and mosaics must have the same length.',
    );
  }
  if (colorProfiles != null && colorProfiles.length != mosaics.length) {
    throw ArgumentError(
      'colorProfiles and mosaics must have the same length.',
    );
  }
  if (renderMetadata != null && renderMetadata.length != mosaics.length) {
    throw ArgumentError(
      'renderMetadata and mosaics must have the same length.',
    );
  }

  final List<LinearRawMosaic?> effectiveMosaics =
      List<LinearRawMosaic?>.from(mosaics);
  final List<FileBackedLinearRawMosaicStore?> effectiveStores =
      preparedMosaicStores == null
          ? List<FileBackedLinearRawMosaicStore?>.filled(mosaics.length, null)
          : List<FileBackedLinearRawMosaicStore?>.from(preparedMosaicStores);
  final List<List<double>?> phaseScalesByFrame =
      List<List<double>?>.filled(mosaics.length, null);
  final Set<FileBackedLinearRawMosaicStore> ownedMosaicStores =
      <FileBackedLinearRawMosaicStore>{
    ...?preparedMosaicStores?.whereType<FileBackedLinearRawMosaicStore>(),
  };
  try {
    final Map<int, Object?> effectiveFailures =
        Map<int, Object?>.from(decodeFailures);
    LinearRgbColorTransform? outputColorTransform;
    DngFinalRenderProfile? postColorRenderProfile;
    if (colorProfiles != null) {
      final RawCameraColorConsensus? consensus = selectRawCameraColorConsensus(
        profiles: colorProfiles,
        patterns: <CfaPattern?>[
          for (int index = 0; index < effectiveMosaics.length; index++)
            effectiveStores[index]?.cfaPattern ??
                effectiveMosaics[index]?.cfaPattern,
        ],
      );
      if (consensus != null) {
        final int profileReferenceIndex = consensus.representativeIndex;
        final RawCameraColorProfile referenceProfile = consensus.profile;
        final CfaPattern referencePattern =
            (effectiveStores[profileReferenceIndex]?.cfaPattern ??
                effectiveMosaics[profileReferenceIndex]!.cfaPattern);
        final RawFrameMetadata? representativeMetadata =
            renderMetadata?[profileReferenceIndex];
        final bool requiresDngProfileWorkingSpace =
            representativeMetadata?.profileHueSatMap != null ||
                representativeMetadata?.profileLookTable != null;
        outputColorTransform = requiresDngProfileWorkingSpace
            ? linearProPhotoTransformFromDngD65(
                xyzToCameraD65: referenceProfile.d65XyzToCamera,
                cameraWhiteBalanceRgb: referenceProfile
                    .normalizedRgbWhiteBalance(referencePattern),
              )
            : referenceProfile.outputTransform(referencePattern);
        if (representativeMetadata != null) {
          postColorRenderProfile = DngFinalRenderProfile.postColorFromMetadata(
            sourceId: sourcePaths[profileReferenceIndex],
            metadata: representativeMetadata,
            inputIsLinearProPhoto: requiresDngProfileWorkingSpace,
          );
        }
        for (int index = 0; index < effectiveMosaics.length; index++) {
          final CfaPattern? pattern = effectiveStores[index]?.cfaPattern ??
              effectiveMosaics[index]?.cfaPattern;
          if (pattern == null) continue;
          final RawCameraColorProfile? profile = colorProfiles[index];
          if (profile == null || !consensus.memberIndices.contains(index)) {
            effectiveMosaics[index] = null;
            effectiveStores[index] = null;
            effectiveFailures[index] = StateError(
              profile == null
                  ? 'color profile missing while other frames provide one'
                  : 'camera color matrix differs from the reference frame',
            );
            continue;
          }
          phaseScalesByFrame[index] = whiteBalanceHarmonizationPhaseScales(
            source: profile,
            target: referenceProfile,
            sourcePattern: pattern,
            targetPattern: referencePattern,
          );
        }
      }
    }

    final List<CfaDrizzleMilkyWayFrameDiagnostics> diagnostics =
        List<CfaDrizzleMilkyWayFrameDiagnostics>.filled(
      sourcePaths.length,
      const CfaDrizzleMilkyWayFrameDiagnostics(sourcePath: '', included: false),
    );

    final Map<int, List<DetectedStar>> detectedStarsByFrame =
        <int, List<DetectedStar>>{};
    for (int index = 0; index < effectiveMosaics.length; index++) {
      reportStatus?.call(
        stage: '星検出・参照フレーム選択',
        current: index,
        total: effectiveMosaics.length,
      );
      LinearRawMosaic? mosaic = effectiveMosaics[index];
      final FileBackedLinearRawMosaicStore? preparedStore =
          effectiveStores[index];
      if (mosaic == null && preparedStore == null) continue;
      try {
        final List<double>? phaseScales = phaseScalesByFrame[index];
        late final LuminancePlane green;
        late final RawSaturationMask? invalid;

        if (preparedStore != null && mosaic == null) {
          final FileBackedGreenLuminanceResult extracted =
              await extractGreenLuminanceFromFileBackedMosaic(
            store: preparedStore,
            phaseScales: phaseScales,
            isCancelled: isCancelled,
          );
          green = extracted.luminance;
          invalid = extracted.saturationInfluenceMask;
        } else {
          mosaic ??= await preparedStore!.readFull();
          if (phaseScales != null) {
            _applyPhaseScalesInPlace(mosaic, phaseScales);
          }
          green = extractGreenLuminanceFromMosaic(mosaic);
          invalid = greenLuminanceSaturationInfluenceMask(mosaic);
        }

        detectedStarsByFrame[index] =
            _excludeSaturationInfluencedRegistrationStars(
          stars: detectStars(
            green,
            thresholdSigma: starDetectorThresholdSigma,
            usePsfRefinement: usePsfRefinement,
          ),
          invalidMask: invalid,
          width: green.width,
          height: green.height,
        );
        if (preparedStore == null) {
          final LinearRawMosaic inMemoryMosaic = mosaic!;
          final FileBackedLinearRawMosaicStore store =
              await FileBackedLinearRawMosaicStore.createTemporary(
            width: inMemoryMosaic.width,
            height: inMemoryMosaic.height,
            cfaPattern: inMemoryMosaic.cfaPattern,
          );
          try {
            await store.writeFull(inMemoryMosaic);
            effectiveStores[index] = store;
            ownedMosaicStores.add(store);
            // The harmonization was baked into this newly-created store.
            phaseScalesByFrame[index] = null;
          } on Object {
            await store.dispose();
            rethrow;
          }
        }
      } on Object catch (error) {
        final FileBackedLinearRawMosaicStore? failedStore =
            effectiveStores[index];
        effectiveStores[index] = null;
        if (failedStore != null && !identical(failedStore, preparedStore)) {
          await failedStore.dispose();
        }
        diagnostics[index] = CfaDrizzleMilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: false,
          excludedReason: 'star detection failed: $error',
        );
      } finally {
        // Release the only materialized full-resolution input before loading the
        // next frame. The committed file-backed store remains authoritative.
        effectiveMosaics[index] = null;
      }
    }

    if (detectedStarsByFrame.isEmpty) {
      for (int index = 0; index < sourcePaths.length; index++) {
        if (diagnostics[index].sourcePath.isNotEmpty) continue;
        diagnostics[index] = CfaDrizzleMilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: false,
          excludedReason: effectiveFailures.containsKey(index)
              ? 'decode failed: ${effectiveFailures[index]}'
              : 'decode did not complete',
        );
      }
      throw CfaDrizzleMilkyWayRegistrationFailed(diagnostics);
    }

    final int bestObservedStarCount = detectedStarsByFrame.values
        .map((List<DetectedStar> stars) => stars.length)
        .reduce(math.max);
    // Rank reference candidates strictly by the already-validated intrinsic
    // image-quality score. Work194 adds only a viability gate: if the best
    // candidate cannot register enough total frames to satisfy
    // minRegisteredFrames, try the next intrinsic-quality candidate instead of
    // failing the entire stack immediately. The first viable candidate wins, so
    // the normal case (best-quality candidate is viable) is bit-for-bit
    // unchanged downstream.
    final Map<int, double> referenceQualityByIndex = <int, double>{};
    final List<int> rankedReferenceIndices = detectedStarsByFrame.keys.toList();
    for (final int index in rankedReferenceIndices) {
      final List<DetectedStar> stars = detectedStarsByFrame[index]!;
      referenceQualityByIndex[index] = intrinsicReferenceFrameQualityWeight(
        roundnessValues: <double>[
          for (final DetectedStar star in stars) star.roundness,
        ],
        detectedStarCount: stars.length,
        bestObservedStarCount: bestObservedStarCount,
        roundnessHalfWeight: roundnessHalfWeight,
        countShortfallHalfWeightFraction: countShortfallHalfWeightFraction,
        minimumWeight: minimumRegistrationWeight,
      );
    }
    rankedReferenceIndices.sort((int a, int b) {
      final int qualityOrder = referenceQualityByIndex[b]!.compareTo(
        referenceQualityByIndex[a]!,
      );
      if (qualityOrder != 0) return qualityOrder;
      final int countOrder = detectedStarsByFrame[b]!.length.compareTo(
            detectedStarsByFrame[a]!.length,
          );
      if (countOrder != 0) return countOrder;
      return a.compareTo(b);
    });

    int referenceIndex = rankedReferenceIndices.first;
    if (minRegisteredFrames > 1 && rankedReferenceIndices.length > 1) {
      for (final int candidateIndex in rankedReferenceIndices) {
        final List<DetectedStar> candidateStars =
            detectedStarsByFrame[candidateIndex]!;
        int registrableFrameCount = 1; // the reference frame itself
        for (final MapEntry<int, List<DetectedStar>> target
            in detectedStarsByFrame.entries) {
          if (target.key == candidateIndex) continue;
          try {
            estimateSimilarityTransform(
              candidateStars,
              target.value,
              toleranceRadius: transformToleranceRadius,
            );
            registrableFrameCount += 1;
            if (registrableFrameCount >= minRegisteredFrames) break;
          } on Object {
            // A failed pair only means this candidate cannot use that target.
            // The actual registration pass still owns diagnostics.
          }
        }
        if (registrableFrameCount >= minRegisteredFrames) {
          referenceIndex = candidateIndex;
          break;
        }
      }
    }
    if (referenceIndex < 0) {
      throw StateError('Failed to select a CFA drizzle reference frame.');
    }
    final List<DetectedStar> referenceStars =
        detectedStarsByFrame[referenceIndex]!;
    final double referenceRegistrationWeight = registrationQualityWeight(
      0,
      residualHalfWeightRadius: residualHalfWeightRadius,
      minimumWeight: minimumRegistrationWeight,
    );
    final double referenceWeight = useComprehensiveFrameWeighting
        ? comprehensiveFrameQualityWeight(
            registrationWeight: referenceRegistrationWeight,
            roundnessValues: <double>[
              for (final DetectedStar star in referenceStars) star.roundness,
            ],
            detectedStarCount: referenceStars.length,
            referenceStarCount: bestObservedStarCount,
            roundnessHalfWeight: roundnessHalfWeight,
            countShortfallHalfWeightFraction: countShortfallHalfWeightFraction,
            minimumWeight: minimumRegistrationWeight,
          )
        : referenceRegistrationWeight;
    diagnostics[referenceIndex] = CfaDrizzleMilkyWayFrameDiagnostics(
      sourcePath: sourcePaths[referenceIndex],
      included: true,
      detectedStarCount: referenceStars.length,
      rotationDegrees: 0,
      rmsResidual: 0,
      registrationWeight: referenceWeight,
    );

    final List<int> includedIndices = <int>[referenceIndex];
    final List<StarSimilarityTransformEstimate?> transformsByIncludedIndex =
        <StarSimilarityTransformEstimate?>[null];
    final List<double> weightsByIncludedIndex = <double>[referenceWeight];
    final List<LocalResidualCorrectionField?>
        localCorrectionFieldsByIncludedIndex = <LocalResidualCorrectionField?>[
      null
    ];

    for (int index = 0; index < effectiveStores.length; index++) {
      reportStatus?.call(
        stage: '高精度位置合わせ',
        current: index,
        total: effectiveStores.length,
      );
      if (index == referenceIndex) continue;
      final FileBackedLinearRawMosaicStore? mosaicStore =
          effectiveStores[index];
      if (mosaicStore == null) {
        diagnostics[index] = CfaDrizzleMilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: false,
          excludedReason: effectiveFailures.containsKey(index)
              ? 'decode failed: ${effectiveFailures[index]}'
              : 'decode did not complete',
        );
        continue;
      }
      if (isCancelled?.call() ?? false) {
        throw const CfaDrizzleTiledCancelled();
      }
      try {
        final List<DetectedStar>? targetStars = detectedStarsByFrame[index];
        if (targetStars == null) {
          continue;
        }
        final StarSimilarityTransformEstimate estimate =
            estimateSimilarityTransform(
          referenceStars,
          targetStars,
          toleranceRadius: transformToleranceRadius,
        );
        // enableLocalRegistration=trueの場合、大域変換の残差(Work120の
        // buildLocalResidualMatches)から局所補正場(Work119)をフィットする。
        final AffineSamplingTransform globalTransform =
            AffineSamplingTransform.similarity(
          rotationDegrees: estimate.rotationDegrees,
          sourceOffsetX: estimate.sourceOffsetX,
          sourceOffsetY: estimate.sourceOffsetY,
          centerX: estimate.centerX,
          centerY: estimate.centerY,
        );
        final List<LocalResidualMatch> localResidualMatches =
            buildLocalResidualMatches(
          matches: estimate.matches,
          referenceStars: referenceStars,
          targetStars: targetStars,
          globalTransform: globalTransform,
        );
        final LocalResidualCorrectionField? localCorrectionField =
            enableLocalRegistration
                ? fitLocalResidualCorrectionField(
                    localResidualMatches,
                    minimumMatchesPerCoefficient:
                        localRegistrationMinimumMatchesPerCoefficient,
                    maximumCorrectionMagnitude:
                        localRegistrationMaximumCorrectionMagnitude,
                  )
                : null;
        final double effectiveRmsResidual = localResidualCorrectedRms(
          localResidualMatches,
          localCorrectionField,
        );
        final double weight = registrationQualityWeight(
          effectiveRmsResidual,
          residualHalfWeightRadius: residualHalfWeightRadius,
          minimumWeight: minimumRegistrationWeight,
        );
        // useComprehensiveFrameWeighting=trueの場合、位置合わせ残差だけ
        // でなく、検出された星の形状(丸さ)・検出数(参照フレームとの
        // 比較)も加味した複合品質重みへ差し替える(Work116)。既定の
        // falseを明示した場合だけ、registrationQualityWeightのみを使う。
        final double effectiveWeight = useComprehensiveFrameWeighting
            ? comprehensiveFrameQualityWeight(
                registrationWeight: weight,
                roundnessValues: <double>[
                  for (final DetectedStar star in targetStars) star.roundness,
                ],
                detectedStarCount: targetStars.length,
                referenceStarCount: bestObservedStarCount,
                roundnessHalfWeight: roundnessHalfWeight,
                countShortfallHalfWeightFraction:
                    countShortfallHalfWeightFraction,
                minimumWeight: minimumRegistrationWeight,
              )
            : weight;
        diagnostics[index] = CfaDrizzleMilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: true,
          detectedStarCount: targetStars.length,
          rotationDegrees: estimate.rotationDegrees,
          rmsResidual: effectiveRmsResidual,
          registrationWeight: effectiveWeight,
        );
        includedIndices.add(index);
        transformsByIncludedIndex.add(estimate);
        weightsByIncludedIndex.add(effectiveWeight);
        localCorrectionFieldsByIncludedIndex.add(localCorrectionField);
      } on Object catch (error) {
        diagnostics[index] = CfaDrizzleMilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: false,
          excludedReason: 'registration failed: $error',
        );
      }
    }

    if (includedIndices.length < minRegisteredFrames) {
      throw CfaDrizzleMilkyWayRegistrationFailed(diagnostics);
    }

    final FileBackedLinearRawMosaicStore referenceStore =
        effectiveStores[referenceIndex]!;
    final int nativeWidth = referenceStore.width;
    final int nativeHeight = referenceStore.height;
    final int outputWidth = (nativeWidth * outputScale).round();
    final int outputHeight = (nativeHeight * outputScale).round();

    final List<CfaDrizzleTiledFrame> drizzleFrames = <CfaDrizzleTiledFrame>[];
    for (int i = 0; i < includedIndices.length; i++) {
      final int frameIndex = includedIndices[i];
      final FileBackedLinearRawMosaicStore store = effectiveStores[frameIndex]!;
      drizzleFrames.add(
        CfaDrizzleTiledFrame(
          mosaicStore: store,
          transformEstimate: transformsByIncludedIndex[i],
          weight: weightsByIncludedIndex[i],
          localCorrectionField: localCorrectionFieldsByIncludedIndex[i],
          phaseScales: phaseScalesByFrame[frameIndex],
        ),
      );
    }

    stageCheckpoint?.bindInputs({
      'scale': outputScale,
      'pixfrac': pixfrac,
      'robust': enableRobustRejection,
      'minCoverage': rejectionMinCoverage,
      'minFrames': rejectionMinFramesForRejection,
      'sigmaLow': rejectionSigmaLow,
      'sigmaHigh': rejectionSigmaHigh,
      'frames': [
        for (final f in drizzleFrames)
          {
            'weight': f.weight,
            'phases': f.phaseScales,
            'transform': f.transformEstimate == null
                ? null
                : [
                    f.transformEstimate!.rotationDegrees,
                    f.transformEstimate!.sourceOffsetX,
                    f.transformEstimate!.sourceOffsetY,
                    f.transformEstimate!.centerX,
                    f.transformEstimate!.centerY
                  ],
            'local': f.localCorrectionField?.toCheckpointJson(),
          }
      ],
    });
    final CfaDrizzleTiledResult drizzled;
    LinearRgbTileStore? saturationDecisionCoverageStore;
    if (enableRobustRejection) {
      reportStatus?.call(
        stage: 'CFA Drizzle・ロバスト外れ値除去',
        current: 0,
        total: drizzleFrames.length,
      );
      final int streamingTileSize =
          drizzleFrames.length >= 8 ? math.min(tileSize, 64) : tileSize;
      final StreamingRobustCfaDrizzleResult streamed =
          await robustDrizzleCfaFramesParallelTiled(
        stageCheckpoint: stageCheckpoint,
        frames: drizzleFrames,
        outputWidth: outputWidth,
        outputHeight: outputHeight,
        valueStoreFactory: valueStoreFactory,
        coverageStoreFactory: coverageStoreFactory,
        tileSize: streamingTileSize,
        // Highest quality stacks are deliberately completion-first on phones.
        // One 64 px tile at a time bounds transient memory and avoids sustained
        // multi-core heat. The cooldown yields to Android between committed
        // tiles without changing any pixel calculation.
        maximumWorkers: drizzleFrames.length >= 8 ? 1 : 2,
        tileCooldown: drizzleFrames.length >= 8
            ? const Duration(milliseconds: 24)
            : Duration.zero,
        outputScale: outputScale,
        pixfrac: pixfrac,
        minCoverage: rejectionMinCoverage,
        minFramesForRejection: rejectionMinFramesForRejection,
        sigmaLow: rejectionSigmaLow,
        sigmaHigh: rejectionSigmaHigh,
        isCancelled: isCancelled,
        reportProgress: reportProgress,
      );
      drizzled = CfaDrizzleTiledResult(
        valueStore: streamed.valueStore,
        coverageStore: streamed.coverageStore,
        saturationCoverageStore: streamed.saturationCoverageStore,
      );
      saturationDecisionCoverageStore = streamed.preRejectionCoverageStore;
    } else {
      reportStatus?.call(
        stage: 'CFA Drizzle',
        current: 0,
        total: drizzleFrames.length,
      );
      drizzled = await drizzleCfaTiled(
        stageCheckpoint: stageCheckpoint,
        frames: drizzleFrames,
        outputWidth: outputWidth,
        outputHeight: outputHeight,
        valueStoreFactory: valueStoreFactory,
        coverageStoreFactory: coverageStoreFactory,
        tileSize: tileSize,
        outputScale: outputScale,
        pixfrac: pixfrac,
        isCancelled: isCancelled,
        reportProgress: reportProgress,
      );
    }

    return CfaDrizzleMilkyWayResult(
      valueStore: drizzled.valueStore,
      coverageStore: drizzled.coverageStore,
      saturationCoverageStore: drizzled.saturationCoverageStore,
      saturationDecisionCoverageStore: saturationDecisionCoverageStore,
      frameDiagnostics: diagnostics,
      referenceCfaPattern: referenceStore.cfaPattern,
      outputScale: outputScale,
      outputColorTransform: outputColorTransform,
      postColorRenderProfile: postColorRenderProfile,
    );
  } finally {
    await _disposeRawMosaicStoresBestEffort(ownedMosaicStores);
  }
}

void _applyPhaseScalesInPlace(
  LinearRawMosaic mosaic,
  List<double> phaseScales,
) {
  if (phaseScales.length != 4 ||
      phaseScales.any((double value) => !value.isFinite)) {
    throw ArgumentError('RAW white-balance phase scales must be finite.');
  }
  const double maximumFloat32 = 3.4028234663852886e38;
  for (int y = 0; y < mosaic.height; y++) {
    final int rowStart = y * mosaic.width;
    for (int x = 0; x < mosaic.width; x++) {
      final int index = rowStart + x;
      final double scaled =
          mosaic.samples[index] * phaseScales[((y & 1) << 1) | (x & 1)];
      if (!scaled.isFinite || scaled.abs() > maximumFloat32) {
        throw InvalidRawCameraColorProfile(
          'White-balance harmonization exceeds finite Float32 range.',
        );
      }
      mosaic.samples[index] = scaled;
    }
  }
}

Future<void> _disposeRawMosaicStoresBestEffort(
  Iterable<FileBackedLinearRawMosaicStore> stores,
) async {
  Object? firstError;
  StackTrace? firstStackTrace;
  final Set<FileBackedLinearRawMosaicStore> disposed =
      <FileBackedLinearRawMosaicStore>{};
  for (final FileBackedLinearRawMosaicStore store in stores) {
    if (!disposed.add(store)) continue;
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
