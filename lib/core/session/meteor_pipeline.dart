import '../tiles/overlapped_tile_plan.dart';
import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import '../demosaic/demosaic_registry.dart';
import '../engine/concurrency_policy.dart';
import '../engine/default_resource_reader.dart';
import '../engine/job_scheduler.dart';
import '../engine/phase2_validated_job_executor.dart';
import '../engine/prepare_master_calibration_frame.dart';
import '../engine/processing_job.dart';
import '../engine/resource_snapshot.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../models/processing_mode.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_file_probe.dart';
import '../raw/raw_metadata_probe.dart';
import '../registration/luminance_plane.dart';
import '../registration/similarity_transform_math.dart';
import '../registration/star_detector.dart';
import '../registration/star_transform_estimator.dart';
import '../meteor/streak_brightness_profile.dart';
import '../meteor/streak_candidate_detector.dart';
import '../meteor/meteor_candidate_analysis_checkpoint.dart';
import '../meteor/streak_persistence_classifier.dart';
import '../meteor/streak_shape.dart';

double _streakAngleDistance(double a, double b) {
  double delta = (a - b).abs() % math.pi;
  if (delta > math.pi / 2) delta = math.pi - delta;
  return delta;
}

double _pointDistance(
  ({double x, double y}) a,
  ({double x, double y}) b,
) =>
    math.sqrt(math.pow(a.x - b.x, 2) + math.pow(a.y - b.y, 2));

double _minimumStreakEndpointGap(
  StreakCandidate a,
  StreakCandidate b,
) {
  double gap = double.infinity;
  for (final endpointA in a.endpoints) {
    for (final endpointB in b.endpoints) {
      gap = math.min(gap, _pointDistance(endpointA, endpointB));
    }
  }
  return gap;
}

