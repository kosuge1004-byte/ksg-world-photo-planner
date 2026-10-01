import 'dart:typed_data';

import 'star_detector.dart' show DetectedStar, detectStars;
import 'luminance_plane.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';

/// Detects stars across the full frame held by [store], using the green
/// channel as the luminance proxy (matching every other star-detection
/// call site in this app — see `milky_way_pipeline.dart`'s
/// `_detectRegistrationStars` doc comment for why).
///
/// RGB is read in bounded row strips. Only the single-channel green plane is
/// retained, avoiding an additional full-resolution RGB allocation.
Future<List<DetectedStar>> detectStarsFromLinearRgbTileStore(
  LinearRgbTileStore store, {
  double thresholdSigma = 6,
  bool Function()? isCancelled,
}) async {
  final Float32List green = Float32List(store.width * store.height);
  const int rowsPerStrip = 128;
  for (int y = 0; y < store.height; y += rowsPerStrip) {
    if (isCancelled?.call() ?? false) {
      throw StateError('Star-trail gap-fill detection was cancelled.');
    }
    final int rowCount = (store.height - y).clamp(0, rowsPerStrip);
    final LinearRgbTile strip = await store.readRegion(
      x: 0,
      y: y,
      width: store.width,
      height: rowCount,
    );
    for (int local = 0; local < strip.width * strip.height; local++) {
      green[y * store.width + local] = strip.interleavedRgb[local * 3 + 1];
    }
  }
  return detectStars(
    LuminancePlane(width: store.width, height: store.height, samples: green),
    thresholdSigma: thresholdSigma,
  );
}
