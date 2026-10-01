import 'durable_output_receipt.dart';
import 'durable_focus_frame_cache.dart';
import 'durable_decoded_frame_cache.dart';
import '../demosaic/demosaic_registry.dart';
import '../demosaic/native_mobile_stack_demosaic_engine_stub.dart'
    if (dart.library.io) '../demosaic/native_mobile_stack_demosaic_engine.dart';
import '../focus_stack/focus_marking_analysis_pipeline.dart';
import '../io/raw_input_contract.dart';
import '../raw/native_raw_decoder_factory.dart';
import '../raw/raw_file_probe.dart';
import 'focus_marking_background_codec.dart';
import 'external_stall_watchdog.dart';
import 'stack_job_reporter.dart';

const String focusMarkingBackgroundTask = 'focus_marking_background';

Future<bool> runFocusMarkingBackgroundTask(Map<String, dynamic> input) async {
  final List<String> sourcePaths =
      (input['sourcePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final int referenceIndex = (input['referenceIndex'] as num).toInt();
  final String outputPath = input['outputPath'] as String;
  final String statusPath = input['statusPath'] as String;
  final bool showOmissionCandidates =
      input['showOmissionCandidates'] as bool? ?? true;
  final bool autoExcludeOmissionCandidates =
      input['autoExcludeOmissionCandidates'] as bool? ?? false;
  final String outputFormatName =
      input['outputFormatName'] as String? ?? 'linearDng';
  final String storagePresetName =
      input['storagePresetName'] as String? ?? 'maximum';
  if (sourcePaths.length < 2 ||
      referenceIndex < 0 ||
      referenceIndex >= sourcePaths.length) {
    throw ArgumentError('Invalid focus marking background input.');
  }
  final StackJobReporter reporter = StackJobReporter(
    statusPath: statusPath,
    outputPath: outputPath,
    totalItems: sourcePaths.length,
    jobLabel: '深度合成・合焦位置解析',
    completionMessage: '合焦位置の解析が完了しました。使用する写真を確認してください。',
  );
  DurableFocusFrameCache? decodedFrameCache;
  return runWithExternalStallWatchdog(
    statusPath: statusPath,
    jobLabel: '深度合成・合焦位置解析',
    body: () async {
      try {
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
              'algorithmRevision': 337
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
        final metadataProbe = createProductionNativeRawMetadataProbe();
        final List<RawInputFile> inputs = <RawInputFile>[];
        for (int index = 0; index < sourcePaths.length; index++) {
          final probe = await const RawFileProbe().probe(sourcePaths[index]);
          if (!probe.isAccepted) {
            throw StateError(probe.warning ?? 'RAW入力確認に失敗しました。');
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
            progress: 0.06 * (index + 1) / sourcePaths.length,
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
        final FocusMarkingAnalysisResult analysis = await analyzeFocusMarking(
          decodedFrameCache: decodedFrameCache,
          inputs: inputs,
          rawDecoderRegistry:
              createProductionBackgroundNativeRawDecoderRegistry(),
          demosaicRegistry: demosaicRegistry,
          referenceIndex: referenceIndex,
          isCancelled: () => reporter.cancellationRequested,
          reportProgress: ({
            required double fraction,
            required String stage,
            required int completedFrames,
            required int totalFrames,
          }) {
            reporter.updateBestEffort(
              progress: 0.06 + fraction * 0.90,
              stage: stage,
              currentItem: completedFrames,
            );
          },
        );
        await reporter.update(progress: 0.97, stage: 'レビュー情報を保存');
        await writeFocusMarkingBackgroundResult(
          path: outputPath,
          analysis: analysis,
          sourcePaths: sourcePaths,
          referenceIndex: referenceIndex,
          showOmissionCandidates: showOmissionCandidates,
          autoExcludeOmissionCandidates: autoExcludeOmissionCandidates,
          outputFormatName: outputFormatName,
          storagePresetName: storagePresetName,
        );
        await outputReceipt.publish();
        await reporter.runBestEffortCleanup('decoded frame checkpoint cleanup',
            () async {
          final cache = decodedFrameCache;
          if (cache != null && await cache.cache.directory.exists()) {
            await cache.cache.directory.delete(recursive: true);
          }
        });
        await reporter.complete();
        return true;
      } on FocusMarkingAnalysisCancelled {
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
        await reporter.dispose();
      }
    },
  );
}
