import '../image/linear_raw_mosaic.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../memory/transient_memory_store.dart';
import '../tiles/tile_grid.dart';
import 'raw_defect_map.dart';

class PipelineContext {
  PipelineContext({
    required this.memoryStore,
    required this.tileGrid,
  });

  final TransientMemoryStore memoryStore;
  final TileGrid tileGrid;
  final Map<String, Object?> metadata = <String, Object?>{};
  LinearRawMosaic? rawMosaic;
  LinearRgbTileStore? linearRgbTileStore;
  RawSaturationMask? rgbSaturationInfluenceMask;
  RawDefectMap? rawDefectMap;
  void Function()? releaseRawSamples;

  void releaseRawSampleStorage() {
    final void Function()? release = releaseRawSamples;
    releaseRawSamples = null;
    release?.call();
  }

  Future<void> clearTransientData() async {
    final LinearRgbTileStore? tileStore = linearRgbTileStore;
    rawMosaic = null;
    releaseRawSampleStorage();
    linearRgbTileStore = null;
    rgbSaturationInfluenceMask = null;
    rawDefectMap = null;
    memoryStore.clear();
    if (tileStore != null) await tileStore.dispose();
  }
}
