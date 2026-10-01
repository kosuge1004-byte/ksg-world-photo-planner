import 'output_image_format.dart';
import 'linear_dng_writer.dart';

/// Lightroom-oriented file-size choices. These are deliberately explicit
/// formats: only the first preset is numerically identical to the existing
/// 32-bit Float Linear DNG path.
enum LightroomStoragePreset {
  maximum(
    '最大編集耐性',
    '32bit Float DNG・約300MB/24MP',
    OutputImageFormat.linearDng,
    LinearDngCompression.none,
  ),
  lossless(
    '画質維持・容量節約',
    '可逆圧縮32bit DNG・容量は画像による',
    OutputImageFormat.linearDng,
    LinearDngCompression.deflate,
  ),
  balanced(
    '容量半分',
    '16bit TIFF・約150MB/24MP',
    OutputImageFormat.tiff16,
    LinearDngCompression.none,
  ),
  compact(
    '小容量',
    'JPEG・現像済み・数十MB',
    OutputImageFormat.jpeg,
    LinearDngCompression.none,
  );

  const LightroomStoragePreset(
    this.label,
    this.detail,
    this.outputFormat,
    this.dngCompression,
  );

  final String label;
  final String detail;
  final OutputImageFormat outputFormat;
  final LinearDngCompression dngCompression;

  bool get usesCompressionStaging =>
      outputFormat == OutputImageFormat.linearDng &&
      dngCompression == LinearDngCompression.deflate;
}
