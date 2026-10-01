import '../focus_stack/focus_stack_stage_checkpoint.dart';
import '../focus_stack/focus_blend_tile_checkpoint.dart';
import 'durable_output_receipt.dart';
import 'durable_focus_frame_cache.dart';
import 'durable_decoded_frame_cache.dart';
import 'dart:io';

import '../diagnostics/diagnostic_log.dart';

import '../demosaic/demosaic_registry.dart';
import '../demosaic/native_mobile_stack_demosaic_engine_stub.dart'
    if (dart.library.io) '../demosaic/native_mobile_stack_demosaic_engine.dart';
import '../export/export_result.dart' show ExportCancelled;
import '../export/lightroom_storage_preset.dart';
import '../export/output_image_format.dart';
import '../focus_stack/focus_stack_export.dart';
import '../focus_stack/focus_stack_pipeline.dart';
import '../focus_stack/focus_tiled_blender.dart' show FocusBlendMethod, focusBlendMethodFromName;
import '../io/raw_input_contract.dart';
import '../raw/native_raw_decoder_factory.dart';
import '../raw/raw_file_probe.dart';
import 'external_stall_watchdog.dart';
import 'stack_job_reporter.dart';

const String focusStackBackgroundTask = 'focus_stack_background';

T _focusEnumByName<T extends Enum>(List<T> values, Object? raw, T fallback) {
  final String? name = raw as String?;
  if (name == null) return fallback;
  for (final T value in values) {
    if (value.name == name) return value;
  }
  return fallback;
}

