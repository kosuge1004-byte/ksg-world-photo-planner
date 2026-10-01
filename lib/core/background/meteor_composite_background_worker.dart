import 'dart:async';
import 'dart:io';

import '../export/dng_final_render_profile.dart';
import '../export/export_result.dart' show ExportCancelled;
import '../export/lightroom_storage_preset.dart';
import '../export/output_image_format.dart';
import '../engine/default_resource_reader.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../meteor/meteor_composite_result.dart';
import '../meteor/streak_compositor.dart'
    show MeteorCompositeBlendMode, meteorCompositeBlendModeFromName;
import '../raw/native_raw_decoder_factory.dart';
import '../raw/raw_file_probe.dart';
import '../session/meteor_pipeline.dart';
import '../stacking/tiled_kappa_sigma_combiner.dart'
    show TiledStackingCancelled;
import 'meteor_background_codec.dart';
import 'external_stall_watchdog.dart';
import 'stack_job_reporter.dart';

const String meteorCompositeBackgroundTask = 'meteor_composite_background';

final class _MeteorCompositeStorageException implements Exception {
  const _MeteorCompositeStorageException({
    required this.requiredBytes,
    required this.availableBytes,
  });

  final int requiredBytes;
  final int availableBytes;

  @override
  String toString() {
    String format(int bytes) =>
        '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
    return '流星の最終合成に必要な空き容量が不足しています。'
        '\n必要な空き容量: ${format(requiredBytes)}'
        '\n現在の空き容量: ${format(availableBytes)}'
        '\n空き容量を確保した後、「保存済み地点から再開」を押してください。';
  }
}

bool _isMeteorCompositeNoSpaceError(Object error) {
  if (error is FileSystemException && error.osError?.errorCode == 28) {
    return true;
  }
  final String text = error.toString().toLowerCase();
  return text.contains('no space left on device') ||
      text.contains('errno = 28') ||
      text.contains('errno=28');
}

T _meteorEnumByName<T extends Enum>(List<T> values, Object? raw, T fallback) {
  final String? name = raw as String?;
  if (name == null) return fallback;
  for (final T value in values) {
    if (value.name == name) return value;
  }
  return fallback;
}

Future<DngFinalRenderProfile?> _loadReferenceProfile(
  List<String> sourcePaths,
) async {
  if (sourcePaths.isEmpty) return null;
  final String path = sourcePaths.first;
  final probe = await const RawFileProbe().probe(path);
  if (!probe.isAccepted) return null;
  final metadataProbe = createProductionNativeRawMetadataProbe();
  if (!metadataProbe.supports(probe.format)) return null;
  final metadata = await metadataProbe.probe(probe);
  return DngFinalRenderProfile.fromMetadata(
    sourceId: path,
    metadata: metadata.metadata,
    cfaPattern: metadata.cfaPattern,
  );
}

