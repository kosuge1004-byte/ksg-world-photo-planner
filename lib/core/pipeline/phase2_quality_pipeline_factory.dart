import 'dart:async';
import 'dart:io' show Platform;
import 'dart:typed_data';

import '../demosaic/demosaic_algorithm.dart';
import '../demosaic/demosaic_engine.dart';
import '../demosaic/demosaic_registry.dart';
import '../demosaic/demosaic_request.dart';
import '../demosaic/native_mobile_stack_demosaic_engine_stub.dart'
    if (dart.library.io) '../demosaic/native_mobile_stack_demosaic_engine.dart';
import '../engine/processing_job.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../quality/highest_quality_policy.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'dark_frame_subtraction.dart';
import 'parallel_file_backed_demosaic.dart';
import 'cold_pixel_detection.dart';
import 'execution_target.dart';
import 'flat_field_calibration.dart';
import 'hot_pixel_detection.dart';
import 'pipeline_context.dart';
import 'pipeline_stage.dart';
import 'processing_pipeline.dart';
import 'raw_defect_map.dart';
import 'raw_defect_pixel_corrector.dart';
import 'raw_mosaic_calibrator.dart';

/// Default tile-worker isolate pool size for the file-backed demosaic
/// path. Bounded well below the device's core count: each worker holds
/// its own decoded input-tile buffer and native scratch allocation, so
/// an unbounded pool trades one long-running isolate's memory footprint
/// for several concurrent ones, which is a worse trade on memory-
/// constrained phones than the wall-clock win is worth.
int _defaultDemosaicMaxWorkers() {
  try {
    return Platform.numberOfProcessors.clamp(1, 4).toInt();
  } on Object {
    return 2;
  }
}

ProcessingPipeline createPhase2QualityValidationPipeline({
  HighestQualityPolicy qualityPolicy = const HighestQualityPolicy(),
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
  RawDefectPixelCorrector defectPixelCorrector =
      const RawDefectPixelCorrector(),
  DemosaicRegistry? demosaicRegistry,
  LinearRgbTileStoreFactory? rgbTileStoreFactory,
  bool fileBackRawBeforeDemosaic = false,
  int? demosaicMaxWorkers,
}) {
  final DemosaicRegistry effectiveDemosaicRegistry = demosaicRegistry ??
      DemosaicRegistry(
        <DemosaicEngine>[
          NativeMobileStackDemosaicEngine(),
        ],
      );
  return ProcessingPipeline(
    stages: <PipelineStage>[
      _stage('raw_read', 'RAW読込', 2, ExecutionTarget.cpu, qualityPolicy),
      _linearizationStage(qualityPolicy, calibrator),
      _blackLevelStage(qualityPolicy, calibrator),
      _whiteLevelStage(qualityPolicy, calibrator),
      _cameraWhiteBalanceStage(qualityPolicy, calibrator),
      _defectPixelStage(qualityPolicy, defectPixelCorrector),
      _demosaicStage(
        qualityPolicy,
        effectiveDemosaicRegistry,
        rgbTileStoreFactory,
        fileBackRawBeforeDemosaic: fileBackRawBeforeDemosaic,
        maxWorkers: demosaicMaxWorkers ?? _defaultDemosaicMaxWorkers(),
      ),
    ],
  );
}

