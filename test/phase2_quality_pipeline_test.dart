import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_algorithm.dart';
import 'package:mobile_stack/core/demosaic/demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/demosaic_registry.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/engine/processing_job.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/memory/transient_memory_store.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/pipeline/phase2_quality_pipeline_factory.dart';
import 'package:mobile_stack/core/pipeline/pipeline_context.dart';
import 'package:mobile_stack/core/pipeline/pipeline_stage.dart';
import 'package:mobile_stack/core/pipeline/processing_pipeline.dart';
import 'package:mobile_stack/core/pipeline/raw_defect_map.dart';
import 'package:mobile_stack/core/tiles/tile_grid.dart';

import 'support/recording_rgb_tile_store.dart';

void _expectSamples(
  Float32List actual,
  List<double> expected,
) {
  expect(actual, hasLength(expected.length));
  for (int index = 0; index < expected.length; index++) {
    expect(actual[index], closeTo(expected[index], 1e-6));
  }
}

class _RecordingProductionDemosaic implements DemosaicEngine {
  _RecordingProductionDemosaic({
    this.outputWidth,
    this.outputValue = 0.25,
    this.afterProcess,
  });

  final int? outputWidth;
  final double outputValue;
  final void Function()? afterProcess;
  final List<DemosaicRequest> requests = <DemosaicRequest>[];
  DemosaicRequest? get request => requests.isEmpty ? null : requests.last;

  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  @override
  bool get isProductionQuality => true;

  @override
  int get requiredInputRadius => 4;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) async {
    requests.add(request);
    final int width = outputWidth ?? request.tile.outputWidth;
    final LinearRgbTile result = LinearRgbTile(
      x: request.tile.outputX,
      y: request.tile.outputY,
      width: width,
      height: request.tile.outputHeight,
      interleavedRgb: Float32List.fromList(
        List<double>.filled(
          width * request.tile.outputHeight * 3,
          outputValue,
        ),
      ),
    );
    afterProcess?.call();
    return result;
  }
}