Future<bool> runMeteorCompositeBackgroundTask(
    Map<String, dynamic> input) async {
  final String analysisPath = input['analysisPath'] as String;
  final String outputPath = input['outputPath'] as String;
  final String statusPath = input['statusPath'] as String;
  final List<String> sourcePaths =
      (input['sourcePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final List<int> selectedIndices =
      (input['selectedCandidateIndices'] as List<dynamic>? ?? const <dynamic>[])
          .cast<num>()
          .map((num value) => value.toInt())
          .toList(growable: false);
  final OutputImageFormat outputFormat = _meteorEnumByName(
    OutputImageFormat.values,
    input['outputFormat'],
    OutputImageFormat.linearDng,
  );
  final LightroomStoragePreset storagePreset = _meteorEnumByName(
    LightroomStoragePreset.values,
    input['storagePreset'],
    LightroomStoragePreset.maximum,
  );
  // Work357: absent in older payloads => lighten (unchanged behaviour).
  final MeteorCompositeBlendMode blendMode = meteorCompositeBlendModeFromName(
    input['meteorCompositeBlendMode'] as String?,
  );
  if (selectedIndices.isEmpty) {
    throw ArgumentError('At least one meteor candidate must be selected.');
  }
  final StackJobReporter reporter = StackJobReporter(
    statusPath: statusPath,
    outputPath: outputPath,
    totalItems: selectedIndices.length,
    jobLabel: '流星群・最終合成',
    completionMessage: '流星群の最終画像が完成しました。',
  );
  MeteorAnalysisResult? result;
  return runWithExternalStallWatchdog(
    statusPath: statusPath,
    jobLabel: '流星群・最終合成',
    body: () async {
      try {
        if (!await reporter.start()) {
          // Already completed/failed/cancelled — most likely a
          // START_REDELIVER_INTENT redelivery after the service
          // process was killed just after finishing. Do not redo
          // the work or touch the existing terminal status.
          return true;
        }
        await reporter.update(progress: 0.02, stage: '解析結果を復元', currentItem: 0);
        result = await readMeteorAnalysisResult(analysisPath);
        FileBackedLinearRgbTileStore? frameStore;
        for (final store in result!.frameStores) {
          if (store is FileBackedLinearRgbTileStore) {
            frameStore = store;
            break;
          }
        }
        if (frameStore != null) {
          // Background synthesis, foreground accumulation and atomic export
          // can coexist briefly. Reserve three RGB FP32 frames plus a fixed
          // margin before entering that non-trivial write phase.
          final int requiredBytes = frameStore.width *
                  frameStore.height *
                  FileBackedLinearRgbTileStore.bytesPerPixel *
                  3 +
              512 * 1024 * 1024;
          final snapshot = await readDefaultResourceSnapshot().timeout(
            const Duration(seconds: 15),
            onTimeout: () => throw TimeoutException(
              '流星合成前の空き容量確認が15秒以内に完了しませんでした。',
            ),
          );
          final int? availableBytes = snapshot.availableStorageBytes;
          if (availableBytes != null && availableBytes < requiredBytes) {
            throw _MeteorCompositeStorageException(
              requiredBytes: requiredBytes,
              availableBytes: availableBytes,
            );
          }
        }
        final List<MeteorCandidate> candidates = <MeteorCandidate>[];
        for (final int index in selectedIndices) {
          if (index < 0 || index >= result!.candidates.length) {
            throw RangeError.index(
                index, result!.candidates, 'selectedCandidateIndices');
          }
          candidates.add(result!.candidates[index]);
        }
        final Set<int> foregroundFrameIndices = candidates
            .map((MeteorCandidate candidate) => candidate.frameIndex)
            .toSet();
        List<int> backgroundIndices =
            defaultBackgroundFrameIndicesForSelectedFrames(
          result!,
          foregroundFrameIndices,
        );
        if (backgroundIndices.isEmpty) {
          backgroundIndices = defaultBackgroundFrameIndicesForSelectedFrames(
            result!,
            foregroundFrameIndices,
            excludeFrameIndicesWithCandidates: false,
          );
        }
        if (backgroundIndices.isEmpty) {
          throw StateError('選択した流星を含まない背景フレームがありません。背景用の写真を追加してください。');
        }
        final DngFinalRenderProfile? renderProfile =
            await _loadReferenceProfile(sourcePaths);
        await reporter.update(progress: 0.08, stage: '流星を最終合成');
        await compositeSelectedMeteorStreaksTiledAndExport(
          frameStores: result!.frameStores,
          selectedStreaks: <SelectedMeteorStreak>[
            for (final MeteorCandidate candidate in candidates)
              SelectedMeteorStreak(
                frameIndex: candidate.frameIndex,
                streak: candidate.streak,
              ),
          ],
          backgroundFrameIndices: backgroundIndices,
          intermediateTileStoreFactory:
              FileBackedLinearRgbTileStore.createTemporary,
          exportPath: outputPath,
          outputFormat: outputFormat,
          linearDngCompression: storagePreset.dngCompression,
          renderProfile: renderProfile,
          blendMode: blendMode,
          isCancelled: () => reporter.cancellationRequested,
          reportProgress: (double progress) {
            reporter.updateBestEffort(
              progress: 0.08 + progress * 0.91,
              stage: '流星を最終合成',
              currentItem: (progress * selectedIndices.length).ceil(),
            );
          },
        );
        await reporter.complete();
        return true;
      } on TiledStackingCancelled {
        await reporter.cancel();
        return true;
      } on ExportCancelled {
        await reporter.cancel();
        return true;
      } on _MeteorCompositeStorageException catch (error) {
        await reporter.pauseRecoverable(
          error,
          checkpointItems:
              result?.frameStores.where((store) => store != null).length ?? 0,
          stage: '空き容量不足・再開待ち',
        );
        return true;
      } on Object catch (error) {
        if (_isMeteorCompositeNoSpaceError(error)) {
          await reporter.pauseRecoverable(
            '端末の空き容量が不足したため、流星の最終合成を安全に中断しました。'
            '空き容量を確保した後、「保存済み地点から再開」を押してください。',
            checkpointItems:
                result?.frameStores.where((store) => store != null).length ?? 0,
            stage: '空き容量不足・再開待ち',
          );
        } else {
          await reporter.fail(error);
        }
        return true;
      } finally {
        if (result != null) {
          try {
            await Future.wait<void>(<Future<void>>[
              for (final store in result!.frameStores)
                if (store is FileBackedLinearRgbTileStore)
                  store.closeRetainingFile()
                else if (store != null)
                  store.dispose(),
            ]).timeout(const Duration(seconds: 10));
          } on Object {
            // Preserve analysis stores so a recoverable composite can retry;
            // registry cleanup removes them after a terminal user flow.
          }
        }
        try {
          await reporter.dispose().timeout(const Duration(seconds: 10));
        } on Object {
          // Terminal/recoverable status has already been persisted.
        }
      }
    },
  );
}
