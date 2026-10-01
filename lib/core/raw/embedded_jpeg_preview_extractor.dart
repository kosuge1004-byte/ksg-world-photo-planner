import 'dart:io';
import 'dart:typed_data';

import 'raw_format.dart';
import 'raw_probe_result.dart';

class RawEmbeddedPreview {
  RawEmbeddedPreview({
    required Uint8List bytes,
    required this.sourceOffset,
  }) : bytes = Uint8List.fromList(bytes);

  final Uint8List bytes;
  final int sourceOffset;
  String get mimeType => 'image/jpeg';
}

abstract interface class RawPreviewExtractor {
  Future<RawEmbeddedPreview?> extract(RawProbeResult probe);
}

/// TIFF系RAWのIFDを走査して埋め込みJPEGを取り出す軽量抽出器。
///
/// ピクセルRAWを展開せず、JPEGInterchangeFormat/Length またはJPEG圧縮の
/// 単一Stripを読み出す。全オフセットとサイズを元ファイル長に対して検証し、
/// IFD数・エントリー数・プレビュー容量に上限を設ける。
class TiffEmbeddedJpegPreviewExtractor implements RawPreviewExtractor {
  const TiffEmbeddedJpegPreviewExtractor({
    this.maximumPreviewBytes = 8 * 1024 * 1024,
    this.maximumIfdCount = 16,
    this.maximumEntriesPerIfd = 4096,
  })  : assert(maximumPreviewBytes > 0),
        assert(maximumIfdCount > 0),
        assert(maximumEntriesPerIfd > 0);

  final int maximumPreviewBytes;
  final int maximumIfdCount;
  final int maximumEntriesPerIfd;

