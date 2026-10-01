import '../raw/raw_decoder_contract.dart';
import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import 'dart:async';
import 'dart:io' show Platform;
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import '../demosaic/demosaic_registry.dart';
import '../diagnostics/diagnostic_log.dart';
import '../engine/default_resource_reader.dart' show readDefaultResourceSnapshot;
import '../diagnostics/processing_failure_report.dart';
import '../engine/concurrency_policy.dart';
import '../engine/default_resource_reader.dart';
import '../engine/job_scheduler.dart';
import '../engine/phase2_validated_job_executor.dart';
import '../engine/prepare_master_calibration_frame.dart';
import '../engine/processing_job.dart';
import '../engine/resource_snapshot.dart';
import '../image/file_backed_linear_contribution_tile_store.dart';
import '../image/linear_contribution_tile.dart';
import '../image/linear_contribution_tile_store.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../models/processing_mode.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_file_probe.dart';
import '../raw/raw_metadata_probe.dart';
import '../registration/affine_sampling_transform.dart';
import '../registration/local_residual_correction.dart';
import '../registration/registration_hard_quality.dart';
import '../registration/flat_sky_noise_quality.dart';
import '../registration/guided_field_registration.dart';
import '../registration/adaptive_dual_alignment_resampler.dart';
import '../registration/luminance_plane.dart';
import '../registration/star_detector.dart';
import '../registration/star_transform_estimator.dart';
import '../registration/star_psf_quality.dart';
import '../registration/tiled_affine_rgb_resampler.dart';
import '../stacking/comprehensive_frame_quality_weight.dart';
import '../stacking/registration_quality_weight.dart';
import '../stacking/tiled_kappa_sigma_combiner.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'milky_way_tile_combine_checkpoint.dart';
import '../background/durable_milky_way_frame_cache.dart';

/// Wires together the pieces built across Work36-53 into one working
/// Milky Way (天の川・星景スタック) pipeline: decode and demosaic every
/// frame (the same shared per-frame stage `star_trail_pipeline.dart`
/// uses), register every non-reference frame against the first
/// successfully-decoded frame via star detection + rigid-transform
/// estimation, resample each registered frame onto the reference grid,
/// and combine via kappa-sigma rejection — closing this mode's share of
/// the gap WORK52_PROGRESS.md identified, the same way `star_trail_
/// pipeline.dart` closed it for star trail mode.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it). Run `test/milky_way_pipeline_test.
/// dart` before relying on this in production; as with `star_trail_
/// pipeline.dart`, that test file covers [registerAndCombineDecodedFrames]
/// directly (the part with genuinely new, non-trivial logic) but cannot
/// exercise [runMilkyWayPipeline]'s own `JobScheduler`-driven
/// orchestration without a real or fake decoder pipeline wired end to
/// end — an open, explicitly-acknowledged gap, not glossed over.

/// Everything [runMilkyWayPipeline] needs to decode and demosaic each
/// source frame. Mirrors `star_trail_pipeline.dart`'s
/// `StarTrailFrameDecodingConfig` exactly (same fields, same purpose);
/// kept as a separate type rather than shared, since the two pipelines'
/// configs are free to diverge independently as each mode's own needs
/// grow (e.g. Milky Way mode may eventually want its own demosaic
/// quality/registration-specific settings that star trail mode never
/// will).
final class MilkyWayFrameDecodingConfig {
  const MilkyWayFrameDecodingConfig({
    required this.decoderRegistry,
    this.probe = const RawFileProbe(),
    this.metadataProbe,
    this.demosaicRegistry,
    this.rgbTileStoreFactory,
  });

  final RawDecoderRegistry decoderRegistry;
  final RawFileProbe probe;
  final RawMetadataProbe? metadataProbe;
  final DemosaicRegistry? demosaicRegistry;
  final LinearRgbTileStoreFactory? rgbTileStoreFactory;
}

/// Per-frame outcome from [registerAndCombineDecodedFrames], surfaced so
/// a caller (eventually, a review UI) can show the user which frames
/// were actually used and why any others were not — silently dropping a
/// misregistered frame without any record of it would make the final
/// stack's frame count unexplainable.
final class MilkyWayFrameDiagnostics {
  const MilkyWayFrameDiagnostics({
    required this.sourcePath,
    required this.included,
    this.excludedReason,
    this.detectedStarCount,
    this.matchedStarCount,
    this.rotationDegrees,
    this.sourceOffsetX,
    this.sourceOffsetY,
    this.rmsResidual,
    this.globalRmsResidual,
    this.residualP95,
    this.residualMax,
    this.residualDirectionalCoherence,
    this.registrationRmsLimit,
    this.matchSpanXFraction,
    this.matchSpanYFraction,
    this.matchOccupiedQuadrants,
    this.localCorrectionApplied,
    this.registrationWeight,
  });

  final String sourcePath;
  final bool included;

  /// Human-readable reason this frame was left out of the final stack,
  /// or `null` if [included] is `true`.
  final String? excludedReason;

  /// How many point sources `detectStars` found in this frame, or
  /// `null` if star detection was never reached (e.g. the frame failed
  /// to decode before registration was attempted).
  final int? detectedStarCount;

  /// Number of star correspondences retained by the final robust fit.
  /// This is `null` for the identity reference frame or when registration
  /// did not reach a valid fit.
  final int? matchedStarCount;

  /// The estimated rotation (degrees) mapping this frame onto the
  /// reference frame, or `null` for the reference frame itself (always
  /// treated as the identity transform) or an excluded frame.
  final double? rotationDegrees;

  /// Translation components, in full-resolution pixels, of the transform
  /// that maps reference-frame coordinates into this source frame.
  final double? sourceOffsetX;
  final double? sourceOffsetY;

  /// The registration fit's RMS residual (pixels) after the local residual
  /// correction actually used for sampling, or `null` for the same reasons as
  /// [rotationDegrees].
  final double? rmsResidual;

  /// RMS before optional local correction. Keeping both values makes it clear
  /// whether a local polynomial improved the registration or whether the final
  /// transform is effectively global-only.
  final double? globalRmsResidual;

  /// Tail diagnostics of the final matched-star residual distribution.
  final double? residualP95;
  final double? residualMax;

  /// Directional coherence in [0,1]: 0 means residual vectors cancel, 1 means
  /// they all point the same way. This is logged as a diagnostic rather than
  /// treated as a standalone quality verdict.
  final double? residualDirectionalCoherence;

  /// WORK348 hard-gate RMS limit that was applied to this frame, in pixels.
  /// `null` for the reference frame or when registration did not reach the
  /// quality gate.
  final double? registrationRmsLimit;

  /// Spatial support of the matched reference stars. These remain diagnostic
  /// only until real-RAW data justifies a separate coverage threshold.
  final double? matchSpanXFraction;
  final double? matchSpanYFraction;
  final int? matchOccupiedQuadrants;

  /// Whether a non-zero local residual correction survived the distribution-
  /// safety check and is actually used by the resampler.
  final bool? localCorrectionApplied;

  /// The actual stacking weight this frame was combined with (see
  /// `registrationQualityWeight` in `registration_quality_weight.dart`),
  /// or `null` for an excluded frame. Exposed for transparency/
  /// debuggability — e.g. a future review UI could show the user which
  /// frames contributed most to the final stack, or a log could explain
  /// why a particular frame's influence was small without contradicting
  /// its `included: true` status.
  final double? registrationWeight;
}

final class MilkyWayPipelineResult {
  const MilkyWayPipelineResult({
    required this.tileStore,
    required this.frameDiagnostics,
    this.contributionStore,
  });

  final LinearRgbTileStore tileStore;
  final List<MilkyWayFrameDiagnostics> frameDiagnostics;

  /// Exact per-channel survivor counts from the final rejection stack.
  ///
  /// A zero count means the corresponding output channel has no valid
  /// observation; it must not be inferred from a numeric RGB value of zero.
  /// Preserving this separately allows later DNG export to distinguish a real
  /// black sample from an undefined stack sample without fabrication.
  final LinearContributionTileStore? contributionStore;
}

/// Thrown when fewer than [minRegisteredFrames] frames end up usable —
/// either because too few frames decoded successfully, or because star
/// registration failed for too many of the ones that did. [diagnostics]
/// records what happened to every frame that was attempted, decoded or
/// not, so the caller can explain the failure precisely rather than just
/// reporting a bare count.
class MilkyWayRegistrationFailed implements Exception {
  const MilkyWayRegistrationFailed(this.diagnostics);

  final List<MilkyWayFrameDiagnostics> diagnostics;

  @override
  String toString() {
    final int includedCount =
        diagnostics.where((MilkyWayFrameDiagnostics d) => d.included).length;
    return 'MilkyWayRegistrationFailed: only $includedCount of '
        '${diagnostics.length} frames were usable.';
  }
}

/// One frame's immutable registration result. Rolling and batch combination
/// share this representation so frame order, transforms, and weights stay
/// identical across both execution strategies.
/// Work351: global registration model for Milky Way (and meteor) stacks.
///
/// [legacyRigid] is the historical rigid (rotation + translation) model and
/// the default; with it every output is bit-identical to Work350.
/// [guidedWholeField] detects a spatially distributed star set, registers
/// each frame from its temporally adjacent neighbour with a homography grown
/// over the whole field (see `guided_field_registration.dart`), keeps the
/// degree-2 local correction for lens distortion, and adds a whole-field
/// coverage gate. It is opt-in until validated on device data.
enum MilkyWayRegistrationModel { legacyRigid, guidedWholeField }

MilkyWayRegistrationModel milkyWayRegistrationModelFromName(String? name) =>
    MilkyWayRegistrationModel.values.firstWhere(
      (MilkyWayRegistrationModel value) => value.name == name,
      orElse: () => MilkyWayRegistrationModel.legacyRigid,
    );

/// Candidates kept by the guided-mode preview detector before spatial
/// selection, and the number of registration stars after selection.
const int _guidedPreviewStarCandidates = 1200;
const int _guidedRegistrationStarCount = 400;

final class MilkyWayRegisteredFrame {
  const MilkyWayRegisteredFrame({
    required this.frameIndex,
    required this.transform,
    required this.localCorrection,
    required this.weight,
  });

  final int frameIndex;
  final AffineSamplingTransform transform;
  final LocalResidualCorrectionField? localCorrection;
  final double weight;
}

final class MilkyWayRegistrationPlan {
  const MilkyWayRegistrationPlan({
    required this.referenceIndex,
    required this.frames,
    required this.diagnostics,
  });

  final int referenceIndex;
  final List<MilkyWayRegisteredFrame> frames;
  final List<MilkyWayFrameDiagnostics> diagnostics;
}

/// Public streaming entry point for the exact registration-star detector used
/// by the existing batch pipeline.
Future<List<DetectedStar>> detectMilkyWayRegistrationStars(
  LinearRgbTileStore store, {
  double thresholdSigma = 6,
  bool usePsfRefinement = true,
  RawSaturationMask? saturationInfluenceMask,
  bool Function()? isCancelled,
  MilkyWayRegistrationModel registrationModel =
      MilkyWayRegistrationModel.legacyRigid,
}) =>
    _detectRegistrationStars(
      store,
      thresholdSigma: thresholdSigma,
      usePsfRefinement: usePsfRefinement,
      saturationInfluenceMask: saturationInfluenceMask,
      isCancelled: isCancelled,
      registrationModel: registrationModel,
    );

/// Work351: guided whole-field registration of every frame with stars
/// against [referenceStars]. Frames are visited outward from the reference;
/// each is seeded with the model of the last successfully registered frame
/// on the same side (identity for the frames adjacent to the reference), and
/// falls back to the rigid estimate when the chained seed does not converge.
/// Values are a [GuidedFieldRegistrationResult] or the last error.
Map<int, Object> _guidedRegistrations({
  required List<DetectedStar> referenceStars,
  required Map<int, List<DetectedStar>> detectedStarsByFrame,
  required int referenceIndex,
  required int frameCount,
  required int imageWidth,
  required int imageHeight,
  required double transformToleranceRadius,
  bool Function()? isCancelled,
}) {
  final Map<int, Object> results = <int, Object>{};
  AffineSamplingTransform sideSeed = AffineSamplingTransform.identity();
  bool afterReference = true;
  for (final ({int index, int neighbour}) step
      in guidedRegistrationOrder(frameCount, referenceIndex)) {
    if (isCancelled?.call() ?? false) throw const TiledStackingCancelled();
    final bool stepAfterReference = step.index > referenceIndex;
    if (stepAfterReference != afterReference) {
      afterReference = stepAfterReference;
      sideSeed = AffineSamplingTransform.identity();
    }
    final List<DetectedStar>? targetStars = detectedStarsByFrame[step.index];
    if (targetStars == null) continue;
    Object lastError =
        GuidedFieldRegistrationFailed('no seed converged for frame ${step.index}');
    GuidedFieldRegistrationResult? registered;
    try {
      registered = refineGuidedFieldRegistration(
        referenceStars: referenceStars,
        targetStars: targetStars,
        seed: sideSeed,
        imageWidth: imageWidth,
        imageHeight: imageHeight,
        toleranceRadius: transformToleranceRadius,
      );
    } on GuidedFieldRegistrationFailed catch (error) {
      lastError = error;
    }
    if (registered == null) {
      try {
        final StarSimilarityTransformEstimate rigid =
            estimateSimilarityTransform(
          referenceStars.take(150).toList(),
          targetStars.take(150).toList(),
          toleranceRadius: transformToleranceRadius,
          minInliers: 5,
        );
        registered = refineGuidedFieldRegistration(
          referenceStars: referenceStars,
          targetStars: targetStars,
          seed: rigid,
          imageWidth: imageWidth,
          imageHeight: imageHeight,
          toleranceRadius: transformToleranceRadius,
        );
      } on Object catch (error) {
        if (error is InvalidGuidedFieldRegistrationInput) rethrow;
        lastError = error;
      }
    }
    if (registered != null) {
      results[step.index] = registered;
      sideSeed = registered.transform;
    } else {
      results[step.index] = lastError;
    }
  }
  return results;
}

