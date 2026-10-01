import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_contribution_tile.dart';
import '../image/linear_contribution_tile_store.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';

/// Work356: star-trail mean background + maximum trails.
///
/// Dart port of `tool/raw_samples/star_trail_mean_background_reference.mjs`
/// (tests there and in `test/star_trail_mean_background_test.dart`).
///
/// The per-pixel maximum over N noisy frames lifts the sky to the upper tail
/// of the noise (about +2.5 sigma at N=100) and keeps single-frame noise
/// texture; the mean has sqrt(N)-times lower noise. With the excess
/// e = M - A, the combination `A + w(e) (M - A)` keeps M on trails (w = 1)
/// and A on the sky (w = 0). w ramps (smoothstep) between median + 3 and
/// median + 6 robust sigmas of the excess among pixels of similar mean
/// level, so it adapts to shot noise without a noise model. One w per pixel
/// (from luminance) keeps trail colours intact.

final class StarTrailExcessBin {
  const StarTrailExcessBin(this.lowerLevel, this.median, this.sigma);
  final double lowerLevel;
  final double median;
  final double sigma;
}

double _median(List<double> values) {
  final List<double> s = <double>[...values]..sort();
  final int n = s.length;
  return n.isOdd ? s[(n - 1) ~/ 2] : (s[n ~/ 2 - 1] + s[n ~/ 2]) / 2;
}

/// Excess statistics per mean-luminance bin from paired samples.
List<StarTrailExcessBin> starTrailExcessStatistics(
  List<double> levels,
  List<double> excess, {
  int bins = 32,
  int minPerBin = 50,
}) {
  if (levels.length != excess.length || levels.isEmpty) {
    throw ArgumentError('Excess statistics need paired, non-empty samples.');
  }
  final List<int> order = List<int>.generate(levels.length, (int i) => i)
    ..sort((int a, int b) => levels[a].compareTo(levels[b]));
  final int per = math.max(minPerBin, (order.length / bins).ceil());
  final List<List<int>> groups = <List<int>>[];
  for (int start = 0; start < order.length; start += per) {
    final List<int> members =
        order.sublist(start, math.min(order.length, start + per));
    if (members.length < minPerBin && groups.isNotEmpty) {
      groups.last.addAll(members);
    } else {
      groups.add(members);
    }
  }
  return <StarTrailExcessBin>[
    for (final List<int> g in groups)
      () {
        final List<double> e = <double>[for (final int i in g) excess[i]];
        final double med = _median(e);
        final double sigma = math.max(
          1e-9,
          1.4826 * _median(<double>[for (final double v in e) (v - med).abs()]),
        );
        return StarTrailExcessBin(levels[g.first], med, sigma);
      }(),
  ];
}

double starTrailRampWeight(
  double e,
  double median,
  double sigma, {
  double lowK = 3,
  double highK = 6,
}) {
  final double t = (e - (median + lowK * sigma)) / ((highK - lowK) * sigma);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

StarTrailExcessBin _binFor(List<StarTrailExcessBin> bins, double level) {
  int k = 0;
  while (k + 1 < bins.length && level >= bins[k + 1].lowerLevel) {
    k++;
  }
  return bins[k];
}

/// Combines one region (interleaved RGB) in place into a new buffer.
Float32List combineStarTrailMeanAndMaxRegion(
  Float32List mean,
  Float32List max,
  List<StarTrailExcessBin> bins,
) {
  final Float32List out = Float32List(mean.length);
  for (int p = 0; p < mean.length ~/ 3; p++) {
    final int b = p * 3;
    final double a = (mean[b] + mean[b + 1] + mean[b + 2]) / 3;
    final double m = (max[b] + max[b + 1] + max[b + 2]) / 3;
    final StarTrailExcessBin bin = _binFor(bins, a);
    final double w = starTrailRampWeight(m - a, bin.median, bin.sigma);
    for (int c = 0; c < 3; c++) {
      out[b + c] = mean[b + c] + w * (max[b + c] - mean[b + c]);
    }
  }
  return out;
}

/// Mean store (sum / count; 0 where no frame was valid).
Future<LinearRgbTileStore> materializeStarTrailMeanStore({
  required LinearRgbTileStore sum,
  required LinearContributionTileStore count,
  required LinearRgbTileStoreFactory outputStoreFactory,
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: sum.width,
    imageHeight: sum.height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore out = await outputStoreFactory(
    width: sum.width,
    height: sum.height,
    plan: plan,
  );
  bool committed = false;
  try {
    for (final OverlappedTile t in plan.tiles) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Star-trail mean was cancelled.');
      }
      final LinearRgbTile s = await sum.readRegion(
        x: t.outputX,
        y: t.outputY,
        width: t.outputWidth,
        height: t.outputHeight,
      );
      final LinearContributionTile c = await count.readRegion(
        x: t.outputX,
        y: t.outputY,
        width: t.outputWidth,
        height: t.outputHeight,
      );
      final Float32List mean = Float32List(s.interleavedRgb.length);
      for (int i = 0; i < mean.length; i++) {
        final int n = c.interleavedCounts[i];
        mean[i] = n == 0 ? 0 : s.interleavedRgb[i] / n;
      }
      await out.writeTile(LinearRgbTile(
        x: t.outputX,
        y: t.outputY,
        width: t.outputWidth,
        height: t.outputHeight,
        interleavedRgb: mean,
      ));
    }
    await out.commit();
    committed = true;
    return out;
  } finally {
    if (!committed) await out.abort();
  }
}

