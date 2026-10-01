import 'dart:async';

import '../demosaic/demosaic_engine.dart';
import '../demosaic/demosaic_registry.dart';
import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../memory/transient_memory_store.dart';
import '../pipeline/phase2_quality_pipeline_factory.dart';
import '../pipeline/pipeline_context.dart';
import '../diagnostics/diagnostic_log.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_file_probe.dart';
import '../raw/raw_metadata_probe.dart';
import '../raw/raw_probe_result.dart';
import 'default_resource_reader.dart';
import 'resource_snapshot.dart';
import 'streamed_raw_phase2_executor.dart';
import '../tiles/overlapped_tile_plan.dart';
import '../tiles/tile_grid.dart';
import 'processing_job.dart';

/// Interval for the memory/thermal heartbeat logged while a single native
/// RAW decode call is in flight (see [_withResourceHeartbeat]). Frequent
/// enough to see a real memory climb or thermal rise develop over a
/// multi-minute call, infrequent enough to not itself be a source of
/// overhead or log-file bloat over a legitimately long "maximum" quality
/// decode.
const Duration _resourceHeartbeatInterval = Duration(seconds: 20);

/// Wraps a single native decode [call] with a periodic [DiagnosticLog] entry
/// reporting system available memory, thermal pressure, and battery level
/// (via [readDefaultResourceSnapshot], the same reading already used for
/// scheduling decisions) for as long as [call] is still pending.
///
/// The decode call itself is opaque native/FFI work that reports nothing to
/// [DiagnosticLog] while it runs — see the "start"/"complete" markers added
/// around each call site, which show *that* a call is stuck but say nothing
/// about *why*. A heartbeat that keeps sampling for the call's entire
/// duration turns "still 0/8 after 70 minutes" into either "available
/// memory was collapsing/thermal pressure was pinned at 1.0 the whole time"
/// (points at device resource exhaustion) or "resources looked normal
/// throughout" (points at the native call itself, e.g. a genuinely corrupt
/// input or an algorithmic hang) — a distinction the previous logging could
/// not make.
Future<T> _withResourceHeartbeat<T>({
  required String label,
  required String sourcePath,
  required Future<T> Function() call,
}) async {
  final Stopwatch stopwatch = Stopwatch()..start();
  final Timer heartbeat = Timer.periodic(_resourceHeartbeatInterval, (_) {
    unawaited(() async {
      try {
        final ResourceSnapshot snapshot = await readDefaultResourceSnapshot();
        final double availableMemoryMb =
            snapshot.availableMemoryBytes / (1024 * 1024);
        await DiagnosticLog.log(
          '$label heartbeat source=$sourcePath '
          'elapsed=${stopwatch.elapsed.inSeconds}s '
          'availableMemory=${availableMemoryMb.toStringAsFixed(0)}MB '
          'thermalPressure=${snapshot.thermalPressure.toStringAsFixed(2)} '
          'battery=${(snapshot.batteryLevel * 100).toStringAsFixed(0)}%',
        );
      } on Object {
        // Diagnostics must never take down real processing.
      }
    }());
  });
  try {
    return await call();
  } finally {
    heartbeat.cancel();
  }
}

