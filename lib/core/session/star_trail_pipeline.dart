import '../image/file_backed_linear_rgb_tile_store.dart';
import '../stacking/foreground_region.dart';
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
import '../image/linear_contribution_tile.dart';
import '../image/linear_contribution_tile_store.dart';
import '../models/processing_mode.dart';
import '../meteor/streak_persistence_classifier.dart';
import '../meteor/streak_shape.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_file_probe.dart';
import '../raw/raw_metadata_probe.dart';
import '../registration/tiled_affine_rgb_resampler.dart'
    show CoveredLinearRgbTile;
import '../registration/star_transform_estimator.dart';
import '../registration/similarity_transform_math.dart';
import '../stacking/tiled_lighten_blend_combiner.dart';
import '../stacking/star_trail_edge_fade.dart';
import '../stacking/star_trail_reference_foreground_protection.dart';
import 'meteor_pipeline.dart'
    show
        MeteorCandidate,
        MeteorAnalysisResult,
        MeteorCompactFrameFeatures,
        analyzeDecodedFrames;
import '../tiles/overlapped_tile_plan.dart';

/// Wires together the pieces built across Work40-52 into one working
/// star trail (星の軌跡) pipeline: given N source RAW file paths, decode
/// and demosaic every frame (reusing the exact per-frame phase 2
/// pipeline every mode already shares), then combine them via lighten
/// blend into one final tile store — closing the gap
/// WORK52_PROGRESS.md identified (every mode currently discards its
/// per-frame output with nothing to combine it into) for this specific,
/// simplest mode.
///
/// What this does *not* do, deliberately, matching WORK52_PROGRESS.md's
/// staged plan: it does not write the final result to a durable file or
/// display it anywhere — there is still no results/gallery screen
/// anywhere in this project (see that note), so this stops at producing
/// a finished, [LinearRgbTileStore]-backed result and leaves "save and
/// show it" as later, separate work.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it). Run `test/star_trail_pipeline_test.
/// dart` before relying on this in production; that test file covers
/// [combineDecodedFrames] directly (the part with genuinely new,
/// non-trivial logic) but cannot exercise [runStarTrailPipeline]'s own
/// `JobScheduler`-driven orchestration without a real or fake decoder
/// pipeline wired end to end — noted as a real, currently-open testing
/// gap in this module's own doc comments below, not glossed over.

