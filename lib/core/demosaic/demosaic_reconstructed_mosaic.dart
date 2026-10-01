import '../demosaic/demosaic_algorithm.dart';
import '../demosaic/demosaic_engine.dart';
import '../demosaic/demosaic_registry.dart';
import '../demosaic/demosaic_request.dart';
import '../demosaic/native_mobile_stack_demosaic_engine_stub.dart'
    if (dart.library.io) '../demosaic/native_mobile_stack_demosaic_engine.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';

/// Runs [mosaic] (typically `reconstructNativeCfaMosaicFromDrizzle`/
/// `reconstructNativeCfaMosaicFromDrizzleTiled`'s own output, Work112)
/// through this project's real, structure-tensor-based adaptive
/// demosaic engine (`mobile_stack_adaptive_demosaic_engine.dart`),
/// tile by tile, exactly mirroring `phase2_quality_pipeline_
/// factory.dart`'s own private `_demosaicStage`'s tile-processing loop
/// — the same engine invocation, tile plan construction (24px overlap
/// for the engine's own convolution neighborhood), and per-tile request
/// validation that pipeline stage already uses for an ordinary single
/// camera exposure, applied here to a CFA-drizzle-combined one instead.
///
/// This module exists specifically because `_demosaicStage` itself is
/// private to `phase2_quality_pipeline_factory.dart` and operates on a
/// `PipelineContext` this project's CFA drizzle pipeline
/// (`cfa_drizzle_milky_way_pipeline.dart`) does not itself build or
/// use — rather than duplicating that stage's own logic *inside* that
/// unrelated file, or exposing its own private helper just for this one
/// caller, this is a small, independent, directly-testable function
/// with the same core loop, callable from anywhere a reconstructed
/// mosaic needs demosaicing without going through the full phase2
/// pipeline machinery.
///
/// This file has not been executed against the Dart SDK. Its own new
/// logic — the tile-plan construction and per-tile loop — mirrors
/// `_demosaicStage`'s own already-established (if unexported) pattern
/// closely enough that this file's own risk is concentrated in that
/// mirroring being faithful, which `test/demosaic_reconstructed_
/// mosaic_test.dart` verifies directly against a real demosaic engine
/// instance (`NativeMobileStackDemosaicEngine`).
Future<LinearRgbTileStore> demosaicReconstructedMosaic({
  required LinearRawMosaic mosaic,
  required DemosaicRegistry demosaicRegistry,
  required LinearRgbTileStoreFactory outputStoreFactory,
  int tileSize = 512,
  int overlap = 24,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  final DemosaicEngine engine = demosaicRegistry.requireProduction(
    DemosaicAlgorithm.mobileStackAdaptive,
  );
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: mosaic.width,
    imageHeight: mosaic.height,
    tileSize: tileSize,
    overlap: overlap,
  );
  final LinearRgbTileStore store = await outputStoreFactory(
    width: mosaic.width,
    height: mosaic.height,
    plan: plan,
  );

  bool committed = false;
  try {
    for (int index = 0; index < plan.tiles.length; index++) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Demosaic was cancelled.');
      }
      final OverlappedTile plannedTile = plan.tiles[index];
      final DemosaicRequest request = DemosaicRequest(
        mosaic: mosaic,
        tile: plannedTile,
        isCancelled: isCancelled,
      );
      request.validate();
      final LinearRgbTile tile = await engine.processTile(request);
      await store.writeTile(tile);
      reportProgress?.call((index + 1) / plan.tiles.length);
    }
    await store.commit();
    committed = true;
    return store;
  } finally {
    try {
      if (!committed) await store.abort();
    } finally {
      if (engine is DisposableDemosaicEngine) {
        (engine as DisposableDemosaicEngine).disposeTransientResources();
      }
    }
  }
}

/// File-backed counterpart of [demosaicReconstructedMosaic].
///
/// It uses the exact same production algorithm, tile geometry and overlap but
/// materializes only each tile's CFA input rectangle. This is a storage-
/// lifetime optimization; global coordinates and CFA phase remain unchanged.
Future<LinearRgbTileStore> demosaicFileBackedRawMosaic({
  required FileBackedLinearRawMosaicStore mosaicStore,
  required RawSaturationMask? saturationMask,
  required DemosaicRegistry demosaicRegistry,
  required LinearRgbTileStoreFactory outputStoreFactory,
  int tileSize = 512,
  int overlap = 24,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  final DemosaicEngine engine = demosaicRegistry.requireProduction(
    DemosaicAlgorithm.mobileStackAdaptive,
  );
  if (engine is! NativeMobileStackDemosaicEngine) {
    // Alternative production engines only expose the original whole-mosaic
    // contract. Keep them usable for tests and future plug-ins; the Android
    // production engine takes the bounded-memory path below.
    final samples = await mosaicStore.readRegion(
      x: 0,
      y: 0,
      width: mosaicStore.width,
      height: mosaicStore.height,
    );
    return demosaicReconstructedMosaic(
      mosaic: LinearRawMosaic(
        width: mosaicStore.width,
        height: mosaicStore.height,
        cfaPattern: mosaicStore.cfaPattern,
        samples: samples,
      ),
      demosaicRegistry: demosaicRegistry,
      outputStoreFactory: outputStoreFactory,
      tileSize: tileSize,
      overlap: overlap,
      isCancelled: isCancelled,
      reportProgress: reportProgress,
    );
  }
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: mosaicStore.width,
    imageHeight: mosaicStore.height,
    tileSize: tileSize,
    overlap: overlap,
  );
  final LinearRgbTileStore store = await outputStoreFactory(
    width: mosaicStore.width,
    height: mosaicStore.height,
    plan: plan,
  );
  bool committed = false;
  try {
    for (int index = 0; index < plan.tiles.length; index++) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Demosaic was cancelled.');
      }
      final OverlappedTile plannedTile = plan.tiles[index];
      final LinearRgbTile tile = await engine.processFileBackedTile(
        store: mosaicStore,
        tile: plannedTile,
        saturationMask: saturationMask,
        isCancelled: isCancelled,
      );
      await store.writeTile(tile);
      reportProgress?.call((index + 1) / plan.tiles.length);
    }
    await store.commit();
    committed = true;
    return store;
  } finally {
    try {
      if (!committed) await store.abort();
    } finally {
      if (engine is DisposableDemosaicEngine) {
        (engine as DisposableDemosaicEngine).disposeTransientResources();
      }
    }
  }
}
