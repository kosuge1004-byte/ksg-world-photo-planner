import 'dart:async';

import '../color/raw_camera_color_profile.dart';
import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../memory/transient_memory_store.dart';
import '../pipeline/phase2_quality_pipeline_factory.dart';
import '../pipeline/pipeline_context.dart';
import '../raw/file_backed_raw_decode.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_file_probe.dart';
import '../raw/raw_metadata_probe.dart';
import '../raw/raw_probe_result.dart';
import '../tiles/tile_grid.dart';
import 'processing_job.dart';
import 'streamed_raw_phase2_executor.dart';

/// [runPhase2ValidatedJob]の姉妹関数: 同じ入力検証・デコード手順を踏むが、
/// `createRawMosaicCalibrationPipeline`(デモザイク以降を含まない)を使い、
/// 較正済み(黒レベル・ホワイトレベル・カメラWB・不良画素補正の4段適用済み)
/// だが未デモザイクの [LinearRawMosaic] を [onMosaicReady] へ引き渡す。
///
/// CFA drizzleベースのパイプライン(`tiled_cfa_drizzle.dart`, Work87、
/// および `extract_green_luminance_from_mosaic.dart`, Work88)は、
/// 位置合わせとdrizzle自体がデモザイクの代わりを果たす設計であり、
/// 通常のphase2パイプライン(`runPhase2ValidatedJob`)が最終的に生成する
/// デモザイク済みRGBタイルストアではなく、この較正済み生モザイクの方を
/// 必要とする。
///
/// [runPhase2ValidatedJob]をそのまま再利用して「デモザイクだけ止める」
/// オプションを追加する設計も検討したが、この関数は独立したファイルとして
/// 実装した: [runPhase2ValidatedJob]は既にWork68以降の実機・エミュレータ
/// 検証を経た、このプロジェクトで最も枯れた実行パスの1つであり、
/// そこへ新しい分岐を持ち込むより、確立された「probe→decode→較正
/// パイプライン実行→コールバック引き渡し」という構造を、意図の異なる
/// 新しい関数として複製する方が、既存の検証済み挙動への影響が無く安全
/// だと判断した(このプロジェクトが繰り返し採用してきた「重複は独立した
/// 進化の安全性のために許容する」という方針と同じ)。
///
/// [LinearRawMosaic]自体はファイルハンドルを持たないプレーンなインメモリ
/// オブジェクトのため、[onMosaicReady]へ引き渡した後に
/// `PipelineContext.clearTransientData()`が`context.rawMosaic`をnullに
/// しても、コールバック側が既に保持している参照には一切影響しない
/// (`LinearRgbTileStore`のような明示的な`dispose()`が必要な資源とは
/// 異なり、後始末のための所有権の切り離しを別途行う必要が無い —
/// `pipeline_context.dart`の`clearTransientData()`実装を直接確認して
/// 判断した)。
///
/// Work160では、通常のPhase2 executorと同じ`onRenderMetadataReady`
/// コールバックも追加した。decoder側のセンサー情報を正本としつつ、同一RAW
/// のmetadata probeから不足しているoptional render metadataだけを補完する
/// `mergeSameFrameRawMetadata`を使う。色プロファイル生成も同じmerged metadata
/// を使うため、decoderがWBを持たずprobeだけが正規WBを持つ場合にCFA Drizzle
/// フレームを誤って「色プロファイル欠落」として除外しない。
///
/// [masterDark]が指定された場合、黒レベル補正の直後にダークフレーム
/// 減算(`dark_frame_subtraction.dart`, Work96)を適用する。[masterFlat]
/// が指定された場合、カメラホワイトバランス適用の直後にフラット
/// フィールド補正(`flat_field_calibration.dart`, Work98)を適用する
/// (`createRawMosaicCalibrationPipelineWithCorrections`, Work98)。
/// いずれも`null`(既定値)の場合はこれまで通り適用しない
/// — 既存の呼び出し元は全てこれらを渡していないため、挙動は一切
/// 変わらない。
Future<void> runRawMosaicCalibrationJob(
  ProcessingJob job,
  void Function(double progress) reportProgress, {
  RawFileProbe probe = const RawFileProbe(),
  RawMetadataProbe? metadataProbe,
  required RawDecoderRegistry decoderRegistry,
  LinearRawMosaic? masterDark,
  LinearRawMosaic? masterFlat,
  FileBackedLinearRawMosaicStore? masterDarkStore,
  FileBackedLinearRawMosaicStore? masterFlatStore,
  bool enableHotPixelDetection = false,
  bool enableColdPixelDetection = false,
  bool preferStreamedRawCalibration = false,
  FutureOr<void> Function(FileBackedLinearRawMosaicStore store)?
      onMosaicStoreReady,
  required FutureOr<void> Function(LinearRawMosaic mosaic) onMosaicReady,
  FutureOr<void> Function(RawCameraColorProfile? profile)? onColorProfileReady,
  FutureOr<void> Function(
    RawFrameMetadata metadata,
    CfaPattern cfaPattern,
  )? onRenderMetadataReady,
}) async {
  final RawProbeResult result = await probe.probe(job.sourcePath);
  if (!result.isAccepted) {
    throw StateError(
      result.warning ?? 'RAWファイルの入力検証に失敗しました。',
    );
  }
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
      final RawMetadataProbeResult metadata = await metadataProbe.probe(
        result,
      );
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
        !enableColdPixelDetection &&
        masterDark == null &&
        masterFlat == null &&
        fileBackedDecoder != null &&
        fileBackedDecoder.supportsFileBackedDecode &&
        metadataGeometryAllowsStreaming &&
        onMosaicStoreReady != null;
    if (canUseStreamedRaw) {
      FileBackedRawDecode? decodedFile;
      FileBackedLinearRawMosaicStore? calibratedStore;
      bool storeTransferred = false;
      try {
        decodedFile = await FileBackedRawDecode.decode(
          decoder: fileBackedDecoder,
          request: RawDecodeRequest(probe: result),
        );
        final RawFrameMetadata mergedMetadata = mergeSameFrameRawMetadata(
          decoded: decodedFile.result.metadata,
          probed: probedMetadata,
        );
        final StreamedRawCalibrationResult calibrated =
            await calibrateStreamedRawToStore(
          input: decodedFile.store,
          metadata: mergedMetadata,
          masterDarkStore: masterDarkStore,
          masterFlatStore: masterFlatStore,
          rowChunk: 64,
          isCancelled: () => job.cancellationRequested,
          reportProgress: reportProgress,
        );
        calibratedStore = calibrated.store;
        if (job.cancellationRequested) return;
        final List<double>? d65XyzToCamera = mergedMetadata.d65XyzToCamera;
        final List<double>? phaseWhiteBalance =
            mergedMetadata.cameraWhiteBalance;
        await onColorProfileReady?.call(
          d65XyzToCamera == null || phaseWhiteBalance == null
              ? null
              : RawCameraColorProfile(
                  d65XyzToCamera: d65XyzToCamera,
                  phaseWhiteBalance: phaseWhiteBalance,
                ),
        );
        await onRenderMetadataReady?.call(
          mergedMetadata,
          decodedFile.result.cfaPattern,
        );
        await onMosaicStoreReady(calibratedStore);
        storeTransferred = true;
        return;
      } on RawDecodeFailure catch (error) {
        if (error.code != RawDecodeErrorCode.unsupportedFormat) rethrow;
        context.metadata['streamedRawFallback'] = error.message;
      } finally {
        await decodedFile?.dispose();
        if (!storeTransferred) {
          await calibratedStore?.dispose();
        }
      }
    }

    final RawDecodeResult decoded = await decoder.decode(
      RawDecodeRequest(probe: result),
    );
    context.rawMosaic = decoded.mosaic;
    final RawFrameMetadata mergedMetadata = mergeSameFrameRawMetadata(
      decoded: decoded.metadata,
      probed: probedMetadata,
    );
    context.metadata
      ..['sourceWidth'] = decoded.mosaic.width
      ..['sourceHeight'] = decoded.mosaic.height
      ..['sourceCfa'] = decoded.mosaic.cfaPattern.name
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
      ..['rawDecoderId'] = decoded.decoderId;
    if (job.cancellationRequested) return;

    final pipeline = masterDark == null && masterFlat == null
        ? createRawMosaicCalibrationPipeline()
        : createRawMosaicCalibrationPipelineWithCorrections(
            masterDark: masterDark,
            masterFlat: masterFlat,
            enableHotPixelDetection: enableHotPixelDetection,
            enableColdPixelDetection: enableColdPixelDetection,
          );
    await pipeline.run(job, context, reportProgress);
    if (job.cancellationRequested) return;

    final LinearRawMosaic? calibratedMosaic = context.rawMosaic;
    if (calibratedMosaic == null) {
      throw StateError('較正パイプラインが完了しましたがRAWモザイクがありません。');
    }
    final List<double>? d65XyzToCamera = mergedMetadata.d65XyzToCamera;
    final List<double>? phaseWhiteBalance = mergedMetadata.cameraWhiteBalance;
    await onColorProfileReady?.call(
      d65XyzToCamera == null || phaseWhiteBalance == null
          ? null
          : RawCameraColorProfile(
              d65XyzToCamera: d65XyzToCamera,
              phaseWhiteBalance: phaseWhiteBalance,
            ),
    );
    await onRenderMetadataReady?.call(
      mergedMetadata,
      decoded.mosaic.cfaPattern,
    );
    await onMosaicReady(calibratedMosaic);
  } finally {
    await context.clearTransientData();
  }
}
