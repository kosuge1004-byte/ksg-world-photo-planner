import '../drizzle/cfa_drizzle_tiled_checkpoint.dart';
import 'durable_decoded_frame_cache.dart';
import 'durable_output_receipt.dart';
import 'dart:io';

import '../drizzle/tiled_cfa_drizzle.dart' show CfaDrizzleTiledCancelled;
import '../export/export_result.dart' show ExportCancelled;
import '../export/output_image_format.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../raw/native_raw_decoder_factory.dart';
import '../session/cfa_drizzle_milky_way_export.dart';
import '../session/cfa_drizzle_milky_way_pipeline.dart';
import 'external_stall_watchdog.dart';
import 'stack_job_reporter.dart';

const String cfaDrizzleBackgroundTask = 'cfa_drizzle_stack_background';

Future<bool> runCfaDrizzleBackgroundTask(Map<String, dynamic> input) async {
  final List<String> sourcePaths =
      (input['sourcePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final List<String>? darkFramePaths =
      (input['darkFramePaths'] as List<dynamic>?)?.cast<String>();
  final List<String>? flatFramePaths =
      (input['flatFramePaths'] as List<dynamic>?)?.cast<String>();
  final String outputPath = input['outputPath'] as String;
  final String statusPath = input['statusPath'] as String;
  final bool enableRobustRejection =
      input['enableRobustRejection'] as bool? ?? true;
  final bool useComprehensiveFrameWeighting =
      input['useComprehensiveFrameWeighting'] as bool? ?? true;
  final bool usePsfRefinement = input['usePsfRefinement'] as bool? ?? true;
  final bool enableLocalRegistration =
      input['enableLocalRegistration'] as bool? ?? true;

  if (sourcePaths.length < 2) {
    throw ArgumentError('Background stack requires at least two RAW frames.');
  }

  final StackJobReporter reporter = StackJobReporter(
    statusPath: statusPath,
    outputPath: outputPath,
    totalItems: sourcePaths.length,
  );

  CfaDrizzleTiledCheckpointStore? checkpoint;
  CfaDrizzleMilkyWayResult? result;
  return runWithExternalStallWatchdog(
    statusPath: statusPath,
    jobLabel: '天の川スタック',
    body: () async {
      try {
        if (!await reporter.start()) {
          // Already completed/failed/cancelled — most likely a
          // START_REDELIVER_INTENT redelivery after the service
          // process was killed just after finishing. Do not redo
          // the work or touch the existing terminal status.
          return true;
        }
        final identity = await DurableDecodedFrameCache.buildIdentity(paths: [
          ...sourcePaths,
          ...?darkFramePaths,
          ...?flatFramePaths
        ], options: {
          for (final e in input.entries)
            if (e.key != 'statusPath' && e.key != 'outputPath') e.key: e.value,
          'algorithmRevision': 344
        });
        final outputReceipt = DurableOutputReceipt(outputPath, identity);
        if (await outputReceipt.isValid()) {
          await reporter.complete();
          return true;
        }
        checkpoint = CfaDrizzleTiledCheckpointStore(
            directory: Directory(
                '${File(statusPath).parent.path}${Platform.pathSeparator}cfa_tiles_v2'),
            identity: identity);
        await reporter.update(
          progress: 0,
          stage: 'RAW解析・較正',
          currentItem: 0,
        );

        result = await runCfaDrizzleMilkyWayPipeline(
          stageCheckpoint: checkpoint,
          sourcePaths: sourcePaths,
          decodingConfig: CfaDrizzleMilkyWayDecodingConfig(
            decoderRegistry:
                createProductionBackgroundNativeRawDecoderRegistry(),
            metadataProbe: createFeatureFlaggedNativeRawMetadataProbe(),
          ),
          valueStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
          coverageStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
          darkFramePaths:
              (darkFramePaths?.isEmpty ?? true) ? null : darkFramePaths,
          flatFramePaths:
              (flatFramePaths?.isEmpty ?? true) ? null : flatFramePaths,
          enableRobustRejection: enableRobustRejection,
          useComprehensiveFrameWeighting: useComprehensiveFrameWeighting,
          usePsfRefinement: usePsfRefinement,
          enableLocalRegistration: enableLocalRegistration,
          reportStatus: ({
            required String stage,
            required int current,
            required int total,
          }) {
            reporter.updateBestEffort(stage: stage, currentItem: current);
          },
          reportProgress: (double progress) {
            reporter.updateBestEffort(progress: progress * 0.7);
          },
          isCancelled: () => reporter.cancellationRequested,
        );

        await reporter.update(
          progress: 0.7,
          stage: 'CFA再構築・Linear DNG書き出し',
          currentItem: sourcePaths.length,
        );

        await File(outputPath).parent.create(recursive: true);
        await compositeCfaDrizzleMilkyWayAndExport(
          result: result!,
          retainCheckpointFiles: true,
          gapFillOutputStoreFactory:
              FileBackedLinearRgbTileStore.createTemporary,
          exportPath: outputPath,
          format: OutputImageFormat.linearDng,
          localToneStrength: 0,
          reportProgress: (double progress) {
            reporter.updateBestEffort(progress: 0.7 + progress * 0.3);
          },
          isCancelled: () => reporter.cancellationRequested,
        );

        await outputReceipt.publish();
        await reporter.runBestEffortCleanup(
            'CFA checkpoint cleanup', () async => checkpoint?.clear());
        await reporter.complete();
        return true;
      } on CfaDrizzleTiledCancelled {
        await reporter.cancel();
        return true;
      } on ExportCancelled {
        await reporter.cancel();
        return true;
      } on Object catch (error) {
        // The application-level failure is durably persisted by the reporter.
        // Return success to WorkManager so it does not silently retry an expensive
        // highest-quality stack after the UI has already surfaced a terminal
        // failure. A new attempt must be an explicit user action.
        if (reporter.cancellationRequested) {
          await reporter.cancel();
        } else if ((checkpoint?.completedTileCount ?? 0) > 0) {
          await reporter.failRecoverable(error,
              checkpointItems: sourcePaths.length);
        } else {
          await reporter.fail(error);
        }
        return true;
      } finally {
        await reporter.runBestEffortCleanup('CFA handles', () async {
          final current = result;
          if (current != null) {
            for (final store in [
              current.valueStore,
              current.coverageStore,
              current.saturationCoverageStore,
              current.saturationDecisionCoverageStore
            ]) {
              if (store is FileBackedLinearRgbTileStore) {
                await store.closeRetainingFile();
              }
            }
          }
          if (reporter.cancellationRequested) await checkpoint?.clear();
        });
        await reporter.dispose();
      }
    },
  );
}
