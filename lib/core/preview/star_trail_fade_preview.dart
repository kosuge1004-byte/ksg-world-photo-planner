import 'dart:isolate';
import 'dart:typed_data';

import 'package:image/image.dart' as img;

import '../stacking/star_trail_edge_fade.dart';

/// A decoded, fixed-size, byte-per-channel RGB frame used only for the
/// settings-screen fade preview below — unrelated to the app's real
/// FP32/linear-light stacking pipeline (`lighten_blend_combiner.dart`).
///
/// Deliberately tiny (see [decodeStarTrailPreviewFrames]'s
/// [previewWidth]) so recompositing on every slider tick stays fast
/// enough to feel live, and built from each source's already-extracted
/// embedded JPEG thumbnail (`RawInputFile.thumbnailBytes`) rather than
/// decoding/demosaicing the RAW itself.
final class StarTrailPreviewFrame {
  const StarTrailPreviewFrame({
    required this.width,
    required this.height,
    required this.rgb,
  });

  final int width;
  final int height;

  /// Interleaved 8-bit R,G,B samples (gamma-encoded, straight from the
  /// embedded JPEG — not linear light). Length is `width * height * 3`.
  final Uint8List rgb;
}

/// Decodes each entry of [thumbnails] (some of which may be `null` if a
/// source's embedded preview wasn't extractable) into a same-size
/// [StarTrailPreviewFrame], skipping the `null` entries. Runs off the UI
/// isolate since decoding dozens of JPEGs, even small ones, is enough
/// work to visibly jank a frame if done inline.
///
/// This is a one-time cost paid when the settings screen opens (or a
/// file selection changes); afterwards, [composeStarTrailFadePreview]
/// recombines the already-decoded frames synchronously on every slider
/// change without redoing this decode.
Future<List<StarTrailPreviewFrame>> decodeStarTrailPreviewFrames({
  required List<Uint8List?> thumbnails,
  int previewWidth = 180,
}) {
  return Isolate.run(() {
    final List<StarTrailPreviewFrame> frames = <StarTrailPreviewFrame>[];
    for (final Uint8List? bytes in thumbnails) {
      if (bytes == null) continue;
      final img.Image? decoded = img.decodeImage(bytes);
      if (decoded == null) continue;
      final img.Image resized = decoded.width > previewWidth
          ? img.copyResize(decoded, width: previewWidth)
          : decoded;
      final int width = resized.width;
      final int height = resized.height;
      final Uint8List rgb = Uint8List(width * height * 3);
      int offset = 0;
      for (final img.Pixel pixel in resized) {
        rgb[offset] = pixel.r.toInt().clamp(0, 255);
        rgb[offset + 1] = pixel.g.toInt().clamp(0, 255);
        rgb[offset + 2] = pixel.b.toInt().clamp(0, 255);
        offset += 3;
      }
      frames.add(StarTrailPreviewFrame(width: width, height: height, rgb: rgb));
    }
    return frames;
  });
}

/// Composites already-decoded [frames] (see
/// [decodeStarTrailPreviewFrames]) with [settings] applied, using the
/// same per-frame weighting shape as the real pipeline
/// (`computeStarTrailFadeWeights` — see that function's doc comment)
/// but a plain per-channel max instead of the real linear-light lighten
/// blend, since these are gamma-encoded 8-bit thumbnail samples, not
/// FP32 linear RGB.
///
/// Fast enough to call synchronously from a slider's `onChanged`: no
/// isolate hop, no re-decoding. Frames narrower/shorter than the widest
/// frame are centered; this only matters for thumbnails with slightly
/// different embedded-preview sizes across a burst, which is rare but
/// not impossible.
///
/// Returns `null` if [frames] is empty (nothing to preview yet).
({int width, int height, Uint8List rgb})? composeStarTrailFadePreview({
  required List<StarTrailPreviewFrame> frames,
  required StarTrailFadeSettings settings,
}) {
  if (frames.isEmpty) return null;
  final int width = frames.map((StarTrailPreviewFrame f) => f.width).reduce(
        (int a, int b) => a > b ? a : b,
      );
  final int height = frames.map((StarTrailPreviewFrame f) => f.height).reduce(
        (int a, int b) => a > b ? a : b,
      );

  final List<double> weights = computeStarTrailFadeWeights(
    frameCount: frames.length,
    settings: settings,
  );

  final Uint8List out = Uint8List(width * height * 3);
  for (int frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    final StarTrailPreviewFrame frame = frames[frameIndex];
    final double weight = weights[frameIndex];
    final int offsetX = (width - frame.width) ~/ 2;
    final int offsetY = (height - frame.height) ~/ 2;
    for (int y = 0; y < frame.height; y++) {
      final int outRowBase = (y + offsetY) * width + offsetX;
      final int frameRowBase = y * frame.width;
      for (int x = 0; x < frame.width; x++) {
        final int outBase = (outRowBase + x) * 3;
        final int frameBase = (frameRowBase + x) * 3;
        for (int channel = 0; channel < 3; channel++) {
          final int weighted =
              (frame.rgb[frameBase + channel] * weight).round();
          if (weighted > out[outBase + channel]) {
            out[outBase + channel] = weighted.clamp(0, 255);
          }
        }
      }
    }
  }
  return (width: width, height: height, rgb: out);
}