/// Diagnostic view of a guided result in the historical estimate shape
/// (rotation/offset at the frame center, matches, RMS). Only diagnostics and
/// the local-correction/gate inputs read it; resampling uses the projective
/// transform itself.
StarSimilarityTransformEstimate _guidedDiagnosticEstimate(
  GuidedFieldRegistrationResult guided,
  int imageWidth,
  int imageHeight,
) {
  final double centerX = (imageWidth - 1) / 2;
  final double centerY = (imageHeight - 1) / 2;
  return StarSimilarityTransformEstimate(
    rotationDegrees: guided.rotationDegreesAt(centerX, centerY),
    sourceOffsetX: guided.transform.sourceX(centerX, centerY) - centerX,
    sourceOffsetY: guided.transform.sourceY(centerX, centerY) - centerY,
    centerX: centerX,
    centerY: centerY,
    inlierCount: guided.inlierCount,
    rmsResidual: guided.rmsResidual,
    matches: guided.matches,
  );
}

/// Work351: in guided mode, prefer a near-best reference close to the
/// temporal center (smaller maximum sky rotation to any frame). Legacy mode
/// never calls this.
void _preferTemporalCenterInPlace(
  List<int> rankedReferenceIndices,
  Map<int, double> referenceQualityByIndex,
  int frameCount,
) {
  final List<int> reordered = preferTemporalCenterReference(
    rankedReferenceIndices,
    referenceQualityByIndex,
    frameCount,
  );
  rankedReferenceIndices
    ..clear()
    ..addAll(reordered);
}

/// Builds the same registration order, transforms, local corrections, and
/// comprehensive quality weights as [registerAndCombineDecodedFrames], but
/// from compact star lists so full-resolution decoded stores can be released.
MilkyWayRegistrationPlan buildMilkyWayRegistrationPlan({
  required List<String> sourcePaths,
  required Map<int, List<DetectedStar>> detectedStarsByFrame,
  Map<int, Object?> decodeFailures = const <int, Object?>{},
  Map<int, Object?> starDetectionFailures = const <int, Object?>{},
  int? referenceIndex,
  int minRegisteredFrames = 2,
  double transformToleranceRadius = 3,
  double residualHalfWeightRadius = 1.5,
  double minimumRegistrationWeight = 0.05,
  bool useComprehensiveFrameWeighting = true,
  double roundnessHalfWeight = 0.3,
  double countShortfallHalfWeightFraction = 0.5,
  bool enableLocalRegistration = true,
  double localRegistrationMinimumMatchesPerCoefficient = 4,
  double localRegistrationMaximumCorrectionMagnitude = 3,
  int? imageWidth,
  int? imageHeight,
  MilkyWayRegistrationModel registrationModel =
      MilkyWayRegistrationModel.legacyRigid,
}) {
  if (referenceIndex != null &&
      (referenceIndex < 0 || referenceIndex >= sourcePaths.length)) {
    throw RangeError.index(referenceIndex, sourcePaths, 'referenceIndex');
  }
  if ((imageWidth == null) != (imageHeight == null) ||
      (imageWidth != null && (imageWidth <= 0 || imageHeight! <= 0))) {
    throw ArgumentError(
        'imageWidth/imageHeight must be both null or positive.');
  }
  final bool guided =
      registrationModel == MilkyWayRegistrationModel.guidedWholeField;
  if (guided && imageWidth == null) {
    throw ArgumentError(
      'Guided whole-field registration requires imageWidth/imageHeight.',
    );
  }
  final List<MilkyWayFrameDiagnostics> diagnostics =
      List<MilkyWayFrameDiagnostics>.generate(
    sourcePaths.length,
    (int index) {
      final Object? detectionFailure = starDetectionFailures[index];
      if (detectionFailure != null) {
        return MilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: false,
          excludedReason: 'star detection failed: $detectionFailure',
        );
      }
      return MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: false,
      );
    },
  );
  if (detectedStarsByFrame.isEmpty) {
    for (int index = 0; index < sourcePaths.length; index++) {
      if (diagnostics[index].excludedReason != null) continue;
      diagnostics[index] = MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: false,
        excludedReason: decodeFailures.containsKey(index)
            ? 'decode failed: ${decodeFailures[index]}'
            : 'decode did not complete',
      );
    }
    throw MilkyWayRegistrationFailed(diagnostics);
  }

  final int bestObservedStarCount = detectedStarsByFrame.values
      .map((List<DetectedStar> stars) => stars.length)
      .reduce(math.max);
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

  if (guided && referenceIndex == null) {
    _preferTemporalCenterInPlace(
      rankedReferenceIndices,
      referenceQualityByIndex,
      sourcePaths.length,
    );
  }
  int resolvedReferenceIndex = referenceIndex ?? rankedReferenceIndices.first;
  if (referenceIndex != null &&
      !detectedStarsByFrame.containsKey(referenceIndex)) {
    diagnostics[referenceIndex] = MilkyWayFrameDiagnostics(
      sourcePath: sourcePaths[referenceIndex],
      included: false,
      excludedReason: decodeFailures.containsKey(referenceIndex)
          ? 'selected reference decode failed: ${decodeFailures[referenceIndex]}'
          : 'selected reference star detection failed',
    );
    throw MilkyWayRegistrationFailed(diagnostics);
  }
  if (referenceIndex == null &&
      minRegisteredFrames > 1 &&
      rankedReferenceIndices.length > 1) {
    for (final int candidateIndex in rankedReferenceIndices) {
      final List<DetectedStar> candidateStars =
          detectedStarsByFrame[candidateIndex]!;
      int registrableFrameCount = 1;
      for (final MapEntry<int, List<DetectedStar>> target
          in detectedStarsByFrame.entries) {
        if (target.key == candidateIndex) continue;
        try {
          estimateSimilarityTransform(
            candidateStars,
            target.value,
            toleranceRadius: transformToleranceRadius,
            minInliers: 5,
          );
          registrableFrameCount++;
          if (registrableFrameCount >= minRegisteredFrames) break;
        } on Object {
          // Try the next pair/candidate.
        }
      }
      if (registrableFrameCount >= minRegisteredFrames) {
        resolvedReferenceIndex = candidateIndex;
        break;
      }
    }
  }

  final List<DetectedStar> referenceStars =
      detectedStarsByFrame[resolvedReferenceIndex]!;
  final int registrationImageWidth = imageWidth ?? 0;
  final int registrationImageHeight = imageHeight ?? 0;
  final Map<int, Object>? guidedResults = guided
      ? _guidedRegistrations(
          referenceStars: referenceStars,
          detectedStarsByFrame: detectedStarsByFrame,
          referenceIndex: resolvedReferenceIndex,
          frameCount: sourcePaths.length,
          imageWidth: registrationImageWidth,
          imageHeight: registrationImageHeight,
          transformToleranceRadius: transformToleranceRadius,
        )
      : null;
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
  diagnostics[resolvedReferenceIndex] = MilkyWayFrameDiagnostics(
    sourcePath: sourcePaths[resolvedReferenceIndex],
    included: true,
    detectedStarCount: referenceStars.length,
    rotationDegrees: 0,
    sourceOffsetX: 0,
    sourceOffsetY: 0,
    rmsResidual: 0,
    globalRmsResidual: 0,
    residualP95: 0,
    residualMax: 0,
    residualDirectionalCoherence: 0,
    localCorrectionApplied: false,
    registrationWeight: referenceWeight,
  );
  final List<MilkyWayRegisteredFrame> frames = <MilkyWayRegisteredFrame>[
    MilkyWayRegisteredFrame(
      frameIndex: resolvedReferenceIndex,
      transform: AffineSamplingTransform.identity(),
      localCorrection: null,
      weight: referenceWeight,
    ),
  ];

  for (int index = 0; index < sourcePaths.length; index++) {
    if (index == resolvedReferenceIndex) continue;
    final List<DetectedStar>? targetStars = detectedStarsByFrame[index];
    if (targetStars == null) {
      if (diagnostics[index].excludedReason == null) {
        diagnostics[index] = MilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: false,
          excludedReason: decodeFailures.containsKey(index)
              ? 'decode failed: ${decodeFailures[index]}'
              : 'decode did not complete',
        );
      }
      continue;
    }
    try {
      final StarSimilarityTransformEstimate estimate;
      final AffineSamplingTransform globalTransform;
      if (guidedResults != null) {
        final Object? guidedResult = guidedResults[index];
        if (guidedResult is! GuidedFieldRegistrationResult) {
          // Recorded by the caller's catch as "registration failed: ...".
          throw GuidedFieldRegistrationFailed(
            'frame $index was not registered: ${guidedResult ?? 'no attempt'}',
          );
        }
        globalTransform = guidedResult.transform;
        estimate = _guidedDiagnosticEstimate(
          guidedResult,
          registrationImageWidth,
          registrationImageHeight,
        );
      } else {
        estimate = estimateSimilarityTransform(
          referenceStars,
          targetStars,
          toleranceRadius: transformToleranceRadius,
          minInliers: 5,
        );
        globalTransform = AffineSamplingTransform.similarity(
          rotationDegrees: estimate.rotationDegrees,
          sourceOffsetX: estimate.sourceOffsetX,
          sourceOffsetY: estimate.sourceOffsetY,
          centerX: estimate.centerX,
          centerY: estimate.centerY,
        );
      }
      final List<LocalResidualMatch> localResidualMatches =
          buildLocalResidualMatches(
        matches: estimate.matches,
        referenceStars: referenceStars,
        targetStars: targetStars,
        globalTransform: globalTransform,
      );
      final LocalResidualStatistics globalResidualStatistics =
          summarizeLocalResiduals(localResidualMatches, null);
      final LocalResidualCorrectionField? candidateLocalCorrection =
          enableLocalRegistration
              ? fitLocalResidualCorrectionField(
                  localResidualMatches,
                  minimumMatchesPerCoefficient:
                      localRegistrationMinimumMatchesPerCoefficient,
                  maximumCorrectionMagnitude:
                      localRegistrationMaximumCorrectionMagnitude,
                )
              : null;
      LocalResidualCorrectionField? localCorrection = candidateLocalCorrection;
      LocalResidualStatistics effectiveResidualStatistics =
          globalResidualStatistics;
      if (candidateLocalCorrection?.fitted ?? false) {
        final LocalResidualStatistics candidateStatistics =
            summarizeLocalResiduals(
          localResidualMatches,
          candidateLocalCorrection,
        );
        if (localResidualCorrectionIsDistributionSafe(
          globalStatistics: globalResidualStatistics,
          correctedStatistics: candidateStatistics,
        )) {
          effectiveResidualStatistics = candidateStatistics;
        } else {
          // A local fit is optional. Never accept an RMS improvement that
          // worsens the p95/max tail: a lower average must not be purchased
          // by leaving a few stars substantially farther from their targets.
          localCorrection = null;
        }
      } else {
        localCorrection = null;
      }
      final RegistrationHardQualityGateResult registrationGate =
          evaluateRegistrationHardQualityGate(
        residuals: effectiveResidualStatistics,
        referenceStars: referenceStars,
        transformToleranceRadius: transformToleranceRadius,
      );
      // Work351: guided mode additionally requires whole-field support
      // (relative to the reference star field). Legacy mode: null, so the
      // pass/fail decision and reason text are unchanged.
      final RegistrationCoverageGateResult? coverageGate =
          guidedResults != null
              ? evaluateRegistrationCoverageGate(
                  matches: estimate.matches,
                  referenceStars: referenceStars,
                  imageWidth: registrationImageWidth,
                  imageHeight: registrationImageHeight,
                )
              : null;
      final bool registrationGatePassed =
          registrationGate.passed && (coverageGate?.passed ?? true);
      final List<String> registrationGateReasons = <String>[
        ...registrationGate.reasons,
        for (final String reason in coverageGate?.reasons ?? const <String>[])
          'coverage: $reason',
      ];
      final RegistrationSpatialCoverage? spatialCoverage =
          imageWidth != null && imageHeight != null
              ? summarizeRegistrationSpatialCoverage(
                  matches: estimate.matches,
                  referenceStars: referenceStars,
                  imageWidth: imageWidth,
                  imageHeight: imageHeight,
                )
              : null;
      final double effectiveRmsResidual = effectiveResidualStatistics.rms;
      if (!registrationGatePassed) {
        diagnostics[index] = MilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: false,
          excludedReason: 'registration quality hard gate: '
              '${registrationGateReasons.join(" | ")}',
          detectedStarCount: targetStars.length,
          matchedStarCount: estimate.inlierCount,
          rotationDegrees: estimate.rotationDegrees,
          sourceOffsetX: estimate.sourceOffsetX,
          sourceOffsetY: estimate.sourceOffsetY,
          rmsResidual: effectiveRmsResidual,
          globalRmsResidual: globalResidualStatistics.rms,
          residualP95: effectiveResidualStatistics.p95Magnitude,
          residualMax: effectiveResidualStatistics.maxMagnitude,
          residualDirectionalCoherence:
              effectiveResidualStatistics.directionalCoherence,
          registrationRmsLimit: registrationGate.rmsLimitPx,
          matchSpanXFraction: spatialCoverage?.spanXFraction,
          matchSpanYFraction: spatialCoverage?.spanYFraction,
          matchOccupiedQuadrants: spatialCoverage?.occupiedQuadrants,
          localCorrectionApplied: localCorrection?.fitted ?? false,
        );
        continue;
      }
      final double registrationWeight = registrationQualityWeight(
        effectiveRmsResidual,
        residualHalfWeightRadius: residualHalfWeightRadius,
        minimumWeight: minimumRegistrationWeight,
      );
      final double frameWeight = useComprehensiveFrameWeighting
          ? comprehensiveFrameQualityWeight(
              registrationWeight: registrationWeight,
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
          : registrationWeight;
      diagnostics[index] = MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: true,
        detectedStarCount: targetStars.length,
        matchedStarCount: estimate.inlierCount,
        rotationDegrees: estimate.rotationDegrees,
        sourceOffsetX: estimate.sourceOffsetX,
        sourceOffsetY: estimate.sourceOffsetY,
        rmsResidual: effectiveRmsResidual,
        globalRmsResidual: globalResidualStatistics.rms,
        residualP95: effectiveResidualStatistics.p95Magnitude,
        residualMax: effectiveResidualStatistics.maxMagnitude,
        residualDirectionalCoherence:
            effectiveResidualStatistics.directionalCoherence,
        registrationRmsLimit: registrationGate.rmsLimitPx,
        matchSpanXFraction: spatialCoverage?.spanXFraction,
        matchSpanYFraction: spatialCoverage?.spanYFraction,
        matchOccupiedQuadrants: spatialCoverage?.occupiedQuadrants,
        localCorrectionApplied: localCorrection?.fitted ?? false,
        registrationWeight: frameWeight,
      );
      frames.add(MilkyWayRegisteredFrame(
        frameIndex: index,
        transform: globalTransform,
        localCorrection: localCorrection,
        weight: frameWeight,
      ));
    } on Object catch (error) {
      diagnostics[index] = MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: false,
        excludedReason: 'registration failed: $error',
      );
    }
  }
  if (frames.length < minRegisteredFrames) {
    throw MilkyWayRegistrationFailed(diagnostics);
  }
  return MilkyWayRegistrationPlan(
    referenceIndex: resolvedReferenceIndex,
    frames: frames,
    diagnostics: diagnostics,
  );
}