  @override
  Future<RawEmbeddedPreview?> extract(RawProbeResult probe) async {
    if (!probe.isAccepted || !_supports(probe.format)) return null;

    final File file = File(probe.path);
    RandomAccessFile? handle;
    try {
      handle = await file.open();
      final int fileLength = await handle.length();
      if (fileLength < 16) return null;

      final Uint8List header = await _readAt(handle, 0, 16);
      final Endian? endian = _readEndian(header);
      if (endian == null) return null;

      final int firstIfdOffset = _uint32(header, 4, endian);
      final List<int> pendingIfds = <int>[firstIfdOffset];
      final Set<int> visitedIfds = <int>{};
      final List<_PreviewCandidate> candidates = <_PreviewCandidate>[];

      while (pendingIfds.isNotEmpty && visitedIfds.length < maximumIfdCount) {
        final int ifdOffset = pendingIfds.removeAt(0);
        if (ifdOffset <= 0 || !visitedIfds.add(ifdOffset)) continue;
        if (!_rangeFits(ifdOffset, 2, fileLength)) continue;

        final Uint8List countBytes = await _readAt(handle, ifdOffset, 2);
        final int entryCount = _uint16(countBytes, 0, endian);
        if (entryCount < 1 || entryCount > maximumEntriesPerIfd) continue;

        final int directoryBytes = 2 + entryCount * 12 + 4;
        if (!_rangeFits(ifdOffset, directoryBytes, fileLength)) continue;
        final Uint8List directory =
            await _readAt(handle, ifdOffset, directoryBytes);

        int? jpegOffset;
        int? jpegLength;
        int? compression;
        int? stripOffset;
        int? stripLength;

        for (int index = 0; index < entryCount; index++) {
          final int entryOffset = 2 + index * 12;
          final int tag = _uint16(directory, entryOffset, endian);
          final int type = _uint16(directory, entryOffset + 2, endian);
          final int count = _uint32(directory, entryOffset + 4, endian);
          final int value = _uint32(directory, entryOffset + 8, endian);
          final int? scalar = _scalarValue(
            directory,
            entryOffset + 8,
            type,
            count,
            endian,
          );

          switch (tag) {
            case 0x0103:
              compression = scalar;
              break;
            case 0x0111:
              stripOffset = scalar;
              break;
            case 0x0117:
              stripLength = scalar;
              break;
            case 0x014A:
              await _appendOffsetValues(
                handle,
                pendingIfds,
                fileLength,
                type,
                count,
                value,
                scalar,
                endian,
              );
              break;
            case 0x0201:
              jpegOffset = scalar;
              break;
            case 0x0202:
              jpegLength = scalar;
              break;
            case 0x8769:
              if (scalar != null) pendingIfds.add(scalar);
              break;
          }
        }

        _addCandidate(candidates, jpegOffset, jpegLength, fileLength);
        if (compression == 6) {
          _addCandidate(candidates, stripOffset, stripLength, fileLength);
        }

        final int nextOffsetPosition = 2 + entryCount * 12;
        final int nextIfd = _uint32(directory, nextOffsetPosition, endian);
        if (nextIfd > 0) pendingIfds.add(nextIfd);
      }

      candidates.sort(
        (_PreviewCandidate left, _PreviewCandidate right) =>
            right.length.compareTo(left.length),
      );
      for (final _PreviewCandidate candidate in candidates) {
        if (candidate.length > maximumPreviewBytes) continue;
        final Uint8List bytes =
            await _readAt(handle, candidate.offset, candidate.length);
        if (_isJpeg(bytes)) {
          return RawEmbeddedPreview(
            bytes: bytes,
            sourceOffset: candidate.offset,
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

  bool _supports(RawFormat format) => switch (format) {
        RawFormat.arw ||
        RawFormat.cr2 ||
        RawFormat.dng ||
        RawFormat.nef ||
        RawFormat.nrw ||
        RawFormat.orf ||
        RawFormat.pef ||
        RawFormat.rw2 =>
          true,
        RawFormat.cr3 || RawFormat.raf || RawFormat.unknown => false,
      };

  Endian? _readEndian(Uint8List header) {
    if (header[0] == 0x49 && header[1] == 0x49) return Endian.little;
    if (header[0] == 0x4D && header[1] == 0x4D) return Endian.big;
    return null;
  }

  int? _scalarValue(
    Uint8List bytes,
    int valueOffset,
    int type,
    int count,
    Endian endian,
  ) {
    if (count != 1) return null;
    return switch (type) {
      3 => _uint16(bytes, valueOffset, endian),
      4 => _uint32(bytes, valueOffset, endian),
      _ => null,
    };
  }

  Future<void> _appendOffsetValues(
    RandomAccessFile handle,
    List<int> target,
    int fileLength,
    int type,
    int count,
    int value,
    int? scalar,
    Endian endian,
  ) async {
    if (type != 4 || count < 1) return;
    if (count == 1) {
      if (scalar != null) target.add(scalar);
      return;
    }

    final int limitedCount = count.clamp(0, maximumIfdCount).toInt();
    final int byteCount = limitedCount * 4;
    if (!_rangeFits(value, byteCount, fileLength)) return;
    final Uint8List offsets = await _readAt(handle, value, byteCount);
    for (int index = 0; index < limitedCount; index++) {
      final int offset = _uint32(offsets, index * 4, endian);
      if (offset > 0) target.add(offset);
    }
  }

  void _addCandidate(
    List<_PreviewCandidate> candidates,
    int? offset,
    int? length,
    int fileLength,
  ) {
    if (offset == null || length == null || length < 4) return;
    if (!_rangeFits(offset, length, fileLength)) return;
    candidates.add(_PreviewCandidate(offset: offset, length: length));
  }

  bool _isJpeg(Uint8List bytes) {
    return bytes.length >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8;
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

  int _uint16(Uint8List bytes, int offset, Endian endian) {
    return ByteData.sublistView(bytes).getUint16(offset, endian);
  }

  int _uint32(Uint8List bytes, int offset, Endian endian) {
    return ByteData.sublistView(bytes).getUint32(offset, endian);
  }
}

class _PreviewCandidate {
  const _PreviewCandidate({
    required this.offset,
    required this.length,
  });

  final int offset;
  final int length;
}