/// Phase 2の入力検証と高品質パイプライン接続を行うExecutor。
///
/// ファイルが選択後に削除・置換されていないかをヘッダーから再検証し、
/// 受理できるRAWだけを品質パイプラインへ渡す。登録済みの実デコーダーがある
/// 形式はFP32 CFAまで展開してPipelineContextへ保持し、黒／白レベルと
/// カメラWBを明示的に適用する。デモザイクは独自の本番品質エンジンだけを
/// 要求し、RGBを一時ファイルへタイル保存する。未接続ビルドでは低品質方式へ
/// 切り替えず明示的に失敗する。
///
/// デフォルトでは、生成したタイルストアは処理完了後に必ず破棄される
/// （[onTileStoreReady] が `null` の場合、この関数の可視の副作用は既存の
/// 検証のみで、永続的な出力は残らない）。星の軌跡・流星モードのように、
/// 複数フレーム分のタイルストアをセッションをまたいで保持し、後段の合成
/// ステージ（例：`TiledLightenBlendCombiner`）へ渡す必要がある呼び出し元は、
/// [onTileStoreReady] にコールバックを渡すことで、コミット済みタイル
/// ストアの所有権を引き継げる。コールバックが呼ばれた後、このタイル
/// ストアはこの関数からは破棄されなくなるため、以降のライフサイクル
/// （最終的な `dispose()` を含む）はコールバック側の責任になる。
///
/// [onTileStoreReady] が例外を投げた場合は、その時点でまだ所有権が
/// 移っていない扱いとなり、`finally` 内の `clearTransientData()` が
/// タイルストアを破棄する（一時ファイルを残さないための安全側の
/// デフォルト）。呼び出し元がストアの参照を自分のデータ構造へ
/// 反映させる処理を持つ場合は、その反映が完全に終わってから初めて
/// 例外を投げずに正常終了するように実装し、「反映したのに後から
/// 破棄される」不整合を避けること。
/// [masterDark]・[masterFlat]・[enableHotPixelDetection](Work109)は、
/// `createPhase2QualityValidationPipelineWithCorrections`のものと
/// 同じ意味を持つ。いずれも指定しない(既定値`null`/`true`だが
/// `masterDark`が`null`なら`enableHotPixelDetection`自体は無効)場合、
/// これまで通り`createPhase2QualityValidationPipeline`をそのまま使う
/// ため、既存の呼び出し元(星の軌跡・天の川・流星群の3モード全て)は
/// 挙動が一切変わらない。
Future<void> runPhase2ValidatedJob(
  ProcessingJob job,
  void Function(double progress) reportProgress, {
  RawFileProbe probe = const RawFileProbe(),
  RawMetadataProbe? metadataProbe,
  required RawDecoderRegistry decoderRegistry,
  DemosaicRegistry? demosaicRegistry,
  LinearRgbTileStoreFactory? rgbTileStoreFactory,
  LinearRawMosaic? masterDark,
  LinearRawMosaic? masterFlat,
  FileBackedLinearRawMosaicStore? masterDarkStore,
  FileBackedLinearRawMosaicStore? masterFlatStore,
  bool enableHotPixelDetection = false,
  FutureOr<void> Function(RawFrameMetadata metadata, CfaPattern cfaPattern)?
      onRenderMetadataReady,
  FutureOr<void> Function(LinearRgbTileStore tileStore)? onTileStoreReady,
  FutureOr<void> Function(RawSaturationMask? mask)? onSaturationMaskReady,
  FutureOr<void> Function(String path)? onRawExecutionPathReady,
  bool fileBackRawBeforeDemosaic = false,
  bool preferStreamedRawCalibration = false,
}) async {
  await DiagnosticLog.log('phase2 job start source=${job.sourcePath}');
  job
    ..currentStageId = 'raw_input_validation'
    ..currentStageLabel = 'RAW入力確認';
  final RawProbeResult result = await probe.probe(job.sourcePath);
  if (!result.isAccepted) {
    throw StateError(result.warning ?? 'RAWファイルの入力検証に失敗しました。');
  }
  job
    ..lastCompletedStageId = job.currentStageId
    ..lastCompletedStageLabel = job.currentStageLabel;
  if (job.cancellationRequested) return;

  final RawDecoder decoder = decoderRegistry.requireDecoder(result.format);

  final PipelineContext context = PipelineContext(
    memoryStore: TransientMemoryStore(maximumBytes: 8 * 1024 * 1024),
    tileGrid: const TileGrid(),
  );
  RawFrameMetadata? probedMetadata;
  try {
    context.metadata
      ..['sourceFormat'] = result.format.name
      ..['sourceBytes'] = result.byteLength
      ..['signatureMatched'] = result.signatureMatched;
    if (metadataProbe != null && metadataProbe.supports(result.format)) {
      job
        ..currentStageId = 'raw_metadata'
        ..currentStageLabel = 'RAWメタデータ解析';
      final RawMetadataProbeResult metadata = await metadataProbe.probe(result);
      probedMetadata = metadata.metadata;
      context.metadata
        ..['sourceWidth'] = metadata.width
        ..['sourceHeight'] = metadata.height
        ..['sourceCfa'] = metadata.cfaPattern.name
        ..['activeLeft'] = metadata.metadata.activeArea.left
        ..['activeTop'] = metadata.metadata.activeArea.top
        ..['activeWidth'] = metadata.metadata.activeArea.width
        ..['activeHeight'] = metadata.metadata.activeArea.height
        ..['sourceOrientation'] = metadata.metadata.orientation
        ..['sourceBlackLevels'] = metadata.metadata.blackLevels
        ..['sourceWhiteLevel'] = metadata.metadata.whiteLevel
        ..['sourceCameraWhiteBalance'] = metadata.metadata.cameraWhiteBalance
        ..['metadataProbeId'] = metadata.probeId;
      job
        ..lastCompletedStageId = job.currentStageId
        ..lastCompletedStageLabel = job.currentStageLabel;
    }

    final bool metadataGeometryAllowsStreaming = probedMetadata == null ||
        (probedMetadata.orientation == 1 &&
            probedMetadata.activeArea.left == 0 &&
            probedMetadata.activeArea.top == 0 &&
            context.metadata['sourceWidth'] ==
                probedMetadata.activeArea.width &&
            context.metadata['sourceHeight'] ==
                probedMetadata.activeArea.height);
    final RawFileBackedDecoder? fileBackedDecoder =
        decoder is RawFileBackedDecoder
            ? decoder as RawFileBackedDecoder
            : null;
    final bool canUseStreamedRaw = preferStreamedRawCalibration &&
        !enableHotPixelDetection &&
        masterDark == null &&
        masterFlat == null &&
        fileBackedDecoder != null &&
        fileBackedDecoder.supportsFileBackedDecode &&
        metadataGeometryAllowsStreaming;
    if (canUseStreamedRaw) {
      try {
        await DiagnosticLog.log(
          'native_raw_decode start (streamed) source=${job.sourcePath}',
        );
        final StreamedRawPhase2Result streamed = await _withResourceHeartbeat(
          label: 'native_raw_decode',
          sourcePath: job.sourcePath,
          call: () => runStreamedRawPhase2(
            job: job,
            decoder: fileBackedDecoder,
            decodeRequest: RawDecodeRequest(probe: result),
            probedMetadata: probedMetadata,
            reportProgress: reportProgress,
            masterDarkStore: masterDarkStore,
            masterFlatStore: masterFlatStore,
            demosaicRegistry: demosaicRegistry,
            rgbTileStoreFactory:
                rgbTileStoreFactory ?? _createTemporaryRgbTileStore,
            tileGrid: context.tileGrid,
          ),
        );
        await DiagnosticLog.log(
          'native_raw_decode complete (streamed) source=${job.sourcePath}',
        );
        context.metadata
          ..['rawDecoderId'] = 'streamed:${result.format.name}'
          ..['rawCalibrationStorage'] = 'fileBackedRows'
          ..['demosaicRawSource'] = 'fileBackedDirect';
        await onRawExecutionPathReady?.call('streamed-file-backed');
        bool tileStoreTransferred = false;
        try {
          if (!job.cancellationRequested) {
            await onRenderMetadataReady?.call(
              streamed.metadata,
              streamed.cfaPattern,
            );
            await onSaturationMaskReady?.call(
              streamed.rgbSaturationInfluenceMask,
            );
            if (onTileStoreReady != null) {
              await onTileStoreReady(streamed.tileStore);
              tileStoreTransferred = true;
            }
          }
        } finally {
          if (!tileStoreTransferred) {
            await streamed.tileStore.dispose();
          }
        }
        return;
      } on DemosaicProcessingCancelled {
        if (job.cancellationRequested) return;
        rethrow;
      } on RawDecodeFailure catch (error) {
        if (error.code != RawDecodeErrorCode.unsupportedFormat) rethrow;
        context.metadata['streamedRawFallback'] = error.message;
        await onRawExecutionPathReady?.call(
          'memory-fallback:unsupported-stream-geometry',
        );
      }
    } else if (preferStreamedRawCalibration) {
      // Work362: record which precondition blocked the streamed path, so a
      // device log shows whether the faster file-backed calibration could
      // apply (diagnostic only; no pixel change).
      await DiagnosticLog.log(
        'rawPath stream-precondition '
        'hotPixel=$enableHotPixelDetection '
        'masterDark=${masterDark != null} masterFlat=${masterFlat != null} '
        'fileBackedDecoder=${fileBackedDecoder != null} '
        'supportsFileBacked=${fileBackedDecoder?.supportsFileBackedDecode} '
        'geometryAllows=$metadataGeometryAllowsStreaming '
        'orientation=${probedMetadata?.orientation} '
        'activeLeft=${probedMetadata?.activeArea.left} '
        'activeTop=${probedMetadata?.activeArea.top} '
        'activeWidth=${probedMetadata?.activeArea.width} '
        'activeHeight=${probedMetadata?.activeArea.height} '
        'sourceWidth=${context.metadata['sourceWidth']} '
        'sourceHeight=${context.metadata['sourceHeight']} '
        'source=${job.sourcePath}',
      );
      await onRawExecutionPathReady
          ?.call('memory-fallback:stream-precondition');
    }

    job
      ..currentStageId = 'native_raw_decode'
      ..currentStageLabel = 'ネイティブRAWデコード';
    await DiagnosticLog.log(
      'native_raw_decode start (in-memory) source=${job.sourcePath}',
    );
    RawDecodeResult? decoded = await _withResourceHeartbeat(
      label: 'native_raw_decode',
      sourcePath: job.sourcePath,
      call: () => decoder.decode(RawDecodeRequest(probe: result)),
    );
    await DiagnosticLog.log(
      'native_raw_decode complete (in-memory) source=${job.sourcePath}',
    );
    final RawDecodeResult decodedResult = decoded!;
    job
      ..lastCompletedStageId = job.currentStageId
      ..lastCompletedStageLabel = job.currentStageLabel;
    context.rawMosaic = decodedResult.mosaic;
    final RawSampleLease? decodedSampleLease = decodedResult.sampleLease;
    context.releaseRawSamples = decodedSampleLease?.release;
    final CfaPattern decodedCfaPattern = decodedResult.mosaic.cfaPattern;
    final RawFrameMetadata mergedMetadata = mergeSameFrameRawMetadata(
      decoded: decodedResult.metadata,
      probed: probedMetadata,
    );
    context.metadata
      ..['sourceWidth'] = decodedResult.mosaic.width
      ..['sourceHeight'] = decodedResult.mosaic.height
      ..['sourceCfa'] = decodedCfaPattern.name
      ..['activeLeft'] = mergedMetadata.activeArea.left
      ..['activeTop'] = mergedMetadata.activeArea.top
      ..['activeWidth'] = mergedMetadata.activeArea.width
      ..['activeHeight'] = mergedMetadata.activeArea.height
      ..['sourceOrientation'] = mergedMetadata.orientation
      ..['sourceBlackLevels'] = mergedMetadata.blackLevels
      ..['sourceWhiteLevel'] = mergedMetadata.whiteLevel
      ..['sourceCameraWhiteBalance'] = mergedMetadata.cameraWhiteBalance
      ..['sourceLinearizationTable'] = mergedMetadata.linearizationTable
      ..['sourceBlackLevelDeltaH'] = mergedMetadata.blackLevelDeltaH
      ..['sourceBlackLevelDeltaV'] = mergedMetadata.blackLevelDeltaV
      ..['rawDecoderId'] = decodedResult.decoderId;
    // Do not keep a second owner path to the full decoded mosaic. The pipeline
    // owns it through context.rawMosaic and Work297 may spill/release it before
    // the long tile-by-tile demosaic loop.
    decoded = null;
    if (job.cancellationRequested) return;

    final pipeline = masterDark == null &&
            masterFlat == null &&
            masterDarkStore == null &&
            masterFlatStore == null
        ? createPhase2QualityValidationPipeline(
            demosaicRegistry: demosaicRegistry,
            rgbTileStoreFactory:
                rgbTileStoreFactory ?? _createTemporaryRgbTileStore,
            fileBackRawBeforeDemosaic: fileBackRawBeforeDemosaic,
          )
        : createPhase2QualityValidationPipelineWithCorrections(
            masterDark: masterDark,
            masterFlat: masterFlat,
            masterDarkStore: masterDarkStore,
            masterFlatStore: masterFlatStore,
            enableHotPixelDetection: enableHotPixelDetection,
            demosaicRegistry: demosaicRegistry,
            rgbTileStoreFactory:
                rgbTileStoreFactory ?? _createTemporaryRgbTileStore,
            fileBackRawBeforeDemosaic: fileBackRawBeforeDemosaic,
          );
    await pipeline.run(
      job,
      context,
      reportProgress,
      onStageTimed: (stage, elapsed) => unawaited(DiagnosticLog.log(
        'phase2 stage=${stage.id} elapsedMs=${elapsed.inMilliseconds} '
        'source=${job.sourcePath}',
      )),
    );

    if (!job.cancellationRequested) {
      await onRenderMetadataReady?.call(
        mergedMetadata,
        decodedCfaPattern,
      );
    }

    // onTileStoreReady が指定されている場合のみ、コミット済みタイル
    // ストアの所有権を呼び出し元へ引き継ぐ。ジョブがキャンセルされた
    // 場合や、何らかの理由でパイプラインがストアを設定しなかった場合は
    // context.linearRgbTileStore が null のままなので、その場合は何もせず
    // 既存どおり finally 内の clearTransientData() が（null に対する
    // no-op として）処理を完了する。
    if (!job.cancellationRequested && onSaturationMaskReady != null) {
      await onSaturationMaskReady(context.rgbSaturationInfluenceMask);
    }
    if (onTileStoreReady != null &&
        !job.cancellationRequested &&
        context.linearRgbTileStore != null) {
      final LinearRgbTileStore readyStore = context.linearRgbTileStore!;
      await onTileStoreReady(readyStore);
      // コールバックへ引き渡した時点で所有権は呼び出し元に移るため、
      // ここで context から切り離しておく。こうしないと finally 内の
      // clearTransientData() がこのストアを破棄してしまい、呼び出し元が
      // 受け取った直後のストアを使えなくなってしまう。
      context.linearRgbTileStore = null;
    }
  } finally {
    await context.clearTransientData();
  }
}

Future<LinearRgbTileStore> _createTemporaryRgbTileStore({
  required int width,
  required int height,
  required OverlappedTilePlan plan,
}) =>
    FileBackedLinearRgbTileStore.createTemporary(
      width: width,
      height: height,
      plan: plan,
    );