/// Produces one coverage-marked registered tile using the same sampling path
/// as the batch combiner.
Future<CoveredLinearRgbTile> sampleMilkyWayRegisteredFrameTile({
  required MilkyWayRegisteredFrame frame,
  required int referenceIndex,
  required LinearRgbTileStore referenceStore,
  required LinearRgbTileStore sourceStore,
  required OverlappedTile outputTile,
  required int outputImageWidth,
  required int outputImageHeight,
  RawSaturationMask? referenceInvalidMask,
  RawSaturationMask? sourceInvalidMask,
  ResamplingInterpolation interpolation = ResamplingInterpolation.bicubic,
  bool preserveStaticForeground = true,
  bool Function()? isCancelled,
}) async {
  if (frame.frameIndex == referenceIndex) {
    final LinearRgbTile tile = await sourceStore.readRegion(
      x: outputTile.outputX,
      y: outputTile.outputY,
      width: outputTile.outputWidth,
      height: outputTile.outputHeight,
    );
    return CoveredLinearRgbTile(
      tile: tile,
      coverage: _coverageExcludingInvalidMask(
        tileX: outputTile.outputX,
        tileY: outputTile.outputY,
        width: tile.width,
        height: tile.height,
        imageWidth: outputImageWidth,
        invalidMask: sourceInvalidMask,
      ),
    );
  }
  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: interpolation,
  );
  if (preserveStaticForeground) {
    return AdaptiveDualAlignmentResampler(starResampler: resampler).sampleTile(
      reference: referenceStore,
      source: sourceStore,
      outputTile: outputTile,
      outputImageWidth: outputImageWidth,
      outputImageHeight: outputImageHeight,
      starTransform: frame.transform,
      localCorrectionField: frame.localCorrection,
      referenceInvalidMask: referenceInvalidMask,
      sourceInvalidMask: sourceInvalidMask,
      isCancelled: isCancelled,
    );
  }
  return resampler.sampleTile(
    source: sourceStore,
    outputTile: outputTile,
    outputImageWidth: outputImageWidth,
    outputImageHeight: outputImageHeight,
    transform: frame.transform,
    localCorrectionField: frame.localCorrection,
    sourceInvalidMask: sourceInvalidMask,
    isCancelled: isCancelled,
  );
}

/// Extracts the green channel of [tile] as a [LuminancePlane] — the
/// luminance proxy star detection runs on. Using the green channel
/// directly (not a weighted RGB-to-luminance formula) matches every
/// other module in this project's star-detection pipeline
/// (`star_centroid_detector_reference.mjs`'s own doc comment describes
/// its input the same way: "typically a demosaiced green channel"), and
/// the Bayer pattern's own 2x sampling density in green makes it the
/// sharpest, least-interpolated channel to detect point sources in
/// anyway.
/// WORK350: concurrent frames for registration star detection. Two keeps the
/// extra CPU/thermal load moderate (the app's thermal controller still gates
/// frame boundaries) while roughly halving this stage's wall time.
const int _starDetectionConcurrency = 2;

/// Sendable inputs only: a path is reopened read-only inside the worker
/// because an open RandomAccessFile cannot cross isolates.
final class _WorkerStarDetectionRequest {
  const _WorkerStarDetectionRequest({
    required this.path,
    required this.width,
    required this.height,
    required this.thresholdSigma,
    required this.usePsfRefinement,
    required this.saturationInfluenceMask,
    this.registrationModel = MilkyWayRegistrationModel.legacyRigid,
  });

  final String path;
  final int width;
  final int height;
  final double thresholdSigma;
  final bool usePsfRefinement;
  final RawSaturationMask? saturationInfluenceMask;
  final MilkyWayRegistrationModel registrationModel;
}

final class _WorkerStarDetectionResult {
  const _WorkerStarDetectionResult(this.stars);
  final List<DetectedStar> stars;
}

/// Worker isolate entry. Top-level so the spawn message carries only sendable
/// values. The result is handed over with Isolate.exit (no copy).
Future<void> _starDetectionWorkerEntry(
  (SendPort, _WorkerStarDetectionRequest) message,
) async {
  final (SendPort reply, _WorkerStarDetectionRequest request) = message;
  final List<DetectedStar> stars = await _runWorkerStarDetection(request);
  Isolate.exit(reply, _WorkerStarDetectionResult(stars));
}

/// WORK350: one killable star-detection worker isolate.
///
/// [result] completes with the stars, with the worker's error (as
/// [RemoteError]) if detection throws, or with [TiledStackingCancelled] after
/// [kill]. [result] is pre-marked as handled so a killed or abandoned worker
/// can never surface an unhandled async error.
final class _StarDetectionWorker {
  _StarDetectionWorker._();

  final Completer<List<DetectedStar>> _completer =
      Completer<List<DetectedStar>>();
  final ReceivePort _port = ReceivePort();
  Isolate? _isolate;
  bool _killed = false;

  Future<List<DetectedStar>> get result => _completer.future;

  static _StarDetectionWorker start(_WorkerStarDetectionRequest request) {
    final _StarDetectionWorker worker = _StarDetectionWorker._();
    worker.result.ignore();
    worker._port.listen(worker._onMessage);
    unawaited(worker._spawn(request));
    return worker;
  }

  Future<void> _spawn(_WorkerStarDetectionRequest request) async {
    try {
      final Isolate isolate = await Isolate.spawn(
        _starDetectionWorkerEntry,
        (_port.sendPort, request),
        onExit: _port.sendPort,
        onError: _port.sendPort,
        debugName: 'mw-star-detection',
      );
      if (_killed) {
        // kill() ran while the spawn was in flight.
        isolate.kill(priority: Isolate.immediate);
      } else {
        _isolate = isolate;
      }
    } on Object catch (error, stackTrace) {
      _finish(error: error, stackTrace: stackTrace);
    }
  }

  void _onMessage(Object? message) {
    if (message is _WorkerStarDetectionResult) {
      _finish(stars: message.stars);
    } else if (message is List && message.length == 2) {
      // onError payload: [error.toString(), stackTrace.toString()].
      _finish(
        error: RemoteError('${message[0]}', '${message[1]}'),
        stackTrace: StackTrace.empty,
      );
    } else {
      // onExit (null) without a result: the isolate died.
      _finish(
        error: StateError('Star-detection worker exited without a result.'),
        stackTrace: StackTrace.current,
      );
    }
  }

  void _finish({
    List<DetectedStar>? stars,
    Object? error,
    StackTrace? stackTrace,
  }) {
    if (!_completer.isCompleted) {
      if (error != null) {
        _completer.completeError(error, stackTrace);
      } else {
        _completer.complete(stars!);
      }
    }
    _isolate = null;
    _port.close();
  }

  /// Stops the worker immediately. Safe to call at any time, repeatedly.
  void kill() {
    if (_killed) return;
    _killed = true;
    _isolate?.kill(priority: Isolate.immediate);
    _finish(
      error: const TiledStackingCancelled(),
      stackTrace: StackTrace.current,
    );
  }
}

/// Awaits [worker] while polling [isCancelled] on the calling isolate.
Future<List<DetectedStar>> _awaitStarWorkerCancellable(
  _StarDetectionWorker worker, {
  required bool Function()? isCancelled,
  required void Function() onCancelled,
}) async {
  final bool Function()? cancelled = isCancelled;
  if (cancelled == null) return worker.result;
  if (cancelled()) {
    worker.kill();
    onCancelled();
    throw const TiledStackingCancelled();
  }
  final Timer poll = Timer.periodic(
    _starWorkerCancellationPollInterval,
    (Timer timer) {
      if (!cancelled()) return;
      timer.cancel();
      worker.kill();
      onCancelled();
    },
  );
  try {
    return await worker.result;
  } finally {
    poll.cancel();
  }
}

const Duration _starWorkerCancellationPollInterval =
    Duration(milliseconds: 200);

Future<List<DetectedStar>> _runWorkerStarDetection(
  _WorkerStarDetectionRequest request,
) async {
  final FileBackedLinearRgbTileStore store =
      await FileBackedLinearRgbTileStore.openCommitted(
    path: request.path,
    width: request.width,
    height: request.height,
  );
  try {
    return await _detectRegistrationStars(
      store,
      thresholdSigma: request.thresholdSigma,
      usePsfRefinement: request.usePsfRefinement,
      saturationInfluenceMask: request.saturationInfluenceMask,
      registrationModel: request.registrationModel,
    );
  } finally {
    await store.closeRetainingFile();
  }
}

Future<List<DetectedStar>> _detectRegistrationStars(
  LinearRgbTileStore store, {
  required double thresholdSigma,
  required bool usePsfRefinement,
  RawSaturationMask? saturationInfluenceMask,
  bool Function()? isCancelled,
  MilkyWayRegistrationModel registrationModel =
      MilkyWayRegistrationModel.legacyRigid,
}) async {
  final bool guided =
      registrationModel == MilkyWayRegistrationModel.guidedWholeField;
  // WORK345: keep the memory-bounded coarse detector above 16MP, but never
  // use its half-resolution centroid as the final registration coordinate.
  // Coarse candidates are mapped back to the sensor grid and re-detected in
  // small native-resolution ROIs below. This keeps the large full-frame
  // Float32 plane at one quarter the size while restoring native-resolution
  // sub-pixel centroid precision for the transform fit.
  const int maximumRegistrationPixels = 16 * 1024 * 1024;
  // The stack, bicubic resampling and
  // exported pixels remain full resolution. Only coarse star-candidate
  // discovery is downsampled; every accepted centroid is refined again from
  // native-resolution RGB before the registration transform is estimated.
  final int scale =
      store.width * store.height > maximumRegistrationPixels ? 2 : 1;
  const int previewRowsPerStrip = 128;
  final int previewWidth = (store.width + scale - 1) ~/ scale;
  final int previewHeight = (store.height + scale - 1) ~/ scale;
  if (saturationInfluenceMask != null &&
      saturationInfluenceMask.pixelCount != store.width * store.height) {
    throw ArgumentError(
      'Registration saturation mask dimensions do not match RGB source.',
    );
  }
  final Float32List green = Float32List(previewWidth * previewHeight);

  for (int previewY = 0;
      previewY < previewHeight;
      previewY += previewRowsPerStrip) {
    if (isCancelled?.call() ?? false) {
      throw const TiledStackingCancelled();
    }
    final int previewRowCount = (previewHeight - previewY).clamp(
      0,
      previewRowsPerStrip,
    );
    final int sourceY = previewY * scale;
    final int sourceHeight = (previewRowCount * scale).clamp(
      0,
      store.height - sourceY,
    );
    final LinearRgbTile strip = await store.readRegion(
      x: 0,
      y: sourceY,
      width: store.width,
      height: sourceHeight,
    );
    for (int localPreviewY = 0;
        localPreviewY < previewRowCount;
        localPreviewY++) {
      if (isCancelled?.call() ?? false) {
        throw const TiledStackingCancelled();
      }
      final int localSourceY = localPreviewY * scale;
      final int blockHeight = scale.clamp(0, sourceHeight - localSourceY);
      for (int previewX = 0; previewX < previewWidth; previewX++) {
        final int sourceX = previewX * scale;
        final int blockWidth = scale.clamp(0, store.width - sourceX);
        double sum = 0;
        for (int dy = 0; dy < blockHeight; dy++) {
          int sample = ((localSourceY + dy) * store.width + sourceX) * 3 + 1;
          for (int dx = 0; dx < blockWidth; dx++, sample += 3) {
            sum += strip.interleavedRgb[sample];
          }
        }
        final int previewIndex =
            (previewY + localPreviewY) * previewWidth + previewX;
        green[previewIndex] = sum / (blockWidth * blockHeight);
      }
    }
  }

  // Work351 guided mode: keep more candidates, then select a spatially
  // distributed subset below. Legacy mode passes detectStars' own default
  // (200), so its output is unchanged.
  final List<DetectedStar> previewStars = detectStars(
    LuminancePlane(width: previewWidth, height: previewHeight, samples: green),
    thresholdSigma: thresholdSigma,
    usePsfRefinement: usePsfRefinement,
    maxStars: guided ? _guidedPreviewStarCandidates : 200,
  );
  final List<DetectedStar> coarseSensorCoordinateStars = scale == 1
      ? previewStars
      : <DetectedStar>[
          for (final DetectedStar star in previewStars)
            DetectedStar(
              x: (star.x + 0.5) * scale - 0.5,
              y: (star.y + 0.5) * scale - 0.5,
              flux: star.flux,
              peakValue: star.peakValue,
              roundness: star.roundness,
              sharpness: star.sharpness,
              psfFwhmPx: star.psfFwhmPx,
            ),
        ];
  // Work351 guided mode: brightest-only lists concentrate in the densest
  // part of the Milky Way; select per grid cell before the (per-star)
  // native-resolution refinement so its cost stays bounded.
  final List<DetectedStar> selectedCoarseStars = guided
      ? selectSpatiallyDistributedStars(
          coarseSensorCoordinateStars,
          imageWidth: store.width,
          imageHeight: store.height,
          limit: _guidedRegistrationStarCount,
        )
      : coarseSensorCoordinateStars;
  final List<DetectedStar> sensorCoordinateStars = scale == 1
      ? selectedCoarseStars
      : await _refineRegistrationStarsAtNativeResolution(
          store,
          selectedCoarseStars,
          thresholdSigma: thresholdSigma,
          usePsfRefinement: usePsfRefinement,
          isCancelled: isCancelled,
        );
  final int detectorWindowRadius = 4 * scale;
  return <DetectedStar>[
    for (final DetectedStar star in sensorCoordinateStars)
      if (!_previewWindowTouchesInvalid(
        starX: star.x,
        starY: star.y,
        width: store.width,
        height: store.height,
        invalidMask: saturationInfluenceMask,
        radius: detectorWindowRadius,
      ))
        star,
  ];
}

