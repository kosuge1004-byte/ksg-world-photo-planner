import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_algorithm.dart';
import 'package:mobile_stack/core/demosaic/demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/demosaic_reconstructed_mosaic.dart';
import 'package:mobile_stack/core/demosaic/demosaic_registry.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';

import 'support/recording_rgb_tile_store.dart';

/// Tests [demosaicReconstructedMosaic] directly. The real demosaic
/// algorithm's own numeric correctness is a separate concern this file
/// does not re-verify; this file's job is the new tile-plan/loop
/// wiring, using the same fake production-quality demosaic engine stub
/// `phase2_validated_job_executor_test.dart` (Work68+) already
/// established for testing this exact kind of wiring.
class OverlappedTileRecord {
  OverlappedTileRecord({
    required this.outputX,
    required this.outputY,
    required this.outputWidth,
    required this.outputHeight,
  });

  final int outputX;
  final int outputY;
  final int outputWidth;
  final int outputHeight;
}

class _StubDemosaicEngine implements DemosaicEngine, DisposableDemosaicEngine {
  _StubDemosaicEngine({this.recordedTiles});

  final List<OverlappedTileRecord>? recordedTiles;
  bool transientResourcesDisposed = false;

  @override
  void disposeTransientResources() {
    transientResourcesDisposed = true;
  }

  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  @override
  bool get isProductionQuality => true;

  @override
  int get requiredInputRadius => 4;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) async {
    recordedTiles?.add(
      OverlappedTileRecord(
        outputX: request.tile.outputX,
        outputY: request.tile.outputY,
        outputWidth: request.tile.outputWidth,
        outputHeight: request.tile.outputHeight,
      ),
    );
    return LinearRgbTile(
      x: request.tile.outputX,
      y: request.tile.outputY,
      width: request.tile.outputWidth,
      height: request.tile.outputHeight,
      interleavedRgb: Float32List(
        request.tile.outputWidth * request.tile.outputHeight * 3,
      )..fillRange(
          0,
          request.tile.outputWidth * request.tile.outputHeight * 3,
          0.25,
        ),
    );
  }
}

LinearRawMosaic _makeMosaic(int width, int height) {
  final Float32List samples = Float32List(width * height)
    ..fillRange(0, width * height, 0.1);
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: CfaPattern.rggb,
    samples: samples,
  );
}

void main() {
  test('全タイルがエンジンへ渡され、コミット済みのストアが返る', () async {
    const int width = 40;
    const int height = 30;
    final List<OverlappedTileRecord> recordedTiles = <OverlappedTileRecord>[];
    final DemosaicRegistry registry = DemosaicRegistry(<DemosaicEngine>[
      _StubDemosaicEngine(recordedTiles: recordedTiles),
    ]);
    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();

    final LinearRgbTileStore result = await demosaicReconstructedMosaic(
      mosaic: _makeMosaic(width, height),
      demosaicRegistry: registry,
      outputStoreFactory: outputFactory.call,
      tileSize: 16,
      overlap: 4,
    );

    expect(recordedTiles, isNotEmpty);
    expect((result as RecordingRgbTileStore).isCommitted, isTrue);
    expect(result.width, width);
    expect(result.height, height);
    expect(
      (registry.requireProduction(DemosaicAlgorithm.mobileStackAdaptive)
              as _StubDemosaicEngine)
          .transientResourcesDisposed,
      isTrue,
    );
  });

  test('登録エンジンが無い場合はDemosaicBackendUnavailableを投げる', () async {
    final DemosaicRegistry registry = DemosaicRegistry(<DemosaicEngine>[]);
    await expectLater(
      demosaicReconstructedMosaic(
        mosaic: _makeMosaic(8, 8),
        demosaicRegistry: registry,
        outputStoreFactory: RecordingRgbTileStoreFactory().call,
      ),
      throwsA(isA<DemosaicBackendUnavailable>()),
    );
  });

  test('キャンセルされると出力ストアがabortされる', () async {
    final _StubDemosaicEngine engine = _StubDemosaicEngine();
    final DemosaicRegistry registry = DemosaicRegistry(<DemosaicEngine>[
      engine,
    ]);
    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();
    await expectLater(
      demosaicReconstructedMosaic(
        mosaic: _makeMosaic(40, 40),
        demosaicRegistry: registry,
        outputStoreFactory: outputFactory.call,
        tileSize: 16,
        overlap: 4,
        isCancelled: () => true,
      ),
      throwsA(isA<StateError>()),
    );
    expect(outputFactory.latest!.aborted, isTrue);
    expect(engine.transientResourcesDisposed, isTrue);
  });
}
