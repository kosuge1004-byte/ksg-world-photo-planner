import 'dart:io';
import 'dart:typed_data';

final class FocusWinnerRegion {
  const FocusWinnerRegion({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required this.frameIndices,
    required this.confidence,
  });

  final int x;
  final int y;
  final int width;
  final int height;
  final Int32List frameIndices;
  final Float32List confidence;
}

/// File-backed focus winner/confidence planes.
///
/// Labels remain Int32 and confidence remains Float32, exactly matching the
/// existing in-memory FocusWinnerMap representation. The difference is only
/// residency: callers read bounded regions instead of retaining 8 bytes/pixel
/// for the entire image in Dart heap.
final class FileBackedFocusWinnerMap {
  FileBackedFocusWinnerMap._({
    required this.width,
    required this.height,
    required this.directory,
    required this.labelsFile,
    required this.confidenceFile,
    required this.prefix,
    required bool ownsDirectory,
  }) : _ownsDirectory = ownsDirectory;

  final int width;
  final int height;
  final Directory directory;
  final File labelsFile;
  final File confidenceFile;

  /// The file-name stem shared by [labelsFile] (`$prefix.i32`) and
  /// [confidenceFile] (`$prefix.f32`). Exposed so a durable checkpoint (see
  /// `FocusStackStageCheckpointStore`) can record enough to reopen this exact
  /// pair with [openExisting] on a later run, without the checkpoint module
  /// needing to know this class's internal file-naming scheme.
  final String prefix;
  final bool _ownsDirectory;
  bool _disposed = false;

  static Future<FileBackedFocusWinnerMap> createTemporary({
    required int width,
    required int height,
    Directory? directory,
    String prefix = 'focus-winners',
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Winner-map dimensions must be positive.');
    }
    final bool owns = directory == null;
    final Directory dir = directory ??
        await Directory.systemTemp.createTemp('mobile-stack-focus-winners-');
    if (!await dir.exists()) await dir.create(recursive: true);
    final File labels = File(
      '${dir.path}${Platform.pathSeparator}$prefix.i32',
    );
    final File confidence = File(
      '${dir.path}${Platform.pathSeparator}$prefix.f32',
    );
    return FileBackedFocusWinnerMap._(
      width: width,
      height: height,
      directory: dir,
      labelsFile: labels,
      confidenceFile: confidence,
      prefix: prefix,
      ownsDirectory: owns,
    );
  }

  /// Reopens a previously completed `$prefix.i32`/`$prefix.f32` pair inside
  /// [directory] without creating, truncating, or deleting anything.
  ///
  /// This is strictly a read-only view onto files some earlier run already
  /// finished writing (via [writeAllFromChunks]) and a caller has decided,
  /// from its own durable manifest, are still trustworthy for [width] and
  /// [height]. It re-validates the two file lengths itself rather than
  /// trusting the caller's manifest values blindly, and never resizes or
  /// repairs a mismatch: a wrong-length file is refused, not fixed up, since
  /// silently reinterpreting misaligned bytes as winner labels/confidence
  /// would be worse than forcing the caller to recompute.
  static Future<FileBackedFocusWinnerMap> openExisting({
    required Directory directory,
    required int width,
    required int height,
    required String prefix,
    int? expectedLabelBytes,
    int? expectedConfidenceBytes,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Winner-map dimensions must be positive.');
    }
    final File labels = File(
      '${directory.path}${Platform.pathSeparator}$prefix.i32',
    );
    final File confidence = File(
      '${directory.path}${Platform.pathSeparator}$prefix.f32',
    );
    final int pixelCount = width * height;
    final int requiredLabelBytes =
        expectedLabelBytes ?? pixelCount * Int32List.bytesPerElement;
    final int requiredConfidenceBytes =
        expectedConfidenceBytes ?? pixelCount * Float32List.bytesPerElement;
    if (requiredLabelBytes != pixelCount * Int32List.bytesPerElement ||
        requiredConfidenceBytes != pixelCount * Float32List.bytesPerElement) {
      throw StateError(
        'Winner-map checkpoint byte length does not match width*height.',
      );
    }
    if (!await labels.exists() || !await confidence.exists()) {
      throw StateError('Winner-map checkpoint files are missing.');
    }
    if (await labels.length() != requiredLabelBytes ||
        await confidence.length() != requiredConfidenceBytes) {
      throw StateError('Winner-map checkpoint files have the wrong length.');
    }
    return FileBackedFocusWinnerMap._(
      width: width,
      height: height,
      directory: directory,
      labelsFile: labels,
      confidenceFile: confidence,
      prefix: prefix,
      // Never owns the directory: it belongs to whatever durable checkpoint
      // or measure directory the caller is managing, exactly like the
      // `directory:` (non-owning) path of createTemporary above.
      ownsDirectory: false,
    );
  }