/// [createPhase2QualityValidationPipeline]と同じだが、
/// `createRawMosaicCalibrationPipelineWithCorrections`(Work98/108)と
/// 同じ`masterDark`・`masterFlat`・`enableHotPixelDetection`を較正段へ
/// 適用してからデモザイクまで進む版(Work109/Work249)。
///
/// これまでダーク/フラット較正・ホットピクセル検出(Work96-108)は、
/// CFA drizzleベースの実験的パイプライン(`cfa_drizzle_milky_way_
/// pipeline.dart`)からしか到達できず、実際にホーム画面から到達できる
/// 星の軌跡・天の川・流星群の3モード(いずれも本関数の姉妹関数である
/// [createPhase2QualityValidationPipeline]/[runPhase2ValidatedJob]を
/// 経由する)には一切繋がっていなかった — 各較正段自体
/// (`_darkFrameSubtractionStage`等)はこのファイル内の既存のprivate
/// 関数をそのまま再利用している。Work249では、この前処理ファクトリに
/// 残っていた実処理を伴わない「星位置合わせ／スタック累積／ノイズ低減／
/// Linear画像生成」の疑似ステージを除去し、ここではRAW前処理とデモザイク
/// までだけを担当する。実際の位置合わせ・合成・出力は後段パイプラインで
/// 実行・進捗報告される。
///
/// 既存の[createPhase2QualityValidationPipeline]自体は一切変更して
/// いない、純粋な追加関数。
ProcessingPipeline createPhase2QualityValidationPipelineWithCorrections({
  LinearRawMosaic? masterDark,
  LinearRawMosaic? masterFlat,
  FileBackedLinearRawMosaicStore? masterDarkStore,
  FileBackedLinearRawMosaicStore? masterFlatStore,
  // Automatic cosmetic correction is explicit opt-in. Dark/flat calibration
  // remains enabled independently; no guessed defect threshold is applied by default.
  bool enableHotPixelDetection = false,
  bool enableColdPixelDetection = false,
  int hotPixelNeighborhoodRadius = 5,
  double hotPixelRatioThreshold = 5,
  double hotPixelAbsoluteThreshold = 0,
  int coldPixelNeighborhoodRadius = 5,
  double coldPixelRatioThreshold = 5,
  double coldPixelAbsoluteThreshold = 0,
  HighestQualityPolicy qualityPolicy = const HighestQualityPolicy(),
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
  RawDefectPixelCorrector defectPixelCorrector =
      const RawDefectPixelCorrector(),
  DemosaicRegistry? demosaicRegistry,
  LinearRgbTileStoreFactory? rgbTileStoreFactory,
  bool fileBackRawBeforeDemosaic = false,
  int? demosaicMaxWorkers,
}) {
  if (masterDark != null && masterDarkStore != null) {
    throw ArgumentError(
      'Supply either masterDark or masterDarkStore, not both.',
    );
  }
  if (masterFlat != null && masterFlatStore != null) {
    throw ArgumentError(
      'Supply either masterFlat or masterFlatStore, not both.',
    );
  }
  if (enableHotPixelDetection &&
      masterDark == null &&
      masterDarkStore != null) {
    throw ArgumentError(
      'File-backed master-dark hot-pixel detection is not enabled in this path.',
    );
  }
  if (enableColdPixelDetection &&
      masterFlat == null &&
      masterFlatStore != null) {
    throw ArgumentError(
      'File-backed master-flat cold-pixel detection is not enabled in this path.',
    );
  }
  final DemosaicRegistry effectiveDemosaicRegistry = demosaicRegistry ??
      DemosaicRegistry(
        <DemosaicEngine>[
          NativeMobileStackDemosaicEngine(),
        ],
      );
  return ProcessingPipeline(
    stages: <PipelineStage>[
      _stage('raw_read', 'RAW読込', 2, ExecutionTarget.cpu, qualityPolicy),
      _linearizationStage(qualityPolicy, calibrator),
      _blackLevelStage(qualityPolicy, calibrator),
      if (masterDark != null)
        _darkFrameSubtractionStage(qualityPolicy, masterDark),
      if (masterDarkStore != null)
        _fileBackedDarkFrameSubtractionStage(qualityPolicy, masterDarkStore),
      if (masterDark != null && enableHotPixelDetection)
        _hotPixelDetectionStage(
          qualityPolicy,
          masterDark,
          neighborhoodRadius: hotPixelNeighborhoodRadius,
          ratioThreshold: hotPixelRatioThreshold,
          absoluteThreshold: hotPixelAbsoluteThreshold,
        ),
      if (masterFlat != null && enableColdPixelDetection)
        _coldPixelDetectionStage(
          qualityPolicy,
          masterFlat,
          neighborhoodRadius: coldPixelNeighborhoodRadius,
          ratioThreshold: coldPixelRatioThreshold,
          absoluteThreshold: coldPixelAbsoluteThreshold,
        ),
      _whiteLevelStage(qualityPolicy, calibrator),
      _cameraWhiteBalanceStage(qualityPolicy, calibrator),
      if (masterFlat != null)
        _flatFieldCorrectionStage(qualityPolicy, masterFlat),
      if (masterFlatStore != null)
        _fileBackedFlatFieldCorrectionStage(qualityPolicy, masterFlatStore),
      _defectPixelStage(qualityPolicy, defectPixelCorrector),
      _demosaicStage(
        qualityPolicy,
        effectiveDemosaicRegistry,
        rgbTileStoreFactory,
        fileBackRawBeforeDemosaic: fileBackRawBeforeDemosaic,
        maxWorkers: demosaicMaxWorkers ?? _defaultDemosaicMaxWorkers(),
      ),
    ],
  );
}

