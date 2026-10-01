import 'cr3_embedded_jpeg_preview_extractor.dart';
import 'embedded_jpeg_preview_extractor.dart';
import 'raf_embedded_jpeg_preview_extractor.dart';
import 'raw_format.dart';
import 'raw_probe_result.dart';

/// 検査済みRAW形式に対応する安全なプレビュー抽出器へ振り分ける。
class FormatAwareRawPreviewExtractor implements RawPreviewExtractor {
  const FormatAwareRawPreviewExtractor({
    this.tiffExtractor = const TiffEmbeddedJpegPreviewExtractor(),
    this.cr3Extractor = const Cr3EmbeddedJpegPreviewExtractor(),
    this.rafExtractor = const RafEmbeddedJpegPreviewExtractor(),
  });

  final TiffEmbeddedJpegPreviewExtractor tiffExtractor;
  final Cr3EmbeddedJpegPreviewExtractor cr3Extractor;
  final RafEmbeddedJpegPreviewExtractor rafExtractor;

  @override
  Future<RawEmbeddedPreview?> extract(RawProbeResult probe) {
    return switch (probe.format) {
      RawFormat.cr3 => cr3Extractor.extract(probe),
      RawFormat.raf => rafExtractor.extract(probe),
      _ => tiffExtractor.extract(probe),
    };
  }
}