  int get pixelCount => width * height;

  Future<void> writeAllFromChunks({
    required Future<void> Function(
      RandomAccessFile labelsWriter,
      RandomAccessFile confidenceWriter,
    ) producer,
  }) async {
    _ensureOpen();
    RandomAccessFile? lw;
    RandomAccessFile? cw;
    bool completed = false;
    try {
      lw = await labelsFile.open(mode: FileMode.write);
      cw = await confidenceFile.open(mode: FileMode.write);
      await producer(lw, cw);
      await lw.flush();
      await cw.flush();
      await lw.close();
      lw = null;
      await cw.close();
      cw = null;
      final int expectedLabels = pixelCount * Int32List.bytesPerElement;
      final int expectedConfidence = pixelCount * Float32List.bytesPerElement;
      if (await labelsFile.length() != expectedLabels ||
          await confidenceFile.length() != expectedConfidence) {
        throw StateError('Winner-map output file length mismatch.');
      }
      completed = true;
    } finally {
      await lw?.close();
      await cw?.close();
      if (!completed) {
        if (await labelsFile.exists()) await labelsFile.delete();
        if (await confidenceFile.exists()) await confidenceFile.delete();
      }
    }
  }

  Future<FocusWinnerRegion> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    _ensureOpen();
    if (x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > this.width ||
        y + height > this.height) {
      throw RangeError('Winner-map region is outside the image.');
    }
    final Int32List labels = Int32List(width * height);
    final Float32List confidence = Float32List(width * height);
    final RandomAccessFile lr = await labelsFile.open(mode: FileMode.read);
    final RandomAccessFile cr = await confidenceFile.open(mode: FileMode.read);
    try {
      for (int row = 0; row < height; row++) {
        final int sourcePixel = (y + row) * this.width + x;
        final int destinationPixel = row * width;
        await lr.setPosition(sourcePixel * Int32List.bytesPerElement);
        await cr.setPosition(sourcePixel * Float32List.bytesPerElement);
        await _readExact(
          lr,
          labels.buffer.asUint8List(
            destinationPixel * Int32List.bytesPerElement,
            width * Int32List.bytesPerElement,
          ),
        );
        await _readExact(
          cr,
          confidence.buffer.asUint8List(
            destinationPixel * Float32List.bytesPerElement,
            width * Float32List.bytesPerElement,
          ),
        );
      }
    } finally {
      await lr.close();
      await cr.close();
    }
    return FocusWinnerRegion(
      x: x,
      y: y,
      width: width,
      height: height,
      frameIndices: labels,
      confidence: confidence,
    );
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    if (await labelsFile.exists()) await labelsFile.delete();
    if (await confidenceFile.exists()) await confidenceFile.delete();
    if (_ownsDirectory && await directory.exists()) {
      await directory.delete(recursive: true);
    }
  }

  void _ensureOpen() {
    if (_disposed) throw StateError('Winner-map store is disposed.');
  }
}

Future<void> _readExact(
  RandomAccessFile file,
  Uint8List destination,
) async {
  int offset = 0;
  while (offset < destination.length) {
    final int read = await file.readInto(
      destination,
      offset,
      destination.length,
    );
    if (read == 0) {
      throw StateError('Winner-map file ended inside a requested region.');
    }
    offset += read;
  }
}