Future<List<DetectedStar>> _refineRegistrationStarsAtNativeResolution(
  LinearRgbTileStore store,
  List<DetectedStar> coarseStars, {
  required double thresholdSigma,
  required bool usePsfRefinement,
  bool Function()? isCancelled,
}) async {
  const int nativeWindowRadius = 8;
  final List<DetectedStar> refined = <DetectedStar>[];
  for (final DetectedStar coarse in coarseStars) {
    if (isCancelled?.call() ?? false) {
      throw const TiledStackingCancelled();
    }
    final int centerX = coarse.x.round().clamp(0, store.width - 1).toInt();
    final int centerY = coarse.y.round().clamp(0, store.height - 1).toInt();
    final int left = math.max(0, centerX - nativeWindowRadius);
    final int right = math.min(store.width - 1, centerX + nativeWindowRadius);
    final int top = math.max(0, centerY - nativeWindowRadius);
    final int bottom = math.min(store.height - 1, centerY + nativeWindowRadius);
    final int width = right - left + 1;
    final int height = bottom - top + 1;
    if (width <= 8 || height <= 8) {
      refined.add(coarse);
      continue;
    }
    final LinearRgbTile region = await store.readRegion(
      x: left,
      y: top,
      width: width,
      height: height,
    );
    final Float32List green = Float32List(width * height);
    for (int pixel = 0; pixel < green.length; pixel++) {
      green[pixel] = region.interleavedRgb[pixel * 3 + 1];
    }
    final List<DetectedStar> local = detectStars(
      LuminancePlane(width: width, height: height, samples: green),
      thresholdSigma: thresholdSigma,
      usePsfRefinement: usePsfRefinement,
      maxStars: 16,
    );
    if (local.isEmpty) {
      // Fail soft: the coarse detector already established a valid point
      // source. Native refinement is an accuracy improvement, not a reason to
      // discard an otherwise usable registration star.
      refined.add(coarse);
      continue;
    }
    final double predictedX = coarse.x - left;
    final double predictedY = coarse.y - top;
    DetectedStar best = local.first;
    double bestDistanceSquared = double.infinity;
    for (final DetectedStar candidate in local) {
      final double dx = candidate.x - predictedX;
      final double dy = candidate.y - predictedY;
      final double distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        best = candidate;
      }
    }
    refined.add(DetectedStar(
      x: left + best.x,
      y: top + best.y,
      flux: best.flux,
      peakValue: best.peakValue,
      roundness: best.roundness,
      sharpness: best.sharpness,
      psfFwhmPx: best.psfFwhmPx,
    ));
  }
  return refined;
}

/// A coverage mask marking every pixel of a `width`x`height` region as
/// covered — see `star_trail_pipeline.dart`'s identical `_fullCoverage`
/// for why this is correct for a region read directly out of an
/// already-complete tile store (used here only for the reference
/// frame's own un-resampled contribution).

bool _previewWindowTouchesInvalid({
  required double starX,
  required double starY,
  required int width,
  required int height,
  required RawSaturationMask? invalidMask,
  required int radius,
}) {
  if (invalidMask == null || invalidMask.isEmpty) return false;
  final int centerX = starX.round();
  final int centerY = starY.round();
  final int left = (centerX - radius).clamp(0, width - 1).toInt();
  final int right = (centerX + radius).clamp(0, width - 1).toInt();
  final int top = (centerY - radius).clamp(0, height - 1).toInt();
  final int bottom = (centerY + radius).clamp(0, height - 1).toInt();
  for (int y = top; y <= bottom; y++) {
    int index = y * width + left;
    for (int x = left; x <= right; x++, index++) {
      if (invalidMask.isSaturatedIndex(index)) return true;
    }
  }
  return false;
}

/// Samples one registered frame exactly as the batch combiner does, while
/// allowing the caller to keep only the reference and current source stores.
final class MilkyWayRegisteredFrameSampler {
  MilkyWayRegisteredFrameSampler({
    required this.frame,
    required this.referenceIndex,
    required this.referenceStore,
    required this.sourceStore,
    required this.outputImageWidth,
    required this.outputImageHeight,
    this.referenceInvalidMask,
    this.sourceInvalidMask,
    this.preserveStaticForeground = true,
    ResamplingInterpolation interpolation = ResamplingInterpolation.bicubic,
    this.reportStage,
    this.isCancelled,
  }) : _resampler = TiledAffineRgbResampler(interpolation: interpolation) {
    if (referenceStore.width != outputImageWidth ||
        referenceStore.height != outputImageHeight ||
        sourceStore.width != outputImageWidth ||
        sourceStore.height != outputImageHeight) {
      throw StateError('Rolling Milky Way frame dimensions do not match.');
    }
  }

  final MilkyWayRegisteredFrame frame;
  final int referenceIndex;
  final LinearRgbTileStore referenceStore;
  final LinearRgbTileStore sourceStore;
  final int outputImageWidth;
  final int outputImageHeight;
  final RawSaturationMask? referenceInvalidMask;
  final RawSaturationMask? sourceInvalidMask;
  final bool preserveStaticForeground;
  final ProcessingStageReporter? reportStage;
  final bool Function()? isCancelled;
  final TiledAffineRgbResampler _resampler;
  late final AdaptiveDualAlignmentResampler _dualAlignment =
      AdaptiveDualAlignmentResampler(starResampler: _resampler);

  Future<CoveredLinearRgbTile> sampleTile(OverlappedTile region) async {
    if (frame.frameIndex == referenceIndex) {
      final LinearRgbTile tile = await sourceStore.readRegion(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
      );
      return CoveredLinearRgbTile(
        tile: tile,
        coverage: _coverageExcludingInvalidMask(
          tileX: region.outputX,
          tileY: region.outputY,
          width: tile.width,
          height: tile.height,
          imageWidth: outputImageWidth,
          invalidMask: sourceInvalidMask,
        ),
      );
    }
    if (preserveStaticForeground) {
      reportStage?.call(
        ProcessingFailureStage.foregroundProcessing,
        '星空と静止前景の適応的二重位置合わせ',
      );
      final CoveredLinearRgbTile sampled = await _dualAlignment.sampleTile(
        reference: referenceStore,
        source: sourceStore,
        outputTile: region,
        outputImageWidth: outputImageWidth,
        outputImageHeight: outputImageHeight,
        starTransform: frame.transform,
        localCorrectionField: frame.localCorrection,
        referenceInvalidMask: referenceInvalidMask,
        sourceInvalidMask: sourceInvalidMask,
        isCancelled: isCancelled,
      );
      reportStage?.call(
        ProcessingFailureStage.stackCombination,
        '重み付き平均合成（移動体自動削除OFF）',
      );
      return sampled;
    }
    return _resampler.sampleTile(
      source: sourceStore,
      outputTile: region,
      outputImageWidth: outputImageWidth,
      outputImageHeight: outputImageHeight,
      transform: frame.transform,
      localCorrectionField: frame.localCorrection,
      sourceInvalidMask: sourceInvalidMask,
      isCancelled: isCancelled,
    );
  }
}

Uint8List _fullCoverage(int width, int height) =>
    Uint8List(width * height)..fillRange(0, width * height, 1);

Uint8List _coverageExcludingInvalidMask({
  required int tileX,
  required int tileY,
  required int width,
  required int height,
  required int imageWidth,
  required RawSaturationMask? invalidMask,
}) {
  if (invalidMask == null || invalidMask.isEmpty) {
    return _fullCoverage(width, height);
  }
  final Uint8List coverage = Uint8List(width * height);
  for (int y = 0; y < height; y++) {
    final int globalRow = (tileY + y) * imageWidth + tileX;
    final int localRow = y * width;
    for (int x = 0; x < width; x++) {
      coverage[localRow + x] =
          invalidMask.isSaturatedIndex(globalRow + x) ? 0 : 1;
    }
  }
  return coverage;
}

