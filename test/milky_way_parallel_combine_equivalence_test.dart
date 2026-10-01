import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/session/milky_way_pipeline.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

/// Work361: the parallel classic combine (worker isolates) must be
/// bit-identical to the historical sequential loop.

Float32List _frame(int w, int h, double rotDeg, double dx, double dy, int seed) {
  final Float32List rgb = Float32List(w * h * 3);
  final math.Random noise = math.Random(seed);
  for (int i = 0; i < rgb.length; i++) {
    rgb[i] = 0.15 + 0.002 * noise.nextDouble();
  }
  int state = 4242;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  final double r = rotDeg * math.pi / 180;
  for (int s = 0; s < 40; s++) {
    final double sx = 20 + next() * (w - 40);
    final double sy = 20 + next() * (h - 40);
    final double peak = 3 + next() * 6;
    final double cx = w / 2 + (sx - w / 2) * math.cos(r) - (sy - h / 2) * math.sin(r) + dx;
    final double cy = h / 2 + (sx - w / 2) * math.sin(r) + (sy - h / 2) * math.cos(r) + dy;
    for (int y = math.max(0, cy.round() - 6); y <= math.min(h - 1, cy.round() + 6); y++) {
      for (int x = math.max(0, cx.round() - 6); x <= math.min(w - 1, cx.round() + 6); x++) {
        final double v = peak *
            math.exp(-((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (2 * 1.3 * 1.3));
        rgb[(y * w + x) * 3 + 1] += v;
      }
    }
  }
  return rgb;
}

Future<FileBackedLinearRgbTileStore> _fileStore(
  Directory dir,
  String name,
  Float32List rgb,
  int w,
  int h,
) async {
  final OverlappedTilePlan plan =
      OverlappedTilePlan.create(imageWidth: w, imageHeight: h, tileSize: w, overlap: 0);
  final FileBackedLinearRgbTileStore store = await FileBackedLinearRgbTileStore.create(
    path: '${dir.path}${Platform.pathSeparator}$name.f32',
    width: w,
    height: h,
    plan: plan,
  );
  await store.writeTile(
    LinearRgbTile(x: 0, y: 0, width: w, height: h, interleavedRgb: rgb),
  );
  await store.commit();
  return store;
}

Future<Float32List> _run(List<LinearRgbTileStore?> stores, int workers) async {
  final MilkyWayPipelineResult result = await registerAndCombineDecodedFrames(
    sourcePaths: <String>['a.arw', 'b.arw', 'c.arw', 'd.arw'],
    frameStores: stores,
    decodeFailures: const <int, Object?>{},
    outputTileStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
    tileSize: 64,
    referenceIndex: 0,
    combineWorkerIsolates: workers,
  );
  final LinearRgbTile all = await result.tileStore.readRegion(
    x: 0,
    y: 0,
    width: result.tileStore.width,
    height: result.tileStore.height,
  );
  final Float32List copy = Float32List.fromList(all.interleavedRgb);
  await result.tileStore.dispose();
  return copy;
}

void main() {
  test('parallel combine equals the sequential combine bit for bit', () async {
    const int w = 200, h = 160;
    final Directory dir =
        await Directory.systemTemp.createTemp('work361-parallel-combine-');
    try {
      final List<LinearRgbTileStore?> stores = <LinearRgbTileStore?>[
        await _fileStore(dir, 'a', _frame(w, h, 0, 0, 0, 1), w, h),
        await _fileStore(dir, 'b', _frame(w, h, 1.5, 2, -1, 2), w, h),
        await _fileStore(dir, 'c', _frame(w, h, -1, -1.5, 1, 3), w, h),
        await _fileStore(dir, 'd', _frame(w, h, 2, 1, 2, 4), w, h),
      ];
      final Float32List sequential = await _run(stores, 1);
      final Float32List parallel = await _run(stores, 3);
      expect(parallel.length, sequential.length);
      expect(
        ByteData.sublistView(parallel).buffer.asUint8List(),
        ByteData.sublistView(sequential).buffer.asUint8List(),
      );
    } finally {
      await dir.delete(recursive: true);
    }
  });
}
