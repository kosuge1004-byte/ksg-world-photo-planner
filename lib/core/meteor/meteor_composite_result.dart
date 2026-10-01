import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../export/dng_final_render_profile.dart';
import '../export/export_result.dart';
import '../export/output_image_format.dart';
import '../export/linear_dng_writer.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../registration/tiled_affine_rgb_resampler.dart'
    show CoveredLinearRgbTile, TiledAffineRgbResampler, ResamplingInterpolation;
import '../registration/affine_sampling_transform.dart';
import 'meteor_registration.dart';
import '../session/meteor_pipeline.dart' show MeteorAnalysisResult;
import '../stacking/tiled_kappa_sigma_combiner.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'streak_compositor.dart';
import 'streak_shape.dart';

final class SelectedMeteorStreak {
  const SelectedMeteorStreak({required this.frameIndex, required this.streak});

  final int frameIndex;
  final StreakShape streak;
}

final class _RegisteredStreak implements StreakShape {
  _RegisteredStreak(
      StreakShape source, AffineSamplingTransform inverseSampling) {
    final forward = inverseSampling.inverse();
    endpoints = source.endpoints
        .map(
            (p) => (x: forward.sourceX(p.x, p.y), y: forward.sourceY(p.x, p.y)))
        .toList();
    width = source.width *
        math.sqrt(forward.m00 * forward.m00 + forward.m10 * forward.m10);
  }
  @override
  late final List<({double x, double y})> endpoints;
  @override
  late final double width;
}

/// Completes meteor mode's own share of the "select frames -> get a
/// viewable image file" flow (`export_pipeline_result.dart`, Work58,
/// already did this for star trail/Milky Way mode): the human-triggered
/// step that runs *after* a review UI shows the candidates
/// `meteor_pipeline.dart`'s `runMeteorAnalysisPipeline` found and the
/// user picks which one(s) to keep.
///
/// Deliberately kept separate from `meteor_pipeline.dart` itself — that
/// pipeline's job is analysis for a human to review, not deciding
/// anything (see that module's own doc comment); this module is what a
/// review UI calls only once that human decision has actually been
/// made, using the `MeteorAnalysisResult.frameStores`
/// `runMeteorAnalysisPipeline` deliberately left undisposed for exactly
/// this purpose.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it). Its own logic is thin orchestration
/// over already-tested pieces (`streak_compositor.dart`'s
/// `compositeSelectedStreaks`, already validated in `streak_compositor_
/// test.dart`, `export_result.dart`'s `exportLinearRgbTileToBmp`,
/// already validated in `export_result_test.dart`, and — for
/// [compositeSelectedMeteorCandidateWithStackedBackgroundAndExport] —
/// `tiled_kappa_sigma_combiner.dart`'s `TiledKappaSigmaCombiner`,
/// already validated in `tiled_kappa_sigma_combiner_test.dart`);
/// `test/meteor_composite_result_test.dart` covers this file's own new
/// logic directly against fake tile stores and a real temp-directory
/// file.
///
/// Two compositing functions are provided:
/// - [compositeSelectedMeteorCandidateAndExport]: background is a single
///   chosen frame — simple, but that frame's own noise (and any
///   incidental transient in a *different* background frame, which this
///   approach cannot see or reject) carries through unchanged.
/// - [compositeSelectedMeteorCandidateWithStackedBackgroundAndExport]:
///   background is robustly combined from several frames via kappa-sigma
///   rejection — see that function's own doc comment for why this, not
///   lighten blend, is the right combiner for a background specifically.