/// [createPhase2QualityValidationPipeline]と同じ黒レベル・ホワイトレベル・
/// カメラホワイトバランス・不良画素補正の4段だけを実行し、デモザイク以降
/// は一切含まないパイプライン。
///
/// CFA drizzleベースのパイプライン(`tiled_cfa_drizzle.dart`, Work87)は、
/// 位置合わせとdrizzle自体がデモザイクの代わりを果たす設計であり、
/// フレームをデモザイクへ渡す前の、較正済みだが未デモザイクの
/// [PipelineContext.rawMosaic] だけが必要になる。この工場関数は、
/// 既存の較正ステージ実装(`_blackLevelStage`等)をそのまま再利用し、
/// デモザイク以降を単に含めないことでこれを提供する — 既存の
/// [createPhase2QualityValidationPipeline] 自体は一切変更していない、
/// 純粋な追加。
ProcessingPipeline createRawMosaicCalibrationPipeline({
  HighestQualityPolicy qualityPolicy = const HighestQualityPolicy(),
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
  RawDefectPixelCorrector defectPixelCorrector =
      const RawDefectPixelCorrector(),
}) {
  return ProcessingPipeline(
    stages: <PipelineStage>[
      _stage('raw_read', 'RAW読込', 2, ExecutionTarget.cpu, qualityPolicy),
      _linearizationStage(qualityPolicy, calibrator),
      _blackLevelStage(qualityPolicy, calibrator),
      _whiteLevelStage(qualityPolicy, calibrator),
      _cameraWhiteBalanceStage(qualityPolicy, calibrator),
      _defectPixelStage(qualityPolicy, defectPixelCorrector),
    ],
  );
}

/// [createRawMosaicCalibrationPipeline]と同じだが、黒レベル補正の直後
/// (ホワイトレベル正規化より前)に、[masterDark]を使ったダークフレーム
/// 減算(`dark_frame_subtraction.dart`, Work96)を挿入する版。
///
/// 挿入位置を黒レベル補正の直後にした理由: `dark_frame_subtraction.
/// dart`自身のドキュメントに明記した通り、マスターダークは「黒レベル
/// より上の、暗電流由来の信号」を表す設計であり、これと同じく黒レベル
/// 減算済みのライトフレームから引くことで初めて意味を持つ。ホワイト
/// レベル正規化やカメラホワイトバランスのゲームより後に減算すると、
/// マスターダークの値がそれらのスケーリングと整合しなくなってしまう
/// ため、この位置が正しい。
///
/// 既存の[createRawMosaicCalibrationPipeline]自体は一切変更していない
/// 、純粋な追加関数(Work96のダーク減算モジュールと同じ、このプロ
/// ジェクトが一貫して採用してきた「既存の枯れたコードには手を入れず
/// 複製する」方針)。
ProcessingPipeline createRawMosaicCalibrationPipelineWithDarkSubtraction({
  required LinearRawMosaic masterDark,
  HighestQualityPolicy qualityPolicy = const HighestQualityPolicy(),
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
  RawDefectPixelCorrector defectPixelCorrector =
      const RawDefectPixelCorrector(),
}) {
  return ProcessingPipeline(
    stages: <PipelineStage>[
      _stage('raw_read', 'RAW読込', 2, ExecutionTarget.cpu, qualityPolicy),
      _linearizationStage(qualityPolicy, calibrator),
      _blackLevelStage(qualityPolicy, calibrator),
      _darkFrameSubtractionStage(qualityPolicy, masterDark),
      _whiteLevelStage(qualityPolicy, calibrator),
      _cameraWhiteBalanceStage(qualityPolicy, calibrator),
      _defectPixelStage(qualityPolicy, defectPixelCorrector),
    ],
  );
}

PipelineStage _darkFrameSubtractionStage(
  HighestQualityPolicy qualityPolicy,
  LinearRawMosaic masterDark,
) {
  const String id = 'dark_frame_subtraction';
  return PipelineStage(
    id: id,
    label: 'ダークフレーム減算',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (
      ProcessingJob job,
      PipelineContext context,
      void Function(double) report,
    ) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final LinearRawMosaic? rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      context.rawMosaic = subtractDarkFrameInPlace(rawMosaic, masterDark);
      context.metadata['rawCalibration:$id'] = true;
      report(1);
    },
  );
}

