import '../image/linear_rgb_tile.dart';
import 'demosaic_algorithm.dart';
import 'demosaic_request.dart';

abstract interface class DemosaicEngine {
  DemosaicAlgorithm get algorithm;
  bool get isProductionQuality;
  int get requiredInputRadius;
  Future<LinearRgbTile> processTile(DemosaicRequest request);
}

abstract interface class DisposableDemosaicEngine {
  void disposeTransientResources();
}

class DemosaicBackendUnavailable implements Exception {
  const DemosaicBackendUnavailable(this.message);
  final String message;

  @override
  String toString() => message;
}

class DemosaicProcessingCancelled implements Exception {
  const DemosaicProcessingCancelled();

  @override
  String toString() => 'Demosaic processing was cancelled.';
}