/// Returns every *analyzed* frame index in [result] except
/// [foregroundFrameIndex], suitable as a ready-to-use
/// `backgroundFrameIndices` argument to
/// [compositeSelectedMeteorCandidateWithStackedBackgroundAndExport] —
/// removing the manual step of enumerating "every other frame" by hand
/// for the common case.
///
/// - [excludeFrameIndicesWithCandidates] (default `true`): also excludes
///   any analyzed frame that itself produced at least one streak
///   candidate of its own (a different meteor, a satellite, an
///   aircraft — see `MeteorAnalysisResult.candidates`). This is a
///   deliberately *more cautious* default than relying on kappa-sigma
///   rejection alone: rejection statistically handles a transient
///   present in a minority of the background frames (demonstrated
///   directly in Work62's own test), but with only a *few* background
///   frames — a common case for a short meteor-mode burst — a single
///   contaminated frame may not be a clear enough minority for
///   rejection to reliably suppress it. Since this project's own
///   detection pipeline already knows exactly which frames contain a
///   detected streak, using that information directly (excluding those
///   frames from the background candidate set entirely) is strictly
///   more information than the combiner's own per-pixel statistics
///   alone have to work with, so it is used by default here rather than
///   left as an opt-in. Pass `false` to fall back to "every other
///   analyzed frame, no matter its own candidate count" if excluding
///   candidate-bearing frames leaves too few background frames for a
///   given sequence.
///
/// Throws [ArgumentError] if [foregroundFrameIndex] is out of range for
/// [result].
List<int> defaultBackgroundFrameIndices(
  MeteorAnalysisResult result,
  int foregroundFrameIndex, {
  bool excludeFrameIndicesWithCandidates = true,
}) {
  return defaultBackgroundFrameIndicesForSelectedFrames(
    result,
    <int>{foregroundFrameIndex},
    excludeFrameIndicesWithCandidates: excludeFrameIndicesWithCandidates,
  );
}

/// Multi-selection counterpart of [defaultBackgroundFrameIndices]. Every
/// selected foreground frame is excluded from the robust background.
List<int> defaultBackgroundFrameIndicesForSelectedFrames(
  MeteorAnalysisResult result,
  Set<int> foregroundFrameIndices, {
  bool excludeFrameIndicesWithCandidates = true,
}) {
  if (foregroundFrameIndices.isEmpty) {
    throw ArgumentError.value(
      foregroundFrameIndices,
      'foregroundFrameIndices',
      'At least one foreground frame is required.',
    );
  }
  for (final int foregroundFrameIndex in foregroundFrameIndices) {
    if (foregroundFrameIndex >= 0 &&
        foregroundFrameIndex < result.frameDiagnostics.length) {
      continue;
    }
    throw ArgumentError.value(
      foregroundFrameIndex,
      'foregroundFrameIndex',
      'Out of range for result.frameDiagnostics (length '
          '${result.frameDiagnostics.length}).',
    );
  }
  final Set<int> framesWithCandidates = excludeFrameIndicesWithCandidates
      ? result.candidates.map((candidate) => candidate.frameIndex).toSet()
      : const <int>{};
  return <int>[
    for (int index = 0; index < result.frameDiagnostics.length; index++)
      if (!foregroundFrameIndices.contains(index) &&
          result.frameDiagnostics[index].analyzed &&
          !framesWithCandidates.contains(index))
        index,
  ];
}