/// Decodes and demosaics every frame in [sourcePaths], registers every
/// non-reference frame against the first one via star detection and
/// rigid-transform estimation, and combines all usable frames via
/// kappa-sigma rejection into one final [LinearRgbTileStore].
///
/// Unlike `star_trail_pipeline.dart`'s `runStarTrailPipeline` (which
/// fails the whole batch if any single frame's decode fails), this
/// function tolerates individual frame failures — both decode failures
/// and registration failures — by excluding just that frame and
/// continuing with the rest, provided at least [minRegisteredFrames]
/// remain usable. This is a deliberate difference, not an
/// inconsistency: every star-trail frame is equally valid content (the
/// mode's own trail-tracing logic already handles a frame simply not
/// covering a given pixel), so a decode failure there really does mean
/// "less data, otherwise fine" — but *including* a frame whose
/// registration failed (or that never decoded) into a Milky Way stack
/// would actively corrupt the result, not just thin it out, so this
/// pipeline is built to drop what doesn't fit rather than let a single
/// bad frame force discarding an entire good capture session, which
/// better serves this project's "image quality first" priority than an
/// all-or-nothing policy would (see WORK54_PROGRESS.md).
///
/// See [registerAndCombineDecodedFrames] for the parameters not
/// documented here ([kappa], [maximumIterations], [tileSize],
/// [starDetectorThresholdSigma], [transformToleranceRadius],
/// [minRegisteredFrames], [residualHalfWeightRadius],
/// [minimumRegistrationWeight], [interpolation]) — all forwarded
/// unchanged.
///
/// Throws [MilkyWayRegistrationFailed] if fewer than
/// [minRegisteredFrames] frames end up usable.
Future<MilkyWayPipelineResult> runMilkyWayPipeline({
  required List<String> sourcePaths,
  required MilkyWayFrameDecodingConfig decodingConfig,
  required LinearRgbTileStoreFactory outputTileStoreFactory,
  LinearRawMosaic? masterDark,
  LinearRawMosaic? masterFlat,
  List<String>? darkFramePaths,
  List<String>? flatFramePaths,
  double kappa = 2.5,
  int maximumIterations = 3,
  int tileSize = 512,
  double starDetectorThresholdSigma = 6,
  bool usePsfRefinement = true,
  double transformToleranceRadius = 3,
  int minRegisteredFrames = 2,
  double residualHalfWeightRadius = 1.5,
  double minimumRegistrationWeight = 0.05,
  bool useComprehensiveFrameWeighting = true,
  double roundnessHalfWeight = 0.3,
  double countShortfallHalfWeightFraction = 0.5,
  bool enableLocalRegistration = true,
  double localRegistrationMinimumMatchesPerCoefficient = 4,
  double localRegistrationMaximumCorrectionMagnitude = 3,
  ResamplingInterpolation interpolation = ResamplingInterpolation.bicubic,
  bool preserveStaticForeground = true,
  bool enableMovingObjectRemoval = true,
  int? referenceIndex,
  ProcessingStageReporter? reportStage,
  ConcurrencyPolicy concurrencyPolicy = fullFrameRawConcurrencyPolicy,
  Future<ResourceSnapshot> Function() resourceReader =
      readDefaultResourceSnapshot,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
  // See `registerAndCombineDecodedFrames`'s own doc comment on this same
  // parameter: optional, off by default, and when provided it bypasses
  // `outputTileStoreFactory`/`contributionTileStoreFactory` (both still
  // required above for callers that do not use this) for the final combine
  // stage only. Decode durability is the separate `decodedFrameCache`
  // parameter below.
  MilkyWayTileCombineCheckpointStore? stageCheckpoint,
  // Makes decode itself resumable (previously the gap this same parameter's
  // doc comment used to note as unaddressed): every existing caller that
  // omits this gets exactly the same always-redecode behavior as before.
  // See `DurableMilkyWayFrameCache` for what it additionally persists
  // beyond the generic `DurableDecodedFrameCache` (the per-frame saturation
  // mask).
  DurableMilkyWayFrameCache? decodedFrameCache,
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
    throw const TiledStackingCancelled();
  }

  final List<LinearRgbTileStore?> frameStores =
      List<LinearRgbTileStore?>.filled(sourcePaths.length, null);
  final List<RawSaturationMask?> saturationInfluenceMasks =
      List<RawSaturationMask?>.filled(sourcePaths.length, null);
  final Map<int, Object?> decodeFailures = <int, Object?>{};
  final decodedMetadata =
      List<RawFrameMetadata?>.filled(sourcePaths.length, null);
  final decodedCfaPatterns = List<CfaPattern?>.filled(sourcePaths.length, null);

  final JobScheduler scheduler = JobScheduler(
    executor: (ProcessingJob job, void Function(double) frameProgress) async {
      final int frameIndex = int.parse(job.id.split('#').last);
      final DurableMilkyWayFrame? restored =
          await decodedFrameCache?.restore(frameIndex);
      if (restored != null) {
        frameStores[frameIndex] = restored.store;
        saturationInfluenceMasks[frameIndex] = restored.saturationMask;
        frameProgress(1);
        return;
      }
      return runPhase2ValidatedJob(
        job,
        frameProgress,
        probe: decodingConfig.probe,
        metadataProbe: decodingConfig.metadataProbe,
        decoderRegistry: decodingConfig.decoderRegistry,
        demosaicRegistry: decodingConfig.demosaicRegistry,
        rgbTileStoreFactory: decodedFrameCache == null
            ? decodingConfig.rgbTileStoreFactory
            : (
                    {required int width,
                    required int height,
                    required OverlappedTilePlan plan}) =>
                decodedFrameCache.create(
                    index: frameIndex,
                    width: width,
                    height: height,
                    plan: plan),
        masterDark: effectiveMasterDark,
        masterFlat: effectiveMasterFlat,
        masterDarkStore: effectiveMasterDarkStore,
        masterFlatStore: effectiveMasterFlatStore,
        preferStreamedRawCalibration: true,
        onRenderMetadataReady: (metadata, cfaPattern) {
          decodedMetadata[frameIndex] = metadata;
          decodedCfaPatterns[frameIndex] = cfaPattern;
        },
        onTileStoreReady: (LinearRgbTileStore tileStore) async {
          frameStores[frameIndex] = tileStore;
          // onSaturationMaskReady (below) always fires before
          // onTileStoreReady for the same frame — see
          // phase2_validated_job_executor.dart — so
          // saturationInfluenceMasks[frameIndex] is already whatever this
          // frame's mask is (including null for "no saturated pixels") by
          // the time this runs.
          await decodedFrameCache?.publish(
            frameIndex,
            tileStore,
            saturationInfluenceMasks[frameIndex],
            metadata: decodedMetadata[frameIndex]!,
            cfaPattern: decodedCfaPatterns[frameIndex]!,
          );
        },
        onSaturationMaskReady: (RawSaturationMask? mask) {
          saturationInfluenceMasks[frameIndex] = mask;
        },
      );
    },
    resourceReader: resourceReader,
    policy: concurrencyPolicy,
  );

  final List<ProcessingJob> jobs = <ProcessingJob>[
    for (int index = 0; index < sourcePaths.length; index++)
      ProcessingJob(
        id: 'milky-way-frame#$index',
        mode: ProcessingMode.milkyWay,
        sourcePath: sourcePaths[index],
      ),
  ];
  scheduler.enqueueAll(jobs);
  try {
    await scheduler.waitUntilIdle();
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
      decodeFailures[index] = StateError(
        'Frame ended in unexpected state ${job.state}.',
      );
    }
  }

  try {
    return await registerAndCombineDecodedFrames(
      sourcePaths: sourcePaths,
      frameStores: frameStores,
      saturationInfluenceMasks: saturationInfluenceMasks,
      decodeFailures: decodeFailures,
      outputTileStoreFactory: outputTileStoreFactory,
      kappa: kappa,
      maximumIterations: maximumIterations,
      tileSize: tileSize,
      starDetectorThresholdSigma: starDetectorThresholdSigma,
      usePsfRefinement: usePsfRefinement,
      transformToleranceRadius: transformToleranceRadius,
      minRegisteredFrames: minRegisteredFrames,
      residualHalfWeightRadius: residualHalfWeightRadius,
      minimumRegistrationWeight: minimumRegistrationWeight,
      useComprehensiveFrameWeighting: useComprehensiveFrameWeighting,
      roundnessHalfWeight: roundnessHalfWeight,
      countShortfallHalfWeightFraction: countShortfallHalfWeightFraction,
      enableLocalRegistration: enableLocalRegistration,
      localRegistrationMinimumMatchesPerCoefficient:
          localRegistrationMinimumMatchesPerCoefficient,
      localRegistrationMaximumCorrectionMagnitude:
          localRegistrationMaximumCorrectionMagnitude,
      interpolation: interpolation,
      preserveStaticForeground: preserveStaticForeground,
      enableMovingObjectRemoval: enableMovingObjectRemoval,
      referenceIndex: referenceIndex,
      reportStage: reportStage,
      reportProgress: reportProgress,
      isCancelled: isCancelled,
      stageCheckpoint: stageCheckpoint,
    );
  } finally {
    await _disposeRgbStoresBestEffort(
      frameStores,
      cache: decodedFrameCache,
      discard: isCancelled?.call() ?? false,
    );
  }
}

Future<void> _disposeRgbStoresBestEffort(
  Iterable<LinearRgbTileStore?> stores, {
  DurableMilkyWayFrameCache? cache,
  bool discard = false,
}) async {
  Object? firstError;
  StackTrace? firstStackTrace;
  final Set<LinearRgbTileStore> disposed = <LinearRgbTileStore>{};
  for (final LinearRgbTileStore? store in stores) {
    if (store == null || !disposed.add(store)) continue;
    try {
      if (cache != null) {
        await cache.release(store, discard: discard);
      } else {
        await store.dispose();
      }
    } on Object catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
  }
  if (firstError != null) {
    Error.throwWithStackTrace(firstError, firstStackTrace!);
  }
}

/// Registers and combines already-decoded [frameStores] (any entry may
/// be `null`, meaning that frame failed to decode — see
/// [decodeFailures], keyed by index into [sourcePaths]/[frameStores]).
/// The highest intrinsic-quality usable entry becomes the reference frame (identity
/// transform, always included if any frame decoded at all); every other
/// non-null frame is registered against it via `detectStars` +
/// `estimateSimilarityTransform`, resampled onto the reference grid via
/// `TiledAffineRgbResampler`, and combined via `TiledKappaSigmaCombiner`
/// with each frame weighted by its own registration quality (see
/// `registrationQualityWeight` in `registration_quality_weight.dart`,
/// and WORK56_PROGRESS.md for why uniform weighting — this function's
/// original behavior in Work54 — was replaced): a frame that barely
/// passed the registration acceptance gate contributes proportionally
/// less to the final stack than one that registered almost perfectly,
/// rather than being trusted equally with it. The reference frame itself
/// always gets the maximum weight (its `rmsResidual` is `0` by
/// construction, not by fitting).
///
/// - [kappa], [maximumIterations]: forwarded to [TiledKappaSigmaCombiner].
/// - [tileSize]: output tile size for the final combination pass
///   (registration itself runs on a full-frame luminance plane, not
///   tiled). `OverlappedTilePlan.create` is always called with
///   `overlap: 0` here — [TiledAffineRgbResampler.sampleTile] computes
///   its own required *source* read bounds directly from the transform
///   (see that method's `_sourceBounds`), never consulting an
///   [OverlappedTile]'s `inputX`/`inputY`/`inputWidth`/`inputHeight`
///   fields at all, so a margin baked into the tile plan itself would be
///   silently unused dead configuration for this reader — nothing to
///   preserve by setting it nonzero, and nothing at risk by leaving it 0.
/// - [starDetectorThresholdSigma]: forwarded to [detectStars] for every
///   frame (reference and targets alike).
/// - [transformToleranceRadius]: forwarded to
///   [estimateSimilarityTransform].
/// - [minRegisteredFrames] (default 2): the minimum total included frame
///   count (reference plus however many others registered successfully)
///   required to proceed; below this, throws
///   [MilkyWayRegistrationFailed] with full diagnostics for every frame
///   attempted.
/// - [residualHalfWeightRadius], [minimumRegistrationWeight]: forwarded
///   to [registrationQualityWeight] for every non-reference frame.
/// - [interpolation] (default [ResamplingInterpolation.bicubic]): forwarded to
///   [TiledAffineRgbResampler]. The app is quality-first, so the high-level
///   stack path now defaults to bicubic for meaningfully better
///   preservation of sharp point sources (stars) at the cost of a
///   modestly wider per-tile source read and somewhat more per-pixel
///   computation — see [ResamplingInterpolation.bicubic]'s own doc
///   comment for the measured improvement.
/// Work361: everything one classic-combine output tile depends on. The same
/// [_combineClassicTile] runs on the main isolate (sequential path) and in
/// the worker isolates (parallel path), so both produce identical bits: each
/// output pixel depends only on these inputs and the tile's own reads.
final class _ClassicCombineTileContext {
  const _ClassicCombineTileContext({
    required this.includedIndices,
    required this.includedWeights,
    required this.includedTransforms,
    required this.includedLocalCorrections,
    required this.frameStores,
    required this.saturationMasks,
    required this.referenceIndex,
    required this.width,
    required this.height,
    required this.preserveStaticForeground,
    required this.resampler,
    required this.dualAlignment,
    required this.combiner,
  });

  final List<int> includedIndices;
  final List<double> includedWeights;
  final List<AffineSamplingTransform> includedTransforms;
  final List<LocalResidualCorrectionField?> includedLocalCorrections;
  final List<LinearRgbTileStore?> frameStores;
  final List<RawSaturationMask?> saturationMasks;
  final int referenceIndex;
  final int width;
  final int height;
  final bool preserveStaticForeground;
  final TiledAffineRgbResampler resampler;
  final AdaptiveDualAlignmentResampler dualAlignment;
  final TiledKappaSigmaCombiner combiner;
}

Future<RejectionStackedRgbTile> _combineClassicTile(
  _ClassicCombineTileContext c,
  OverlappedTile outputTile, {
  bool Function()? isCancelled,
  void Function()? beforeForegroundSample,
  void Function()? afterForegroundSample,
}) {
  return c.combiner.combineTile(
    frameCount: c.includedIndices.length,
    frameWeights: c.includedWeights,
    outputTile: outputTile,
    readFrame: (int listIndex, OverlappedTile region) async {
      final int frameIndex = c.includedIndices[listIndex];
      if (frameIndex == c.referenceIndex) {
        final LinearRgbTile tile = await c.frameStores[frameIndex]!.readRegion(
          x: region.outputX,
          y: region.outputY,
          width: region.outputWidth,
          height: region.outputHeight,
        );
        return CoveredLinearRgbTile(
          tile: tile,
          coverage: _coverageExcludingInvalidMask(
            tileX: region.outputX,
            tileY: region.outputY,
            width: tile.width,
            height: tile.height,
            imageWidth: c.width,
            invalidMask: c.saturationMasks[frameIndex],
          ),
        );
      }
      if (c.preserveStaticForeground) {
        beforeForegroundSample?.call();
        final CoveredLinearRgbTile sampled = await c.dualAlignment.sampleTile(
          reference: c.frameStores[c.referenceIndex]!,
          source: c.frameStores[frameIndex]!,
          outputTile: region,
          outputImageWidth: c.width,
          outputImageHeight: c.height,
          starTransform: c.includedTransforms[listIndex],
          localCorrectionField: c.includedLocalCorrections[listIndex],
          referenceInvalidMask: c.saturationMasks[c.referenceIndex],
          sourceInvalidMask: c.saturationMasks[frameIndex],
          isCancelled: isCancelled,
        );
        afterForegroundSample?.call();
        return sampled;
      }
      return c.resampler.sampleTile(
        source: c.frameStores[frameIndex]!,
        outputTile: region,
        outputImageWidth: c.width,
        outputImageHeight: c.height,
        transform: c.includedTransforms[listIndex],
        localCorrectionField: c.includedLocalCorrections[listIndex],
        sourceInvalidMask: c.saturationMasks[frameIndex],
        isCancelled: isCancelled,
      );
    },
    isCancelled: isCancelled,
  );
}

/// Work361: number of worker isolates for the classic combine. Tiles are
/// independent, so any count gives identical output; this only trades
/// speed against heat and memory (each worker holds one tile's frames plus
/// the combiner's 32 MiB aligned-frame cache).
int classicCombineWorkerCount() {
  final int cores = Platform.numberOfProcessors;
  if (cores >= 8) return 3;
  if (cores >= 6) return 2;
  return 1;
}

final class _ClassicCombineWorkerInit {
  const _ClassicCombineWorkerInit({
    required this.context,
    required this.storePaths,
  });

  /// [_ClassicCombineTileContext.frameStores] is replaced in the worker by
  /// stores reopened read-only from [storePaths].
  final _ClassicCombineTileContext context;
  final Map<int, String> storePaths;
}

final class _ClassicCombineTileRequest {
  const _ClassicCombineTileRequest(this.tileIndex, this.tile);
  final int tileIndex;
  final OverlappedTile tile;
}

final class _ClassicCombineTileReply {
  const _ClassicCombineTileReply({
    required this.tileIndex,
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required this.rgb,
    required this.counts,
  });
  final int tileIndex;
  final int x;
  final int y;
  final int width;
  final int height;
  final TransferableTypedData rgb;
  final TransferableTypedData counts;
}

final class _ClassicCombineTileFailure {
  const _ClassicCombineTileFailure(this.tileIndex, this.message);
  final int tileIndex;
  final String message;
}

