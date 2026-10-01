import 'dart:io';
import 'dart:typed_data';

import 'embedded_jpeg_preview_extractor.dart';
import 'raw_format.dart';
import 'raw_probe_result.dart';

/// Canon CR3内のPRVW/THMBボックスから埋め込みJPEGを取り出す。
///
/// CR3はISO Base Media File Formatを基礎にしたコンテナで、Canon固有の
/// PRVW/THMBボックスにプレビューJPEGを格納する。RAW画像データは展開せず、
/// ボックスの宣言サイズ・JPEGオフセット・JPEG長をすべて検証して読み出す。
class Cr3EmbeddedJpegPreviewExtractor implements RawPreviewExtractor {
  const Cr3EmbeddedJpegPreviewExtractor({
    this.maximumPreviewBytes = 8 * 1024 * 1024,
    this.maximumScanBytes = 64 * 1024 * 1024,
    this.scanChunkBytes = 64 * 1024,
    this.maximumCandidateCount = 32,
  })  : assert(maximumPreviewBytes > 0),
        assert(maximumScanBytes > 0),
        assert(scanChunkBytes >= 32),
        assert(maximumCandidateCount > 0);

  final int maximumPreviewBytes;
  final int maximumScanBytes;
  final int scanChunkBytes;
  final int maximumCandidateCount;

  static const List<int> _prvwTag = <int>[0x50, 0x52, 0x56, 0x57];
  static const List<int> _thmbTag = <int>[0x54, 0x48, 0x4D, 0x42];

  @override
  Future<RawEmbeddedPreview?> extract(RawProbeResult probe) async {
    if (!probe.isAccepted || probe.format != RawFormat.cr3) return null;

    RandomAccessFile? handle;
    try {
      handle = await File(probe.path).open();
      final int fileLength = await handle.length();
      if (fileLength < 24) return null;

      final List<_Cr3PreviewCandidate> candidates =
          await _findCandidates(handle, fileLength);
      candidates.sort(
        (_Cr3PreviewCandidate left, _Cr3PreviewCandidate right) =>
            right.jpegLength.compareTo(left.jpegLength),
      );

      for (final _Cr3PreviewCandidate candidate in candidates) {
        final Uint8List bytes = await _readAt(
          handle,
          candidate.jpegOffset,
          candidate.jpegLength,
        );
        if (_isJpeg(bytes)) {
          return RawEmbeddedPreview(
            bytes: bytes,
            sourceOffset: candidate.jpegOffset,
          );
        }
      }
      return null;
    } on FileSystemException {
      return null;
    } on RangeError {
      return null;
    } finally {
      await handle?.close();
    }
  }

  Future<List<_Cr3PreviewCandidate>> _findCandidates(
    RandomAccessFile handle,
    int fileLength,
  ) async {
    final List<_Cr3PreviewCandidate> candidates = <_Cr3PreviewCandidate>[];
    final Set<int> visitedBoxOffsets = <int>{};
    final int scanLength =
        fileLength < maximumScanBytes ? fileLength : maximumScanBytes;

    int offset = 0;
    Uint8List overlap = Uint8List(0);
    while (offset < scanLength &&
        visitedBoxOffsets.length < maximumCandidateCount) {
      final int remaining = scanLength - offset;
      final int readLength =
          remaining < scanChunkBytes ? remaining : scanChunkBytes;
      final Uint8List chunk = await _readAt(handle, offset, readLength);
      final Uint8List window = Uint8List(overlap.length + chunk.length)
        ..setRange(0, overlap.length, overlap)
        ..setRange(overlap.length, overlap.length + chunk.length, chunk);
      final int windowOffset = offset - overlap.length;

      for (int index = 0;
          index <= window.length - 4 &&
              visitedBoxOffsets.length < maximumCandidateCount;
          index++) {
        if (!_matchesTag(window, index)) continue;
        final int tagOffset = windowOffset + index;
        final int boxOffset = tagOffset - 4;
        if (boxOffset < 0 || !visitedBoxOffsets.add(boxOffset)) continue;

        final _Cr3PreviewCandidate? candidate =
            await _readCandidate(handle, boxOffset, fileLength);
        if (candidate != null) candidates.add(candidate);
      }

      final int overlapLength = window.length < 7 ? window.length : 7;
      overlap = Uint8List.fromList(
        window.sublist(window.length - overlapLength),
      );
      offset += readLength;
    }
    return candidates;
  }

  Future<_Cr3PreviewCandidate?> _readCandidate(
    RandomAccessFile handle,
    int boxOffset,
    int fileLength,
  ) async {
    const int requiredHeaderBytes = 24;
    if (!_rangeFits(boxOffset, requiredHeaderBytes, fileLength)) return null;

    final Uint8List header =
        await _readAt(handle, boxOffset, requiredHeaderBytes);
    final bool isPrvw = _equalsAt(header, 4, _prvwTag);
    final bool isThmb = _equalsAt(header, 4, _thmbTag);
    if (!isPrvw && !isThmb) return null;

    final ByteData data = ByteData.sublistView(header);
    final int boxLength = data.getUint32(0, Endian.big);
    if (boxLength < requiredHeaderBytes ||
        !_rangeFits(boxOffset, boxLength, fileLength)) {
      return null;
    }

    final int widthOffset = isPrvw ? 14 : 12;
    final int heightOffset = isPrvw ? 16 : 14;
    final int jpegLengthOffset = isPrvw ? 20 : 16;
    final int width = data.getUint16(widthOffset, Endian.big);
    final int height = data.getUint16(heightOffset, Endian.big);
    final int jpegLength = data.getUint32(jpegLengthOffset, Endian.big);
    const int jpegDataOffset = 24;

    if (width == 0 ||
        height == 0 ||
        jpegLength < 4 ||
        jpegLength > maximumPreviewBytes ||
        jpegDataOffset + jpegLength > boxLength) {
      return null;
    }

    final int jpegOffset = boxOffset + jpegDataOffset;
    if (!_rangeFits(jpegOffset, jpegLength, fileLength)) return null;
    final Uint8List magic = await _readAt(handle, jpegOffset, 3);
    if (!_isJpeg(magic)) return null;

    return _Cr3PreviewCandidate(
      jpegOffset: jpegOffset,
      jpegLength: jpegLength,
    );
  }

  bool _matchesTag(Uint8List bytes, int offset) {
    return _equalsAt(bytes, offset, _prvwTag) ||
        _equalsAt(bytes, offset, _thmbTag);
  }

  bool _equalsAt(Uint8List bytes, int offset, List<int> expected) {
    if (offset < 0 || offset + expected.length > bytes.length) return false;
    for (int index = 0; index < expected.length; index++) {
      if (bytes[offset + index] != expected[index]) return false;
    }
    return true;
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

class _Cr3PreviewCandidate {
  const _Cr3PreviewCandidate({
    required this.jpegOffset,
    required this.jpegLength,
  });

  final int jpegOffset;
  final int jpegLength;
}
