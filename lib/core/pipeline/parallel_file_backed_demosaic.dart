import 'dart:async';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import '../demosaic/demosaic_engine.dart';
import '../demosaic/native_mobile_stack_demosaic_engine_stub.dart'
    if (dart.library.io) '../demosaic/native_mobile_stack_demosaic_engine.dart';
import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../quality/highest_quality_policy.dart';
import '../tiles/overlapped_tile_plan.dart';

/// Everything a worker isolate needs to open its own read-only view of the
/// committed calibrated-RAW store and reconstruct the (optional) saturation
/// mask, without sharing any mutable state with the orchestrating isolate.
final class _DemosaicWorkerStartup {
  const _DemosaicWorkerStartup({
    required this.id,
    required this.storePath,
    required this.storeWidth,
    required this.storeHeight,
    required this.cfaPattern,
    required this.saturationMaskPixelCount,
    required this.saturationMaskPackedBytes,
    required this.saturationMaskSaturatedCount,
    required this.responses,
  });

  final int id;
  final String storePath;
  final int storeWidth;
  final int storeHeight;
  final CfaPattern cfaPattern;
  final int? saturationMaskPixelCount;
  final Uint8List? saturationMaskPackedBytes;
  final int? saturationMaskSaturatedCount;
  final SendPort responses;
}

final class _DemosaicWorkerReady {
  const _DemosaicWorkerReady(this.id, this.commands);
  final int id;
  final SendPort commands;
}

final class _DemosaicTileRequest {
  const _DemosaicTileRequest(this.index, this.tile);
  final int index;
  final OverlappedTile tile;
}

final class _DemosaicStopWorker {
  const _DemosaicStopWorker();
}

final class _DemosaicWorkerStopped {
  const _DemosaicWorkerStopped(this.id);
  final int id;
}

final class _DemosaicTileResponse {
  const _DemosaicTileResponse({
    required this.workerId,
    required this.index,
    required this.interleavedRgb,
  });
  final int workerId;
  final int index;
  final TransferableTypedData interleavedRgb;
}

final class _DemosaicWorkerFailure {
  const _DemosaicWorkerFailure(this.workerId, this.error, this.stackTrace);
  final int workerId;
  final String error;
  final String stackTrace;
}

@pragma('vm:entry-point')
Future<void> _demosaicWorkerMain(_DemosaicWorkerStartup startup) async {
  final ReceivePort commands = ReceivePort();
  FileBackedLinearRawMosaicStore? store;
  NativeMobileStackDemosaicEngine? engine;
  try {
    store = await FileBackedLinearRawMosaicStore.openReadOnly(
      path: startup.storePath,
      width: startup.storeWidth,
      height: startup.storeHeight,
      cfaPattern: startup.cfaPattern,
      hasSaturationMask: false,
      hasSaturatedPixels: false,
    );
    final RawSaturationMask? saturationMask =
        startup.saturationMaskPackedBytes == null
            ? null
            : RawSaturationMask.takePackedBytes(
                pixelCount: startup.saturationMaskPixelCount!,
                packedBytes: startup.saturationMaskPackedBytes!,
                saturatedCount: startup.saturationMaskSaturatedCount!,
              );
    engine = NativeMobileStackDemosaicEngine();
    final NativeMobileStackDemosaicEngine activeEngine = engine;
    startup.responses.send(_DemosaicWorkerReady(startup.id, commands.sendPort));
    await for (final Object? message in commands) {
      if (message is _DemosaicStopWorker) break;
      if (message is! _DemosaicTileRequest) continue;
      try {
        final LinearRgbTile tile = await activeEngine.processFileBackedTile(
          store: store,
          tile: message.tile,
          saturationMask: saturationMask,
          qualityPolicy: const HighestQualityPolicy(),
        );
        startup.responses.send(_DemosaicTileResponse(
          workerId: startup.id,
          index: message.index,
          interleavedRgb: TransferableTypedData.fromList(<Uint8List>[
            tile.interleavedRgb.buffer.asUint8List(
              tile.interleavedRgb.offsetInBytes,
              tile.interleavedRgb.lengthInBytes,
            ),
          ]),
        ));
      } catch (error, stackTrace) {
        startup.responses.send(
          _DemosaicWorkerFailure(startup.id, '$error', '$stackTrace'),
        );
        break;
      }
    }
  } catch (error, stackTrace) {
    startup.responses
        .send(_DemosaicWorkerFailure(startup.id, '$error', '$stackTrace'));
  } finally {
    commands.close();
    try {
      if (engine is DisposableDemosaicEngine) {
        (engine as DisposableDemosaicEngine).disposeTransientResources();
      }
    } on Object {
      // Best-effort; the isolate is about to be killed regardless.
    }
    try {
      await store?.dispose();
    } on Object {
      // The orchestrating isolate is the authoritative owner; best effort.
    }
    startup.responses.send(_DemosaicWorkerStopped(startup.id));
  }
}