/// [createRawMosaicCalibrationPipeline]と同じだが、[masterDark]・
/// [masterFlat]のどちらか、または両方を任意に組み合わせて適用できる、
/// より汎用的な版(Work98)。
///
/// - [masterDark]は黒レベル補正の直後・ホワイトレベル正規化より前に
///   適用する(`createRawMosaicCalibrationPipelineWithDarkSubtraction`,
///   Work97と同じ位置・同じ理由)。
/// - [masterFlat]はカメラホワイトバランス適用の直後・不良画素補正より
///   前に適用する。フラット較正は乗算的な補正(周辺減光・ゴミの影を
///   1.0付近の係数で除算する)であり、ホワイトバランスのチャンネル別
///   ゲインが先に適用済みであれば、フラット較正自体はチャンネルを
///   問わず同じ係数で全チャンネルへ一様に効く(周辺減光・ゴミの影は
///   通常どのチャンネルにも同じように影響するため)、という前提に
///   基づく順序。
/// - [enableHotPixelDetection](Work108、既定`false`)は、[masterDark]が
///   指定されている場合のみ意味を持つ: `hot_pixel_detection.dart`で
///   マスターダークからホットピクセルを検出し、`context.rawDefectMap`
///   を設定してから[_defectPixelStage]を実行する。このプロジェクトの
///   不良画素補正ステージ自体は早くから存在していたが、
///   `context.rawDefectMap`がどこからも実際に設定されたことが無く、
///   常にスキップされ続けていた(`hot_pixel_detection.dart`自身の
///   ドキュメント参照) — マスターダークが利用可能な場合にこの発見的
///   ギャップを埋める。
///
/// 既存の[createRawMosaicCalibrationPipeline]・
/// [createRawMosaicCalibrationPipelineWithDarkSubtraction]自体は一切
/// 変更していない、純粋な追加関数。
ProcessingPipeline createRawMosaicCalibrationPipelineWithCorrections({
  LinearRawMosaic? masterDark,
  LinearRawMosaic? masterFlat,
  // Automatic cosmetic correction is explicit opt-in. Dark/flat calibration
  // remains enabled independently; no guessed defect threshold is applied by default.
  bool enableHotPixelDetection = false,
  bool enableColdPixelDetection = false,
  int hotPixelNeighborhoodRadius = 5,
  double hotPixelRatioThreshold = 5,
  double hotPixelAbsoluteThreshold = 0,
  int coldPixelNeighborhoodRadius = 5,
  double coldPixelRatioThreshold = 5,
  double coldPixelAbsoluteThreshold = 0,
  HighestQualityPolicy qualityPolicy = const HighestQualityPolicy(),
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
  RawDefectPixelCorrector defectPixelCorrector =
      const RawDefectPixelCorrector(),
}) {
  return ProcessingPipeline(
    stages: <PipelineStage>[
      _stage('raw_read', 'RAW読込', 2, ExecutionTarget.cpu, qualityPolicy),
      _linearizationStage(qualityPolicy, calibrator),
      _blackLevelStage(qualityPolicy, calibrator),
      if (masterDark != null)
        _darkFrameSubtractionStage(qualityPolicy, masterDark),
      if (masterDark != null && enableHotPixelDetection)
        _hotPixelDetectionStage(
          qualityPolicy,
          masterDark,
          neighborhoodRadius: hotPixelNeighborhoodRadius,
          ratioThreshold: hotPixelRatioThreshold,
          absoluteThreshold: hotPixelAbsoluteThreshold,
        ),
      if (masterFlat != null && enableColdPixelDetection)
        _coldPixelDetectionStage(
          qualityPolicy,
          masterFlat,
          neighborhoodRadius: coldPixelNeighborhoodRadius,
          ratioThreshold: coldPixelRatioThreshold,
          absoluteThreshold: coldPixelAbsoluteThreshold,
        ),
      _whiteLevelStage(qualityPolicy, calibrator),
      _cameraWhiteBalanceStage(qualityPolicy, calibrator),
      if (masterFlat != null)
        _flatFieldCorrectionStage(qualityPolicy, masterFlat),
      _defectPixelStage(qualityPolicy, defectPixelCorrector),
    ],
  );
}

PipelineStage _fileBackedDarkFrameSubtractionStage(
  HighestQualityPolicy qualityPolicy,
  FileBackedLinearRawMosaicStore masterDarkStore,
) {
  const String id = 'dark_frame_subtraction';
  return PipelineStage(
    id: id,
    label: 'ダークフレーム減算',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (
      ProcessingJob job,
      PipelineContext context,
      void Function(double) report,
    ) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final LinearRawMosaic? rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      context.rawMosaic = await subtractDarkFrameFromStoreInPlace(
        rawMosaic,
        masterDarkStore,
      );
      context.metadata
        ..['rawCalibration:$id'] = true
        ..['rawCalibration:$id:masterStorage'] = 'fileBacked';
      report(1);
    },
  );
}

PipelineStage _fileBackedFlatFieldCorrectionStage(
  HighestQualityPolicy qualityPolicy,
  FileBackedLinearRawMosaicStore masterFlatStore,
) {
  const String id = 'flat_field_correction';
  return PipelineStage(
    id: id,
    label: 'フラットフィールド補正',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (
      ProcessingJob job,
      PipelineContext context,
      void Function(double) report,
    ) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final LinearRawMosaic? rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      context.rawMosaic = await applyFlatFieldCorrectionFromStoreInPlace(
        rawMosaic,
        masterFlatStore,
      );
      context.metadata
        ..['rawCalibration:$id'] = true
        ..['rawCalibration:$id:masterStorage'] = 'fileBacked';
      report(1);
    },
  );
}

PipelineStage _hotPixelDetectionStage(
  HighestQualityPolicy qualityPolicy,
  LinearRawMosaic masterDark, {
  required int neighborhoodRadius,
  required double ratioThreshold,
  required double absoluteThreshold,
}) {
  const String id = 'hot_pixel_detection';
  return PipelineStage(
    id: id,
    label: 'ホットピクセル検出',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (
      ProcessingJob job,
      PipelineContext context,
      void Function(double) report,
    ) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final RawDefectMap defectMap = detectHotPixelsFromMasterDark(
        masterDark,
        neighborhoodRadius: neighborhoodRadius,
        ratioThreshold: ratioThreshold,
        absoluteThreshold: absoluteThreshold,
      );
      context.rawDefectMap = defectMap;
      context.metadata['rawCalibration:$id'] = true;
      context.metadata['hotPixelCount'] = defectMap.points.length;
      report(1);
    },
  );
}