/// Composites [selectedStreaks] (from the frame at [foregroundFrameIndex]
/// in [frameStores]) onto the frame at [backgroundFrameIndex], and
/// writes the result to [exportPath].
///
/// - [frameStores]: typically `MeteorAnalysisResult.frameStores` from a
///   prior `runMeteorAnalysisPipeline`/`analyzeDecodedFrames` call. A
///   `null` entry at either index (that frame failed to decode) throws
///   [ArgumentError] rather than silently compositing against nothing.
/// - [foregroundFrameIndex]: which frame actually contains the meteor
///   the user selected — typically `MeteorCandidate.frameIndex` for
///   whichever candidate(s) they picked.
/// - [backgroundFrameIndex]: which frame's content should show through
///   everywhere *except* the selected streak's own masked region. Often
///   a different frame from the sequence (so the meteor frame's own,
///   single-frame noise level doesn't leak into the rest of the image).
///   For a more robust, multi-frame background instead of a single
///   chosen frame, see
///   [compositeSelectedMeteorCandidateWithStackedBackgroundAndExport]
///   (Work62).
/// - [selectedStreaks]: the streak-shaped candidate(s) to composite in —
///   typically one or more `MeteorCandidate.streak` values the user
///   picked, all understood to belong to [foregroundFrameIndex]'s frame
///   (compositing streaks from a *different* frame than
///   [foregroundFrameIndex] would composite the wrong pixels; this
///   function does not itself verify that association, since
///   `StreakShape` alone carries no frame-index information — the
///   caller, which does have that association via `MeteorCandidate`, is
///   responsible for keeping the two consistent).
/// - [paddingPixels], [exposureScale], [whitePoint]: forwarded to
///   [compositeSelectedStreaks] and [exportLinearRgbTileToBmp]
///   respectively.
///
/// Returns the [File] that was written.
Future<File> compositeSelectedMeteorCandidateAndExport({
  required List<LinearRgbTileStore?> frameStores,
  required int foregroundFrameIndex,
  required int backgroundFrameIndex,
  required List<StreakShape> selectedStreaks,
  required String exportPath,
  double paddingPixels = 3,
  double? exposureScale,
  double? whitePoint,
  DngFinalRenderProfile? renderProfile,
  Map<int, AffineSamplingTransform>? frameTransforms,
  int referenceFrameIndex = 0,
}) async {
  if (foregroundFrameIndex < 0 || foregroundFrameIndex >= frameStores.length) {
    throw ArgumentError.value(
      foregroundFrameIndex,
      'foregroundFrameIndex',
      'Out of range for frameStores (length ${frameStores.length}).',
    );
  }
  if (backgroundFrameIndex < 0 || backgroundFrameIndex >= frameStores.length) {
    throw ArgumentError.value(
      backgroundFrameIndex,
      'backgroundFrameIndex',
      'Out of range for frameStores (length ${frameStores.length}).',
    );
  }
  final LinearRgbTileStore? foregroundStore = frameStores[foregroundFrameIndex];
  if (foregroundStore == null) {
    throw ArgumentError(
      'frameStores[$foregroundFrameIndex] is null -- that frame was not '
      'successfully decoded, so it has no content to composite from.',
    );
  }
  final LinearRgbTileStore? backgroundStore = frameStores[backgroundFrameIndex];
  if (backgroundStore == null) {
    throw ArgumentError(
      'frameStores[$backgroundFrameIndex] is null -- that frame was not '
      'successfully decoded, so it has no content to composite onto.',
    );
  }

  if (backgroundFrameIndex == foregroundFrameIndex) {
    throw ArgumentError('Meteor foreground cannot be its own background.');
  }
  if (foregroundStore.width != backgroundStore.width ||
      foregroundStore.height != backgroundStore.height) {
    throw ArgumentError('Meteor frame dimensions must match.');
  }
  final transforms = frameTransforms ??
      await registerMeteorFrames(
          frameStores: frameStores,
          requiredIndices: {foregroundFrameIndex, backgroundFrameIndex},
          referenceIndex: referenceFrameIndex);
  final width = foregroundStore.width, height = foregroundStore.height;
  final region = OverlappedTile(
      outputX: 0,
      outputY: 0,
      outputWidth: width,
      outputHeight: height,
      inputX: 0,
      inputY: 0,
      inputWidth: width,
      inputHeight: height);
  const resampler =
      TiledAffineRgbResampler(interpolation: ResamplingInterpolation.bicubic);
  final foreground = await resampler.sampleTile(
      source: foregroundStore,
      outputTile: region,
      outputImageWidth: width,
      outputImageHeight: height,
      transform: transforms[foregroundFrameIndex]!);
  final background = await resampler.sampleTile(
      source: backgroundStore,
      outputTile: region,
      outputImageWidth: width,
      outputImageHeight: height,
      transform: transforms[backgroundFrameIndex]!);
  final composited = background.tile;
  compositeSelectedStreaksInPlace(
      destination: composited,
      foreground: foreground.tile,
      foregroundCoverage: foreground.coverage,
      streaks: selectedStreaks
          .map((s) => _RegisteredStreak(s, transforms[foregroundFrameIndex]!))
          .toList(),
      paddingPixels: paddingPixels);
  return exportLinearRgbTileToBmp(
    tile: composited,
    outputPath: exportPath,
    exposureScale: exposureScale,
    whitePoint: whitePoint,
    renderProfile: renderProfile,
  );
}

