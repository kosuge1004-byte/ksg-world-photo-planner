import 'dart:math' as math;
import 'dart:typed_data';

import '../registration/luminance_plane.dart';

final class FocusExactPreview {
  FocusExactPreview({
    required this.width,
    required this.height,
    required Uint8List luminance8,
  }) : luminance8 = Uint8List.fromList(luminance8) {
    if (width <= 0 || height <= 0 || this.luminance8.length != width * height) {
      throw ArgumentError('Exact focus preview dimensions are inconsistent.');
    }
  }

  final int width;
  final int height;
  final Uint8List luminance8;
}

/// Creates a review preview in exactly the same coordinate system as the
/// aligned focus analysis. This avoids relying on embedded-JPEG EXIF/orientation
/// behavior for precision-critical mask display.
///
/// The preview is display-only. It never feeds focus measurement or blending.
FocusExactPreview buildExactFocusPreview(
  LuminancePlane source, {
  int maximumDimension = 1024,
}) {
  if (maximumDimension < 64 || maximumDimension > 4096) {
    throw ArgumentError.value(maximumDimension, 'maximumDimension');
  }

  final double scale = math.min(
    1,
    maximumDimension / math.max(source.width, source.height),
  );
  final int outWidth = math.max(1, (source.width * scale).round());
  final int outHeight = math.max(1, (source.height * scale).round());

  final Float64List reduced = Float64List(outWidth * outHeight);
  final List<double> finiteSamples = <double>[];

  for (int oy = 0; oy < outHeight; oy++) {
    final int y0 = (oy * source.height / outHeight).floor();
    final int y1 = math
        .max(
          y0 + 1,
          ((oy + 1) * source.height / outHeight).ceil(),
        )
        .clamp(1, source.height);
    for (int ox = 0; ox < outWidth; ox++) {
      final int x0 = (ox * source.width / outWidth).floor();
      final int x1 = math
          .max(
            x0 + 1,
            ((ox + 1) * source.width / outWidth).ceil(),
          )
          .clamp(1, source.width);

      double sum = 0;
      int count = 0;
      for (int y = y0; y < y1; y++) {
        for (int x = x0; x < x1; x++) {
          final double value = source.samples[y * source.width + x];
          if (!value.isFinite) continue;
          sum += value;
          count++;
        }
      }
      final double value = count == 0 ? 0 : sum / count;
      reduced[oy * outWidth + ox] = value;
      if (value.isFinite) finiteSamples.add(value);
    }
  }

  if (finiteSamples.isEmpty) {
    return FocusExactPreview(
      width: outWidth,
      height: outHeight,
      luminance8: Uint8List(outWidth * outHeight),
    );
  }
  finiteSamples.sort();
  final double black = _percentile(finiteSamples, 0.01);
  final double white = _percentile(finiteSamples, 0.995);
  final double span = white > black ? white - black : 1;

  final Uint8List output = Uint8List(outWidth * outHeight);
  for (int index = 0; index < reduced.length; index++) {
    final double normalized =
        ((reduced[index] - black) / span).clamp(0, 1).toDouble();
    // Display-only sqrt lift. This is not used for focus analysis.
    output[index] = (math.sqrt(normalized) * 255).round().clamp(0, 255);
  }
  return FocusExactPreview(
    width: outWidth,
    height: outHeight,
    luminance8: output,
  );
}

double _percentile(List<double> sorted, double fraction) {
  if (sorted.isEmpty) return 0;
  final double position = fraction * (sorted.length - 1);
  final int lower = position.floor();
  final int upper = position.ceil();
  if (lower == upper) return sorted[lower];
  final double t = position - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
}