Future<bool> runFocusStackBackgroundTask(Map<String, dynamic> input) async {
  final List<String> sourcePaths =
      (input['sourcePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final String outputPath = input['outputPath'] as String;
  final String statusPath = input['statusPath'] as String;
  final int referenceIndex = (input['referenceIndex'] as num?)?.toInt() ?? 0;
  // Work353: absent in older payloads => false (unchanged behaviour).
  final bool normalizeFrameExposure =
      input['focusNormalizeExposure'] as bool? ?? false;
  // Work354: absent in older payloads => depthMap (unchanged behaviour).
  final FocusBlendMethod blendMethod =
      focusBlendMethodFromName(input['focusBlendMethod'] as String?);
  final OutputImageFormat outputFormat = _focusEnumByName(
    OutputImageFormat.values,
    input['outputFormat'],
    OutputImageFormat.linearDng,
  );
  final LightroomStoragePreset storagePreset = _focusEnumByName(
    LightroomStoragePreset.values,
    input['storagePreset'],
    LightroomStoragePreset.maximum,
  );
  final StackJobReporter reporter = StackJobReporter(
    statusPath: statusPath,
    outputPath: outputPath,
    totalItems: sourcePaths.length,
    jobLabel: '深度合成',
  );
  FocusStackPipelineResult? result;
  DurableFocusFrameCache? decodedFrameCache;
  FocusStackStageCheckpointStore? stageCheckpoint;
  FocusBlendTileCheckpointStore? blendCheckpoint;
  return runWithExternalStallWatchdog(
    statusPath: statusPath,
    jobLabel: '深度合成',
    body: () async {
      try {
        if (sourcePaths.length < 2) {
          throw ArgumentError('Focus stack requires at least two RAW frames.');
        }
        if (referenceIndex < 0 || referenceIndex >= sourcePaths.length) {
          throw RangeError.index(referenceIndex, sourcePaths, 'referenceIndex');
        }
        if (!await reporter.start()) {
          // Already completed/failed/cancelled — most likely a
          // START_REDELIVER_INTENT redelivery after the service
          // process was killed just after finishing. Do not redo
          // the work or touch the existing terminal status.
          return true;
        }
        final identity = await DurableDecodedFrameCache.buildIdentity(
            paths: sourcePaths,
            options: <String, Object?>{
              for (final entry in input.entries)
                if (entry.key != 'statusPath' && entry.key != 'outputPath')
                  entry.key: entry.value,
              'algorithmRevision': 344
            });
        final outputReceipt = DurableOutputReceipt(outputPath, identity);
        if (await outputReceipt.isValid()) {
          await reporter.update(
              progress: 0.99,
              stage: '保存済み出力を検証・再利用',
              recoverableCheckpointItems: sourcePaths.length);
          await reporter.complete();
          return true;
        }
        await reporter.update(progress: 0, stage: 'RAW確認', currentItem: 0);
        const RawFileProbe fileProbe = RawFileProbe();
        final metadataProbe = createProductionNativeRawMetadataProbe();
        final List<RawInputFile> inputs = <RawInputFile>[];
        for (int index = 0; index < sourcePaths.length; index++) {
          final probe = await fileProbe.probe(sourcePaths[index]);
          if (!probe.isAccepted) {
            throw StateError(
                'RAWファイルを確認できません: ${sourcePaths[index]} / ${probe.warning}');
          }
          final metadata = metadataProbe.supports(probe.format)
              ? await metadataProbe.probe(probe)
              : null;
          inputs.add(RawInputFile(
            path: sourcePaths[index],
            byteLength: probe.byteLength,
            probe: probe,
            metadata: metadata,
          ));
          await reporter.update(
            progress: 0.08 * (index + 1) / sourcePaths.length,
            stage: 'RAW確認',
            currentItem: index + 1,
          );
        }
        final DemosaicRegistry demosaicRegistry =
            DemosaicRegistry(<NativeMobileStackDemosaicEngine>[
          NativeMobileStackDemosaicEngine(),
        ]);
        decodedFrameCache = DurableFocusFrameCache(
            DurableDecodedFrameCache(
                statusPath: statusPath,
                identity: identity), onCommitted: (count) async {
          reporter.updateBestEffort(recoverableCheckpointItems: count);
        });
        stageCheckpoint = FocusStackStageCheckpointStore(
            directory: Directory(
                '${File(statusPath).parent.path}${Platform.pathSeparator}focus_stages_v2'),
            identity: '$identity|focus-stage-344|tile512');
        blendCheckpoint = FocusBlendTileCheckpointStore(
            directory: Directory(
                '${File(statusPath).parent.path}${Platform.pathSeparator}focus_blend_v2'),
            identity: '$identity|focus-blend-344|tile512');
        result = await runFocusStackPipeline(
          stageCheckpoint: stageCheckpoint,
          blendCheckpoint: blendCheckpoint,
          decodedFrameCache: decodedFrameCache,
          inputs: inputs,
          rawDecoderRegistry:
              createProductionBackgroundNativeRawDecoderRegistry(),
          demosaicRegistry: demosaicRegistry,
          referenceIndex: referenceIndex,
          normalizeFrameExposure: normalizeFrameExposure,
          blendMethod: blendMethod,
          log: (String message) {
            DiagnosticLog.log(message);
          },
          isCancelled: () => reporter.cancellationRequested,
          reportProgress: ({
            required double fraction,
            required String stage,
            required int completedFrames,
            required int totalFrames,
          }) {
            reporter.updateBestEffort(
              progress: 0.08 + fraction * 0.82,
              stage: stage,
              currentItem: completedFrames,
            );
          },
        );
        await reporter.update(
            progress: 0.91, stage: '${outputFormat.label}を書き出し');
        await File(outputPath).parent.create(recursive: true);
        await exportFocusStackResult(
          result: result!,
          outputPath: outputPath,
          format: outputFormat,
          linearDngCompression: storagePreset.dngCompression,
          isCancelled: () => reporter.cancellationRequested,
        );
        await outputReceipt.publish();
        await result!.dispose(retainCheckpointFiles: true);
        result = null;
        await reporter.runBestEffortCleanup('focus phase checkpoint cleanup',
            () async {
          await stageCheckpoint?.clear();
          await blendCheckpoint?.clear();
        });
        await reporter.runBestEffortCleanup('decoded frame checkpoint cleanup',
            () async {
          final cache = decodedFrameCache;
          if (cache != null && await cache.cache.directory.exists()) {
            await cache.cache.directory.delete(recursive: true);
          }
        });
        await reporter.complete();
        return true;
      } on FocusStackPipelineCancelled {
        await reporter.cancel();
        return true;
      } on ExportCancelled {
        await reporter.cancel();
        return true;
      } on Object catch (error) {
        if ((decodedFrameCache?.committedFrames ?? 0) > 0) {
          await reporter.failRecoverable(error,
              checkpointItems: decodedFrameCache!.committedFrames);
        } else {
          await reporter.fail(error);
        }
        return true;
      } finally {
        await reporter.runBestEffortCleanup(
          'focus stack result cleanup',
          () async => result?.dispose(retainCheckpointFiles: true),
        );
        if (reporter.cancellationRequested) {
          await reporter.runBestEffortCleanup(
              'cancelled focus checkpoint cleanup', () async {
            await stageCheckpoint?.clear();
            await blendCheckpoint?.clear();
          });
        }
        await reporter.dispose();
      }
    },
  );
}