/// Two passes over [maxStore]/[meanStore]: excess statistics on an
/// 8x8-subsampled grid, then the combination tile by tile.
Future<LinearRgbTileStore> combineStarTrailMeanAndMax({
  required LinearRgbTileStore maxStore,
  required LinearRgbTileStore meanStore,
  required LinearRgbTileStoreFactory outputStoreFactory,
  int tileSize = 512,
  int sampleStride = 8,
  bool Function()? isCancelled,
  void Function(String message)? log,
}) async {
  if (maxStore.width != meanStore.width || maxStore.height != meanStore.height) {
    throw ArgumentError('Max and mean stores differ in size.');
  }
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: maxStore.width,
    imageHeight: maxStore.height,
    tileSize: tileSize,
    overlap: 0,
  );
  final List<double> levels = <double>[];
  final List<double> excess = <double>[];
  for (final OverlappedTile t in plan.tiles) {
    if (isCancelled?.call() ?? false) {
      throw StateError('Star-trail mean/max combination was cancelled.');
    }
    final Float32List a = (await meanStore.readRegion(
      x: t.outputX,
      y: t.outputY,
      width: t.outputWidth,
      height: t.outputHeight,
    ))
        .interleavedRgb;
    final Float32List m = (await maxStore.readRegion(
      x: t.outputX,
      y: t.outputY,
      width: t.outputWidth,
      height: t.outputHeight,
    ))
        .interleavedRgb;
    for (int y = (sampleStride - t.outputY % sampleStride) % sampleStride;
        y < t.outputHeight;
        y += sampleStride) {
      for (int x = (sampleStride - t.outputX % sampleStride) % sampleStride;
          x < t.outputWidth;
          x += sampleStride) {
        final int b = (y * t.outputWidth + x) * 3;
        final double la = (a[b] + a[b + 1] + a[b + 2]) / 3;
        final double lm = (m[b] + m[b + 1] + m[b + 2]) / 3;
        levels.add(la);
        excess.add(lm - la);
      }
    }
  }
  final List<StarTrailExcessBin> bins =
      starTrailExcessStatistics(levels, excess);
  log?.call(
    'starTrail meanBackground samples=${levels.length} bins=${bins.length} '
    'medianExcess=${bins.map((StarTrailExcessBin b) => b.median.toStringAsExponential(2)).join(",")}',
  );
  final LinearRgbTileStore out = await outputStoreFactory(
    width: maxStore.width,
    height: maxStore.height,
    plan: plan,
  );
  bool committed = false;
  try {
    for (final OverlappedTile t in plan.tiles) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Star-trail mean/max combination was cancelled.');
      }
      final Float32List a = (await meanStore.readRegion(
        x: t.outputX,
        y: t.outputY,
        width: t.outputWidth,
        height: t.outputHeight,
      ))
          .interleavedRgb;
      final Float32List m = (await maxStore.readRegion(
        x: t.outputX,
        y: t.outputY,
        width: t.outputWidth,
        height: t.outputHeight,
      ))
          .interleavedRgb;
      await out.writeTile(LinearRgbTile(
        x: t.outputX,
        y: t.outputY,
        width: t.outputWidth,
        height: t.outputHeight,
        interleavedRgb: combineStarTrailMeanAndMaxRegion(a, m, bins),
      ));
    }
    await out.commit();
    committed = true;
    return out;
  } finally {
    if (!committed) await out.abort();
  }
}