/// Everything [runStarTrailPipeline] needs to decode and demosaic each
/// source frame, matching [runPhase2ValidatedJob]'s own required
/// parameters. Grouped into one object so [runStarTrailPipeline]'s own
/// parameter list doesn't have to repeat every one of them.
final class StarTrailFrameDecodingConfig {
  const StarTrailFrameDecodingConfig({
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

/// Thrown when one or more source frames failed to decode/demosaic;
/// [failures] maps each failed source path to the error it raised.
/// Whatever frames *did* succeed are disposed before this is thrown
/// (see [runStarTrailPipeline]'s doc comment) — a partial star trail
/// from an incomplete frame set would silently misrepresent the
/// sequence, so this fails the whole batch rather than combining
/// whatever happened to succeed.
class StarTrailFrameDecodingFailed implements Exception {
  const StarTrailFrameDecodingFailed(this.failures);

  final Map<String, Object?> failures;

  @override
  String toString() =>
      'StarTrailFrameDecodingFailed: ${failures.length} of the source '
      'frames failed: ${failures.keys.join(', ')}';
}

/// Decodes and demosaics every frame in [sourcePaths] (via the existing,
/// mode-agnostic [runPhase2ValidatedJob] pipeline, run concurrently
/// through a [JobScheduler]), then combines all of them via
/// [TiledLightenBlendCombiner] into one final [LinearRgbTileStore].
///
/// - [sourcePaths]: at least 2 RAW file paths, in capture order (lighten
///   blend itself doesn't care about order, but a star trail's own
///   temporal identity does, for anyone inspecting intermediate frames).
/// - [decodingConfig]: forwarded to every per-frame [runPhase2ValidatedJob]
///   call.
/// - [outputTileStoreFactory]: builds the store the *combined* result is
///   written into — a separate factory from
///   [StarTrailFrameDecodingConfig.rgbTileStoreFactory], since the two
///   stores serve different purposes (N short-lived per-frame sources
///   the pipeline itself disposes once combined, versus one longer-lived
///   combined result the caller owns afterward).
/// - [keepHighest], [minimumCoveringFrames]: forwarded to
///   [TiledLightenBlendCombiner]; see that class and `lighten_blend_
///   combiner.dart` for their meaning.
/// - [tileSize]: the *output* tile size used both for reading each
///   source frame's regions and for writing the combined result;
///   overlap is always 0, since lighten blend (unlike registration-
///   based resampling) never needs a neighboring-pixel margin — each
///   output pixel only ever depends on the exact same pixel position
///   in each source frame.
/// - [concurrencyPolicy] (default `fullFrameRawConcurrencyPolicy`,
///   matching `processing_progress_screen.dart`'s own choice for the
///   same reason: a full-frame RAW job retains a large FP32 CFA buffer
///   through the quality pipeline, so serializing frames avoids
///   multiplying that peak allocation): forwarded to the [JobScheduler]
///   driving the per-frame decode/demosaic stage.
/// - [isCancelled]: checked before each output tile during the
///   *combination* stage only (forwarded to [combineDecodedFrames]) —
///   this does **not** currently stop an in-progress *decode/demosaic*
///   stage partway through; each individual per-frame job's own
///   [ProcessingJob.cancellationRequested] would need to be set instead
///   for that (e.g. by a caller holding references to the [ProcessingJob]
///   objects this function creates internally, which it does not
///   currently expose). This is a real, documented scope limitation, not
///   an oversight: wiring full cross-stage cancellation would mean
///   polling [isCancelled] from within the [JobScheduler]-driven loop
///   too and calling `requestCancellation()` on every in-flight job,
///   which was left out to keep this function's first version to a
///   reviewable size.
///
/// Throws [ArgumentError] if fewer than 2 source paths are given (a
/// "star trail" of one frame is meaningless), or
/// [StarTrailFrameDecodingFailed] if any frame's decode/demosaic step
/// fails — no partial combination is attempted, and every frame that did
/// succeed before the failure was noticed is disposed before the error
/// is thrown, so no temporary per-frame storage is leaked.
Future<LinearRgbTileStore> runStarTrailPipeline({
  required List<String> sourcePaths,
  required StarTrailFrameDecodingConfig decodingConfig,
  required LinearRgbTileStoreFactory outputTileStoreFactory,
  LinearRawMosaic? masterDark,
  LinearRawMosaic? masterFlat,
  List<String>? darkFramePaths,
  List<String>? flatFramePaths,
  int keepHighest = 1,
  int minimumCoveringFrames = 1,
  int tileSize = 512,
  StarTrailFadeSettings fadeSettings = const StarTrailFadeSettings(),
  ConcurrencyPolicy concurrencyPolicy = fullFrameRawConcurrencyPolicy,
  Future<ResourceSnapshot> Function() resourceReader =
      readDefaultResourceSnapshot,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
}) async {
  if (sourcePaths.length < 2) {
    throw ArgumentError.value(
      sourcePaths,
      'sourcePaths',
      'At least 2 frames are required for a star trail.',
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
    throw const TiledLightenBlendCancelled();
  }

  // frameStores[i] stays null until frame i's job hands off its
  // committed tile store via onTileStoreReady; using a fixed-size,
  // index-addressed list (rather than appending to a shared growable
  // list from concurrent job callbacks) keeps each frame's store
  // unambiguously associated with its own source path regardless of
  // which order the concurrently-running jobs actually finish in.
  final List<LinearRgbTileStore?> frameStores =
      List<LinearRgbTileStore?>.filled(sourcePaths.length, null);

  final JobScheduler scheduler = JobScheduler(
    executor: (ProcessingJob job, void Function(double) frameProgress) {
      final int frameIndex = int.parse(job.id.split('#').last);
      return runPhase2ValidatedJob(
        job,
        frameProgress,
        probe: decodingConfig.probe,
        metadataProbe: decodingConfig.metadataProbe,
        decoderRegistry: decodingConfig.decoderRegistry,
        demosaicRegistry: decodingConfig.demosaicRegistry,
        rgbTileStoreFactory: decodingConfig.rgbTileStoreFactory,
        masterDark: effectiveMasterDark,
        masterFlat: effectiveMasterFlat,
        masterDarkStore: effectiveMasterDarkStore,
        masterFlatStore: effectiveMasterFlatStore,
        preferStreamedRawCalibration: true,
        onTileStoreReady: (LinearRgbTileStore tileStore) {
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
        id: 'star-trail-frame#$index',
        mode: ProcessingMode.starTrail,
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

  final Map<String, Object?> failures = <String, Object?>{};
  for (int index = 0; index < jobs.length; index++) {
    final ProcessingJob job = jobs[index];
    if (job.state == ProcessingJobState.failed) {
      failures[sourcePaths[index]] = job.error;
    } else if (job.state != ProcessingJobState.completed) {
      failures[sourcePaths[index]] =
          StateError('Frame ended in unexpected state ${job.state}.');
    }
  }

  if (failures.isNotEmpty) {
    await _disposeStarTrailStoresBestEffort(frameStores);
    throw StarTrailFrameDecodingFailed(failures);
  }

  final List<LinearRgbTileStore> readyStores =
      frameStores.cast<LinearRgbTileStore>();
  try {
    return await combineDecodedFrames(
      frameStores: readyStores,
      outputTileStoreFactory: outputTileStoreFactory,
      keepHighest: keepHighest,
      minimumCoveringFrames: minimumCoveringFrames,
      tileSize: tileSize,
      fadeSettings: fadeSettings,
      reportProgress: reportProgress,
      isCancelled: isCancelled,
    );
  } finally {
    await _disposeStarTrailStoresBestEffort(readyStores);
  }
}

Future<void> _disposeStarTrailStoresBestEffort(
  Iterable<LinearRgbTileStore?> stores,
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

/// Detects only high-confidence non-sidereal streaks for star-trail
/// rejection. A streak is rejected when either:
/// - cross-frame motion is explicitly inconsistent with the estimated star
///   field motion (`independentMotion`), or
/// - its along-streak brightness profile contains multiple separated bright
///   runs (`likelyBlinking`), characteristic of aircraft navigation lights.
///
/// `skyMotion` candidates are deliberately never rejected: they are
/// consistent with the stellar field and therefore may be genuine star-trail
/// structure. Isolated continuous streaks are also retained because a
/// single-frame continuous line cannot be robustly distinguished from a
/// meteor using image pixels alone.
Future<List<List<StreakShape>>> detectStarTrailNonSiderealStreaks({
  required List<String> sourcePaths,
  required List<LinearRgbTileStore> frameStores,
  bool Function()? isCancelled,
}) async {
  if (sourcePaths.length != frameStores.length) {
    throw ArgumentError(
      'sourcePaths and frameStores must have the same length.',
    );
  }
  final MeteorAnalysisResult analysis = await analyzeDecodedFrames(
    sourcePaths: sourcePaths,
    frameStores: frameStores,
    decodeFailures: const <int, Object?>{},
    isCancelled: isCancelled,
  );
  final List<List<StreakShape>> rejected = <List<StreakShape>>[
    for (int i = 0; i < frameStores.length; i++) <StreakShape>[],
  ];
  for (final MeteorCandidate candidate in analysis.candidates) {
    final StreakPersistenceCategory category = candidate.persistence.category;
    final bool independentMotion =
        category == StreakPersistenceCategory.independentMotion;
    final bool blinkingAircraft =
        candidate.brightnessProfile.sufficientSamples &&
            candidate.brightnessProfile.likelyBlinking;
    final bool preserveAsSkyMotion =
        category == StreakPersistenceCategory.skyMotion;
    if (!preserveAsSkyMotion && (independentMotion || blinkingAircraft)) {
      rejected[candidate.frameIndex].add(candidate.streak);
    }
  }
  return rejected;
}

/// A coverage mask marking every pixel of a `width`x`height` region as
/// covered — the right mask for a region read directly out of an
/// already-complete, already-demosaiced per-frame tile store (unlike a
/// registration-resampled tile, nothing in this read can be partially
/// out of bounds or otherwise invalid).
Uint8List _fullCoverage(int width, int height) =>
    Uint8List(width * height)..fillRange(0, width * height, 1);

double _squaredDistanceToStarTrailSegment(
  double px,
  double py,
  double x0,
  double y0,
  double x1,
  double y1,
) {
  final double dx = x1 - x0;
  final double dy = y1 - y0;
  final double lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) {
    final double ox = px - x0;
    final double oy = py - y0;
    return ox * ox + oy * oy;
  }
  final double projection = ((px - x0) * dx + (py - y0) * dy) / lengthSquared;
  final double t = projection.clamp(0.0, 1.0).toDouble();
  final double closestX = x0 + t * dx;
  final double closestY = y0 + t * dy;
  final double ox = px - closestX;
  final double oy = py - closestY;
  return ox * ox + oy * oy;
}

/// Returns full coverage except around conservatively classified aircraft or
/// satellite streaks. The mask is generated per band, so memory stays bounded
/// by the existing tiled combine size instead of allocating full-frame masks.
Uint8List _coverageExcludingStarTrailStreaks(
  LinearRgbTile tile,
  List<StreakShape> streaks, {
  double paddingPixels = 3,
}) {
  final Uint8List coverage = _fullCoverage(tile.width, tile.height);
  if (streaks.isEmpty) return coverage;
  for (final StreakShape streak in streaks) {
    if (streak.endpoints.length != 2) continue;
    final ({double x, double y}) a = streak.endpoints[0];
    final ({double x, double y}) b = streak.endpoints[1];
    final double radius = math.max(1.0, streak.width / 2 + paddingPixels);
    final double radiusSquared = radius * radius;
    final int localMinX = math.max(
      0,
      (math.min(a.x, b.x) - radius).floor() - tile.x,
    );
    final int localMaxX = math.min(
      tile.width - 1,
      (math.max(a.x, b.x) + radius).ceil() - tile.x,
    );
    final int localMinY = math.max(
      0,
      (math.min(a.y, b.y) - radius).floor() - tile.y,
    );
    final int localMaxY = math.min(
      tile.height - 1,
      (math.max(a.y, b.y) + radius).ceil() - tile.y,
    );
    if (localMinX > localMaxX || localMinY > localMaxY) continue;
    for (int y = localMinY; y <= localMaxY; y++) {
      final double globalY = (tile.y + y).toDouble();
      for (int x = localMinX; x <= localMaxX; x++) {
        final double globalX = (tile.x + x).toDouble();
        if (_squaredDistanceToStarTrailSegment(
              globalX,
              globalY,
              a.x,
              a.y,
              b.x,
              b.y,
            ) <=
            radiusSquared) {
          coverage[y * tile.width + x] = 0;
        }
      }
    }
  }
  return coverage;
}

/// Combines already-decoded [frameStores] (all the same dimensions —
/// mismatched frame sizes are rejected outright, since lighten blend
/// has no resampling step to reconcile them) via
/// [TiledLightenBlendCombiner], tile by tile per an
/// [OverlappedTilePlan] built from [tileSize] with zero overlap, into
/// one new tile store built from [outputTileStoreFactory].
///
/// Split out from [runStarTrailPipeline] deliberately: this is the part
/// with genuinely new combination logic worth testing directly against
/// hand-built fake tile stores, independent of `JobScheduler`-driven
/// decode orchestration (which is mostly wiring, not new logic, in
/// [runStarTrailPipeline] itself). Does not dispose [frameStores] itself
/// — the caller (here, [runStarTrailPipeline]) owns that decision, since
/// a caller combining already-owned stores it wants to keep around
/// (e.g. for a future "revise which frames are included" UI) needs the
/// choice not to be made for it.
Future<LinearRgbTileStore> combineDecodedFrames({
  required List<LinearRgbTileStore> frameStores,
  required LinearRgbTileStoreFactory outputTileStoreFactory,
  int keepHighest = 1,
  int minimumCoveringFrames = 1,
  int tileSize = 512,
  List<List<StreakShape>>? excludedStreaksByFrame,
  LinearRgbTileStore? referenceForegroundStore,
  bool preserveReferenceForeground = false,
  ForegroundRegion? foregroundRegion,
  StarTrailFadeSettings fadeSettings = const StarTrailFadeSettings(),
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
}) async {
  if (frameStores.length < 2) {
    throw ArgumentError.value(
      frameStores,
      'frameStores',
      'At least 2 frames are required for a star trail.',
    );
  }
  final int width = frameStores.first.width;
  final int height = frameStores.first.height;
  for (final LinearRgbTileStore store in frameStores) {
    if (store.width != width || store.height != height) {
      throw ArgumentError(
        'All frame stores must share the same dimensions; got '
        '${store.width}x${store.height} alongside ${width}x$height.',
      );
    }
  }
  if (excludedStreaksByFrame != null &&
      excludedStreaksByFrame.length != frameStores.length) {
    throw ArgumentError(
      'excludedStreaksByFrame must match frameStores length.',
    );
  }
  if (preserveReferenceForeground) {
    if (foregroundRegion == null) throw ArgumentError('地上光抑制の対象領域を指定してください。');
    if (referenceForegroundStore == null) {
      throw ArgumentError(
        'referenceForegroundStore is required when foreground protection is enabled.',
      );
    }
    if (referenceForegroundStore.width != width ||
        referenceForegroundStore.height != height) {
      throw ArgumentError(
        'referenceForegroundStore must match the star-trail frame dimensions.',
      );
    }
  }

  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore outputStore = await (preserveReferenceForeground
      ? FileBackedLinearRgbTileStore.createTemporary
      : outputTileStoreFactory)(
    width: width,
    height: height,
    plan: plan,
  );

  final TiledLightenBlendCombiner combiner = TiledLightenBlendCombiner(
    keepHighest: keepHighest,
    minimumCoveringFrames: minimumCoveringFrames,
  );
  final List<double> frameWeights = computeStarTrailFadeWeights(
    frameCount: frameStores.length,
    settings: fadeSettings,
  );
  bool committed = false;
  try {
    for (int index = 0; index < plan.tiles.length; index++) {
      if (isCancelled?.call() ?? false) {
        throw const TiledLightenBlendCancelled();
      }
      final OverlappedTile outputTile = plan.tiles[index];
      final LightenBlendStackedRgbTile combined = await combiner.combineTile(
        frameCount: frameStores.length,
        outputTile: outputTile,
        frameWeights: frameWeights,
        readFrame: (int frameIndex, OverlappedTile region) async {
          final LinearRgbTile tile = await frameStores[frameIndex].readRegion(
            x: region.outputX,
            y: region.outputY,
            width: region.outputWidth,
            height: region.outputHeight,
          );
          final List<StreakShape> excluded =
              excludedStreaksByFrame?[frameIndex] ?? const <StreakShape>[];
          return CoveredLinearRgbTile(
            tile: tile,
            coverage: _coverageExcludingStarTrailStreaks(tile, excluded),
          );
        },
        isCancelled: isCancelled,
      );
      await outputStore.writeTile(combined.tile);
      reportProgress?.call((index + 1) / plan.tiles.length);
    }
    await outputStore.commit();
    committed = true;
    if (preserveReferenceForeground) {
      try {
        return await applyStarTrailReferenceForegroundToStore(
            combinedStore: outputStore,
            referenceStore: referenceForegroundStore!,
            foregroundRegion: foregroundRegion!,
            outputStoreFactory: outputTileStoreFactory,
            tileSize: tileSize,
            isCancelled: isCancelled);
      } finally {
        await outputStore.dispose();
      }
    }
    return outputStore;
  } finally {
    if (!committed) await outputStore.abort();
  }
}

/// Work364: enables the fused star-trail path (analysis-pass premerge of
/// frames that cannot receive streak exclusions). Output is identical to the
/// in-order path; set to false to force the historical two full passes.
const bool starTrailFusedPremergeEnabled = true;

/// Work356: blink segments an isolated (single-frame) streak needs before
/// meteor protection lets the blinking rule remove it.
const int starTrailMeteorProtectionMinimumBlinkSegments = 4;

/// Classifies compact first-pass frame features with the same persistence and
/// blinking rules used by [detectStarTrailNonSiderealStreaks], without
/// requiring any full-resolution RGB frame to remain on disk.
List<List<StreakShape>> classifyStarTrailNonSiderealCompactFeatures({
  required List<MeteorCompactFrameFeatures> frames,
  double transformToleranceRadius = 3,
  double? maxAngleDifferenceRadians,
  double maxEndpointGap = 40,
  double skyMotionToleranceRadius = 8,
  // Work356 (meteor protection): when non-null, a streak that appears in
  // a single frame only (category isolated — the meteor pattern) is
  // removed for "blinking" only if it has at least this many distinct
  // bright segments. Aircraft strobes produce many segments during a
  // multi-second exposure; a flaring or fragmenting meteor produces two or
  // three. Null keeps the historical rule (two segments suffice).
  int? minimumBlinkSegmentsForIsolated,
}) {
  final List<List<StreakShape>> rejected = <List<StreakShape>>[
    for (int i = 0; i < frames.length; i++) <StreakShape>[],
  ];
  if (frames.isEmpty) return rejected;

  final List<SimilarityTransformEstimate?> skyTransforms =
      <SimilarityTransformEstimate?>[];
  for (int i = 0; i < frames.length - 1; i++) {
    try {
      skyTransforms.add(estimateSimilarityTransform(
        frames[i].stars,
        frames[i + 1].stars,
        toleranceRadius: transformToleranceRadius,
        minInliers: 5,
      ));
    } on Object {
      skyTransforms.add(null);
    }
  }

  final List<StreakFrame> persistenceFrames = <StreakFrame>[
    for (int i = 0; i < frames.length; i++)
      StreakFrame(frameIndex: i, streaks: frames[i].streaks),
  ];
  final List<StreakPersistenceResult> persistence = classifyStreakPersistence(
    persistenceFrames,
    maxAngleDifferenceRadians: maxAngleDifferenceRadians,
    maxEndpointGap: maxEndpointGap,
    skyTransforms: skyTransforms,
    skyMotionToleranceRadius: skyMotionToleranceRadius,
  );

  final List<int> nextStreakIndex = List<int>.filled(frames.length, 0);
  for (final StreakPersistenceResult result in persistence) {
    final int frameIndex = result.frameIndex;
    final int streakIndex = nextStreakIndex[frameIndex]++;
    final MeteorCompactFrameFeatures frame = frames[frameIndex];
    bool blinking = streakIndex < frame.likelyBlinkingByStreak.length &&
        streakIndex < frame.sufficientBrightnessSamplesByStreak.length &&
        frame.sufficientBrightnessSamplesByStreak[streakIndex] &&
        frame.likelyBlinkingByStreak[streakIndex];
    final List<int>? segmentCounts = frame.brightSegmentCountByStreak;
    if (blinking &&
        minimumBlinkSegmentsForIsolated != null &&
        result.category == StreakPersistenceCategory.isolated &&
        segmentCounts != null &&
        streakIndex < segmentCounts.length &&
        segmentCounts[streakIndex] < minimumBlinkSegmentsForIsolated) {
      blinking = false;
    }
    final bool independentMotion =
        result.category == StreakPersistenceCategory.independentMotion;
    final bool preserveAsSkyMotion =
        result.category == StreakPersistenceCategory.skyMotion;
    if (!preserveAsSkyMotion && (independentMotion || blinking)) {
      rejected[frameIndex].add(result.streak);
    }
  }
  return rejected;
}

/// Exact rolling comparison-light merge for `keepHighest == 1` and
/// `minimumCoveringFrames == 1`. The accumulator carries a durable uint16
/// validity store so uncovered pixels are never confused with numeric zero;
/// this preserves negative linear samples exactly.
Future<
    ({
      LinearRgbTileStore rgb,
      LinearContributionTileStore validity,
    })> mergeStarTrailFrameIntoRollingAccumulator({
  required LinearRgbTileStore frameStore,
  required LinearRgbTileStoreFactory outputRgbStoreFactory,
  required LinearContributionTileStoreFactory outputValidityStoreFactory,
  LinearRgbTileStore? previousRgb,
  LinearContributionTileStore? previousValidity,
  List<StreakShape> excludedStreaks = const <StreakShape>[],
  int tileSize = 512,

  /// Multiplies this frame's brightness before it competes with the
  /// running max, so a caller fading the sequence's start/end (see
  /// `star_trail_edge_fade.dart`) can pass a value below `1.0` for
  /// frames near either edge. `1.0` (the default) reproduces the
  /// previous unweighted behavior exactly.
  double frameWeight = 1.0,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
  // Work364: when set, called if any pixel ties the running value at zero
  // with the opposite sign (+0.0 vs -0.0). Only such ties can make the
  // result depend on merge order; the fused (out-of-order) star-trail path
  // uses this to fall back to the in-order path. Null: no check (legacy).
  void Function()? onSignedZeroTie,
}) async {
  if ((previousRgb == null) != (previousValidity == null)) {
    throw ArgumentError(
        'previousRgb and previousValidity must be supplied together.');
  }
  if (previousRgb != null &&
      (previousRgb.width != frameStore.width ||
          previousRgb.height != frameStore.height ||
          previousValidity!.width != frameStore.width ||
          previousValidity.height != frameStore.height)) {
    throw ArgumentError(
        'Rolling accumulator dimensions do not match the frame.');
  }

  final int width = frameStore.width;
  final int height = frameStore.height;
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore outRgb = await outputRgbStoreFactory(
    width: width,
    height: height,
    plan: plan,
  );
  LinearContributionTileStore? outValidity;
  bool committed = false;
  try {
    outValidity = await outputValidityStoreFactory(
      width: width,
      height: height,
      plan: plan,
    );
    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw const TiledLightenBlendCancelled();
      }
      final OverlappedTile region = plan.tiles[tileIndex];
      final LinearRgbTile frame = await frameStore.readRegion(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
      );
      final Uint8List frameCoverage =
          _coverageExcludingStarTrailStreaks(frame, excludedStreaks);
      final LinearRgbTile? prior = previousRgb == null
          ? null
          : await previousRgb.readRegion(
              x: region.outputX,
              y: region.outputY,
              width: region.outputWidth,
              height: region.outputHeight,
            );
      final LinearContributionTile? priorValidity = previousValidity == null
          ? null
          : await previousValidity.readRegion(
              x: region.outputX,
              y: region.outputY,
              width: region.outputWidth,
              height: region.outputHeight,
            );

      final Float32List out = Float32List(frame.interleavedRgb.length);
      final Uint16List counts = Uint16List(frame.interleavedRgb.length);
      final Float32List current = frame.interleavedRgb;
      final Float32List? old = prior?.interleavedRgb;
      final Uint16List? oldCounts = priorValidity?.interleavedCounts;
      if (current.any((double value) => !value.isFinite) ||
          (old != null && old.any((double value) => !value.isFinite))) {
        throw StateError(
            'Rolling comparison-light input contains a non-finite sample.');
      }
      for (int pixel = 0; pixel < frame.width * frame.height; pixel++) {
        final bool frameValid = frameCoverage[pixel] != 0;
        final int base = pixel * 3;
        for (int channel = 0; channel < 3; channel++) {
          final int offset = base + channel;
          final bool priorValid = oldCounts != null && oldCounts[offset] != 0;
          final double weighted = current[offset] * frameWeight;
          if (priorValid && frameValid) {
            out[offset] = weighted > old![offset] ? weighted : old[offset];
            counts[offset] = 1;
            if (onSignedZeroTie != null &&
                weighted == 0 &&
                old[offset] == 0 &&
                weighted.isNegative != old[offset].isNegative) {
              onSignedZeroTie();
            }
          } else if (priorValid) {
            out[offset] = old![offset];
            counts[offset] = 1;
          } else if (frameValid) {
            out[offset] = weighted;
            counts[offset] = 1;
          } else {
            out[offset] = 0;
            counts[offset] = 0;
          }
        }
      }
      await outRgb.writeTile(LinearRgbTile(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
        interleavedRgb: out,
      ));
      await outValidity.writeTile(LinearContributionTile(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
        interleavedCounts: counts,
      ));
      reportProgress?.call((tileIndex + 1) / plan.tiles.length);
    }
    await outRgb.commit();
    await outValidity.commit();
    committed = true;
    return (rgb: outRgb, validity: outValidity);
  } finally {
    if (!committed) {
      try {
        await outValidity?.abort();
      } on Object {
        // Preserve the original failure; abort is best-effort cleanup.
      }
      try {
        await outRgb.abort();
      } on Object {
        // Preserve the original failure; abort is best-effort cleanup.
      }
    }
  }
}

/// Applies the existing reference-foreground protection tile-by-tile to a
/// rolling accumulator and commits a new RGB generation.
Future<LinearRgbTileStore> applyStarTrailReferenceForegroundToStore({
  required LinearRgbTileStore combinedStore,
  required LinearRgbTileStore referenceStore,
  required ForegroundRegion foregroundRegion,
  required LinearRgbTileStoreFactory outputStoreFactory,
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  if (combinedStore.width != referenceStore.width ||
      combinedStore.height != referenceStore.height) {
    throw ArgumentError('Foreground reference dimensions do not match.');
  }
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: combinedStore.width,
    imageHeight: combinedStore.height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore output = await outputStoreFactory(
      width: combinedStore.width, height: combinedStore.height, plan: plan);
  bool committed = false;
  try {
    for (final OverlappedTile region in plan.tiles) {
      if (isCancelled?.call() ?? false) {
        throw const TiledLightenBlendCancelled();
      }
      final x0 = math.max(0, region.outputX - 8);
      final y0 = math.max(0, region.outputY - 8);
      final x1 = math.min(
          combinedStore.width, region.outputX + region.outputWidth + 8);
      final y1 = math.min(
          combinedStore.height, region.outputY + region.outputHeight + 8);
      final combined = await combinedStore.readRegion(
          x: x0, y: y0, width: x1 - x0, height: y1 - y0);
      final reference = await referenceStore.readRegion(
          x: x0, y: y0, width: x1 - x0, height: y1 - y0);
      preserveReferenceAgainstBroadTransientBrightening(
          combined: combined,
          reference: reference,
          foregroundWeights: foregroundRegion.weights(
              combined, combinedStore.width, combinedStore.height));
      final cropped = Float32List(region.outputWidth * region.outputHeight * 3);
      for (int y = 0; y < region.outputHeight; y++) {
        final from =
            ((region.outputY - y0 + y) * combined.width + region.outputX - x0) *
                3;
        cropped.setRange(y * region.outputWidth * 3,
            (y + 1) * region.outputWidth * 3, combined.interleavedRgb, from);
      }
      await output.writeTile(LinearRgbTile(
          x: region.outputX,
          y: region.outputY,
          width: region.outputWidth,
          height: region.outputHeight,
          interleavedRgb: cropped));
    }
    await output.commit();
    committed = true;
    return output;
  } finally {
    if (!committed) {
      try {
        await output.abort();
      } on Object {
        // Preserve the original failure; abort is best-effort cleanup.
      }
    }
  }
}
/// Work356: rolling per-pixel sum and valid-frame count (the mean
/// background for [combineStarTrailMeanAndMax] and the averaged foreground).
/// Uses the same streak exclusion as the comparison-light merge; no fade
/// weight (the background must not be faded). Sums are Float32 of linear
/// samples (relative precision ~1e-7 per addition; ample for <= 65535
/// frames of [0, ~1] data).
Future<
    ({
      LinearRgbTileStore sum,
      LinearContributionTileStore count,
    })> mergeStarTrailFrameIntoRollingSum({
  required LinearRgbTileStore frameStore,
  required LinearRgbTileStoreFactory outputSumStoreFactory,
  required LinearContributionTileStoreFactory outputCountStoreFactory,
  LinearRgbTileStore? previousSum,
  LinearContributionTileStore? previousCount,
  List<StreakShape> excludedStreaks = const <StreakShape>[],
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  if ((previousSum == null) != (previousCount == null)) {
    throw ArgumentError('previousSum and previousCount must be supplied together.');
  }
  final int width = frameStore.width;
  final int height = frameStore.height;
  if (previousSum != null &&
      (previousSum.width != width ||
          previousSum.height != height ||
          previousCount!.width != width ||
          previousCount.height != height)) {
    throw ArgumentError('Rolling sum dimensions do not match the frame.');
  }
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore outSum =
      await outputSumStoreFactory(width: width, height: height, plan: plan);
  LinearContributionTileStore? outCount;
  bool committed = false;
  try {
    outCount =
        await outputCountStoreFactory(width: width, height: height, plan: plan);
    for (final OverlappedTile region in plan.tiles) {
      if (isCancelled?.call() ?? false) {
        throw const TiledLightenBlendCancelled();
      }
      final LinearRgbTile frame = await frameStore.readRegion(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
      );
      final Uint8List coverage =
          _coverageExcludingStarTrailStreaks(frame, excludedStreaks);
      final Float32List? oldSum = previousSum == null
          ? null
          : (await previousSum.readRegion(
              x: region.outputX,
              y: region.outputY,
              width: region.outputWidth,
              height: region.outputHeight,
            ))
              .interleavedRgb;
      final Uint16List? oldCount = previousCount == null
          ? null
          : (await previousCount.readRegion(
              x: region.outputX,
              y: region.outputY,
              width: region.outputWidth,
              height: region.outputHeight,
            ))
              .interleavedCounts;
      final Float32List current = frame.interleavedRgb;
      final Float32List sum = Float32List(current.length);
      final Uint16List count = Uint16List(current.length);
      for (int pixel = 0; pixel < frame.width * frame.height; pixel++) {
        final bool valid = coverage[pixel] != 0;
        for (int c = 0; c < 3; c++) {
          final int o = pixel * 3 + c;
          final double prior = oldSum == null ? 0 : oldSum[o];
          final int priorCount = oldCount == null ? 0 : oldCount[o];
          if (valid) {
            if (!current[o].isFinite) {
              throw StateError('Rolling sum input contains a non-finite sample.');
            }
            if (priorCount == 0xffff) {
              throw StateError('Rolling sum frame count overflow.');
            }
            sum[o] = prior + current[o];
            count[o] = priorCount + 1;
          } else {
            sum[o] = prior;
            count[o] = priorCount;
          }
        }
      }
      await outSum.writeTile(LinearRgbTile(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
        interleavedRgb: sum,
      ));
      await outCount.writeTile(LinearContributionTile(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
        interleavedCounts: count,
      ));
    }
    await outSum.commit();
    await outCount.commit();
    committed = true;
    return (sum: outSum, count: outCount);
  } finally {
    if (!committed) {
      await outSum.abort();
      await outCount?.abort();
    }
  }
}
