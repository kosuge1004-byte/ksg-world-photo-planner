import 'cfa_drizzle_tiled_checkpoint.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import 'dart:async';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../registration/local_residual_correction.dart';
import '../registration/similarity_transform_math.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'cfa_drizzle.dart' show CfaDrizzleResult;
import 'robust_combine_cfa_drizzle.dart';
import 'tiled_cfa_drizzle.dart';
import 'tiled_robust_combine_cfa_drizzle.dart';

final class _FrameDescriptor {
  const _FrameDescriptor({
    required this.path,
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.hasSaturationMask,
    required this.hasSaturatedPixels,
    required this.transformEstimate,
    required this.weight,
    required this.localCorrectionField,
    required this.phaseScales,
  });

  factory _FrameDescriptor.fromFrame(CfaDrizzleTiledFrame frame) =>
      _FrameDescriptor(
        path: frame.mosaicStore.path,
        width: frame.mosaicStore.width,
        height: frame.mosaicStore.height,
        cfaPattern: frame.mosaicStore.cfaPattern,
        hasSaturationMask: frame.mosaicStore.hasSaturationMask,
        hasSaturatedPixels: frame.mosaicStore.hasSaturatedPixels,
        transformEstimate: frame.transformEstimate,
        weight: frame.weight,
        localCorrectionField: frame.localCorrectionField,
        phaseScales: frame.phaseScales,
      );

  final String path;
  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final bool hasSaturationMask;
  final bool hasSaturatedPixels;
  final SimilarityTransformEstimate? transformEstimate;
  final double weight;
  final LocalResidualCorrectionField? localCorrectionField;
  final List<double>? phaseScales;
}

final class _WorkerStartup {
  const _WorkerStartup({
    required this.id,
    required this.frames,
    required this.responses,
    required this.outputScale,
    required this.pixfrac,
    required this.minCoverage,
    required this.minFramesForRejection,
    required this.sigmaLow,
    required this.sigmaHigh,
  });
  final int id;
  final List<_FrameDescriptor> frames;
  final SendPort responses;
  final double outputScale;
  final double pixfrac;
  final double minCoverage;
  final int minFramesForRejection;
  final double sigmaLow;
  final double sigmaHigh;
}

final class _WorkerReady {
  const _WorkerReady(this.id, this.commands);
  final int id;
  final SendPort commands;
}

final class _TileRequest {
  const _TileRequest(this.index, this.tile);
  final int index;
  final OverlappedTile tile;
}

final class _StopWorker {
  const _StopWorker();
}

final class _WorkerStopped {
  const _WorkerStopped(this.id);
  final int id;
}

final class _TileResponse {
  const _TileResponse({
    required this.workerId,
    required this.index,
    required this.values,
    required this.coverage,
    this.saturation,
    this.preRejection,
  });
  final int workerId;
  final int index;
  final TransferableTypedData values;
  final TransferableTypedData coverage;
  final TransferableTypedData? saturation;
  final TransferableTypedData? preRejection;
}

final class _WorkerFailure {
  const _WorkerFailure(this.workerId, this.error, this.stackTrace);
  final int workerId;
  final String error;
  final String stackTrace;
}

final class _ComputedTile {
  const _ComputedTile({
    required this.values,
    required this.coverage,
    this.saturation,
    this.preRejection,
  });
  final Float32List values;
  final Float32List coverage;
  final Float32List? saturation;
  final Float32List? preRejection;
}

TransferableTypedData _transfer(Float32List values) =>
    TransferableTypedData.fromList(<Uint8List>[
      values.buffer.asUint8List(values.offsetInBytes, values.lengthInBytes),
    ]);

Float32List _materialize(TransferableTypedData data) =>
    data.materialize().asFloat32List();