void main() {
  test('通常RAW前処理パイプラインは実処理を伴わない後段疑似ステージを含まない', () {
    for (final ProcessingPipeline pipeline in <ProcessingPipeline>[
      createPhase2QualityValidationPipeline(),
      createPhase2QualityValidationPipelineWithCorrections(),
    ]) {
      final List<String> stageIds = pipeline.stages
          .map((PipelineStage stage) => stage.id)
          .toList(growable: false);

      expect(stageIds, contains('demosaic'));
      expect(stageIds, isNot(contains('registration')));
      expect(stageIds, isNot(contains('stack_accumulation')));
      expect(stageIds, isNot(contains('noise_reduction')));
      expect(stageIds, isNot(contains('final_linear_image')));
      expect(stageIds.last, 'demosaic');
    }
  });

  test('品質パイプラインがデモザイク前にRAW補正3段を実行する', () async {
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline();
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(
          <double>[55, 60, 65, 70],
        ),
      );
    context.metadata
      ..['sourceBlackLevels'] = const <double>[10, 20, 30, 40]
      ..['sourceWhiteLevel'] = 100
      ..['sourceCameraWhiteBalance'] = const <double>[2, 1, 1, 1.5]
      ..['activeLeft'] = 0
      ..['activeTop'] = 0;
    final ProcessingJob job = ProcessingJob(
      id: 'calibration-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final List<String> stageIds = pipeline.stages
        .map((PipelineStage stage) => stage.id)
        .toList(growable: false);

    expect(
      stageIds.indexOf('camera_white_balance'),
      stageIds.indexOf('white_level') + 1,
    );
    expect(
      stageIds.indexOf('camera_white_balance'),
      lessThan(stageIds.indexOf('demosaic')),
    );
    expect(
      stageIds.indexOf('defect_pixel'),
      stageIds.indexOf('camera_white_balance') + 1,
    );

    for (final String stageId in <String>[
      'black_level',
      'white_level',
      'camera_white_balance',
    ]) {
      final PipelineStage stage = pipeline.stages.firstWhere(
        (PipelineStage candidate) => candidate.id == stageId,
      );
      await stage.runner(job, context, (_) {});
    }

    _expectSamples(
      context.rawMosaic!.samples,
      <double>[1.5, 2 / 3, 7 / 12, 0.75],
    );
    expect(context.metadata['rawCalibration:black_level'], isTrue);
    expect(context.metadata['rawCalibration:white_level'], isTrue);
    expect(
      context.metadata['rawCalibration:camera_white_balance'],
      isTrue,
    );
    expect(
      context.metadata['precision:camera_white_balance'],
      'float32',
    );
  });

  test('DNG線形化後の値でWhiteLevel飽和マスクを再構築する', () async {
    final ProcessingPipeline pipeline = createRawMosaicCalibrationPipeline();
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = LinearRawMosaic(
        width: 2,
        height: 1,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(<double>[2, 3]),
      );
    context.metadata
      ..['sourceLinearizationTable'] = const <double>[0, 10, 80, 120]
      ..['sourceWhiteLevel'] = 100;
    final ProcessingJob job = ProcessingJob(
      id: 'linearized-saturation-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.dng',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'linearization',
    );

    await stage.runner(job, context, (_) {});

    _expectSamples(context.rawMosaic!.samples, const <double>[80, 120]);
    expect(context.rawMosaic!.isSaturatedAt(0, 0), isFalse);
    expect(context.rawMosaic!.isSaturatedAt(1, 0), isTrue);
  });

  test('カメラWBが無いRAWは補正を明示的にスキップする', () async {
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline();
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = LinearRawMosaic(
        width: 1,
        height: 1,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(<double>[1]),
      );
    final ProcessingJob job = ProcessingJob(
      id: 'no-wb-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'camera_white_balance',
    );

    await stage.runner(job, context, (_) {});

    expect(
      context.metadata['rawCalibration:camera_white_balance'],
      'skipped:notAvailable',
    );
    expect(context.rawMosaic!.samples.single, 1);
  });

  test('明示的な欠陥マップをデモザイク前に補正する', () async {
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline();
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )
      ..rawMosaic = LinearRawMosaic(
        width: 5,
        height: 5,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(
          List<double>.filled(25, 1)..[12] = 99,
        ),
      )
      ..rawDefectMap = RawDefectMap(
        const <RawDefectPoint>[RawDefectPoint(x: 2, y: 2)],
      );
    final ProcessingJob job = ProcessingJob(
      id: 'defect-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'defect_pixel',
    );

    await stage.runner(job, context, (_) {});

    expect(context.rawMosaic!.sampleAt(2, 2), closeTo(1, 1e-6));
    expect(context.metadata['rawDefectCorrection:defect_pixel'], isTrue);
    expect(context.metadata['rawDefectCorrection:correctedCount'], 1);
    expect(context.metadata['rawDefectCorrection:skippedCount'], 0);
  });

  test('欠陥マップが無ければ点光源を変更せずスキップする', () async {
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline();
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = LinearRawMosaic(
        width: 3,
        height: 3,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(
          List<double>.filled(9, 1)..[4] = 50,
        ),
      );
    final ProcessingJob job = ProcessingJob(
      id: 'no-defect-map-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'defect_pixel',
    );

    await stage.runner(job, context, (_) {});

    expect(context.rawMosaic!.sampleAt(1, 1), 50);
    expect(
      context.metadata['rawDefectCorrection:defect_pixel'],
      'skipped:notAvailable',
    );
  });

  test('未接続独自デモザイクを成功扱いにせず補正済みCFAを保持する', () async {
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline();
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[1, 2, 3, 4]),
    );
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = mosaic;
    final ProcessingJob job = ProcessingJob(
      id: 'missing-adaptive-demosaic-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'demosaic',
    );

    await expectLater(
      stage.runner(job, context, (_) {}),
      throwsA(isA<DemosaicBackendUnavailable>()),
    );

    expect(context.rawMosaic, same(mosaic));
    expect(context.linearRgbTileStore, isNull);
  });

  test('本番品質タイル出力をコミット後に保持しRAWを解放する', () async {
    final _RecordingProductionDemosaic engine = _RecordingProductionDemosaic();
    final RecordingRgbTileStoreFactory storeFactory =
        RecordingRgbTileStoreFactory();
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline(
      demosaicRegistry: DemosaicRegistry(
        <DemosaicEngine>[engine],
      ),
      rgbTileStoreFactory: storeFactory.call,
    );
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[1, 2, 3, 4]),
    );
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(preferredTileWidth: 32),
    )
      ..rawMosaic = mosaic
      ..rawDefectMap = RawDefectMap(
        const <RawDefectPoint>[RawDefectPoint(x: 0, y: 0)],
      );
    final ProcessingJob job = ProcessingJob(
      id: 'connected-adaptive-demosaic-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'demosaic',
    );

    await stage.runner(job, context, (_) {});

    expect(engine.request, isNotNull);
    expect(engine.request!.mosaic, same(mosaic));
    expect(engine.request!.tile.outputWidth, 2);
    expect(engine.request!.tile.outputHeight, 2);
    expect(engine.request!.tile.inputWidth, 2);
    expect(engine.request!.tile.inputHeight, 2);
    expect(context.rawMosaic, isNull);
    expect(context.rawDefectMap, isNull);
    expect(context.linearRgbTileStore, same(storeFactory.latest));
    expect(storeFactory.latest!.isCommitted, isTrue);
    expect(storeFactory.latest!.completedTileCount, 1);
    expect(context.metadata['demosaicAlgorithm'], 'mobileStackAdaptive');
    expect(context.metadata['demosaicProductionQuality'], isTrue);
    expect(context.metadata['demosaicTileCount'], 1);
    expect(context.metadata['demosaicPeakRgbTileBytes'], 48);
    expect(context.metadata['demosaicPersistentBytes'], 48);
  });

  test('小さい設定幅を64へ上げ重なり付き4タイルを順次処理する', () async {
    final _RecordingProductionDemosaic engine = _RecordingProductionDemosaic();
    final RecordingRgbTileStoreFactory storeFactory =
        RecordingRgbTileStoreFactory();
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline(
      demosaicRegistry: DemosaicRegistry(
        <DemosaicEngine>[engine],
      ),
      rgbTileStoreFactory: storeFactory.call,
    );
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 100,
      height: 70,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(
        List<double>.filled(100 * 70, 1),
      ),
    );
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(preferredTileWidth: 32),
    )..rawMosaic = mosaic;
    final ProcessingJob job = ProcessingJob(
      id: 'four-tile-adaptive-demosaic',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'demosaic',
    );

    await stage.runner(job, context, (_) {});

    expect(engine.requests, hasLength(4));
    expect(engine.requests[0].tile.outputWidth, 64);
    expect(engine.requests[0].tile.outputHeight, 64);
    expect(engine.requests[0].tile.inputWidth, 88);
    expect(engine.requests[0].tile.inputHeight, 70);
    expect(engine.requests[1].tile.outputX, 64);
    expect(engine.requests[1].tile.inputX, 40);
    expect(engine.requests[3].tile.outputWidth, 36);
    expect(engine.requests[3].tile.outputHeight, 6);
    expect(storeFactory.latest!.completedTileCount, 4);
    expect(storeFactory.latest!.isCommitted, isTrue);
    expect(context.metadata['demosaicTileCount'], 4);
    expect(context.metadata['demosaicPeakRgbTileBytes'], 64 * 64 * 3 * 4);
  });

  test('独自デモザイクのタイル寸法が違えばRAWを保持して中断する', () async {
    final _RecordingProductionDemosaic engine =
        _RecordingProductionDemosaic(outputWidth: 1);
    final RecordingRgbTileStoreFactory storeFactory =
        RecordingRgbTileStoreFactory();
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline(
      demosaicRegistry: DemosaicRegistry(
        <DemosaicEngine>[engine],
      ),
      rgbTileStoreFactory: storeFactory.call,
    );
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[1, 2, 3, 4]),
    );
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = mosaic;
    final ProcessingJob job = ProcessingJob(
      id: 'invalid-adaptive-demosaic-dimensions',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'demosaic',
    );

    await expectLater(
      stage.runner(job, context, (_) {}),
      throwsStateError,
    );

    expect(context.rawMosaic, same(mosaic));
    expect(context.linearRgbTileStore, isNull);
    expect(storeFactory.latest!.aborted, isTrue);
  });

  test('独自デモザイクの非有限値をRAW解放前に拒否する', () async {
    final _RecordingProductionDemosaic engine =
        _RecordingProductionDemosaic(outputValue: double.nan);
    final RecordingRgbTileStoreFactory storeFactory =
        RecordingRgbTileStoreFactory();
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline(
      demosaicRegistry: DemosaicRegistry(
        <DemosaicEngine>[engine],
      ),
      rgbTileStoreFactory: storeFactory.call,
    );
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[1, 2, 3, 4]),
    );
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = mosaic;
    final ProcessingJob job = ProcessingJob(
      id: 'invalid-adaptive-demosaic-samples',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'demosaic',
    );

    await expectLater(
      stage.runner(job, context, (_) {}),
      throwsStateError,
    );

    expect(context.rawMosaic, same(mosaic));
    expect(context.linearRgbTileStore, isNull);
    expect(storeFactory.latest!.aborted, isTrue);
  });

  test('タイル処理中のキャンセルで部分RGBを破棄しRAWを保持する', () async {
    late final ProcessingJob job;
    final _RecordingProductionDemosaic engine = _RecordingProductionDemosaic(
      afterProcess: () => job.requestCancellation(),
    );
    final RecordingRgbTileStoreFactory storeFactory =
        RecordingRgbTileStoreFactory();
    final ProcessingPipeline pipeline = createPhase2QualityValidationPipeline(
      demosaicRegistry: DemosaicRegistry(
        <DemosaicEngine>[engine],
      ),
      rgbTileStoreFactory: storeFactory.call,
    );
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[1, 2, 3, 4]),
    );
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = mosaic;
    job = ProcessingJob(
      id: 'cancel-demosaic-tile',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final PipelineStage stage = pipeline.stages.firstWhere(
      (PipelineStage candidate) => candidate.id == 'demosaic',
    );

    await stage.runner(job, context, (_) {});

    expect(context.rawMosaic, same(mosaic));
    expect(context.linearRgbTileStore, isNull);
    expect(storeFactory.latest!.aborted, isTrue);
  });
}
