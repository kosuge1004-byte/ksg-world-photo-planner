import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/engine/processing_job.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/memory/transient_memory_store.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/pipeline/phase2_quality_pipeline_factory.dart';
import 'package:mobile_stack/core/pipeline/pipeline_context.dart';
import 'package:mobile_stack/core/tiles/tile_grid.dart';

void main() {
  test('master-flat cold site is merged into the real correction pipeline',
      () async {
    const int width = 9;
    const int height = 9;
    final Float32List flatSamples = Float32List.fromList(
      <double>[for (int i = 0; i < width * height; i++) 1],
    );
    flatSamples[4 * width + 4] = 0.05;
    final LinearRawMosaic masterFlat = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
      samples: flatSamples,
    );
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    )..rawMosaic = LinearRawMosaic(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(
          <double>[for (int i = 0; i < width * height; i++) 50],
        ),
      );
    context.metadata
      ..['sourceBlackLevels'] = const <double>[0, 0, 0, 0]
      ..['sourceWhiteLevel'] = 100
      ..['sourceCameraWhiteBalance'] = const <double>[1, 1, 1, 1]
      ..['activeLeft'] = 0
      ..['activeTop'] = 0;
    final pipeline = createRawMosaicCalibrationPipelineWithCorrections(
      masterFlat: masterFlat,
      enableColdPixelDetection: true,
      coldPixelRatioThreshold: 5,
      coldPixelAbsoluteThreshold: 0.1,
    );
    final ProcessingJob job = ProcessingJob(
      id: 'cold-pixel-wiring',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/light.ARW',
    );
    const Set<String> stages = <String>{
      'black_level',
      'cold_pixel_detection',
      'white_level',
      'camera_white_balance',
      'flat_field_correction',
      'defect_pixel',
    };
    for (final stage in pipeline.stages) {
      if (stages.contains(stage.id)) {
        await stage.runner(job, context, (_) {});
      }
    }

    expect(context.metadata['coldPixelCount'], 1);
    expect(context.metadata['rawDefectCorrection:correctedCount'], 1);
    expect(context.rawMosaic!.sampleAt(4, 4), closeTo(0.5, 1e-6));
  });
}