@pragma('vm:entry-point')
Future<void> _workerMain(_WorkerStartup startup) async {
  final List<FileBackedLinearRawMosaicStore> stores =
      <FileBackedLinearRawMosaicStore>[];
  final ReceivePort commands = ReceivePort();
  try {
    final List<CfaDrizzleTiledFrame> frames = <CfaDrizzleTiledFrame>[];
    for (final _FrameDescriptor descriptor in startup.frames) {
      final FileBackedLinearRawMosaicStore store =
          await FileBackedLinearRawMosaicStore.openReadOnly(
        path: descriptor.path,
        width: descriptor.width,
        height: descriptor.height,
        cfaPattern: descriptor.cfaPattern,
        hasSaturationMask: descriptor.hasSaturationMask,
        hasSaturatedPixels: descriptor.hasSaturatedPixels,
      );
      stores.add(store);
      frames.add(CfaDrizzleTiledFrame(
        mosaicStore: store,
        transformEstimate: descriptor.transformEstimate,
        weight: descriptor.weight,
        localCorrectionField: descriptor.localCorrectionField,
        phaseScales: descriptor.phaseScales,
      ));
    }
    final List<CfaDrizzleFrameGeometry> geometries =
        frames.map(prepareCfaDrizzleFrameGeometry).toList(growable: false);
    startup.responses.send(_WorkerReady(startup.id, commands.sendPort));
    await for (final Object? message in commands) {
      if (message is _StopWorker) break;
      if (message is! _TileRequest) continue;
      try {
        final _ComputedTile result = await _computeTile(
          frames: frames,
          geometries: geometries,
          tile: message.tile,
          outputScale: startup.outputScale,
          pixfrac: startup.pixfrac,
          minCoverage: startup.minCoverage,
          minFramesForRejection: startup.minFramesForRejection,
          sigmaLow: startup.sigmaLow,
          sigmaHigh: startup.sigmaHigh,
        );
        startup.responses.send(_TileResponse(
          workerId: startup.id,
          index: message.index,
          values: _transfer(result.values),
          coverage: _transfer(result.coverage),
          saturation:
              result.saturation == null ? null : _transfer(result.saturation!),
          preRejection: result.preRejection == null
              ? null
              : _transfer(result.preRejection!),
        ));
      } catch (error, stackTrace) {
        startup.responses.send(
          _WorkerFailure(startup.id, '$error', '$stackTrace'),
        );
        break;
      }
    }
  } catch (error, stackTrace) {
    startup.responses.send(_WorkerFailure(startup.id, '$error', '$stackTrace'));
  } finally {
    commands.close();
    for (final FileBackedLinearRawMosaicStore store in stores) {
      try {
        await store.dispose();
      } on Object {
        // Writer isolate remains the owner and performs authoritative cleanup.
      }
    }
    startup.responses.send(_WorkerStopped(startup.id));
  }
}

Future<_ComputedTile> _computeTile({
  required List<CfaDrizzleTiledFrame> frames,
  required List<CfaDrizzleFrameGeometry> geometries,
  required OverlappedTile tile,
  required double outputScale,
  required double pixfrac,
  required double minCoverage,
  required int minFramesForRejection,
  required double sigmaLow,
  required double sigmaHigh,
}) async {
  final int pixelCount = tile.outputWidth * tile.outputHeight;
  final bool hasSaturation =
      frames.any((frame) => frame.mosaicStore.hasSaturatedPixels);
  final List<CfaDrizzleResult> perFrame = <CfaDrizzleResult>[];
  final Float64List? saturationSum =
      hasSaturation ? Float64List(pixelCount * 3) : null;
  final Float64List? preRejectionSum =
      hasSaturation ? Float64List(pixelCount * 3) : null;
  for (int frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    final result = await drizzleCfaFrameToOutputTile(
      frame: frames[frameIndex],
      outputTile: tile,
      outputScale: outputScale,
      pixfrac: pixfrac,
      preparedGeometry: geometries[frameIndex],
    );
    perFrame.add(result.scientific);
    if (hasSaturation) {
      for (int channel = 0; channel < 3; channel++) {
        final Float64List frameCoverage =
            result.scientific.channels[channel].coverage;
        final Float64List? frameSaturation =
            result.saturation?.channels[channel].coverage;
        for (int pixel = 0; pixel < pixelCount; pixel++) {
          final int index = pixel * 3 + channel;
          preRejectionSum![index] += frameCoverage[pixel];
          if (frameSaturation != null) {
            saturationSum![index] += frameSaturation[pixel];
          }
        }
      }
    }
  }
  final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
    perFrame,
    minCoverage: minCoverage,
    minFramesForRejection: minFramesForRejection,
    sigmaLow: sigmaLow,
    sigmaHigh: sigmaHigh,
  );
  final Float32List values = Float32List(pixelCount * 3);
  final Float32List coverage = Float32List(pixelCount * 3);
  final Float32List? saturation =
      hasSaturation ? Float32List(pixelCount * 3) : null;
  final Float32List? preRejection =
      hasSaturation ? Float32List(pixelCount * 3) : null;
  const double maximumFloat32 = 3.4028234663852886e38;
  for (int pixel = 0; pixel < pixelCount; pixel++) {
    for (int channel = 0; channel < 3; channel++) {
      final int index = pixel * 3 + channel;
      final double value = combined.channels[channel].value[pixel];
      final double weight = combined.channels[channel].coverage[pixel];
      final double saturatedWeight = saturationSum?[index] ?? 0;
      final double observedWeight = preRejectionSum?[index] ?? 0;
      if (!value.isFinite ||
          !weight.isFinite ||
          !saturatedWeight.isFinite ||
          !observedWeight.isFinite ||
          weight < 0 ||
          saturatedWeight < 0 ||
          observedWeight < 0 ||
          value.abs() > maximumFloat32 ||
          weight > maximumFloat32 ||
          saturatedWeight > maximumFloat32 ||
          observedWeight > maximumFloat32) {
        throw InvalidRobustCombineInput(
          'Parallel robust CFA drizzle output exceeds finite Float32 range.',
        );
      }
      values[index] = value;
      coverage[index] = weight;
      if (hasSaturation) {
        saturation![index] = saturatedWeight;
        preRejection![index] = observedWeight;
      }
    }
  }
  return _ComputedTile(
    values: values,
    coverage: coverage,
    saturation: saturation,
    preRejection: preRejection,
  );
}

