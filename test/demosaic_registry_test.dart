import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_algorithm.dart';
import 'package:mobile_stack/core/demosaic/demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/demosaic_registry.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/reference_bilinear_demosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';

class _ProductionAdaptiveEngine implements DemosaicEngine {
  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  @override
  bool get isProductionQuality => true;

  @override
  int get requiredInputRadius => 4;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) {
    throw UnimplementedError();
  }
}

void main() {
  test('does not replace unavailable independent demosaic with a fallback', () {
    final DemosaicRegistry registry = DemosaicRegistry(const [
      MobileStackAdaptiveDemosaicEngine(),
      ReferenceBilinearDemosaic(),
    ]);

    expect(
      registry.hasProductionBackend(DemosaicAlgorithm.mobileStackAdaptive),
      isFalse,
    );
    expect(
      registry.require(DemosaicAlgorithm.mobileStackAdaptive),
      isA<MobileStackAdaptiveDemosaicEngine>(),
    );
    expect(
      () => registry.require(DemosaicAlgorithm.referenceBilinear),
      returnsNormally,
    );
  });

  test('throws when no requested engine is registered', () {
    final DemosaicRegistry registry = DemosaicRegistry(const []);
    expect(
      () => registry.require(DemosaicAlgorithm.mobileStackAdaptive),
      throwsA(isA<DemosaicBackendUnavailable>()),
    );
  });

  test('本番品質でないエンジンを品質パイプラインへ渡さない', () {
    final DemosaicRegistry registry = DemosaicRegistry(
      const <DemosaicEngine>[
        MobileStackAdaptiveDemosaicEngine(),
        ReferenceBilinearDemosaic(),
      ],
    );

    expect(
      () => registry.requireProduction(
        DemosaicAlgorithm.mobileStackAdaptive,
      ),
      throwsA(isA<DemosaicBackendUnavailable>()),
    );
    expect(
      () => registry.requireProduction(
        DemosaicAlgorithm.referenceBilinear,
      ),
      throwsA(isA<DemosaicBackendUnavailable>()),
    );
  });

  test('同じ方式のエンジン重複登録を拒否する', () {
    expect(
      () => DemosaicRegistry(
        const <DemosaicEngine>[
          MobileStackAdaptiveDemosaicEngine(),
          MobileStackAdaptiveDemosaicEngine(),
        ],
      ),
      throwsStateError,
    );
  });

  test('明示された本番品質の独自デモザイクだけを返す', () {
    final DemosaicRegistry registry = DemosaicRegistry(
      <DemosaicEngine>[
        _ProductionAdaptiveEngine(),
      ],
    );

    expect(
      registry.requireProduction(DemosaicAlgorithm.mobileStackAdaptive),
      isA<_ProductionAdaptiveEngine>(),
    );
  });
}