/// Demosaics every tile in [plan] against the committed, read-only
/// [calibratedRawStore], distributing tiles across up to [maximumWorkers]
/// long-lived isolates and writing completed tiles into [outputStore] in
/// deterministic plan order (identical order to the previous single-isolate
/// loop, so output is byte-for-byte unchanged — only wall-clock time
/// differs).
///
/// Each worker opens its own read-only view of [calibratedRawStore]; none of
/// them mutate it, so multiple concurrent readers are safe. [outputStore] is
/// written only by the orchestrating isolate.
Future<void> demosaicFileBackedTilesParallel({
  required FileBackedLinearRawMosaicStore calibratedRawStore,
  required RawSaturationMask? saturationMask,
  required OverlappedTilePlan plan,
  required LinearRgbTileStore outputStore,
  int maximumWorkers = 4,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
  void Function(OverlappedTile planned, LinearRgbTile actual)? validateTile,
}) async {
  if (plan.tiles.isEmpty) return;
  final int workerCount =
      math.min(math.max(1, maximumWorkers), plan.tiles.length);
  final ReceivePort responses = ReceivePort();
  final StreamIterator<Object?> messages = StreamIterator<Object?>(responses);
  final List<Isolate> isolates = <Isolate>[];
  final Map<int, SendPort> commands = <int, SendPort>{};
  try {
    for (int id = 0; id < workerCount; id++) {
      isolates.add(await Isolate.spawn(
        _demosaicWorkerMain,
        _DemosaicWorkerStartup(
          id: id,
          storePath: calibratedRawStore.path,
          storeWidth: calibratedRawStore.width,
          storeHeight: calibratedRawStore.height,
          cfaPattern: calibratedRawStore.cfaPattern,
          saturationMaskPixelCount: saturationMask?.pixelCount,
          saturationMaskPackedBytes: saturationMask?.toPackedBytes(),
          saturationMaskSaturatedCount: saturationMask?.saturatedCount,
          responses: responses.sendPort,
        ),
        debugName: 'demosaic-$id',
      ));
    }
    while (commands.length < workerCount) {
      if (!await messages.moveNext()) throw StateError('Worker port closed.');
      final Object? message = messages.current;
      if (message is _DemosaicWorkerFailure) {
        throw StateError('${message.error}\n${message.stackTrace}');
      }
      if (message is _DemosaicWorkerReady) {
        commands[message.id] = message.commands;
      }
    }
    int nextDispatch = 0;
    for (final MapEntry<int, SendPort> worker in commands.entries) {
      if (nextDispatch >= plan.tiles.length) break;
      worker.value
          .send(_DemosaicTileRequest(nextDispatch, plan.tiles[nextDispatch]));
      nextDispatch++;
    }
    int nextWrite = 0;
    final Map<int, _DemosaicTileResponse> pending =
        <int, _DemosaicTileResponse>{};
    while (nextWrite < plan.tiles.length) {
      if (isCancelled?.call() ?? false) {
        throw const DemosaicProcessingCancelled();
      }
      if (!await messages.moveNext()) throw StateError('Worker port closed.');
      final Object? message = messages.current;
      if (message is _DemosaicWorkerFailure) {
        throw StateError('${message.error}\n${message.stackTrace}');
      }
      if (message is! _DemosaicTileResponse) continue;
      pending[message.index] = message;
      if (nextDispatch < plan.tiles.length) {
        commands[message.workerId]!
            .send(_DemosaicTileRequest(nextDispatch, plan.tiles[nextDispatch]));
        nextDispatch++;
      }
      while (pending.containsKey(nextWrite)) {
        final _DemosaicTileResponse ready = pending.remove(nextWrite)!;
        final OverlappedTile tile = plan.tiles[nextWrite];
        final LinearRgbTile writtenTile = LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: ready.interleavedRgb.materialize().asFloat32List(),
        );
        validateTile?.call(tile, writtenTile);
        await outputStore.writeTile(writtenTile);
        nextWrite++;
        reportProgress?.call(0.02 + 0.96 * nextWrite / plan.tiles.length);
      }
    }
    for (final SendPort port in commands.values) {
      port.send(const _DemosaicStopWorker());
    }
    final Set<int> stoppedWorkers = <int>{};
    while (stoppedWorkers.length < workerCount) {
      if (!await messages.moveNext()) break;
      final Object? message = messages.current;
      if (message is _DemosaicWorkerStopped) stoppedWorkers.add(message.id);
    }
  } finally {
    for (final SendPort port in commands.values) {
      port.send(const _DemosaicStopWorker());
    }
    for (final Isolate isolate in isolates) {
      isolate.kill(priority: Isolate.immediate);
    }
    await messages.cancel();
    responses.close();
  }
}