/// Long-lived isolates process independent output tiles concurrently.
/// Each isolate opens non-owning read-only views of the same committed RAW
/// stores; only this isolate writes final tiles, in deterministic plan order.
/// [tileCooldown] is intended for memory/thermal-constrained devices. With a
/// single worker, the next tile is not dispatched until the current tile has
/// been durably written and the cooldown has elapsed. This changes throughput,
/// never the numerical image result.
Future<StreamingRobustCfaDrizzleResult> robustDrizzleCfaFramesParallelTiled({
  required List<CfaDrizzleTiledFrame> frames,
  required int outputWidth,
  required int outputHeight,
  required LinearRgbTileStoreFactory valueStoreFactory,
  required LinearRgbTileStoreFactory coverageStoreFactory,
  CfaDrizzleTiledCheckpointStore? stageCheckpoint,
  int tileSize = 128,
  int maximumWorkers = 4,
  Duration tileCooldown = Duration.zero,
  double outputScale = 2,
  double pixfrac = 0.7,
  double minCoverage = 1e-6,
  int minFramesForRejection = 4,
  double sigmaLow = 4,
  double sigmaHigh = 3,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  if (frames.isEmpty) {
    throw InvalidRobustCombineInput('At least one CFA frame is required.');
  }
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: outputWidth,
    imageHeight: outputHeight,
    tileSize: tileSize,
    overlap: 0,
  );
  final bool hasSaturation =
      frames.any((frame) => frame.mosaicStore.hasSaturatedPixels);
  late final LinearRgbTileStore outputValue, outputCoverage;
  LinearRgbTileStore? outputSaturation, outputPreRejection;
  int resumeFromTileIndex = 0;
  if (stageCheckpoint != null) {
    final progress = await stageCheckpoint.openOrCreate(
        width: outputWidth,
        height: outputHeight,
        plan: plan,
        needsSaturationStore: hasSaturation,
        needsPreRejectionStore: hasSaturation);
    outputValue = progress.valueStore;
    outputCoverage = progress.coverageStore;
    outputSaturation = progress.saturationCoverageStore;
    outputPreRejection = progress.preRejectionCoverageStore;
    resumeFromTileIndex = progress.resumeFromTileIndex;
  } else {
    outputValue = await valueStoreFactory(
      width: outputWidth,
      height: outputHeight,
      plan: plan,
    );
    outputCoverage = await coverageStoreFactory(
      width: outputWidth,
      height: outputHeight,
      plan: plan,
    );
    outputSaturation = hasSaturation
        ? await coverageStoreFactory(
            width: outputWidth, height: outputHeight, plan: plan)
        : null;
    outputPreRejection = hasSaturation
        ? await coverageStoreFactory(
            width: outputWidth, height: outputHeight, plan: plan)
        : null;
  }
  final workerCount = math.min(math.max(1, maximumWorkers),
      math.max(1, plan.tiles.length - resumeFromTileIndex));
  final ReceivePort responses = ReceivePort();
  final StreamIterator<Object?> messages = StreamIterator<Object?>(responses);
  final List<Isolate> isolates = <Isolate>[];
  final Map<int, SendPort> commands = <int, SendPort>{};
  bool committed = false;
  try {
    if (resumeFromTileIndex == plan.tiles.length) {
      await outputValue.commit();
      await outputCoverage.commit();
      await outputSaturation?.commit();
      await outputPreRejection?.commit();
      committed = true;
      return StreamingRobustCfaDrizzleResult(
          valueStore: outputValue,
          coverageStore: outputCoverage,
          saturationCoverageStore: outputSaturation,
          preRejectionCoverageStore: outputPreRejection);
    }
    final List<_FrameDescriptor> descriptors =
        frames.map(_FrameDescriptor.fromFrame).toList(growable: false);
    for (int id = 0; id < workerCount; id++) {
      isolates.add(await Isolate.spawn(
        _workerMain,
        _WorkerStartup(
          id: id,
          frames: descriptors,
          responses: responses.sendPort,
          outputScale: outputScale,
          pixfrac: pixfrac,
          minCoverage: minCoverage,
          minFramesForRejection: minFramesForRejection,
          sigmaLow: sigmaLow,
          sigmaHigh: sigmaHigh,
        ),
        debugName: 'cfa-drizzle-$id',
      ));
    }
    while (commands.length < workerCount) {
      if (!await messages.moveNext()) throw StateError('Worker port closed.');
      final Object? message = messages.current;
      if (message is _WorkerFailure) {
        throw StateError('${message.error}\n${message.stackTrace}');
      }
      if (message is _WorkerReady) commands[message.id] = message.commands;
    }
    int nextDispatch = resumeFromTileIndex;
    for (final MapEntry<int, SendPort> worker in commands.entries) {
      worker.value.send(_TileRequest(nextDispatch, plan.tiles[nextDispatch]));
      nextDispatch++;
    }
    int nextWrite = resumeFromTileIndex;
    final Map<int, _TileResponse> pending = <int, _TileResponse>{};
    while (nextWrite < plan.tiles.length) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Parallel robust CFA drizzle was cancelled.');
      }
      if (!await messages.moveNext()) throw StateError('Worker port closed.');
      final Object? message = messages.current;
      if (message is _WorkerFailure) {
        throw StateError('${message.error}\n${message.stackTrace}');
      }
      if (message is! _TileResponse) continue;
      pending[message.index] = message;
      if (workerCount > 1 && nextDispatch < plan.tiles.length) {
        commands[message.workerId]!
            .send(_TileRequest(nextDispatch, plan.tiles[nextDispatch]));
        nextDispatch++;
      }
      while (pending.containsKey(nextWrite)) {
        final _TileResponse ready = pending.remove(nextWrite)!;
        final OverlappedTile tile = plan.tiles[nextWrite];
        await outputValue.writeTile(LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: _materialize(ready.values),
        ));
        await outputCoverage.writeTile(LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: _materialize(ready.coverage),
        ));
        if (hasSaturation) {
          await outputSaturation!.writeTile(LinearRgbTile(
            x: tile.outputX,
            y: tile.outputY,
            width: tile.outputWidth,
            height: tile.outputHeight,
            interleavedRgb: _materialize(ready.saturation!),
          ));
          await outputPreRejection!.writeTile(LinearRgbTile(
            x: tile.outputX,
            y: tile.outputY,
            width: tile.outputWidth,
            height: tile.outputHeight,
            interleavedRgb: _materialize(ready.preRejection!),
          ));
        }
        nextWrite++;
        await stageCheckpoint?.recordProgress(nextWrite);
        reportProgress?.call(nextWrite / plan.tiles.length);
        if (workerCount == 1 && nextDispatch < plan.tiles.length) {
          if (tileCooldown > Duration.zero) {
            await Future<void>.delayed(tileCooldown);
          }
          commands[ready.workerId]!
              .send(_TileRequest(nextDispatch, plan.tiles[nextDispatch]));
          nextDispatch++;
        }
      }
    }
    for (final SendPort port in commands.values) {
      port.send(const _StopWorker());
    }
    final Set<int> stoppedWorkers = <int>{};
    while (stoppedWorkers.length < workerCount) {
      if (!await messages.moveNext()) throw StateError('Worker port closed.');
      final Object? message = messages.current;
      if (message is _WorkerFailure) {
        throw StateError('${message.error}\n${message.stackTrace}');
      }
      if (message is _WorkerStopped) stoppedWorkers.add(message.id);
    }
    await outputValue.commit();
    await outputCoverage.commit();
    await outputSaturation?.commit();
    await outputPreRejection?.commit();
    committed = true;
    return StreamingRobustCfaDrizzleResult(
      valueStore: outputValue,
      coverageStore: outputCoverage,
      saturationCoverageStore: outputSaturation,
      preRejectionCoverageStore: outputPreRejection,
    );
  } finally {
    if (!committed) {
      for (final store in [
        outputValue,
        outputCoverage,
        outputSaturation,
        outputPreRejection
      ]) {
        if (stageCheckpoint != null && store is FileBackedLinearRgbTileStore) {
          await store.closeRetainingFile();
        } else {
          await store?.abort();
        }
      }
    }
    for (final SendPort port in commands.values) {
      port.send(const _StopWorker());
    }
    for (final Isolate isolate in isolates) {
      isolate.kill(priority: Isolate.immediate);
    }
    await messages.cancel();
    responses.close();
  }
}