PipelineStage _coldPixelDetectionStage(
  HighestQualityPolicy qualityPolicy,
  LinearRawMosaic masterFlat, {
  required int neighborhoodRadius,
  required double ratioThreshold,
  required double absoluteThreshold,
}) {
  const String id = 'cold_pixel_detection';
  return PipelineStage(
    id: id,
    label: 'Cold pixel detection',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (
      ProcessingJob job,
      PipelineContext context,
      void Function(double) report,
    ) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final RawDefectMap coldMap = detectColdPixelsFromMasterFlat(
        masterFlat,
        neighborhoodRadius: neighborhoodRadius,
        ratioThreshold: ratioThreshold,
        absoluteThreshold: absoluteThreshold,
      );
      final RawDefectMap? existing = context.rawDefectMap;
      context.rawDefectMap = existing == null
          ? coldMap
          : mergeRawDefectMaps(<RawDefectMap>[existing, coldMap]);
      context.metadata['rawCalibration:$id'] = true;
      context.metadata['coldPixelCount'] = coldMap.points.length;
      report(1);
    },
  );
}

PipelineStage _flatFieldCorrectionStage(
  HighestQualityPolicy qualityPolicy,
  LinearRawMosaic masterFlat,
) {
  const String id = 'flat_field_correction';
  return PipelineStage(
    id: id,
    label: 'フラットフィールド補正',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (
      ProcessingJob job,
      PipelineContext context,
      void Function(double) report,
    ) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final LinearRawMosaic? rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      context.rawMosaic =
          applyFlatFieldCorrectionInPlace(rawMosaic, masterFlat);
      context.metadata['rawCalibration:$id'] = true;
      report(1);
    },
  );
}