/// Combines registered background and foreground in bounded RGB tiles.
Future<File> compositeSelectedMeteorStreaksTiledAndExport({
  required List<LinearRgbTileStore?> frameStores,
  required List<SelectedMeteorStreak> selectedStreaks,
  required List<int> backgroundFrameIndices,
  required LinearRgbTileStoreFactory intermediateTileStoreFactory,
  required String exportPath,
  OutputImageFormat outputFormat = OutputImageFormat.bmp8,
  LinearDngCompression linearDngCompression = LinearDngCompression.none,
  double kappa = 2.5,
  int maximumIterations = 3,
  int tileSize = 512,
  double paddingPixels = 3,
  double? exposureScale,
  double? whitePoint,
  DngFinalRenderProfile? renderProfile,
  Map<int, AffineSamplingTransform>? frameTransforms,
  int referenceFrameIndex = 0,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
  // Work357: lighten keeps the historical (bit-identical) result.
  MeteorCompositeBlendMode blendMode = MeteorCompositeBlendMode.lighten,
}) async {
  if (selectedStreaks.isEmpty) {
    throw ArgumentError.value(
      selectedStreaks,
      'selectedStreaks',
      'At least one selected streak is required.',
    );
  }
  if (backgroundFrameIndices.isEmpty) {
    throw ArgumentError.value(
      backgroundFrameIndices,
      'backgroundFrameIndices',
      'At least one background frame is required.',
    );
  }

  final Map<int, List<StreakShape>> streaksByFrame = <int, List<StreakShape>>{};
  final Map<int, LinearRgbTileStore> foregroundStores =
      <int, LinearRgbTileStore>{};
  int? width;
  int? height;
  for (final SelectedMeteorStreak selected in selectedStreaks) {
    final int index = selected.frameIndex;
    if (index < 0 || index >= frameStores.length) {
      throw ArgumentError.value(index, 'selectedStreaks.frameIndex');
    }
    final LinearRgbTileStore? store = frameStores[index];
    if (store == null) {
      throw ArgumentError('frameStores[$index] is null.');
    }
    width ??= store.width;
    height ??= store.height;
    if (store.width != width || store.height != height) {
      throw ArgumentError('All selected foreground frames must match.');
    }
    foregroundStores[index] = store;
    streaksByFrame.putIfAbsent(index, () => <StreakShape>[]).add(
          selected.streak,
        );
  }

  final List<LinearRgbTileStore> backgroundStores = <LinearRgbTileStore>[];
  for (final int index in backgroundFrameIndices) {
    if (foregroundStores.containsKey(index)) {
      throw ArgumentError(
          'Selected meteor foreground frame $index cannot be part of the background stack.');
    }
    if (index < 0 || index >= frameStores.length) {
      throw ArgumentError.value(index, 'backgroundFrameIndices');
    }
    final LinearRgbTileStore? store = frameStores[index];
    if (store == null) {
      throw ArgumentError('frameStores[$index] is null.');
    }
    if (store.width != width || store.height != height) {
      throw ArgumentError('All background and foreground frames must match.');
    }
    backgroundStores.add(store);
  }

  final transforms = frameTransforms ??
      await registerMeteorFrames(
        frameStores: frameStores,
        requiredIndices: {...backgroundFrameIndices, ...foregroundStores.keys},
        referenceIndex: referenceFrameIndex,
        isCancelled: isCancelled,
      );
  for (final index in {...backgroundFrameIndices, ...foregroundStores.keys}) {
    if (!transforms.containsKey(index)) {
      throw ArgumentError('Missing stellar transform for frame $index.');
    }
  }
  const resampler =
      TiledAffineRgbResampler(interpolation: ResamplingInterpolation.bicubic);

  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width!,
    imageHeight: height!,
    tileSize: tileSize,
    overlap: 0,
  );
  LinearRgbTileStore? backgroundStore;
  LinearRgbTileStore? outputStore;
  bool backgroundCommitted = false;
  bool outputCommitted = false;
  try {
    backgroundStore = await intermediateTileStoreFactory(
      width: width,
      height: height,
      plan: plan,
    );
    final TiledKappaSigmaCombiner combiner = TiledKappaSigmaCombiner(
      kappa: kappa,
      maximumIterations: maximumIterations,
      robustSmallStackInitialization: true,
    );
    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw const TiledStackingCancelled();
      }
      final OverlappedTile outputTile = plan.tiles[tileIndex];
      final RejectionStackedRgbTile combined = await combiner.combineTile(
        frameCount: backgroundStores.length,
        frameWeights: List<double>.filled(backgroundStores.length, 1),
        outputTile: outputTile,
        readFrame: (int listIndex, OverlappedTile region) async {
          return resampler.sampleTile(
            source: backgroundStores[listIndex],
            outputTile: region,
            outputImageWidth: width!,
            outputImageHeight: height!,
            transform: transforms[backgroundFrameIndices[listIndex]]!,
            isCancelled: isCancelled,
          );
        },
        isCancelled: isCancelled,
      );
      await backgroundStore.writeTile(combined.tile);
      reportProgress?.call((tileIndex + 1) / plan.tiles.length * 0.45);
    }
    await backgroundStore.commit();
    backgroundCommitted = true;

    // Work357: additive mode needs per-streak parameters estimated once in
    // global coordinates (so every output tile applies the same values).
    final Map<int, List<StreakShape>> registeredByFrame =
        <int, List<StreakShape>>{
      for (final MapEntry<int, List<StreakShape>> group
          in streaksByFrame.entries)
        group.key: <StreakShape>[
          for (final StreakShape s in group.value)
            _RegisteredStreak(s, transforms[group.key]!),
        ],
    };
    final Map<int, List<StreakAdditiveParameters>> additiveParameters =
        <int, List<StreakAdditiveParameters>>{};
    if (blendMode == MeteorCompositeBlendMode.additive) {
      for (final MapEntry<int, List<StreakShape>> group
          in registeredByFrame.entries) {
        final List<StreakAdditiveParameters> perStreak =
            <StreakAdditiveParameters>[];
        for (final StreakShape streak in group.value) {
          final double reach = streak.width / 2 + paddingPixels + 6 + 2;
          final int x0 = math.max(
              0,
              (math.min(streak.endpoints[0].x, streak.endpoints[1].x) - reach)
                  .floor());
          final int y0 = math.max(
              0,
              (math.min(streak.endpoints[0].y, streak.endpoints[1].y) - reach)
                  .floor());
          final int x1 = math.min(
              width,
              (math.max(streak.endpoints[0].x, streak.endpoints[1].x) + reach)
                      .ceil() +
                  1);
          final int y1 = math.min(
              height,
              (math.max(streak.endpoints[0].y, streak.endpoints[1].y) + reach)
                      .ceil() +
                  1);
          if (x1 <= x0 || y1 <= y0) {
            perStreak.add(const StreakAdditiveParameters(
              offset: <double>[0, 0, 0],
              sigma: <double>[
                double.infinity,
                double.infinity,
                double.infinity,
              ],
              samples: 0,
            ));
            continue;
          }
          final OverlappedTile box = OverlappedTile(
            outputX: x0,
            outputY: y0,
            outputWidth: x1 - x0,
            outputHeight: y1 - y0,
            inputX: x0,
            inputY: y0,
            inputWidth: x1 - x0,
            inputHeight: y1 - y0,
          );
          final CoveredLinearRgbTile fg = await resampler.sampleTile(
            source: foregroundStores[group.key]!,
            outputTile: box,
            outputImageWidth: width,
            outputImageHeight: height,
            transform: transforms[group.key]!,
            isCancelled: isCancelled,
          );
          final LinearRgbTile bg = await backgroundStore.readRegion(
            x: x0,
            y: y0,
            width: x1 - x0,
            height: y1 - y0,
          );
          perStreak.add(estimateStreakAdditiveParameters(
            background: bg,
            foreground: fg.tile,
            foregroundCoverage: fg.coverage,
            streak: streak,
            paddingPixels: paddingPixels,
          ));
        }
        additiveParameters[group.key] = perStreak;
      }
    }

    outputStore = await intermediateTileStoreFactory(
      width: width,
      height: height,
      plan: plan,
    );
    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw const TiledStackingCancelled();
      }
      final OverlappedTile region = plan.tiles[tileIndex];
      final LinearRgbTile background = await backgroundStore.readRegion(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
      );
      final LinearRgbTile composited = LinearRgbTile(
        x: background.x,
        y: background.y,
        width: background.width,
        height: background.height,
        interleavedRgb: Float32List.fromList(background.interleavedRgb),
      );
      for (final MapEntry<int, List<StreakShape>> group
          in streaksByFrame.entries) {
        if (isCancelled?.call() ?? false) {
          throw const TiledStackingCancelled();
        }
        final CoveredLinearRgbTile foreground = await resampler.sampleTile(
            source: foregroundStores[group.key]!,
            outputTile: region,
            outputImageWidth: width,
            outputImageHeight: height,
            transform: transforms[group.key]!,
            isCancelled: isCancelled);
        if (blendMode == MeteorCompositeBlendMode.additive) {
          compositeSelectedStreaksAdditiveInPlace(
            destination: composited,
            foreground: foreground.tile,
            foregroundCoverage: foreground.coverage,
            streaks: registeredByFrame[group.key]!,
            parameters: additiveParameters[group.key]!,
            paddingPixels: paddingPixels,
          );
        } else {
          compositeSelectedStreaksInPlace(
            destination: composited,
            foreground: foreground.tile,
            foregroundCoverage: foreground.coverage,
            streaks: group.value
                .map((s) => _RegisteredStreak(s, transforms[group.key]!))
                .toList(),
            paddingPixels: paddingPixels,
          );
        }
      }
      await outputStore.writeTile(composited);
      reportProgress?.call(
        0.45 + (tileIndex + 1) / plan.tiles.length * 0.45,
      );
    }
    await outputStore.commit();
    outputCommitted = true;
    final File file = await exportTileStoreToImage(
      tileStore: outputStore,
      outputPath: exportPath,
      format: outputFormat,
      exposureScale: exposureScale,
      whitePoint: whitePoint,
      renderProfile: renderProfile,
      linearDngCompression: linearDngCompression,
      isCancelled: isCancelled,
    );
    reportProgress?.call(1);
    return file;
  } finally {
    try {
      if (outputStore != null) {
        if (outputCommitted) {
          await outputStore.dispose();
        } else {
          await outputStore.abort();
        }
      }
    } finally {
      if (backgroundStore != null) {
        if (backgroundCommitted) {
          await backgroundStore.dispose();
        } else {
          await backgroundStore.abort();
        }
      }
    }
  }
}