Future<void> _classicCombineWorkerEntry(
  (SendPort, _ClassicCombineWorkerInit) args,
) async {
  final (SendPort reply, _ClassicCombineWorkerInit init) = args;
  final ReceivePort requests = ReceivePort();
  final Map<int, FileBackedLinearRgbTileStore> opened =
      <int, FileBackedLinearRgbTileStore>{};
  try {
    final _ClassicCombineTileContext base = init.context;
    final List<LinearRgbTileStore?> stores =
        List<LinearRgbTileStore?>.filled(base.frameStores.length, null);
    for (final MapEntry<int, String> entry in init.storePaths.entries) {
      final FileBackedLinearRgbTileStore store =
          await FileBackedLinearRgbTileStore.openCommitted(
        path: entry.value,
        width: base.width,
        height: base.height,
      );
      opened[entry.key] = store;
      stores[entry.key] = store;
    }
    final _ClassicCombineTileContext context = _ClassicCombineTileContext(
      includedIndices: base.includedIndices,
      includedWeights: base.includedWeights,
      includedTransforms: base.includedTransforms,
      includedLocalCorrections: base.includedLocalCorrections,
      frameStores: stores,
      saturationMasks: base.saturationMasks,
      referenceIndex: base.referenceIndex,
      width: base.width,
      height: base.height,
      preserveStaticForeground: base.preserveStaticForeground,
      resampler: base.resampler,
      dualAlignment: base.dualAlignment,
      combiner: base.combiner,
    );
    reply.send(requests.sendPort);
    await for (final Object? message in requests) {
      if (message is! _ClassicCombineTileRequest) break;
      try {
        final RejectionStackedRgbTile combined =
            await _combineClassicTile(context, message.tile);
        reply.send(_ClassicCombineTileReply(
          tileIndex: message.tileIndex,
          x: combined.tile.x,
          y: combined.tile.y,
          width: combined.tile.width,
          height: combined.tile.height,
          rgb: TransferableTypedData.fromList(
              <TypedData>[combined.tile.interleavedRgb]),
          counts: TransferableTypedData.fromList(
              <TypedData>[combined.contributingSamples]),
        ));
      } on Object catch (error, stackTrace) {
        reply.send(_ClassicCombineTileFailure(
          message.tileIndex,
          '$error\n$stackTrace',
        ));
        break;
      }
    }
  } on Object catch (error, stackTrace) {
    reply.send(_ClassicCombineTileFailure(-1, '$error\n$stackTrace'));
  } finally {
    requests.close();
    for (final FileBackedLinearRgbTileStore store in opened.values) {
      try {
        await store.closeRetainingFile();
      } on Object {
        // The files belong to the caller; only our read handles close here.
      }
    }
  }
}

/// Runs [_combineClassicTile] for tiles [startTile]..end of [plan] on
/// [workerCount] isolates and hands results to [writeInOrder] strictly in
/// tile order (so durable progress stays monotonic, exactly as in the
/// sequential loop). At most [workerCount] tiles are in flight.
Future<void> _runParallelClassicCombine({
  required _ClassicCombineTileContext context,
  required Map<int, String> storePaths,
  required OverlappedTilePlan plan,
  required int startTile,
  required int workerCount,
  required Future<void> Function(int tileIndex, RejectionStackedRgbTile tile)
      writeInOrder,
  bool Function()? isCancelled,
}) async {
  final ReceivePort replies = ReceivePort();
  final StreamIterator<Object?> incoming =
      StreamIterator<Object?>(replies.cast<Object?>());
  final List<Isolate> isolates = <Isolate>[];
  final List<SendPort> workers = <SendPort>[];
  final Map<int, SendPort> busy = <int, SendPort>{};
  try {
    final _ClassicCombineWorkerInit init = _ClassicCombineWorkerInit(
      context: _ClassicCombineTileContext(
        includedIndices: context.includedIndices,
        includedWeights: context.includedWeights,
        includedTransforms: context.includedTransforms,
        includedLocalCorrections: context.includedLocalCorrections,
        // Open file handles cannot cross isolates; workers reopen by path.
        frameStores: List<LinearRgbTileStore?>.filled(
          context.frameStores.length,
          null,
        ),
        saturationMasks: context.saturationMasks,
        referenceIndex: context.referenceIndex,
        width: context.width,
        height: context.height,
        preserveStaticForeground: context.preserveStaticForeground,
        resampler: context.resampler,
        dualAlignment: context.dualAlignment,
        combiner: context.combiner,
      ),
      storePaths: storePaths,
    );
    for (int i = 0; i < workerCount; i++) {
      isolates.add(await Isolate.spawn(
        _classicCombineWorkerEntry,
        (replies.sendPort, init),
        debugName: 'mw-classic-combine-$i',
      ));
      if (!await incoming.moveNext()) {
        throw StateError('Combine worker exited before it was ready.');
      }
      final Object? handshake = incoming.current;
      if (handshake is _ClassicCombineTileFailure) {
        throw StateError(
          'Combine worker failed to start: ${handshake.message}',
        );
      }
      if (handshake is! SendPort) {
        throw StateError('Unexpected combine worker handshake: $handshake');
      }
      workers.add(handshake);
    }
    int next = startTile;
    int written = startTile;
    final Map<int, RejectionStackedRgbTile> ready =
        <int, RejectionStackedRgbTile>{};
    for (final SendPort worker in workers) {
      if (next >= plan.tiles.length) break;
      busy[next] = worker;
      worker.send(_ClassicCombineTileRequest(next, plan.tiles[next]));
      next++;
    }
    while (written < plan.tiles.length) {
      if (isCancelled?.call() ?? false) {
        throw const TiledStackingCancelled();
      }
      if (!await incoming.moveNext()) {
        throw StateError('Combine workers stopped unexpectedly.');
      }
      final Object? message = incoming.current;
      if (message is _ClassicCombineTileFailure) {
        throw StateError(
          'Combine worker failed on tile ${message.tileIndex}: '
          '${message.message}',
        );
      }
      if (message is! _ClassicCombineTileReply) {
        throw StateError('Unexpected combine worker message: $message');
      }
      final SendPort? worker = busy.remove(message.tileIndex);
      if (worker == null) {
        throw StateError('Combine result for an unrequested tile.');
      }
      ready[message.tileIndex] = RejectionStackedRgbTile(
        tile: LinearRgbTile(
          x: message.x,
          y: message.y,
          width: message.width,
          height: message.height,
          interleavedRgb: message.rgb.materialize().asFloat32List(),
        ),
        contributingSamples: message.counts.materialize().asUint16List(),
      );
      if (next < plan.tiles.length) {
        busy[next] = worker;
        worker.send(_ClassicCombineTileRequest(next, plan.tiles[next]));
        next++;
      }
      while (ready.containsKey(written)) {
        final RejectionStackedRgbTile tile = ready.remove(written)!;
        await writeInOrder(written, tile);
        written++;
      }
    }
  } finally {
    for (final SendPort worker in workers) {
      worker.send(null);
    }
    for (final Isolate isolate in isolates) {
      isolate.kill(priority: Isolate.beforeNextEvent);
    }
    await incoming.cancel();
    replies.close();
  }
}