/// Detects ordinary connected streaks and also reconnects separated,
/// collinear bright fragments such as an aircraft's blinking-light trail.
/// The latter cannot be represented by an 8-connected component alone,
/// yet its full endpoints are required by brightness-profile analysis.
List<StreakCandidate> _detectContinuousAndBeadedStreaks(
  LuminancePlane source, {
  required double thresholdSigma,
  required double minLength,
  required double minElongation,
  required double minWidthUniformity,
  required double maxWidthProfileLobes,
  void Function(String stage, Duration elapsed)? reportTiming,
}) {
  final Stopwatch continuousTimer = Stopwatch()..start();
  final List<StreakCandidate> continuous = detectStreakCandidates(
    source,
    thresholdSigma: thresholdSigma,
    minLength: minLength,
    minElongation: minElongation,
    minWidthUniformity: minWidthUniformity,
    maxWidthProfileLobes: maxWidthProfileLobes,
  );
  continuousTimer.stop();
  reportTiming?.call('streak-continuous', continuousTimer.elapsed);

  final Stopwatch fragmentTimer = Stopwatch()..start();
  final List<StreakCandidate> fragments = detectStreakCandidates(
    source,
    thresholdSigma: thresholdSigma,
    minLength: 2,
    minElongation: math.min(minElongation, 0.3),
    minWidthUniformity: 0,
    maxWidthProfileLobes: double.infinity,
  );
  fragmentTimer.stop();
  reportTiming?.call('streak-fragments', fragmentTimer.elapsed);
  if (fragments.length < 2) return continuous;

  final Stopwatch reconnectTimer = Stopwatch()..start();

  final List<int> parents = List<int>.generate(fragments.length, (int i) => i);
  int root(int value) {
    while (parents[value] != value) {
      parents[value] = parents[parents[value]];
      value = parents[value];
    }
    return value;
  }

  void unite(int a, int b) {
    final int rootA = root(a);
    final int rootB = root(b);
    if (rootA != rootB) parents[rootB] = rootA;
  }

  const double maximumAngleDifference = 10 * math.pi / 180;
  const double maximumFragmentGap = 40;
  for (int i = 0; i < fragments.length; i++) {
    for (int j = i + 1; j < fragments.length; j++) {
      final StreakCandidate a = fragments[i];
      final StreakCandidate b = fragments[j];
      if (_streakAngleDistance(a.angleRadians, b.angleRadians) >
          maximumAngleDifference) {
        continue;
      }
      if (_minimumStreakEndpointGap(a, b) > maximumFragmentGap) continue;
      final double normalX = -math.sin(a.angleRadians);
      final double normalY = math.cos(a.angleRadians);
      final double perpendicularSeparation =
          ((b.centroidX - a.centroidX) * normalX +
                  (b.centroidY - a.centroidY) * normalY)
              .abs();
      if (perpendicularSeparation > math.max(4, (a.width + b.width) / 2)) {
        continue;
      }
      unite(i, j);
    }
  }

  final Map<int, List<StreakCandidate>> groups = <int, List<StreakCandidate>>{};
  for (int i = 0; i < fragments.length; i++) {
    groups.putIfAbsent(root(i), () => <StreakCandidate>[]).add(fragments[i]);
  }

  final List<StreakCandidate> reconnected = <StreakCandidate>[];
  for (final List<StreakCandidate> group in groups.values) {
    if (group.length < 2) continue;
    double cosine2 = 0;
    double sine2 = 0;
    double totalFlux = 0;
    double centerX = 0;
    double centerY = 0;
    double weightedWidth = 0;
    int pixelCount = 0;
    for (final StreakCandidate fragment in group) {
      final double weight = math.max(fragment.flux, 1e-12);
      cosine2 += math.cos(2 * fragment.angleRadians) * weight;
      sine2 += math.sin(2 * fragment.angleRadians) * weight;
      totalFlux += fragment.flux;
      centerX += fragment.centroidX * weight;
      centerY += fragment.centroidY * weight;
      weightedWidth += fragment.width * weight;
      pixelCount += fragment.pixelCount;
    }
    if (totalFlux <= 0) continue;
    centerX /= totalFlux;
    centerY /= totalFlux;
    final double angle = math.atan2(sine2, cosine2) / 2;
    final double axisX = math.cos(angle);
    final double axisY = math.sin(angle);
    double minimumProjection = double.infinity;
    double maximumProjection = double.negativeInfinity;
    for (final StreakCandidate fragment in group) {
      for (final endpoint in fragment.endpoints) {
        final double projection =
            (endpoint.x - centerX) * axisX + (endpoint.y - centerY) * axisY;
        minimumProjection = math.min(minimumProjection, projection);
        maximumProjection = math.max(maximumProjection, projection);
      }
    }
    final double length = maximumProjection - minimumProjection;
    if (length < minLength) continue;
    final double width = weightedWidth / totalFlux;
    final double lengthSquared = length * length;
    final double widthSquared = width * width;
    final double elongation =
        (lengthSquared - widthSquared) / (lengthSquared + widthSquared);
    if (elongation < minElongation) continue;
    reconnected.add(
      StreakCandidate(
        centroidX: centerX,
        centroidY: centerY,
        angleRadians: angle,
        length: length,
        width: width,
        elongation: elongation,
        flux: totalFlux,
        pixelCount: pixelCount,
        endpoints: <({double x, double y})>[
          (
            x: centerX + axisX * minimumProjection,
            y: centerY + axisY * minimumProjection,
          ),
          (
            x: centerX + axisX * maximumProjection,
            y: centerY + axisY * maximumProjection,
          ),
        ],
      ),
    );
  }

  final List<StreakCandidate> combined = <StreakCandidate>[
    ...continuous,
    ...reconnected,
  ]..sort((StreakCandidate a, StreakCandidate b) => b.flux.compareTo(a.flux));
  reconnectTimer.stop();
  reportTiming?.call('streak-reconnect', reconnectTimer.elapsed);
  return combined;
}