PipelineStage _demosaicStage(
  HighestQualityPolicy qualityPolicy,
  DemosaicRegistry registry,
  LinearRgbTileStoreFactory? rgbTileStoreFactory, {
  required bool fileBackRawBeforeDemosaic,
  int maxWorkers = 1,
}) {
  const String id = 'demosaic';
  return PipelineStage(
    id: id,
    label: '高品質デモザイク',
    weight: 4,
    target: ExecutionTarget.gpu,
    runner: (ProcessingJob job, PipelineContext context,
        void Function(double) report) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      context.metadata['requestedDemosaicAlgorithm'] =
          DemosaicAlgorithm.mobileStackAdaptive.name;
      LinearRawMosaic? rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        throw StateError('独自デモザイクへ渡す補正済みRAWモザイクがありません。');
      }
      final int imageWidth = rawMosaic.width;
      final int imageHeight = rawMosaic.height;
      final RawSaturationMask? sourceSaturationMask = rawMosaic.saturationMask;
      final DemosaicEngine engine = registry.requireProduction(
        DemosaicAlgorithm.mobileStackAdaptive,
      );
      final LinearRgbTileStoreFactory? storeFactory = rgbTileStoreFactory;
      if (storeFactory == null) {
        throw const LinearRgbTileStoreUnavailable(
          'RGBタイル保存先が接続されていません。',
        );
      }
      final int requestedTileSize = context.tileGrid.preferredTileWidth;
      final int tileSize = requestedTileSize > 48 ? requestedTileSize : 64;
      final OverlappedTilePlan plan = OverlappedTilePlan.create(
        imageWidth: imageWidth,
        imageHeight: imageHeight,
        tileSize: tileSize,
        overlap: 24,
      );
      final LinearRgbTileStore store = await storeFactory(
        width: imageWidth,
        height: imageHeight,
        plan: plan,
      );
      bool committed = false;
      FileBackedLinearRawMosaicStore? calibratedRawStore;
      try {
        _validateEmptyStore(imageWidth, imageHeight, store);
        if (fileBackRawBeforeDemosaic &&
            engine is NativeMobileStackDemosaicEngine) {
          calibratedRawStore = await _spillCalibratedRawForDemosaic(rawMosaic);
          // The calibrated full-frame CFA plane is no longer required in RAM.
          // Keep only the compact sensor-saturation mask while the native
          // demosaic backend reads each input rectangle from the store.
          context.rawMosaic = null;
          rawMosaic = null;
          // Work298: once every calibrated sample has been copied into the
          // file-backed store, the native decode allocation is no longer part
          // of the demosaic source. Release it now instead of waiting for GC.
          context.releaseRawSampleStorage();
          context.metadata['demosaicRawSource'] = 'fileBacked';
          context.metadata['demosaicRawPersistentBytes'] =
              calibratedRawStore.persistentByteLength;
        } else {
          context.metadata['demosaicRawSource'] = 'memory';
        }
        report(0.02);
        final FileBackedLinearRawMosaicStore? fileBacked = calibratedRawStore;
        if (fileBacked != null && engine is NativeMobileStackDemosaicEngine) {
          // File-backed source: every worker isolate opens its own read-only
          // view of the same committed store, so tiles can be demosaiced
          // concurrently across isolates instead of one at a time on this
          // isolate. Output is written back in the same deterministic plan
          // order as the previous sequential loop — only wall-clock time
          // differs, not the resulting pixels.
          try {
            await demosaicFileBackedTilesParallel(
              calibratedRawStore: fileBacked,
              saturationMask: sourceSaturationMask,
              plan: plan,
              outputStore: store,
              maximumWorkers: maxWorkers,
              isCancelled: () => job.cancellationRequested,
              reportProgress: report,
              validateTile: _validateDemosaicTile,
            );
          } on DemosaicProcessingCancelled {
            if (job.cancellationRequested) return;
            rethrow;
          }
          if (job.cancellationRequested) return;
        } else {
          for (int index = 0; index < plan.tiles.length; index++) {
            if (job.cancellationRequested) return;
            final OverlappedTile plannedTile = plan.tiles[index];
            late final LinearRgbTile tile;
            try {
              final LinearRawMosaic? inMemory = rawMosaic;
              if (inMemory == null) {
                throw StateError(
                    'In-memory demosaic source was released early.');
              }
              final DemosaicRequest request = DemosaicRequest(
                mosaic: inMemory,
                tile: plannedTile,
                qualityPolicy: qualityPolicy,
                isCancelled: () => job.cancellationRequested,
              );
              request.validate();
              tile = await engine.processTile(request);
            } on DemosaicProcessingCancelled {
              if (job.cancellationRequested) return;
              rethrow;
            }
            if (job.cancellationRequested) return;
            _validateDemosaicTile(plannedTile, tile);
            await store.writeTile(tile);
            if (job.cancellationRequested) return;
            report(0.02 + 0.96 * (index + 1) / plan.tiles.length);
          }
        }
        await store.commit();
        if (job.cancellationRequested) return;
        committed = true;
        context
          ..linearRgbTileStore = store
          ..rgbSaturationInfluenceMask = sourceSaturationMask?.dilatedChebyshev(
            width: imageWidth,
            height: imageHeight,
            radius: engine.requiredInputRadius,
          )
          ..rawMosaic = null
          ..rawDefectMap = null;
        context.metadata
          ..['demosaicAlgorithm'] = engine.algorithm.name
          ..['demosaicProductionQuality'] = engine.isProductionQuality
          ..['demosaicTileCount'] = plan.tiles.length
          ..['demosaicPeakRgbTileBytes'] = _maximumRgbTileBytes(plan.tiles)
          ..['demosaicPersistentBytes'] = store.persistentByteLength;
        report(1);
      } finally {
        try {
          await calibratedRawStore?.dispose();
        } on Object {
          // Best-effort cleanup; preserve the original demosaic failure.
        }
        if (!committed) await store.abort();
        if (engine is DisposableDemosaicEngine) {
          (engine as DisposableDemosaicEngine).disposeTransientResources();
        }
      }
    },
  );
}

Future<FileBackedLinearRawMosaicStore> _spillCalibratedRawForDemosaic(
  LinearRawMosaic mosaic,
) async {
  final FileBackedLinearRawMosaicStore store =
      await FileBackedLinearRawMosaicStore.createTemporary(
    width: mosaic.width,
    height: mosaic.height,
    cfaPattern: mosaic.cfaPattern,
  );
  bool committed = false;
  try {
    const int rowChunk = 64;
    for (int y = 0; y < mosaic.height; y += rowChunk) {
      final int rows =
          (mosaic.height - y) < rowChunk ? mosaic.height - y : rowChunk;
      final int start = y * mosaic.width;
      final Float32List view = Float32List.sublistView(
        mosaic.samples,
        start,
        start + rows * mosaic.width,
      );
      await store.writeRows(y: y, rowCount: rows, samples: view);
    }
    // Saturation is retained separately in compact one-bit-per-pixel form, so
    // there is no reason to duplicate it into this short-lived CFA store.
    await store.commitRowWrites();
    committed = true;
    return store;
  } finally {
    if (!committed) await store.abort();
  }
}

int _maximumRgbTileBytes(List<OverlappedTile> tiles) {
  int maximumBytes = 0;
  for (final OverlappedTile tile in tiles) {
    final int bytes = tile.outputWidth * tile.outputHeight * 3 * 4;
    if (bytes > maximumBytes) maximumBytes = bytes;
  }
  return maximumBytes;
}

