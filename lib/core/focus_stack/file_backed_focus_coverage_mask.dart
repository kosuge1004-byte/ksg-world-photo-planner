import 'dart:io';
import 'dart:typed_data';

import '../export/linear_dng_writer.dart';

/// File-backed final focus-stack validity mask.
///
/// Storage format is already DNG TransparencyMask semantics:
///   0   = invalid
///   255 = valid
///
/// This avoids retaining a width*height Uint8List in the focus-stack result.
final class FileBackedFocusCoverageMask
    implements LinearDngTransparencyMaskSource {
  FileBackedFocusCoverageMask._({
    required this.width,
    required this.height,
    required this.directory,
    required this.file,
  });

  @override
  final int width;

  @override
  final int height;

  final Directory directory;
  final File file;

  RandomAccessFile? _writer;
  bool _committed = false;
  bool _disposed = false;
  bool _ownsDirectory = true;

  static Future<FileBackedFocusCoverageMask> createTemporary({
    required int width,
    required int height,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Coverage dimensions must be positive.');
    }
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-focus-coverage-');
    final File file = File(
      '${directory.path}${Platform.pathSeparator}coverage.u8',
    );
    return _openForWriting(
        directory: directory,
        file: file,
        width: width,
        height: height,
        truncate: true);
  }

  /// Creates a coverage mask file at an explicit, caller-chosen [path]
  /// instead of a fresh `Directory.systemTemp` subdirectory. This exists so
  /// a durable checkpoint (see `FocusBlendTileCheckpointStore`) can give the
  /// mask a stable location it can reopen with [openForResume] after a
  /// process death, the same way `FileBackedLinearRgbTileStore.create` lets
  /// its caller choose a durable path instead of always using
  /// `createTemporary`.
  static Future<FileBackedFocusCoverageMask> create({
    required String path,
    required int width,
    required int height,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Coverage dimensions must be positive.');
    }
    return _openForWriting(
      directory: null,
      file: File(path),
      width: width,
      height: height,
      truncate: true,
    );
  }

  /// Reopens an existing, not-yet-committed coverage file for further
  /// `writeRegion` calls, picking up wherever a previous process instance
  /// left off.
  ///
  /// Like `FileBackedLinearRgbTileStore.openForResume`, this does not and
  /// cannot verify that the bytes already on disk are correct — that
  /// guarantee comes entirely from the caller (`FocusBlendTileCheckpointStore`)
  /// only ever trusting regions it durably recorded as written.
  static Future<FileBackedFocusCoverageMask> openForResume({
    required String path,
    required int width,
    required int height,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Coverage dimensions must be positive.');
    }
    final File file = File(path);
    if (!await file.exists()) {
      throw StateError('Coverage mask file is missing: $path');
    }
    if (await file.length() != width * height) {
      throw StateError('Coverage mask file has the wrong length.');
    }
    return _openForWriting(
      directory: null,
      file: file,
      width: width,
      height: height,
      truncate: false,
    );
  }

  static Future<FileBackedFocusCoverageMask> _openForWriting({
    required Directory? directory,
    required File file,
    required int width,
    required int height,
    required bool truncate,
  }) async {
    final RandomAccessFile writer =
        await file.open(mode: truncate ? FileMode.write : FileMode.append);
    if (truncate) {
      await writer.truncate(width * height);
    }
    final FileBackedFocusCoverageMask result = FileBackedFocusCoverageMask._(
      width: width,
      height: height,
      // A null `directory` means "does not own a directory to clean up on
      // dispose" (durable/checkpoint-managed paths, matching
      // FileBackedLinearRgbTileStore's `_ownedDirectory == null` case) — an
      // empty placeholder Directory is never touched by dispose() below in
      // that case.
      directory: directory ?? file.parent,
      file: file,
    );
    result._writer = writer;
    result._ownsDirectory = directory != null;
    return result;
  }

  Future<void> writeRegion({
    required int x,
    required int y,
    required int width,
    required int height,
    required Uint8List binaryCoverage,
  }) async {
    _ensureWritable();
    if (x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > this.width ||
        y + height > this.height) {
      throw RangeError('Coverage region is outside the image.');
    }
    if (binaryCoverage.length != width * height) {
      throw ArgumentError('Coverage region length mismatch.');
    }
    final RandomAccessFile writer = _writer!;
    final Uint8List encodedRow = Uint8List(width);
    for (int row = 0; row < height; row++) {
      final int sourceStart = row * width;
      for (int xLocal = 0; xLocal < width; xLocal++) {
        final int value = binaryCoverage[sourceStart + xLocal];
        if (value != 0 && value != 1) {
          throw ArgumentError('Coverage must contain only 0 or 1.');
        }
        encodedRow[xLocal] = value == 0 ? 0 : 255;
      }
      await writer.setPosition((y + row) * this.width + x);
      await writer.writeFrom(encodedRow);
    }
  }

  Future<void> commit() async {
    _ensureWritable();
    final RandomAccessFile writer = _writer!;
    await writer.flush();
    await writer.close();
    _writer = null;
    if (await file.length() != width * height) {
      throw StateError('Coverage file length mismatch.');
    }
    _committed = true;
  }

  @override
  Future<Uint8List> readRows({
    required int startY,
    required int rowCount,
  }) async {
    _ensureReadable();
    if (startY < 0 || rowCount <= 0 || startY + rowCount > height) {
      throw RangeError('Coverage row read is outside the image.');
    }
    final Uint8List output = Uint8List(width * rowCount);
    final RandomAccessFile reader = await file.open(mode: FileMode.read);
    try {
      await reader.setPosition(startY * width);
      int offset = 0;
      while (offset < output.length) {
        final int read = await reader.readInto(
          output,
          offset,
          output.length,
        );
        if (read == 0) {
          throw StateError('Coverage file ended inside a row read.');
        }
        offset += read;
      }
    } finally {
      await reader.close();
    }
    return output;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    final RandomAccessFile? writer = _writer;
    _writer = null;
    await writer?.close();
    if (_ownsDirectory && await directory.exists()) {
      await directory.delete(recursive: true);
    } else if (!_ownsDirectory && await file.exists()) {
      // A checkpoint-managed (durable-path) mask does not own a whole
      // directory to recursively delete — only its own file, matching
      // FileBackedLinearRgbTileStore.dispose()'s non-owning path.
      await file.delete();
    }
  }

  /// Closes the file handle without deleting anything, so a durable
  /// checkpoint's bytes on disk survive this process instance ending.
  /// Mirrors `FileBackedLinearRgbTileStore.closeRetainingFile`.
  Future<void> flushCheckpoint() async {
    if (_writer == null) throw StateError('Coverage writer is closed');
    await _writer!.flush();
  }

  Future<void> closeRetainingFile() async {
    if (_disposed) return;
    _disposed = true;
    final RandomAccessFile? writer = _writer;
    _writer = null;
    await writer?.close();
  }

  void _ensureWritable() {
    if (_disposed) throw StateError('Coverage store is disposed.');
    if (_committed) throw StateError('Coverage store is already committed.');
    if (_writer == null) throw StateError('Coverage writer is unavailable.');
  }

  void _ensureReadable() {
    if (_disposed) throw StateError('Coverage store is disposed.');
    if (!_committed) throw StateError('Coverage store is not committed.');
  }
}