/// Wires together all five meteor-mode Node-ported modules
/// (`streak_candidate_detector.dart` Work59, `streak_persistence_
/// classifier.dart` Work51, `streak_brightness_profile.dart` Work50,
/// plus `star_detector.dart`/`star_transform_estimator.dart` for the
/// sky-motion registration pass) into one analysis pipeline: decode
/// every source frame, detect streak candidates and stars in each,
/// register adjacent frames against each other for the sky-motion-
/// consistency signal, classify every candidate's cross-frame
/// persistence, and measure each candidate's brightness profile for the
/// blinking (aircraft-navigation-light) signal.
///
/// Deliberately does **not** composite anything — this pipeline's
/// output is the full set of analyzed candidates *for a human to review
/// and choose from* (matching this project's own established design for
/// meteor mode; see `streak_candidate_detector.dart`'s doc comment), not
/// a final image. A separate compositing step (not built here — see
/// WORK60_PROGRESS.md's "What's still not done") would call
/// `streak_compositor.dart`'s existing `compositeSelectedStreaks` once a
/// user has picked which candidate(s) to keep, using the [frameStores]
/// this pipeline's result carries.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it). Every module it wires together
/// already has its own dedicated Node-ported test coverage
/// (`streak_candidate_detector_test.dart`, `streak_persistence_
/// classifier_test.dart`, `streak_brightness_profile_test.dart`,
/// `star_detector_test.dart`, `star_transform_estimator_test.dart`);
/// this file's own new logic — the orchestration connecting them — has
/// direct test coverage in `test/meteor_pipeline_test.dart` for the
/// non-`JobScheduler` parts, following the same testability split
/// established in `star_trail_pipeline.dart`/`milky_way_pipeline.dart`
/// (Work53/54) and their own doc comments' identical caveat about the
/// `JobScheduler`-driven decode stage.

/// Everything [runMeteorAnalysisPipeline] needs to decode and demosaic
/// each source frame. Mirrors `star_trail_pipeline.dart`'s/`milky_way_
/// pipeline.dart`'s identical config types.
/// Thrown by [runMeteorAnalysisPipeline] when `isCancelled` reports true.
/// A dedicated type rather than a generic `StateError`, so callers can
/// distinguish "the person asked to stop" from an actual pipeline failure
/// without relying on matching exception message text.
final class MeteorAnalysisCancelled implements Exception {
  const MeteorAnalysisCancelled();

  @override
  String toString() => 'Meteor analysis was cancelled.';
}

