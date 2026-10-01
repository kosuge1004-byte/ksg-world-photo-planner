import '../meteor/meteor_candidate_analysis_checkpoint.dart';
import 'durable_decoded_frame_cache.dart';
import 'stack_operation_journal.dart';
import 'dart:convert';
import 'dart:io';

import '../image/file_backed_linear_rgb_tile_store.dart';
import '../raw/native_raw_decoder_factory.dart';
import '../session/meteor_pipeline.dart';
import 'meteor_background_codec.dart';
import 'external_stall_watchdog.dart';
import 'stack_job_reporter.dart';

const String meteorBackgroundTask = 'meteor_analysis_background';

Future<bool> runMeteorBackgroundTask(Map<String, dynamic> input) async {
  final List<String> sourcePaths =
      (input['sourcePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final List<String> darkFramePaths =
      (input['darkFramePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final List<String> flatFramePaths =
      (input['flatFramePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final String outputPath = input['outputPath'] as String;
  final String statusPath = input['statusPath'] as String;
  if (sourcePaths.length < 2) {
    throw ArgumentError('Meteor analysis requires at least two RAW frames.');
  }
  final StackJobReporter reporter = StackJobReporter(
    statusPath: statusPath,
    outputPath: outputPath,
    totalItems: sourcePaths.length,
    jobLabel: '流星群',
    completionMessage: '流星候補の解析が完了しました。候補を確認してください。',
  );
  MeteorAnalysisResult? result;
  final journal = StackOperationJournal(statusPath);
  final retainedStores = <FileBackedLinearRgbTileStore>{};
  final committedFrames = <int>{};
  return runWithExternalStallWatchdog(
    statusPath: statusPath,
    jobLabel: '流星群',
    body: () async {
      try {
        if (!await reporter.start()) {
          // Already completed/failed/cancelled — most likely a
          // START_REDELIVER_INTENT redelivery after the service
          // process was killed just after finishing. Do not redo
          // the work or touch the existing terminal status.
          return true;
        }
        await reporter.update(progress: 0, stage: '流星候補解析', currentItem: 0);
        await journal.enter(
            operation: 'meteorInputIdentity', committedItems: 0);
        final identity = await DurableDecodedFrameCache.buildIdentity(
          paths: [...sourcePaths, ...darkFramePaths, ...flatFramePaths],
          options: {
            'algorithmRevision': 336,
            'mode': 'meteorAnalysis',
            'darkFramePaths': darkFramePaths,
            'flatFramePaths': flatFramePaths
          },
        );
        final cache = DurableDecodedFrameCache(
            statusPath: statusPath, identity: identity);
        await journal.enter(
            operation: 'meteorDecodeAndAnalyze', committedItems: 0);
        final candidateCheckpoint = MeteorCandidateAnalysisCheckpointStore(
            directory: Directory(
                '${File(statusPath).parent.path}${Platform.pathSeparator}meteor_candidates_v2'),
            identity: '$identity|detectors-344');
        result = await runMeteorAnalysisPipeline(
          stageCheckpoint: candidateCheckpoint,
          sourcePaths: sourcePaths,
          decodingConfig: MeteorFrameDecodingConfig(
            decoderRegistry:
                createProductionBackgroundNativeRawDecoderRegistry(),
            metadataProbe: createProductionNativeRawMetadataProbe(),
          ),
          createFrameStore: cache.create,
          restoreDecodedFrame: (index) async {
            final store = await cache.restore(index);
            if (store is FileBackedLinearRgbTileStore) {
              retainedStores.add(store);
              committedFrames.add(index);
              await journal.complete(
                  operation: 'meteorFrameRestore',
                  frameIndex: index,
                  committedItems: committedFrames.length);
            } else {
              await journal.enter(
                  operation: 'meteorFrameDecode',
                  frameIndex: index,
                  committedItems: committedFrames.length);
            }
            return store;
          },
          onDecodedFrameCommitted: (index, store) async {
            await cache.publish(index, store);
            retainedStores.add(store as FileBackedLinearRgbTileStore);
            committedFrames.add(index);
            await journal.complete(
                operation: 'meteorFrameDecode',
                frameIndex: index,
                committedItems: committedFrames.length);
            await reporter.update(
                progress: .55 * committedFrames.length / sourcePaths.length,
                stage: 'RAW解析・較正',
                currentItem: committedFrames.length,
                recoverableCheckpointItems: committedFrames.length);
          },
          darkFramePaths: darkFramePaths.isEmpty ? null : darkFramePaths,
          flatFramePaths: flatFramePaths.isEmpty ? null : flatFramePaths,
          isCancelled: () => reporter.cancellationRequested,
          reportProgress: (double progress) {
            reporter.updateBestEffort(
              progress: progress * 0.96,
              stage: '流星候補解析',
              currentItem: (progress * sourcePaths.length).floor(),
            );
          },
        );
        await reporter.update(progress: 0.97, stage: 'レビュー情報を保存');
        await journal.complete(
            operation: 'meteorDecodeAndAnalyze',
            committedItems: committedFrames.length);
        final pendingOutput = File('$outputPath.pending');
        await pendingOutput.writeAsString(
          jsonEncode(encodeMeteorAnalysisResult(result!)),
          flush: true,
        );
        await pendingOutput.rename(outputPath);

        for (final store in result!.frameStores) {
          if (store is FileBackedLinearRgbTileStore) {
            await store.closeRetainingFile();
          }
        }
        result = null;
        await reporter.complete();
        await reporter.runBestEffortCleanup(
            'meteor candidate checkpoint cleanup', candidateCheckpoint.clear);
        return true;
      } on MeteorAnalysisCancelled {
        await reporter.cancel();
        return true;
      } on Object catch (error) {
        if (committedFrames.isNotEmpty) {
          await reporter.failRecoverable(error,
              checkpointItems: committedFrames.length);
        } else {
          await reporter.fail(error);
        }
        return true;
      } finally {
        if (result != null) {
          await reporter.runBestEffortCleanup('meteor frame-store cleanup',
              () async {
            for (final store in result!.frameStores) {
              try {
                if (store is FileBackedLinearRgbTileStore &&
                    retainedStores.contains(store)) {
                  await store.closeRetainingFile();
                } else {
                  await store?.dispose();
                }
              } on Object {
                // Preserve the original outcome and continue with the other
                // stores while the shared outer deadline is still active.
              }
            }
          });
        }
        await reporter.runBestEffortCleanup('retained meteor handles',
            () async {
          for (final store in retainedStores) {
            await store.closeRetainingFile();
          }
        });
        await reporter.dispose();
      }
    },
  );
}