void _validateEmptyStore(
  int expectedWidth,
  int expectedHeight,
  LinearRgbTileStore store,
) {
  if (store.width != expectedWidth || store.height != expectedHeight) {
    throw StateError('RGBタイル保存先の寸法がRAWモザイクと一致しません。');
  }
  if (store.isCommitted || store.completedTileCount != 0) {
    throw StateError('RGBタイル保存先は未使用状態である必要があります。');
  }
}

void _validateDemosaicTile(
  OverlappedTile planned,
  LinearRgbTile actual,
) {
  if (actual.x != planned.outputX ||
      actual.y != planned.outputY ||
      actual.width != planned.outputWidth ||
      actual.height != planned.outputHeight) {
    throw StateError('デモザイク出力タイルが要求領域と一致しません。');
  }
  if (actual.interleavedRgb.any((double value) => !value.isFinite)) {
    throw StateError('デモザイク出力タイルに非有限値が含まれています。');
  }
}

PipelineStage _defectPixelStage(
  HighestQualityPolicy qualityPolicy,
  RawDefectPixelCorrector corrector,
) {
  const String id = 'defect_pixel';
  return PipelineStage(
    id: id,
    label: '不良画素補正',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (ProcessingJob job, PipelineContext context,
        void Function(double) report) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawDefectCorrection:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      final defectMap = context.rawDefectMap;
      if (defectMap == null) {
        context.metadata['rawDefectCorrection:$id'] = 'skipped:notAvailable';
        report(1);
        return;
      }
      final RawDefectCorrectionResult result = await corrector.correct(
        rawMosaic,
        defectMap,
        isCancelled: () => job.cancellationRequested,
        reportProgress: report,
      );
      context.metadata
        ..['rawDefectCorrection:correctedCount'] = result.correctedCount
        ..['rawDefectCorrection:skippedCount'] = result.skippedCount;
      if (result.completed) {
        context.metadata['rawDefectCorrection:$id'] = true;
      }
    },
  );
}

PipelineStage _linearizationStage(
  HighestQualityPolicy qualityPolicy,
  RawMosaicCalibrator calibrator,
) {
  const String id = 'linearization';
  return PipelineStage(
    id: id,
    label: 'DNG線形化',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (ProcessingJob job, PipelineContext context,
        void Function(double) report) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      final Object? value = context.metadata['sourceLinearizationTable'];
      if (value == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:identity';
        report(1);
        return;
      }
      final List<double> table = _numbers(value, 'sourceLinearizationTable');
      final bool completed = await calibrator.applyLinearizationTable(
        rawMosaic,
        table: table,
        isCancelled: () => job.cancellationRequested,
        reportProgress: report,
      );
      if (completed) {
        final double whiteLevel = _requiredNumber(
          context.metadata,
          'sourceWhiteLevel',
        );
        if (!whiteLevel.isFinite || whiteLevel <= 0) {
          throw StateError('sourceWhiteLevel must be a finite positive value.');
        }
        // WhiteLevel is defined in the linearized RAW domain.  Rebuild the
        // immutable saturation mask immediately after LinearizationTable,
        // before black subtraction or any gain changes the sensor-domain
        // meaning of saturation.
        context.rawMosaic = LinearRawMosaic(
          width: rawMosaic.width,
          height: rawMosaic.height,
          cfaPattern: rawMosaic.cfaPattern,
          samples: rawMosaic.samples,
          saturationMask: RawSaturationMask.fromPredicate(
            rawMosaic.samples.length,
            (int index) => rawMosaic.samples[index] >= whiteLevel,
          ),
        );
        context.metadata['rawCalibration:$id'] = true;
      }
    },
  );
}

PipelineStage _blackLevelStage(
  HighestQualityPolicy qualityPolicy,
  RawMosaicCalibrator calibrator,
) {
  const String id = 'black_level';
  return PipelineStage(
    id: id,
    label: 'ブラックレベル補正',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (ProcessingJob job, PipelineContext context,
        void Function(double) report) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      final bool completed = await calibrator.subtractBlackLevels(
        rawMosaic,
        blackLevels: _requiredFourNumbers(
          context.metadata,
          'sourceBlackLevels',
        ),
        patternOriginX: _integerOrZero(context.metadata, 'activeLeft'),
        patternOriginY: _integerOrZero(context.metadata, 'activeTop'),
        blackLevelDeltaH: _optionalNumbers(
          context.metadata['sourceBlackLevelDeltaH'],
          'sourceBlackLevelDeltaH',
        ),
        blackLevelDeltaV: _optionalNumbers(
          context.metadata['sourceBlackLevelDeltaV'],
          'sourceBlackLevelDeltaV',
        ),
        isCancelled: () => job.cancellationRequested,
        reportProgress: report,
      );
      if (completed) {
        context.metadata['rawCalibration:$id'] = true;
      }
    },
  );
}