final class MeteorFrameDecodingConfig {
  const MeteorFrameDecodingConfig({
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

/// One analyzed streak candidate, combining [StreakPersistenceResult]
/// (cross-frame persistence and sky-motion consistency) with its own
/// [StreakBrightnessProfile] (the blinking signal) — everything a review
/// UI needs to help a user decide whether a given candidate is a
/// meteor, without this pipeline making that call itself.
final class MeteorCandidate {
  const MeteorCandidate({
    required this.persistence,
    required this.brightnessProfile,
  });

  final StreakPersistenceResult persistence;
  final StreakBrightnessProfile brightnessProfile;

  int get frameIndex => persistence.frameIndex;
  StreakCandidate get streak => persistence.streak as StreakCandidate;
}

/// Per-frame outcome, analogous to `milky_way_pipeline.dart`'s
/// `MilkyWayFrameDiagnostics` — records what happened to every attempted
/// frame (analyzed, or not, and why), so a caller can explain the final
/// candidate count precisely.
final class MeteorFrameDiagnostics {
  const MeteorFrameDiagnostics({
    required this.sourcePath,
    required this.analyzed,
    this.excludedReason,
    this.detectedStarCount,
    this.detectedStreakCount,
  });

  final String sourcePath;
  final bool analyzed;
  final String? excludedReason;
  final int? detectedStarCount;
  final int? detectedStreakCount;
}

/// Compact, durable star/streak analysis for one decoded frame.
///
/// Unlike [MeteorAnalysisResult], this intentionally contains no RGB tile
/// store. It is sufficient for star-trail aircraft/satellite classification
/// and gap-fill geometry, so callers may dispose the full-resolution FP32 RGB
/// immediately after this snapshot is committed.
final class MeteorCompactFrameFeatures {
  const MeteorCompactFrameFeatures({
    required this.sourcePath,
    required this.width,
    required this.height,
    required this.streaks,
    required this.stars,
    required this.likelyBlinkingByStreak,
    required this.sufficientBrightnessSamplesByStreak,
    this.brightSegmentCountByStreak,
  });

  final String sourcePath;
  final int width;
  final int height;
  final List<StreakCandidate> streaks;
  final List<DetectedStar> stars;
  final List<bool> likelyBlinkingByStreak;
  final List<bool> sufficientBrightnessSamplesByStreak;

  /// Work356: number of distinct bright segments along each streak (the
  /// basis of [likelyBlinkingByStreak]). Null for features restored from
  /// checkpoints written before Work356.
  final List<int>? brightSegmentCountByStreak;
}

/// Extracts every compact signal needed later by star-trail processing from a
/// single decoded frame. Brightness profiling is deliberately done while the
/// frame is still open, allowing the caller to delete the hundreds-of-MiB FP32
/// frame immediately afterward without changing detector thresholds or math.
Future<MeteorCompactFrameFeatures> extractMeteorCompactFrameFeatures({
  required String sourcePath,
  required LinearRgbTileStore store,
  double streakThresholdSigma = 5,
  double minStreakLength = 15,
  double minStreakElongation = 0.8,
  double minWidthUniformity = 0.3,
  double maxWidthProfileLobes = 1,
  double starDetectorThresholdSigma = 6,
  bool Function()? isCancelled,
  void Function(String stage, Duration elapsed)? reportTiming,
}) async {
  final Stopwatch greenTimer = Stopwatch()..start();
  final LuminancePlane green = await _greenChannelOfStore(
    store,
    isCancelled: isCancelled,
  );
  greenTimer.stop();
  reportTiming?.call('green-plane', greenTimer.elapsed);

  final Stopwatch streakTimer = Stopwatch()..start();
  final List<StreakCandidate> streaks = _detectContinuousAndBeadedStreaks(
    green,
    thresholdSigma: streakThresholdSigma,
    minLength: minStreakLength,
    minElongation: minStreakElongation,
    minWidthUniformity: minWidthUniformity,
    maxWidthProfileLobes: maxWidthProfileLobes,
    reportTiming: reportTiming,
  );
  streakTimer.stop();
  reportTiming?.call('streak-total', streakTimer.elapsed);

  final Stopwatch starTimer = Stopwatch()..start();
  final List<DetectedStar> stars = detectStars(
    green,
    thresholdSigma: starDetectorThresholdSigma,
  );
  starTimer.stop();
  reportTiming?.call('star-detection', starTimer.elapsed);

  final Stopwatch brightnessTimer = Stopwatch()..start();
  final List<bool> likelyBlinking = <bool>[];
  final List<bool> sufficient = <bool>[];
  final List<int> segmentCounts = <int>[];
  // Background is frame-wide, not streak-specific. Compute it once instead
  // of repeating an identical full-frame sampled sort for every candidate.
  final double? backgroundMedian =
      streaks.isEmpty ? null : estimateStreakBrightnessBackgroundMedian(green);
  for (final StreakCandidate streak in streaks) {
    if (isCancelled?.call() ?? false) {
      throw const MeteorAnalysisCancelled();
    }
    final StreakBrightnessProfile profile = analyzeStreakBrightnessProfile(
      green,
      streak,
      backgroundMedian: backgroundMedian,
    );
    likelyBlinking.add(profile.likelyBlinking);
    sufficient.add(profile.sufficientSamples);
    segmentCounts.add(profile.segmentCount);
  }
  brightnessTimer.stop();
  reportTiming?.call('streak-brightness', brightnessTimer.elapsed);
  return MeteorCompactFrameFeatures(
    sourcePath: sourcePath,
    width: store.width,
    height: store.height,
    streaks: streaks,
    stars: stars,
    likelyBlinkingByStreak: likelyBlinking,
    sufficientBrightnessSamplesByStreak: sufficient,
    brightSegmentCountByStreak: segmentCounts,
  );
}

final class MeteorAnalysisResult {
  const MeteorAnalysisResult({
    required this.candidates,
    required this.frameDiagnostics,
    required this.frameStores,
  });

  /// Every detected streak candidate across every analyzed frame, each
  /// with its persistence classification and brightness profile.
  final List<MeteorCandidate> candidates;
  final List<MeteorFrameDiagnostics> frameDiagnostics;

  /// The decoded per-frame tile stores, in the same order as
  /// [frameDiagnostics] (a `null` entry means that frame was not
  /// successfully decoded). The caller owns these afterward — needed to
  /// composite a chosen candidate later (via `streak_compositor.dart`'s
  /// `compositeSelectedStreaks`) — and must dispose them once no longer
  /// needed; this pipeline does not dispose them itself, unlike `star_
  /// trail_pipeline.dart`/`milky_way_pipeline.dart`'s combine-only
  /// functions, since meteor mode's compositing step happens later,
  /// after a human decision this pipeline cannot wait for.
  final List<LinearRgbTileStore?> frameStores;
}

/// Work307: extracts the demosaiced green samples used by the star/streak
/// detectors, but reads the RGB tile store in bounded row strips.
///
/// The returned [LuminancePlane] is still full resolution because the existing
/// star/streak detectors require random access to one scalar plane.  What this
/// removes is the additional full-frame 3-channel RGB allocation that used to
/// coexist with that plane.
Future<LuminancePlane> _greenChannelOfStore(
  LinearRgbTileStore store, {
  int rowsPerStrip = 128,
  bool Function()? isCancelled,
}) async {
  if (rowsPerStrip <= 0) {
    throw ArgumentError.value(rowsPerStrip, 'rowsPerStrip');
  }
  final int width = store.width;
  final int height = store.height;
  final Float32List green = Float32List(width * height);
  for (int y = 0; y < height; y += rowsPerStrip) {
    if (isCancelled?.call() ?? false) {
      throw const MeteorAnalysisCancelled();
    }
    final int rows = math.min(rowsPerStrip, height - y);
    final LinearRgbTile strip = await store.readRegion(
      x: 0,
      y: y,
      width: width,
      height: rows,
    );
    final int stripPixels = width * rows;
    final int destinationStart = y * width;
    for (int pixel = 0; pixel < stripPixels; pixel++) {
      green[destinationStart + pixel] = strip.interleavedRgb[pixel * 3 + 1];
    }
  }
  return LuminancePlane(width: width, height: height, samples: green);
}

/// Decodes every frame in [sourcePaths], then hands off to
/// [analyzeDecodedFrames].
///
/// Like `milky_way_pipeline.dart`'s `runMilkyWayPipeline` (and unlike
/// `star_trail_pipeline.dart`'s all-or-nothing `runStarTrailPipeline`),
/// a single frame's decode failure does not fail the whole batch — that
/// frame is simply excluded from analysis (recorded in
/// [MeteorFrameDiagnostics]) and array-position-adjacent frames become
/// each other's neighbors for cross-frame linking, matching
/// `classifyStreakPersistence`'s own documented "gaps are fine"
/// semantics exactly — a meteor sequence losing one frame to a decode
/// error should not lose every other frame's analysis along with it.
///
/// Unlike the other two pipelines' output, [MeteorAnalysisResult]'s
/// [MeteorAnalysisResult.frameStores] are **not disposed** by this
/// function — the caller needs them for a later, human-driven
/// compositing step (see this module's own doc comment) and owns their
/// lifecycle from here on.
///
/// See [analyzeDecodedFrames] for the parameters not documented here
/// (all forwarded unchanged).
Future<MeteorAnalysisResult> runMeteorAnalysisPipeline({
  required List<String> sourcePaths,
  required MeteorFrameDecodingConfig decodingConfig,
  LinearRawMosaic? masterDark,
  LinearRawMosaic? masterFlat,
  List<String>? darkFramePaths,
  List<String>? flatFramePaths,
  double streakThresholdSigma = 5,
  double minStreakLength = 15,
  double minStreakElongation = 0.8,
  double minWidthUniformity = 0.3,
  double maxWidthProfileLobes = 1,
  double starDetectorThresholdSigma = 6,
  double transformToleranceRadius = 3,
  double? maxAngleDifferenceRadians,
  double maxEndpointGap = 40,
  double skyMotionToleranceRadius = 8,
  ConcurrencyPolicy concurrencyPolicy = fullFrameRawConcurrencyPolicy,
  Future<ResourceSnapshot> Function() resourceReader =
      readDefaultResourceSnapshot,
  void Function(double progress)? reportProgress,
  Future<LinearRgbTileStore?> Function(int index)? restoreDecodedFrame,
  Future<void> Function(int index, LinearRgbTileStore store)?
      onDecodedFrameCommitted,
  Future<LinearRgbTileStore> Function(
          {required int index,
          required int width,
          required int height,
          required OverlappedTilePlan plan})?
      createFrameStore,
  bool Function()? isCancelled,
  // Makes the per-frame streak/star detection pass resumable across a
  // process death instead of always restarting it from frame zero, once
  // decode itself has already completed durably. Optional and off by
  // default: every existing caller that omits this gets exactly the same
  // in-memory-only behavior as before, since no detection algorithm below
  // changes when it is present.
  MeteorCandidateAnalysisCheckpointStore? stageCheckpoint,
}) async {
  if (sourcePaths.isEmpty) {
    throw ArgumentError.value(
      sourcePaths,
      'sourcePaths',
      'At least 1 frame is required.',
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
    throw const MeteorAnalysisCancelled();
  }

  final List<LinearRgbTileStore?> frameStores =
      List<LinearRgbTileStore?>.filled(sourcePaths.length, null);
  final Map<int, Object?> decodeFailures = <int, Object?>{};

  late final JobScheduler scheduler;
  scheduler = JobScheduler(
    executor: (ProcessingJob job, void Function(double) frameProgress) async {
      // Checked once per frame, before starting its native decode — the
      // same safe-point pattern used for the standard stack background
      // worker's own scheduler. Does not attempt to interrupt a decode
      // already in flight; it only stops the scheduler from starting any
      // further not-yet-started frames.
      if (isCancelled?.call() ?? false) {
        scheduler.cancelAll();
        return Future<void>.value();
      }
      final int frameIndex = int.parse(job.id.split('#').last);
      final restored = await restoreDecodedFrame?.call(frameIndex);
      if (restored != null) {
        frameStores[frameIndex] = restored;
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
        rgbTileStoreFactory: createFrameStore == null
            ? decodingConfig.rgbTileStoreFactory
            : (
                    {required int width,
                    required int height,
                    required OverlappedTilePlan plan}) =>
                createFrameStore(
                    index: frameIndex,
                    width: width,
                    height: height,
                    plan: plan),
        masterDark: effectiveMasterDark,
        masterFlat: effectiveMasterFlat,
        masterDarkStore: effectiveMasterDarkStore,
        masterFlatStore: effectiveMasterFlatStore,
        preferStreamedRawCalibration: true,
        onTileStoreReady: (LinearRgbTileStore tileStore) async {
          await onDecodedFrameCommitted?.call(frameIndex, tileStore);
          frameStores[frameIndex] = tileStore;
        },
      );
    },
    resourceReader: resourceReader,
    policy: concurrencyPolicy,
  );

  final List<ProcessingJob> jobs = <ProcessingJob>[
    for (int index = 0; index < sourcePaths.length; index++)
      ProcessingJob(
        id: 'meteor-frame#$index',
        mode: ProcessingMode.meteor,
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

  if (isCancelled?.call() ?? false) {
    for (final LinearRgbTileStore? store in frameStores) {
      try {
        await store?.dispose();
      } on Object {
        // Best-effort cleanup — a cancellation is already in progress.
      }
    }
    throw const MeteorAnalysisCancelled();
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

  return analyzeDecodedFrames(
    sourcePaths: sourcePaths,
    frameStores: frameStores,
    decodeFailures: decodeFailures,
    streakThresholdSigma: streakThresholdSigma,
    minStreakLength: minStreakLength,
    minStreakElongation: minStreakElongation,
    minWidthUniformity: minWidthUniformity,
    maxWidthProfileLobes: maxWidthProfileLobes,
    starDetectorThresholdSigma: starDetectorThresholdSigma,
    transformToleranceRadius: transformToleranceRadius,
    maxAngleDifferenceRadians: maxAngleDifferenceRadians,
    maxEndpointGap: maxEndpointGap,
    skyMotionToleranceRadius: skyMotionToleranceRadius,
    isCancelled: isCancelled,
    stageCheckpoint: stageCheckpoint,
  );
}

/// Analyzes already-decoded [frameStores] (any entry may be `null`,
/// meaning that frame failed to decode — see [decodeFailures], keyed by
/// index into [sourcePaths]/[frameStores]).
///
/// Split out from [runMeteorAnalysisPipeline] deliberately, matching
/// `star_trail_pipeline.dart`'s `combineDecodedFrames`/`milky_way_
/// pipeline.dart`'s `registerAndCombineDecodedFrames`: this is the part
/// with genuinely new orchestration logic worth testing directly against
/// hand-built fake tile stores, independent of `JobScheduler`-driven
/// decode orchestration.
///
/// Unlike the Milky Way pipeline's registration (which needs a single
/// chosen reference frame everything else registers against), sky-
/// motion registration here is pairwise between every array-position-
/// adjacent pair of *analyzed* frames (skipping unanalyzed ones exactly
/// as `classifyStreakPersistence` itself treats a gap) — there is no
/// single "reference frame" for meteor mode, since every frame is
/// independently a candidate source, not something being stacked onto a
/// common grid. A pair whose star registration fails (too few stars, no
/// consistent transform) simply contributes a `null` sky transform for
/// that pair — `classifyStreakPersistence` already treats a `null`
/// transform as "sky-motion-consistency unknown for this link" rather
/// than an error, so one bad registration pair does not abort the whole
/// analysis.
Future<MeteorAnalysisResult> analyzeDecodedFrames({
  required List<String> sourcePaths,
  required List<LinearRgbTileStore?> frameStores,
  required Map<int, Object?> decodeFailures,
  double streakThresholdSigma = 5,
  double minStreakLength = 15,
  double minStreakElongation = 0.8,
  double minWidthUniformity = 0.3,
  double maxWidthProfileLobes = 1,
  double starDetectorThresholdSigma = 6,
  double transformToleranceRadius = 3,
  double? maxAngleDifferenceRadians,
  double maxEndpointGap = 40,
  double skyMotionToleranceRadius = 8,
  bool Function()? isCancelled,
  MeteorCandidateAnalysisCheckpointStore? stageCheckpoint,
}) async {
  if (sourcePaths.length != frameStores.length) {
    throw ArgumentError(
      'sourcePaths and frameStores must have the same length.',
    );
  }

  final List<MeteorFrameDiagnostics> diagnostics =
      List<MeteorFrameDiagnostics>.filled(
    sourcePaths.length,
    const MeteorFrameDiagnostics(sourcePath: '', analyzed: false),
  );

  // Analyzed (successfully decoded) frames only, keeping their original
  // index alongside so results can be mapped back to `sourcePaths`.
  final List<int> analyzedIndices = <int>[];
  final List<List<StreakGeometry>> streaksByFrame = <List<StreakGeometry>>[];
  final List<List<StarPoint>> starsByFrame = <List<StarPoint>>[];
  // Do not retain one full-resolution green plane per analyzed frame.
  // Brightness profiles are evaluated in a second, candidate-only pass so
  // peak memory stays bounded by one frame instead of scaling with frame count.

  for (int index = 0; index < frameStores.length; index++) {
    if (isCancelled?.call() ?? false) {
      throw const MeteorAnalysisCancelled();
    }
    final MeteorCandidateCheckpointFrame? restored =
        await stageCheckpoint?.restoreFrame(index);
    if (restored != null && frameStores[index] != null && restored.analyzed) {
      if (!restored.analyzed) {
        diagnostics[index] = MeteorFrameDiagnostics(
          sourcePath: sourcePaths[index],
          analyzed: false,
          excludedReason: restored.excludedReason,
        );
      } else {
        diagnostics[index] = MeteorFrameDiagnostics(
          sourcePath: sourcePaths[index],
          analyzed: true,
          detectedStarCount: restored.stars.length,
          detectedStreakCount: restored.streaks.length,
        );
        analyzedIndices.add(index);
        streaksByFrame.add(restored.streaks.cast<StreakGeometry>());
        starsByFrame.add(restored.stars);
      }
      continue;
    }
    final LinearRgbTileStore? store = frameStores[index];
    if (store == null) {
      final MeteorFrameDiagnostics excluded = MeteorFrameDiagnostics(
        sourcePath: sourcePaths[index],
        analyzed: false,
        excludedReason: decodeFailures.containsKey(index)
            ? 'decode failed: ${decodeFailures[index]}'
            : 'decode did not complete',
      );
      diagnostics[index] = excluded;
      await stageCheckpoint?.recordFrame(
        index,
        MeteorCandidateCheckpointFrame(
          analyzed: false,
          excludedReason: excluded.excludedReason,
          streaks: const <StreakCandidate>[],
          stars: const <DetectedStar>[],
        ),
      );
      continue;
    }

    final LuminancePlane green = await _greenChannelOfStore(
      store,
      isCancelled: isCancelled,
    );
    final List<StreakCandidate> streaks = _detectContinuousAndBeadedStreaks(
      green,
      thresholdSigma: streakThresholdSigma,
      minLength: minStreakLength,
      minElongation: minStreakElongation,
      minWidthUniformity: minWidthUniformity,
      maxWidthProfileLobes: maxWidthProfileLobes,
    );
    final List<StarPoint> stars = detectStars(
      green,
      thresholdSigma: starDetectorThresholdSigma,
    );
    final List<DetectedStar> concreteStars = stars.cast<DetectedStar>();

    diagnostics[index] = MeteorFrameDiagnostics(
      sourcePath: sourcePaths[index],
      analyzed: true,
      detectedStarCount: stars.length,
      detectedStreakCount: streaks.length,
    );
    analyzedIndices.add(index);
    streaksByFrame.add(streaks.cast<StreakGeometry>());
    starsByFrame.add(concreteStars);
    await stageCheckpoint?.recordFrame(
      index,
      MeteorCandidateCheckpointFrame(
        analyzed: true,
        excludedReason: null,
        streaks: streaks,
        stars: concreteStars,
      ),
    );
  }

  if (analyzedIndices.isEmpty) {
    /* Worker clears the checkpoint after durable final output. */
    return MeteorAnalysisResult(
      candidates: const <MeteorCandidate>[],
      frameDiagnostics: diagnostics,
      frameStores: frameStores,
    );
  }

  // Pairwise sky-motion registration between every array-position-
  // adjacent pair of *analyzed* frames.
  final List<SimilarityTransformEstimate?> skyTransforms =
      <SimilarityTransformEstimate?>[];
  for (int i = 0; i < analyzedIndices.length - 1; i++) {
    if (isCancelled?.call() ?? false) {
      throw const MeteorAnalysisCancelled();
    }
    try {
      final StarSimilarityTransformEstimate estimate =
          estimateSimilarityTransform(
        starsByFrame[i],
        starsByFrame[i + 1],
        toleranceRadius: transformToleranceRadius,
        minInliers: 5,
      );
      skyTransforms.add(estimate);
    } on Object {
      skyTransforms.add(null);
    }
  }

  final List<StreakFrame> framesInOrder = <StreakFrame>[
    for (int i = 0; i < analyzedIndices.length; i++)
      StreakFrame(frameIndex: analyzedIndices[i], streaks: streaksByFrame[i]),
  ];
  final List<StreakPersistenceResult> persistenceResults =
      classifyStreakPersistence(
    framesInOrder,
    maxAngleDifferenceRadians: maxAngleDifferenceRadians,
    maxEndpointGap: maxEndpointGap,
    skyTransforms: skyTransforms,
    skyMotionToleranceRadius: skyMotionToleranceRadius,
  );
  // Brightness-profile analysis is intentionally a second pass over only
  // frames that actually contain persistence candidates. This trades a small
  // amount of file-backed RGB I/O for bounded memory: no full-resolution green
  // plane survives from the detection pass, and at most one candidate frame's
  // RGB + green plane is live here at a time.
  final List<MeteorCandidate?> candidateSlots =
      List<MeteorCandidate?>.filled(persistenceResults.length, null);
  final Map<int, List<int>> candidatePositionsByFrame = <int, List<int>>{};
  for (int position = 0; position < persistenceResults.length; position++) {
    candidatePositionsByFrame
        .putIfAbsent(
          persistenceResults[position].frameIndex,
          () => <int>[],
        )
        .add(position);
  }
  for (final MapEntry<int, List<int>> entry
      in candidatePositionsByFrame.entries) {
    if (isCancelled?.call() ?? false) {
      throw const MeteorAnalysisCancelled();
    }
    final LinearRgbTileStore? store = frameStores[entry.key];
    if (store == null) {
      throw StateError(
        'Meteor candidate frame ${entry.key} is no longer available.',
      );
    }
    final LuminancePlane green = await _greenChannelOfStore(
      store,
      isCancelled: isCancelled,
    );
    final double backgroundMedian =
        estimateStreakBrightnessBackgroundMedian(green);
    for (final int position in entry.value) {
      final StreakPersistenceResult persistence = persistenceResults[position];
      candidateSlots[position] = MeteorCandidate(
        persistence: persistence,
        brightnessProfile: analyzeStreakBrightnessProfile(
          green,
          persistence.streak,
          backgroundMedian: backgroundMedian,
        ),
      );
    }
  }
  final List<MeteorCandidate> candidates = <MeteorCandidate>[
    for (final MeteorCandidate? candidate in candidateSlots) candidate!,
  ];

  /* Worker clears the checkpoint after durable final output. */
  return MeteorAnalysisResult(
    candidates: candidates,
    frameDiagnostics: diagnostics,
    frameStores: frameStores,
  );
}
