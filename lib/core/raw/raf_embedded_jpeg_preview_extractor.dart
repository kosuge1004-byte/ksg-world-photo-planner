import 'dart:io';
import 'dart:typed_data';

import 'embedded_jpeg_preview_extractor.dart';
import 'raw_format.dart';
import 'raw_probe_result.dart';

/// Fujifilm RAFヘッダーが指す埋め込みJPEGプレビューを取り出す。
class RafEmbeddedJpegPreviewExtractor implements RawPreviewExtractor {
  const RafEmbeddedJpegPreviewExtractor({
    this.maximumPreviewBytes = 8 * 1024 * 1024,
  }) : assert(maximumPreviewBytes > 0);

  final int maximumPreviewBytes;

  static const int _previewOffsetField = 84;
  static const int _previewLengthField = 88;
  static const int _requiredHeaderBytes = 92;

  @override
  Future<RawEmbeddedPreview?> extract(RawProbeResult probe) async {
    if (!probe.isAccepted || probe.format != RawFormat.raf) return null;

    RandomAccessFile? handle;
    try {
      handle = await File(probe.path).open();
      final int fileLength = await handle.length();
      if (fileLength < _requiredHeaderBytes) return null;

      final Uint8List header = await _readAt(handle, 0, _requiredHeaderBytes);
      final ByteData data = ByteData.sublistView(header);
      final int previewOffset = data.getUint32(_previewOffsetField, Endian.big);
      final int previewLength = data.getUint32(_previewLengthField, Endian.big);
      if (previewLength < 4 ||
          previewLength > maximumPreviewBytes ||
          !_rangeFits(previewOffset, previewLength, fileLength)) {
        return null;
      }

      final Uint8List bytes =
          await _readAt(handle, previewOffset, previewLength);
      if (!_isJpeg(bytes)) return null;
      return RawEmbeddedPreview(
        bytes: bytes,
        sourceOffset: previewOffset,
      );
    } on FileSystemException {
      return null;
    } on RangeError {
      return null;
    } finally {
      await handle?.close();
    }
  }

  bool _isJpeg(Uint8List bytes) {
    return bytes.length >= 3 &&
        bytes[0] == 0xFF &&
        bytes[1] == 0xD8 &&
        bytes[2] == 0xFF;
  }

  bool _rangeFits(int offset, int length, int totalLength) {
    if (offset < 0 || length < 0 || offset > totalLength) return false;
    return length <= totalLength - offset;
  }

  Future<Uint8List> _readAt(
    RandomAccessFile handle,
    int offset,
    int length,
  ) async {
    await handle.setPosition(offset);
    final Uint8List bytes = await handle.read(length);
    if (bytes.length != length) {
      throw FileSystemException('ファイルを最後まで読み込めません。');
    }
    return bytes;
  }
}