Future<MilkyWayPipelineResult> registerAndCombineDecodedFrames({
  required List<String> sourcePaths,
  required List<LinearRgbTileStore?> frameStores,
  List<RawSaturationMask?>? saturationInfluenceMasks,
  required Map<int, Object?> decodeFailures,
  required LinearRgbTileStoreFactory outputTileStoreFactory,
  LinearContributionTileStoreFactory? contributionTileStoreFactory,
  double kappa = 2.5,
  int maximumIterations = 3,
  int tileSize = 512,
  double starDetectorThresholdSigma = 6,
  bool usePsfRefinement = true,
  double transformToleranceRadius = 3,
  int minRegisteredFrames = 2,
  double residualHalfWeightRadius = 1.5,
  double minimumRegistrationWeight = 0.05,
  bool useComprehensiveFrameWeighting = true,
  double roundnessHalfWeight = 0.3,
  double countShortfallHalfWeightFraction = 0.5,
  bool enableLocalRegistration = true,
  double localRegistrationMinimumMatchesPerCoefficient = 4,
  double localRegistrationMaximumCorrectionMagnitude = 3,
  ResamplingInterpolation interpolation = ResamplingInterpolation.bicubic,
  bool preserveStaticForeground = true,
  bool enableMovingObjectRemoval = true,
  int? referenceIndex,
  ProcessingStageReporter? reportStage,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
  // Makes the final tile-combine loop resumable across a process death
  // instead of always restarting from tile zero, for either
  // enableMovingObjectRemoval value. Optional and off by default: every
  // existing caller that omits this gets exactly the same behavior as
  // before (outputTileStoreFactory/contributionTileStoreFactory create
  // fresh, uncommitted stores that are aborted — deleted — on any
  // non-success exit), since the combine math never changes when it is
  // present. When provided, it takes over creating the RGB/contribution
  // stores itself (for stable, reopenable paths) and
  // outputTileStoreFactory/contributionTileStoreFactory are not called.
  MilkyWayTileCombineCheckpointStore? stageCheckpoint,
  MilkyWayRegistrationModel registrationModel =
      MilkyWayRegistrationModel.legacyRigid,
  // Work361: isolates for the combine stage (1 = historical sequential
  // loop). Output is identical for any value.
  int combineWorkerIsolates = 1,
}) async {
  final bool guided =
      registrationModel == MilkyWayRegistrationModel.guidedWholeField;
  if (combineWorkerIsolates < 1) {
    throw ArgumentError.value(
      combineWorkerIsolates,
      'combineWorkerIsolates',
      'must be at least 1',
    );
  }
  if (sourcePaths.length != frameStores.length) {
    throw ArgumentError(
      'sourcePaths and frameStores must have the same length.',
    );
  }
  if (referenceIndex != null &&
      (referenceIndex < 0 || referenceIndex >= sourcePaths.length)) {
    throw RangeError.range(
      referenceIndex,
      0,
      sourcePaths.length - 1,
      'referenceIndex',
    );
  }
  final List<RawSaturationMask?> effectiveSaturationMasks =
      saturationInfluenceMasks ??
          List<RawSaturationMask?>.filled(frameStores.length, null);
  if (effectiveSaturationMasks.length != frameStores.length) {
    throw ArgumentError(
      'saturationInfluenceMasks and frameStores must have the same length.',
    );
  }
  for (int index = 0; index < frameStores.length; index++) {
    final LinearRgbTileStore? store = frameStores[index];
    final RawSaturationMask? mask = effectiveSaturationMasks[index];
    if (store != null &&
        mask != null &&
        mask.pixelCount != store.width * store.height) {
      throw ArgumentError(
        'Saturation influence mask dimensions do not match frame $index.',
      );
    }
  }

  // All decoded inputs must share one sensor raster geometry. Registration
  // estimates a rigid sky transform in a common pixel coordinate system, and
  // the final Linear DNG inherits the selected reference frame's raster size.
  // Mixing full-frame/crop or otherwise different raster dimensions would make
  // those coordinates ambiguous and can fail much later during foreground
  // sampling. Fail closed here, before star detection, with the exact frame.
  int? geometryWidth;
  int? geometryHeight;
  int? geometryReferenceIndex;
  for (int index = 0; index < frameStores.length; index++) {
    final LinearRgbTileStore? store = frameStores[index];
    if (store == null) continue;
    geometryWidth ??= store.width;
    geometryHeight ??= store.height;
    geometryReferenceIndex ??= index;
    if (store.width != geometryWidth || store.height != geometryHeight) {
      throw StateError(
        'Decoded frame dimension mismatch: frame $index is '
        '${store.width}x${store.height}, while frame '
        '$geometryReferenceIndex is ${geometryWidth}x$geometryHeight.',
      );
    }
  }

  final List<MilkyWayFrameDiagnostics> diagnostics =
      List<MilkyWayFrameDiagnostics>.filled(
    sourcePaths.length,
    const MilkyWayFrameDiagnostics(sourcePath: '', included: false),
  );
  final List<int> includedIndices = <int>[];
  final List<AffineSamplingTransform> includedTransforms =
      <AffineSamplingTransform>[];
  final List<LocalResidualCorrectionField?> includedLocalCorrections =
      <LocalResidualCorrectionField?>[];
  final List<double> includedWeights = <double>[];

  final Map<int, List<DetectedStar>> detectedStarsByFrame =
      <int, List<DetectedStar>>{};
  reportStage?.call(ProcessingFailureStage.starDetection, '全入力フレームの登録用星検出');
  await DiagnosticLog.log(
      'stage: starDetection start (${frameStores.length} frames)');
  // WORK350: frames are independent, so up to [_starDetectionConcurrency]
  // committed file-backed frames are detected at once in worker isolates.
  // Each worker runs the unchanged _detectRegistrationStars on a read-only
  // reopening of the same committed file with the same parameters, so the
  // star lists are identical to the sequential run. Results are consumed in
  // frame order, so logs, diagnostics and failure handling are unchanged.
  // Cancellation: workers cannot poll the caller's isCancelled across
  // isolates, so each is a killable spawned isolate. While a frame's result
  // is awaited, isCancelled is polled on this isolate; on cancellation every
  // outstanding worker is killed and the wait fails with
  // TiledStackingCancelled. The finally below kills any worker still alive
  // on every exit path (cancel, error, normal), so none outlives this stage.
  final Map<int, _StarDetectionWorker> prefetchedStars =
      <int, _StarDetectionWorker>{};
  void killPrefetchedStarWorkers() {
    for (final _StarDetectionWorker worker in prefetchedStars.values) {
      worker.kill();
    }
    prefetchedStars.clear();
  }

  void prefetchStarsFrom(int firstIndex) {
    for (int ahead = firstIndex;
        ahead < frameStores.length &&
            prefetchedStars.length < _starDetectionConcurrency;
        ahead++) {
      if (prefetchedStars.containsKey(ahead)) continue;
      final LinearRgbTileStore? candidate = frameStores[ahead];
      if (candidate is! FileBackedLinearRgbTileStore || !candidate.isCommitted) {
        continue;
      }
      prefetchedStars[ahead] = _StarDetectionWorker.start(
        _WorkerStarDetectionRequest(
          path: candidate.path,
          width: candidate.width,
          height: candidate.height,
          thresholdSigma: starDetectorThresholdSigma,
          usePsfRefinement: usePsfRefinement,
          saturationInfluenceMask: effectiveSaturationMasks[ahead],
          registrationModel: registrationModel,
        ),
      );
    }
  }

  try {
  for (int index = 0; index < frameStores.length; index++) {
    final LinearRgbTileStore? store = frameStores[index];
    if (store == null) continue;
    try {
      if (isCancelled?.call() ?? false) throw const TiledStackingCancelled();
      prefetchStarsFrom(index);
      final _StarDetectionWorker? worker = prefetchedStars.remove(index);
      detectedStarsByFrame[index] = worker != null
          ? await _awaitStarWorkerCancellable(
              worker,
              isCancelled: isCancelled,
              onCancelled: killPrefetchedStarWorkers,
            )
          : await _detectRegistrationStars(
              store,
              thresholdSigma: starDetectorThresholdSigma,
              usePsfRefinement: usePsfRefinement,
              saturationInfluenceMask: effectiveSaturationMasks[index],
              isCancelled: isCancelled,
              registrationModel: registrationModel,
            );
      await DiagnosticLog.log('starDetection frame $index done');
    } on TiledStackingCancelled {
      // Cancellation is a control-flow signal, not a bad input frame. Never
      // downgrade it to a per-frame star-detection failure.
      rethrow;
    } on Object catch (error) {
      diagnostics[index] = MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: false,
        excludedReason: 'star detection failed: $error',
      );
    }
  }
  } finally {
    killPrefetchedStarWorkers();
  }

  if (detectedStarsByFrame.isEmpty) {
    for (int index = 0; index < sourcePaths.length; index++) {
      if (diagnostics[index].sourcePath.isNotEmpty) continue;
      diagnostics[index] = MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: false,
        excludedReason: decodeFailures.containsKey(index)
            ? 'decode failed: ${decodeFailures[index]}'
            : 'decode did not complete',
      );
    }
    throw MilkyWayRegistrationFailed(diagnostics);
  }

  final int bestObservedStarCount = detectedStarsByFrame.values
      .map((List<DetectedStar> stars) => stars.length)
      .reduce(math.max);
  reportStage?.call(
    ProcessingFailureStage.referenceFramePreparation,
    referenceIndex == null ? '自動基準選択' : 'ユーザー選択基準の検証',
  );
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

  if (guided && referenceIndex == null) {
    _preferTemporalCenterInPlace(
      rankedReferenceIndices,
      referenceQualityByIndex,
      sourcePaths.length,
    );
  }
  int resolvedReferenceIndex = referenceIndex ?? rankedReferenceIndices.first;
  if (referenceIndex != null &&
      !detectedStarsByFrame.containsKey(referenceIndex)) {
    diagnostics[referenceIndex] = MilkyWayFrameDiagnostics(
      sourcePath: sourcePaths[referenceIndex],
      included: false,
      excludedReason: decodeFailures.containsKey(referenceIndex)
          ? 'selected reference decode failed: ${decodeFailures[referenceIndex]}'
          : 'selected reference star detection failed',
    );
    throw MilkyWayRegistrationFailed(diagnostics);
  }
  if (referenceIndex == null &&
      minRegisteredFrames > 1 &&
      rankedReferenceIndices.length > 1) {
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
            minInliers: 5,
          );
          registrableFrameCount += 1;
          if (registrableFrameCount >= minRegisteredFrames) break;
        } on Object {
          // A failed pair only means this candidate cannot use that target.
          // The actual registration pass still owns diagnostics.
        }
      }
      if (registrableFrameCount >= minRegisteredFrames) {
        resolvedReferenceIndex = candidateIndex;
        break;
      }
    }
  }

  reportStage?.call(
    ProcessingFailureStage.referenceAlignmentPreparation,
    '基準座標とidentity transformの準備',
  );
  if (resolvedReferenceIndex < 0) {
    throw StateError('Failed to select a reference frame.');
  }
  final List<DetectedStar> referenceStars =
      detectedStarsByFrame[resolvedReferenceIndex]!;
  final int registrationImageWidth = frameStores[resolvedReferenceIndex]!.width;
  final int registrationImageHeight =
      frameStores[resolvedReferenceIndex]!.height;
  final Map<int, Object>? guidedResults = guided
      ? _guidedRegistrations(
          referenceStars: referenceStars,
          detectedStarsByFrame: detectedStarsByFrame,
          referenceIndex: resolvedReferenceIndex,
          frameCount: sourcePaths.length,
          imageWidth: registrationImageWidth,
          imageHeight: registrationImageHeight,
          transformToleranceRadius: transformToleranceRadius,
          isCancelled: isCancelled,
        )
      : null;
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
  diagnostics[resolvedReferenceIndex] = MilkyWayFrameDiagnostics(
    sourcePath: sourcePaths[resolvedReferenceIndex],
    included: true,
    detectedStarCount: referenceStars.length,
    rotationDegrees: 0,
    sourceOffsetX: 0,
    sourceOffsetY: 0,
    rmsResidual: 0,
    globalRmsResidual: 0,
    residualP95: 0,
    residualMax: 0,
    residualDirectionalCoherence: 0,
    localCorrectionApplied: false,
    registrationWeight: referenceWeight,
  );
  includedIndices.add(resolvedReferenceIndex);
  includedTransforms.add(AffineSamplingTransform.identity());
  includedLocalCorrections.add(null);
  includedWeights.add(referenceWeight);

  reportStage?.call(ProcessingFailureStage.frameAlignment, '各フレームを基準座標へ位置合わせ');
  for (int index = 0; index < frameStores.length; index++) {
    if (index == resolvedReferenceIndex) continue;
    final LinearRgbTileStore? store = frameStores[index];
    if (store == null) {
      diagnostics[index] = MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: false,
        excludedReason: decodeFailures.containsKey(index)
            ? 'decode failed: ${decodeFailures[index]}'
            : 'decode did not complete',
      );
      continue;
    }
    if (isCancelled?.call() ?? false) {
      throw const TiledStackingCancelled();
    }
    try {
      final List<DetectedStar>? targetStars = detectedStarsByFrame[index];
      if (targetStars == null) {
        continue;
      }
      final StarSimilarityTransformEstimate estimate;
      final AffineSamplingTransform globalTransform;
      if (guidedResults != null) {
        final Object? guidedResult = guidedResults[index];
        if (guidedResult is! GuidedFieldRegistrationResult) {
          // Recorded by the caller's catch as "registration failed: ...".
          throw GuidedFieldRegistrationFailed(
            'frame $index was not registered: ${guidedResult ?? 'no attempt'}',
          );
        }
        globalTransform = guidedResult.transform;
        estimate = _guidedDiagnosticEstimate(
          guidedResult,
          registrationImageWidth,
          registrationImageHeight,
        );
      } else {
        estimate = estimateSimilarityTransform(
          referenceStars,
          targetStars,
          toleranceRadius: transformToleranceRadius,
          minInliers: 5,
        );
        globalTransform = AffineSamplingTransform.similarity(
          rotationDegrees: estimate.rotationDegrees,
          sourceOffsetX: estimate.sourceOffsetX,
          sourceOffsetY: estimate.sourceOffsetY,
          centerX: estimate.centerX,
          centerY: estimate.centerY,
        );
      }
      final List<LocalResidualMatch> localResidualMatches =
          buildLocalResidualMatches(
        matches: estimate.matches,
        referenceStars: referenceStars,
        targetStars: targetStars,
        globalTransform: globalTransform,
      );
      final LocalResidualStatistics globalResidualStatistics =
          summarizeLocalResiduals(localResidualMatches, null);
      final LocalResidualCorrectionField? candidateLocalCorrection =
          enableLocalRegistration
              ? fitLocalResidualCorrectionField(
                  localResidualMatches,
                  minimumMatchesPerCoefficient:
                      localRegistrationMinimumMatchesPerCoefficient,
                  maximumCorrectionMagnitude:
                      localRegistrationMaximumCorrectionMagnitude,
                )
              : null;
      LocalResidualCorrectionField? localCorrectionField =
          candidateLocalCorrection;
      LocalResidualStatistics effectiveResidualStatistics =
          globalResidualStatistics;
      if (candidateLocalCorrection?.fitted ?? false) {
        final LocalResidualStatistics candidateStatistics =
            summarizeLocalResiduals(
          localResidualMatches,
          candidateLocalCorrection,
        );
        if (localResidualCorrectionIsDistributionSafe(
          globalStatistics: globalResidualStatistics,
          correctedStatistics: candidateStatistics,
        )) {
          effectiveResidualStatistics = candidateStatistics;
        } else {
          localCorrectionField = null;
        }
      } else {
        localCorrectionField = null;
      }
      // Weight the frame by the registration transform that will actually be
      // sampled. WORK347 also refuses a local fit that lowers RMS by sacrificing
      // the residual tail. Directional coherence remains a diagnostic.
      final RegistrationHardQualityGateResult registrationGate =
          evaluateRegistrationHardQualityGate(
        residuals: effectiveResidualStatistics,
        referenceStars: referenceStars,
        transformToleranceRadius: transformToleranceRadius,
      );
      // Work351: guided mode additionally requires whole-field support
      // (relative to the reference star field). Legacy mode: null, so the
      // pass/fail decision and reason text are unchanged.
      final RegistrationCoverageGateResult? coverageGate =
          guidedResults != null
              ? evaluateRegistrationCoverageGate(
                  matches: estimate.matches,
                  referenceStars: referenceStars,
                  imageWidth: registrationImageWidth,
                  imageHeight: registrationImageHeight,
                )
              : null;
      final bool registrationGatePassed =
          registrationGate.passed && (coverageGate?.passed ?? true);
      final List<String> registrationGateReasons = <String>[
        ...registrationGate.reasons,
        for (final String reason in coverageGate?.reasons ?? const <String>[])
          'coverage: $reason',
      ];
      final RegistrationSpatialCoverage spatialCoverage =
          summarizeRegistrationSpatialCoverage(
        matches: estimate.matches,
        referenceStars: referenceStars,
        imageWidth: frameStores[resolvedReferenceIndex]!.width,
        imageHeight: frameStores[resolvedReferenceIndex]!.height,
      );
      final double effectiveRmsResidual = effectiveResidualStatistics.rms;
      if (!registrationGatePassed) {
        diagnostics[index] = MilkyWayFrameDiagnostics(
          sourcePath: sourcePaths[index],
          included: false,
          excludedReason: 'registration quality hard gate: '
              '${registrationGateReasons.join(" | ")}',
          detectedStarCount: targetStars.length,
          matchedStarCount: estimate.inlierCount,
          rotationDegrees: estimate.rotationDegrees,
          sourceOffsetX: estimate.sourceOffsetX,
          sourceOffsetY: estimate.sourceOffsetY,
          rmsResidual: effectiveRmsResidual,
          globalRmsResidual: globalResidualStatistics.rms,
          residualP95: effectiveResidualStatistics.p95Magnitude,
          residualMax: effectiveResidualStatistics.maxMagnitude,
          residualDirectionalCoherence:
              effectiveResidualStatistics.directionalCoherence,
          registrationRmsLimit: registrationGate.rmsLimitPx,
          matchSpanXFraction: spatialCoverage.spanXFraction,
          matchSpanYFraction: spatialCoverage.spanYFraction,
          matchOccupiedQuadrants: spatialCoverage.occupiedQuadrants,
          localCorrectionApplied: localCorrectionField?.fitted ?? false,
        );
        continue;
      }
      final double registrationWeight = registrationQualityWeight(
        effectiveRmsResidual,
        residualHalfWeightRadius: residualHalfWeightRadius,
        minimumWeight: minimumRegistrationWeight,
      );
      final double frameWeight = useComprehensiveFrameWeighting
          ? comprehensiveFrameQualityWeight(
              registrationWeight: registrationWeight,
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
          : registrationWeight;
      diagnostics[index] = MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: true,
        detectedStarCount: targetStars.length,
        matchedStarCount: estimate.inlierCount,
        rotationDegrees: estimate.rotationDegrees,
        sourceOffsetX: estimate.sourceOffsetX,
        sourceOffsetY: estimate.sourceOffsetY,
        rmsResidual: effectiveRmsResidual,
        globalRmsResidual: globalResidualStatistics.rms,
        residualP95: effectiveResidualStatistics.p95Magnitude,
        residualMax: effectiveResidualStatistics.maxMagnitude,
        residualDirectionalCoherence:
            effectiveResidualStatistics.directionalCoherence,
        registrationRmsLimit: registrationGate.rmsLimitPx,
        matchSpanXFraction: spatialCoverage.spanXFraction,
        matchSpanYFraction: spatialCoverage.spanYFraction,
        matchOccupiedQuadrants: spatialCoverage.occupiedQuadrants,
        localCorrectionApplied: localCorrectionField?.fitted ?? false,
        registrationWeight: frameWeight,
      );
      includedIndices.add(index);
      includedTransforms.add(globalTransform);
      includedLocalCorrections.add(localCorrectionField);
      includedWeights.add(frameWeight);
    } on Object catch (error) {
      diagnostics[index] = MilkyWayFrameDiagnostics(
        sourcePath: sourcePaths[index],
        included: false,
        excludedReason: 'registration failed: $error',
      );
    }
  }

  for (final MilkyWayFrameDiagnostics diagnostic in diagnostics) {
    await DiagnosticLog.log(
      'Milky Way registration diagnostics (classic): '
      'source=${diagnostic.sourcePath} '
      'included=${diagnostic.included} '
      'excludedReason=${diagnostic.excludedReason} '
      'detectedStars=${diagnostic.detectedStarCount} '
      'matchedStars=${diagnostic.matchedStarCount} '
      'rmsResidualPx=${diagnostic.rmsResidual} '
      'globalRmsResidualPx=${diagnostic.globalRmsResidual} '
      'registrationRmsLimitPx=${diagnostic.registrationRmsLimit} '
      'residualP95Px=${diagnostic.residualP95} '
      'residualMaxPx=${diagnostic.residualMax} '
      'matchSpanX=${diagnostic.matchSpanXFraction} '
      'matchSpanY=${diagnostic.matchSpanYFraction} '
      'matchQuadrants=${diagnostic.matchOccupiedQuadrants} '
      'localCorrectionApplied=${diagnostic.localCorrectionApplied} '
      'weight=${diagnostic.registrationWeight}',
    );
  }
  if (includedIndices.length < minRegisteredFrames) {
    throw MilkyWayRegistrationFailed(diagnostics);
  }

  final int width = frameStores[resolvedReferenceIndex]!.width;
  final int height = frameStores[resolvedReferenceIndex]!.height;
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore outputStore;
  late final LinearContributionTileStore contributionStore;
  int resumeFromTileIndex = 0;
  if (stageCheckpoint != null) {
    stageCheckpoint.bindInputs({
      'indices': includedIndices,
      'weights': includedWeights,
      'transforms': [
        for (final x in includedTransforms)
          x.checkpointCoefficients
      ],
      'localCorrections': [
        for (final x in includedLocalCorrections) x?.toCheckpointJson()
      ],
      'kappa': kappa,
      'iterations': maximumIterations,
      'minimumSurvivingFrames': includedIndices.length >= 2 ? 2 : 1,
      'synchronizeRgbRejection': true,
      'movingRemoval': enableMovingObjectRemoval,
      'foreground': preserveStaticForeground,
      'interpolation': interpolation.name,
    });
    final MilkyWayTileCombineCheckpointProgress progress =
        await stageCheckpoint.openOrCreate(
      width: width,
      height: height,
      plan: plan,
    );
    outputStore = progress.rgbStore;
    contributionStore = progress.contributionStore;
    resumeFromTileIndex = progress.resumeFromTileIndex;
  } else {
    outputStore = await outputTileStoreFactory(
      width: width,
      height: height,
      plan: plan,
    );
    try {
      contributionStore = await (contributionTileStoreFactory ??
          FileBackedLinearContributionTileStore.createTemporary)(
        width: width,
        height: height,
        plan: plan,
      );
    } catch (_) {
      await outputStore.abort();
      rethrow;
    }
  }

  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: interpolation,
  );
  final AdaptiveDualAlignmentResampler dualAlignment =
      AdaptiveDualAlignmentResampler(starResampler: resampler);
  final TiledKappaSigmaCombiner combiner = TiledKappaSigmaCombiner(
    kappa: kappa,
    maximumIterations: maximumIterations,
    // A rejection-induced one-frame survivor cannot reduce random noise.
    // Require at least two synchronized RGB observations whenever two or
    // more registered frames exist; natural geometric edge coverage may still
    // contain one observation and is represented honestly by contributions.
    minimumSurvivingFrames: includedIndices.length >= 2 ? 2 : 1,
    robustSmallStackInitialization: true,
    enableOutlierRejection: enableMovingObjectRemoval,
    // WORK346: never build one output colour from three different source-frame
    // subsets. Rejection is applied to complete RGB observations.
    synchronizeRgbRejection: true,
    maximumPixelsPerBand: 8192,
    // WORK350: the aligned-frame cache was disabled here without a recorded
    // reason (WORK309 documents production as cached). Disabled, every
    // kappa-sigma pass re-ran dual-alignment resampling for every frame:
    // ~1000 resamples per 128px tile at 50 frames (~38 s/tile, ~16 h per
    // stack). The cache stores the identical sampled objects, so results are
    // bit-identical; band size adapts so 300+ frames still fit 32 MiB.
    maximumAlignedFrameCacheBytes: 32 * 1024 * 1024,
  );
  bool committed = false;
  try {
    reportStage?.call(
      ProcessingFailureStage.stackCombination,
      enableMovingObjectRemoval ? 'kappa-sigmaロバスト合成' : '重み付き平均合成（移動体自動削除OFF）',
    );
    await DiagnosticLog.log(
      'stage: stackCombination start (${plan.tiles.length} tiles, tileSize=$tileSize)',
    );
    // WORK350: measured combine throughput (diagnostic log only). No ETA or
    // remaining time is computed or shown: the long-running UI spec forbids it
    // (CODEX_HANDOFF_WORK264: ETA/残り時間は追加しない).
    final Stopwatch combineWatch = Stopwatch()..start();
    // Work361: the per-tile computation is shared by the sequential loop and
    // the parallel workers (identical output); writing, durable progress,
    // logging and the thermal yield stay here, strictly in tile order.
    final _ClassicCombineTileContext tileContext = _ClassicCombineTileContext(
      includedIndices: includedIndices,
      includedWeights: includedWeights,
      includedTransforms: includedTransforms,
      includedLocalCorrections: includedLocalCorrections,
      frameStores: frameStores,
      saturationMasks: effectiveSaturationMasks,
      referenceIndex: resolvedReferenceIndex,
      width: width,
      height: height,
      preserveStaticForeground: preserveStaticForeground,
      resampler: resampler,
      dualAlignment: dualAlignment,
      combiner: combiner,
    );
    Future<void> writeCombinedTile(
      int tileIndex,
      RejectionStackedRgbTile combined,
    ) async {
      await outputStore.writeTile(combined.tile);
      await contributionStore.writeTile(
        LinearContributionTile(
          x: combined.tile.x,
          y: combined.tile.y,
          width: combined.tile.width,
          height: combined.tile.height,
          interleavedCounts: combined.contributingSamples,
        ),
      );
      await stageCheckpoint?.recordProgress(tileIndex + 1);
      reportProgress?.call((tileIndex + 1) / plan.tiles.length);
      if (tileIndex % 10 == 0 || tileIndex == plan.tiles.length - 1) {
        final int timedTiles = tileIndex + 1 - resumeFromTileIndex;
        final double msPerTile =
            timedTiles > 0 ? combineWatch.elapsedMilliseconds / timedTiles : 0.0;
        await DiagnosticLog.log(
          'standard-combine tile ${tileIndex + 1}/${plan.tiles.length} '
          'msPerTile=${msPerTile.toStringAsFixed(0)} '
          'bandPixels=${combiner.effectiveBandPixels(frameCount: includedIndices.length, tileWidth: plan.tiles[tileIndex].outputWidth)}',
        );
      }
      // No yield existed in this loop before. At full resolution (max
      // quality keeps linearScale == 1.0) this can run several hundred
      // tiles back-to-back with no break at all, which is enough sustained
      // CPU/thermal load on a phone to make the whole device unresponsive
      // regardless of frame count — matching the reported repro (2 frames,
      // max quality hangs; lower quality/resolution completes). Mirrors
      // Work279's tile cooldown for the CFA drizzle path. Does not change
      // any pixel calculation.
      await Future<void>.delayed(const Duration(milliseconds: 24));
    }

    for (int tileIndex = 0;
        tileIndex < math.min(resumeFromTileIndex, plan.tiles.length);
        tileIndex++) {
      // Already durably written by a previous process instance.
      reportProgress?.call((tileIndex + 1) / plan.tiles.length);
    }
    // Work361: parallel only when every frame store can be reopened by path
    // in another isolate (file-backed and committed).
    final Map<int, String> storePaths = <int, String>{};
    bool parallelEligible = combineWorkerIsolates > 1 &&
        resumeFromTileIndex < plan.tiles.length;
    for (final int frameIndex in <int>{
      ...includedIndices,
      resolvedReferenceIndex,
    }) {
      final LinearRgbTileStore? store = frameStores[frameIndex];
      if (store is FileBackedLinearRgbTileStore && store.isCommitted) {
        storePaths[frameIndex] = store.path;
      } else {
        parallelEligible = false;
      }
    }
    int workerCount = combineWorkerIsolates;
    if (parallelEligible) {
      // Each worker receives its own copy of the saturation masks (packed
      // bits, up to ~3 MB per 24 MP frame) and holds one tile's frames plus
      // the combiner's 32 MiB cache. Keep all workers within a quarter of the
      // currently available memory; fall back to the sequential loop if
      // fewer than two fit.
      int maskBytes = 0;
      for (final int frameIndex in storePaths.keys) {
        maskBytes += effectiveSaturationMasks[frameIndex]?.packedByteLength ?? 0;
      }
      final int perWorkerBytes = maskBytes + 64 * 1024 * 1024;
      final int budgetBytes =
          (await readDefaultResourceSnapshot()).availableMemoryBytes ~/ 4;
      workerCount =
          math.min(workerCount, math.max(1, budgetBytes ~/ perWorkerBytes));
      if (workerCount < 2) parallelEligible = false;
      await DiagnosticLog.log(
        'stage: stackCombination workers=$workerCount '
        '(requested=$combineWorkerIsolates maskBytes=$maskBytes '
        'budgetBytes=$budgetBytes)',
      );
    }
    if (parallelEligible) {
      await _runParallelClassicCombine(
        context: tileContext,
        storePaths: storePaths,
        plan: plan,
        startTile: resumeFromTileIndex,
        workerCount: workerCount,
        writeInOrder: writeCombinedTile,
        isCancelled: isCancelled,
      );
    } else {
      for (int tileIndex = resumeFromTileIndex;
          tileIndex < plan.tiles.length;
          tileIndex++) {
        if (isCancelled?.call() ?? false) {
          throw const TiledStackingCancelled();
        }
        final RejectionStackedRgbTile combined = await _combineClassicTile(
          tileContext,
          plan.tiles[tileIndex],
          isCancelled: isCancelled,
          beforeForegroundSample: () => reportStage?.call(
            ProcessingFailureStage.foregroundProcessing,
            '星空と静止前景の適応的二重位置合わせ',
          ),
          // readFrame is invoked repeatedly by the combiner. Restore the
          // owning stack stage after foreground sampling succeeds so a later
          // kappa-sigma/statistics failure is not misreported as foreground.
          afterForegroundSample: () => reportStage?.call(
            ProcessingFailureStage.stackCombination,
            enableMovingObjectRemoval
                ? 'kappa-sigmaロバスト合成'
                : '重み付き平均合成（移動体自動削除OFF）',
          ),
        );
        await writeCombinedTile(tileIndex, combined);
      }
    }
    await outputStore.commit();

    // WORK347: quality-first final PSF gate. The output is now readable but is
    // not yet considered a successful pipeline result. Compare the same stars
    // on the final reference grid against the selected source reference and
    // refuse a stack that systematically broadens/elongates point sources.
    if (usePsfRefinement) {
      // Work351: detect with the same star-selection model as the reference
      // list so that the PSF comparison matches like with like.
      final List<DetectedStar> finalStackStars = await _detectRegistrationStars(
        outputStore,
        thresholdSigma: starDetectorThresholdSigma,
        usePsfRefinement: true,
        isCancelled: isCancelled,
        registrationModel: registrationModel,
      );
      final StarPsfQualityComparison psfComparison = compareRegisteredStarPsf(
        referenceStars: referenceStars,
        finalStars: finalStackStars,
      );
      final StarPsfQualityGateResult psfGate = evaluateStarPsfQualityGate(
        comparison: psfComparison,
      );
      await DiagnosticLog.log(
        'Milky Way final PSF quality: '
        'referenceStars=${psfComparison.referenceStarCount} '
        'finalStars=${psfComparison.finalStarCount} '
        'referenceMeasured=${psfComparison.referenceMeasuredStarCount} '
        'finalMeasured=${psfComparison.finalMeasuredStarCount} '
        'positionMatched=${psfComparison.positionMatchedCount} '
        'measuredPairs=${psfComparison.measuredPairCount} '
        'medianFwhmRatio=${psfComparison.medianFwhmRatio} '
        'p90FwhmRatio=${psfComparison.p90FwhmRatio} '
        'medianRoundnessDelta=${psfComparison.medianRoundnessDelta} '
        'passed=${psfGate.passed} reasons=${psfGate.reasons.join(" | ")}',
      );
      if (!psfGate.passed) {
        throw MilkyWayStackQualityFailed(psfGate);
      }
    }

    // WORK348: measure random/high-frequency noise only in reference-anchored
    // star-field tiles and on the same coordinates in the final stack. This
    // runs after the PSF gate so blur cannot masquerade as noise improvement.
    final FlatSkyNoiseQualityComparison noiseComparison =
        await compareFlatSkyNoise(
      referenceStore: frameStores[resolvedReferenceIndex]!,
      finalStore: outputStore,
      referenceStars: referenceStars,
    );
    final FlatSkyNoiseQualityGateResult noiseGate =
        evaluateFlatSkyNoiseQualityGate(comparison: noiseComparison);
    await DiagnosticLog.log(
      'Milky Way flat-sky noise quality: '
      'candidateTiles=${noiseComparison.candidateTileCount} '
      'selectedTiles=${noiseComparison.selectedTileCount} '
      'coefficients=${noiseComparison.sampledCoefficientCount} '
      'referenceSigma=${noiseComparison.referenceSigma} '
      'finalSigma=${noiseComparison.finalSigma} '
      'noiseRatio=${noiseComparison.noiseRatio} '
      'verified=${noiseGate.hasEnoughMeasurements} '
      'passed=${noiseGate.passed} reasons=${noiseGate.reasons.join(" | ")}',
    );
    if (!noiseGate.passed) {
      throw MilkyWayNoiseQualityFailed(noiseGate);
    }

    await contributionStore.commit();
    committed = true;
    /* Worker clears the checkpoint after durable final output. */
    return MilkyWayPipelineResult(
      tileStore: outputStore,
      frameDiagnostics: diagnostics,
      contributionStore: contributionStore,
    );
  } finally {
    if (!committed) {
      if (stageCheckpoint == null) {
        // Unchanged pre-existing behavior: these were always freshly
        // created, uncommitted stores with no durable meaning of their own,
        // so both are always discarded here regardless of why the loop
        // above did not finish.
        try {
          await outputStore.abort();
        } finally {
          await contributionStore.abort();
        }
      } else {
        // A checkpoint is active: never delete its files here — that is
        // exactly the progress a retry should resume from. Only release
        // this process instance's file handles.
        try {
          await (outputStore as FileBackedLinearRgbTileStore)
              .closeRetainingFile();
        } finally {
          await (contributionStore as FileBackedLinearContributionTileStore)
              .closeRetainingFile();
        }
      }
    }
  }
}