PipelineStage _whiteLevelStage(
  HighestQualityPolicy qualityPolicy,
  RawMosaicCalibrator calibrator,
) {
  const String id = 'white_level';
  return PipelineStage(
    id: id,
    label: 'ホワイトレベル正規化',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (ProcessingJob job, PipelineContext context,
        void Function(double) report) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      final bool completed = await calibrator.normalizeWhiteLevel(
        rawMosaic,
        blackLevels: _requiredFourNumbers(
          context.metadata,
          'sourceBlackLevels',
        ),
        whiteLevel: _requiredNumber(
          context.metadata,
          'sourceWhiteLevel',
        ),
        blackLevelDeltaH: _optionalNumbers(
          context.metadata['sourceBlackLevelDeltaH'],
          'sourceBlackLevelDeltaH',
        ),
        blackLevelDeltaV: _optionalNumbers(
          context.metadata['sourceBlackLevelDeltaV'],
          'sourceBlackLevelDeltaV',
        ),
        patternOriginX: _integerOrZero(context.metadata, 'activeLeft'),
        patternOriginY: _integerOrZero(context.metadata, 'activeTop'),
        isCancelled: () => job.cancellationRequested,
        reportProgress: report,
      );
      if (completed) {
        context.metadata['rawCalibration:$id'] = true;
      }
    },
  );
}

PipelineStage _cameraWhiteBalanceStage(
  HighestQualityPolicy qualityPolicy,
  RawMosaicCalibrator calibrator,
) {
  const String id = 'camera_white_balance';
  return PipelineStage(
    id: id,
    label: 'カメラホワイトバランス',
    weight: 1,
    target: ExecutionTarget.cpu,
    runner: (ProcessingJob job, PipelineContext context,
        void Function(double) report) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      final rawMosaic = context.rawMosaic;
      if (rawMosaic == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:noDecodedMosaic';
        report(1);
        return;
      }
      final Object? value = context.metadata['sourceCameraWhiteBalance'];
      if (value == null) {
        context.metadata['rawCalibration:$id'] = 'skipped:notAvailable';
        report(1);
        return;
      }
      final bool completed = await calibrator.applyCameraWhiteBalance(
        rawMosaic,
        gains: _fourNumbers(value, 'sourceCameraWhiteBalance'),
        isCancelled: () => job.cancellationRequested,
        reportProgress: report,
      );
      if (completed) {
        context.metadata['rawCalibration:$id'] = true;
      }
    },
  );
}

PipelineStage _stage(
  String id,
  String label,
  double weight,
  ExecutionTarget target,
  HighestQualityPolicy qualityPolicy, {
  bool releasesTransientDataAfterRun = false,
}) {
  return PipelineStage(
    id: id,
    label: label,
    weight: weight,
    target: target,
    releasesTransientDataAfterRun: releasesTransientDataAfterRun,
    runner: (ProcessingJob job, PipelineContext context,
        void Function(double) report) async {
      context.metadata['precision:$id'] = qualityPolicy.precisionFor(id).name;
      const int steps = 4;
      for (int step = 1; step <= steps; step++) {
        if (job.cancellationRequested) return;
        await Future<void>.delayed(const Duration(milliseconds: 20));
        report(step / steps);
      }
    },
  );
}

List<double> _numbers(Object value, String key) {
  if (value is! List<Object?> || value.isEmpty) {
    throw StateError('$keyは空でない数値リストである必要があります。');
  }
  final List<double> numbers = <double>[];
  for (final Object? item in value) {
    if (item is! num) {
      throw StateError('$keyに数値以外の要素があります。');
    }
    numbers.add(item.toDouble());
  }
  return numbers;
}

List<double>? _optionalNumbers(Object? value, String key) {
  if (value == null) return null;
  return _numbers(value, key);
}

List<double> _requiredFourNumbers(
  Map<String, Object?> metadata,
  String key,
) {
  final Object? value = metadata[key];
  if (value == null) {
    throw StateError('RAW補正に必要な$keyがありません。');
  }
  return _fourNumbers(value, key);
}

List<double> _fourNumbers(Object value, String key) {
  if (value is! List<Object?> || value.length != 4) {
    throw StateError('$keyは4要素の数値リストである必要があります。');
  }
  final List<double> numbers = <double>[];
  for (final Object? item in value) {
    if (item is! num) {
      throw StateError('$keyに数値以外の要素があります。');
    }
    numbers.add(item.toDouble());
  }
  return numbers;
}

double _requiredNumber(
  Map<String, Object?> metadata,
  String key,
) {
  final Object? value = metadata[key];
  if (value is! num) {
    throw StateError('RAW補正に必要な$keyが数値ではありません。');
  }
  return value.toDouble();
}

int _integerOrZero(
  Map<String, Object?> metadata,
  String key,
) {
  final Object? value = metadata[key];
  if (value == null) return 0;
  if (value is! int) {
    throw StateError('$keyは整数である必要があります。');
  }
  return value;
}
