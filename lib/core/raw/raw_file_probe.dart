import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import 'raw_format.dart';
import 'raw_probe_result.dart';

class RawFileProbe {
  const RawFileProbe();

  Future<RawProbeResult> probe(String path) async {
    final File file = File(path);
    final RawFormat extensionFormat = _fromExtension(p.extension(path));
    if (!await file.exists()) {
      return RawProbeResult(
        path: path,
        format: extensionFormat,
        byteLength: 0,
        isReadable: false,
        signatureMatched: false,
        warning: 'ファイルが存在しません。',
      );
    }

    try {
      final int length = await file.length();
      if (length < 16) {
        return RawProbeResult(
          path: path,
          format: extensionFormat,
          byteLength: length,
          isReadable: false,
          signatureMatched: false,
          warning: 'RAWとして短すぎるファイルです。',
        );
      }
      final RandomAccessFile handle = await file.open();
      late final Uint8List header;
      try {
        header = await handle.read(512);
      } finally {
        await handle.close();
      }

      final bool signatureMatched =
          _matchesKnownContainer(header, extensionFormat);
      final String? warning = switch ((extensionFormat, signatureMatched)) {
        (RawFormat.unknown, _) => 'このRAW形式は現在のデコーダー対象外です。',
        (_, false) => '拡張子とファイルヘッダーが一致しません。',
        _ => null,
      };
      return RawProbeResult(
        path: path,
        format: extensionFormat,
        byteLength: length,
        isReadable: true,
        signatureMatched: signatureMatched,
        warning: warning,
      );
    } on FileSystemException catch (error) {
      return RawProbeResult(
        path: path,
        format: extensionFormat,
        byteLength: 0,
        isReadable: false,
        signatureMatched: false,
        warning: error.message,
      );
    }
  }

  RawFormat _fromExtension(String extension) {
    return switch (extension.toLowerCase()) {
      '.arw' => RawFormat.arw,
      '.cr2' => RawFormat.cr2,
      '.cr3' => RawFormat.cr3,
      '.nef' => RawFormat.nef,
      '.nrw' => RawFormat.nrw,
      '.raf' => RawFormat.raf,
      '.rw2' => RawFormat.rw2,
      '.dng' => RawFormat.dng,
      '.orf' => RawFormat.orf,
      '.pef' => RawFormat.pef,
      _ => RawFormat.unknown,
    };
  }

  bool _matchesKnownContainer(Uint8List header, RawFormat format) {
    final bool littleEndianTiff = _startsWith(
      header,
      const <int>[0x49, 0x49, 0x2A, 0x00],
    );
    final bool bigEndianTiff = _startsWith(
      header,
      const <int>[0x4D, 0x4D, 0x00, 0x2A],
    );
    final bool tiff = littleEndianTiff || bigEndianTiff;
    final bool cr2 = littleEndianTiff &&
        _matchesAt(header, 8, const <int>[0x43, 0x52, 0x02, 0x00]);
    final bool cr3 = _matchesAt(
      header,
      4,
      const <int>[
        0x66,
        0x74,
        0x79,
        0x70,
        0x63,
        0x72,
        0x78,
        0x20,
      ],
    );
    final bool raf = header.length >= 16 &&
        String.fromCharCodes(header.take(16)) == 'FUJIFILMCCD-RAW ';
    final bool orf = _startsWith(
          header,
          const <int>[0x49, 0x49, 0x52, 0x4F],
        ) ||
        _startsWith(
          header,
          const <int>[0x4D, 0x4D, 0x4F, 0x52],
        );
    final bool rw2 = _startsWith(
      header,
      const <int>[0x49, 0x49, 0x55, 0x00],
    );

    return switch (format) {
      RawFormat.cr3 => cr3,
      RawFormat.raf => raf,
      RawFormat.cr2 => cr2,
      RawFormat.orf => orf,
      RawFormat.rw2 => rw2,
      RawFormat.arw ||
      RawFormat.nef ||
      RawFormat.nrw ||
      RawFormat.dng ||
      RawFormat.pef =>
        tiff,
      RawFormat.unknown => false,
    };
  }

  bool _startsWith(Uint8List bytes, List<int> signature) {
    return _matchesAt(bytes, 0, signature);
  }

  bool _matchesAt(Uint8List bytes, int offset, List<int> signature) {
    if (offset < 0 || bytes.length < offset + signature.length) return false;
    for (int index = 0; index < signature.length; index++) {
      if (bytes[offset + index] != signature[index]) return false;
    }
    return true;
  }
}
