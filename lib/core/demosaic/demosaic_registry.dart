import 'demosaic_algorithm.dart';
import 'demosaic_engine.dart';

class DemosaicRegistry {
  DemosaicRegistry(Iterable<DemosaicEngine> engines) {
    for (final DemosaicEngine engine in engines) {
      if (_engines.containsKey(engine.algorithm)) {
        throw StateError(
          '${engine.algorithm.name}用デモザイクエンジンが重複しています。',
        );
      }
      _engines[engine.algorithm] = engine;
    }
  }

  final Map<DemosaicAlgorithm, DemosaicEngine> _engines =
      <DemosaicAlgorithm, DemosaicEngine>{};

  DemosaicEngine require(DemosaicAlgorithm algorithm) {
    final DemosaicEngine? engine = _engines[algorithm];
    if (engine == null) {
      throw DemosaicBackendUnavailable(
          'No engine registered for ${algorithm.name}.');
    }
    return engine;
  }

  DemosaicEngine requireProduction(DemosaicAlgorithm algorithm) {
    final DemosaicEngine engine = require(algorithm);
    if (!engine.isProductionQuality) {
      throw DemosaicBackendUnavailable(
        '${algorithm.name}の本番品質バックエンドが利用できません。',
      );
    }
    return engine;
  }

  bool hasProductionBackend(DemosaicAlgorithm algorithm) =>
      _engines[algorithm]?.isProductionQuality ?? false;
}
