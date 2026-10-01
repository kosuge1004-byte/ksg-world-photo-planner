import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_rgb_tile.dart';
import '../image/raw_saturation_mask.dart';
import '../quality/highest_quality_policy.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'demosaic_algorithm.dart';
import 'demosaic_engine.dart';
import 'demosaic_request.dart';

final class NativeMobileStackDemosaicEngine implements DemosaicEngine {
  const NativeMobileStackDemosaicEngine();

  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  @override
  bool get isProductionQuality => false;

  @override
  int get requiredInputRadius => 5;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) =>
      Future<LinearRgbTile>.error(
        const DemosaicBackendUnavailable(
          'Native adaptive demosaic is unavailable on this platform.',
        ),
      );

  Future<LinearRgbTile> processFileBackedTile({
    required FileBackedLinearRawMosaicStore store,
    required OverlappedTile tile,
    required RawSaturationMask? saturationMask,
    HighestQualityPolicy qualityPolicy = const HighestQualityPolicy(),
    bool Function()? isCancelled,
  }) =>
      Future<LinearRgbTile>.error(
        const DemosaicBackendUnavailable(
          'Native adaptive demosaic is unavailable on this platform.',
        ),
      );
}