/// Composites [selectedStreaks] (from the frame at [foregroundFrameIndex])
/// onto a *robustly combined* background built from
/// [backgroundFrameIndices] via kappa-sigma rejection
/// ([TiledKappaSigmaCombiner], the same combiner Milky Way mode uses),
/// rather than [compositeSelectedMeteorCandidateAndExport]'s single
/// chosen background frame.
///
/// This is the quality improvement that function's own doc comment
/// named as a deliberately-deferred limitation: a single background
/// frame carries that one frame's own full noise level, and — just as
/// importantly — cannot distinguish the selected meteor from any *other*
/// transient (a satellite, a plane, an unrelated meteor) that happens to
/// cross a *different* one of the background frames. Kappa-sigma
/// rejection specifically addresses both: it is a robust mean across
/// [backgroundFrameIndices] that rejects statistical outliers at each
/// pixel — reducing per-pixel noise the way any multi-frame mean does,
/// while also naturally suppressing a transient streak that appears in
/// only one of the background frames, the same rejection mechanism
/// Milky Way mode already relies on to reject a single bad frame's
/// contribution at any given pixel.
///
/// Lighten blend (`star_trail_pipeline.dart`'s combiner) was considered
/// and deliberately *not* used for this: lighten blend keeps the
/// *brightest* value seen at each pixel across frames, which would
/// preserve — not reject — any stray satellite, aircraft, or other
/// meteor's streak in the background frames, the opposite of what a
/// clean background needs here. Star trail mode's own use of lighten
/// blend is correct for star trail mode specifically because *every*
/// frame's bright trace is wanted there; that is not true of an
/// incidental transient in a meteor-mode background frame.
///
/// - [frameStores], [foregroundFrameIndex], [selectedStreaks],
///   [paddingPixels], [exportPath], [exposureScale], [whitePoint]: as
///   [compositeSelectedMeteorCandidateAndExport].
/// - [backgroundFrameIndices]: at least 1 frame index into [frameStores]
///   (excluding [foregroundFrameIndex], though this is not itself
///   validated — including the foreground frame here would recombine
///   the meteor's own streak into the "background" before compositing
///   it back in a second time, which is almost certainly not what a
///   caller wants, so the caller is expected to exclude it). A `null`
///   (undecoded) entry among these throws [ArgumentError], matching
///   [compositeSelectedMeteorCandidateAndExport]'s treatment of a `null`
///   background.
/// - [backgroundTileStoreFactory]: builds the intermediate combined-
///   background store; disposed automatically once the final composite
///   is produced, regardless of success or failure.
/// - [kappa], [maximumIterations], [tileSize]: forwarded to
///   [TiledKappaSigmaCombiner].
///
/// Returns the [File] that was written.
Future<File> compositeSelectedMeteorCandidateWithStackedBackgroundAndExport({
  required List<LinearRgbTileStore?> frameStores,
  required int foregroundFrameIndex,
  required List<int> backgroundFrameIndices,
  required List<StreakShape> selectedStreaks,
  required LinearRgbTileStoreFactory backgroundTileStoreFactory,
  required String exportPath,
  double kappa = 2.5,
  int maximumIterations = 3,
  int tileSize = 512,
  double paddingPixels = 3,
  double? exposureScale,
  double? whitePoint,
  DngFinalRenderProfile? renderProfile,
  Map<int, AffineSamplingTransform>? frameTransforms,
  int referenceFrameIndex = 0,
  void Function(double progress)? reportProgress,
  bool Function()? isCancelled,
}) async {
  if (foregroundFrameIndex < 0 || foregroundFrameIndex >= frameStores.length) {
    throw ArgumentError.value(
      foregroundFrameIndex,
      'foregroundFrameIndex',
      'Out of range for frameStores (length ${frameStores.length}).',
    );
  }
  final LinearRgbTileStore? foregroundStore = frameStores[foregroundFrameIndex];
  if (foregroundStore == null) {
    throw ArgumentError(
      'frameStores[$foregroundFrameIndex] is null -- that frame was not '
      'successfully decoded, so it has no content to composite from.',
    );
  }
  if (backgroundFrameIndices.isEmpty) {
    throw ArgumentError.value(
      backgroundFrameIndices,
      'backgroundFrameIndices',
      'At least one background frame index is required.',
    );
  }
  final List<LinearRgbTileStore> backgroundStores = <LinearRgbTileStore>[];
  for (final int index in backgroundFrameIndices) {
    if (index == foregroundFrameIndex) {
      throw ArgumentError(
          'Meteor foreground frame cannot be included in its background stack.');
    }
    if (index < 0 || index >= frameStores.length) {
      throw ArgumentError.value(
        index,
        'backgroundFrameIndices',
        'Out of range for frameStores (length ${frameStores.length}).',
      );
    }
    final LinearRgbTileStore? store = frameStores[index];
    if (store == null) {
      throw ArgumentError(
        'frameStores[$index] (one of backgroundFrameIndices) is null -- '
        'that frame was not successfully decoded.',
      );
    }
    backgroundStores.add(store);
  }
  final int width = foregroundStore.width;
  final int height = foregroundStore.height;
  for (final LinearRgbTileStore store in backgroundStores) {
    if (store.width != width || store.height != height) {
      throw ArgumentError(
        'All background frames must share the foreground frame\'s '
        'dimensions; got ${store.width}x${store.height} alongside '
        '${width}x$height.',
      );
    }
  }

  final transforms = frameTransforms ??
      await registerMeteorFrames(
          frameStores: frameStores,
          requiredIndices: {foregroundFrameIndex, ...backgroundFrameIndices},
          referenceIndex: referenceFrameIndex,
          isCancelled: isCancelled);
  const resampler =
      TiledAffineRgbResampler(interpolation: ResamplingInterpolation.bicubic);
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore backgroundStore = await backgroundTileStoreFactory(
    width: width,
    height: height,
    plan: plan,
  );

  final TiledKappaSigmaCombiner combiner = TiledKappaSigmaCombiner(
    kappa: kappa,
    maximumIterations: maximumIterations,
    robustSmallStackInitialization: true,
  );
  bool committed = false;
  try {
    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw const TiledStackingCancelled();
      }
      final OverlappedTile outputTile = plan.tiles[tileIndex];
      final RejectionStackedRgbTile combined = await combiner.combineTile(
        frameCount: backgroundStores.length,
        frameWeights: List<double>.filled(backgroundStores.length, 1),
        outputTile: outputTile,
        readFrame: (int listIndex, OverlappedTile region) async {
          return resampler.sampleTile(
              source: backgroundStores[listIndex],
              outputTile: region,
              outputImageWidth: width,
              outputImageHeight: height,
              transform: transforms[backgroundFrameIndices[listIndex]]!,
              isCancelled: isCancelled);
        },
        isCancelled: isCancelled,
      );
      await backgroundStore.writeTile(combined.tile);
      reportProgress?.call((tileIndex + 1) / plan.tiles.length / 2);
    }
    await backgroundStore.commit();
    committed = true;

    final region = OverlappedTile(
        outputX: 0,
        outputY: 0,
        outputWidth: width,
        outputHeight: height,
        inputX: 0,
        inputY: 0,
        inputWidth: width,
        inputHeight: height);
    final foreground = await resampler.sampleTile(
        source: foregroundStore,
        outputTile: region,
        outputImageWidth: width,
        outputImageHeight: height,
        transform: transforms[foregroundFrameIndex]!,
        isCancelled: isCancelled);
    final LinearRgbTile combinedBackground = await backgroundStore.readRegion(
      x: 0,
      y: 0,
      width: width,
      height: height,
    );
    final composited = combinedBackground;
    compositeSelectedStreaksInPlace(
        destination: composited,
        foreground: foreground.tile,
        foregroundCoverage: foreground.coverage,
        streaks: selectedStreaks
            .map((s) => _RegisteredStreak(s, transforms[foregroundFrameIndex]!))
            .toList(),
        paddingPixels: paddingPixels);
    reportProgress?.call(1);
    return await exportLinearRgbTileToBmp(
      tile: composited,
      outputPath: exportPath,
      exposureScale: exposureScale,
      whitePoint: whitePoint,
      renderProfile: renderProfile,
      isCancelled: isCancelled,
    );
  } finally {
    if (!committed) {
      await backgroundStore.abort();
    } else {
      await backgroundStore.dispose();
    }
  }
}
