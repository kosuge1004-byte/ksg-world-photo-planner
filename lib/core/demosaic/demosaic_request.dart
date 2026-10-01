import '../image/linear_raw_mosaic.dart';
import '../quality/highest_quality_policy.dart';
import '../tiles/overlapped_tile_plan.dart';

class DemosaicRequest {
  const DemosaicRequest({
    required this.mosaic,
    required this.tile,
    this.qualityPolicy = const HighestQualityPolicy(),
    this.isCancelled,
  });

  final LinearRawMosaic mosaic;
  final OverlappedTile tile;
  final HighestQualityPolicy qualityPolicy;
  final bool Function()? isCancelled;

  bool get cancellationRequested => isCancelled?.call() ?? false;

  void validate() {
    if (tile.outputX < 0 ||
        tile.outputY < 0 ||
        tile.outputWidth <= 0 ||
        tile.outputHeight <= 0 ||
        tile.inputX < 0 ||
        tile.inputY < 0 ||
        tile.inputWidth <= 0 ||
        tile.inputHeight <= 0) {
      throw ArgumentError('Demosaic tile coordinates are invalid.');
    }
    if (tile.outputX + tile.outputWidth > mosaic.width ||
        tile.outputY + tile.outputHeight > mosaic.height ||
        tile.inputX + tile.inputWidth > mosaic.width ||
        tile.inputY + tile.inputHeight > mosaic.height) {
      throw ArgumentError('Demosaic tile is outside the CFA mosaic.');
    }
    if (tile.inputX > tile.outputX ||
        tile.inputY > tile.outputY ||
        tile.inputX + tile.inputWidth < tile.outputX + tile.outputWidth ||
        tile.inputY + tile.inputHeight < tile.outputY + tile.outputHeight) {
      throw ArgumentError('Demosaic input tile must enclose its output tile.');
    }
  }
}
