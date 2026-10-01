import 'dart:io';
import 'dart:typed_data';

import 'cfa_pattern.dart';
import 'linear_raw_mosaic.dart';
import 'raw_saturation_mask.dart';

/// A file-backed, region-readable store for one frame's raw (Bayer) CFA
/// mosaic — [LinearRawMosaic]'s counterpart to `LinearRgbTileStore`/
/// `FileBackedLinearRgbTileStore` for already-demosaiced RGB data.
///
/// Built specifically to unblock the tiled, memory-bounded CFA drizzle
/// pipeline `HANDOFF_WORK84_STATUS_AT_LIMIT.md` called for and
/// `WORK85_PROGRESS.md` deliberately deferred: without this, combining N
/// raw frames in CFA space (`cfa_drizzle.dart`, Work85) requires holding
/// every frame's full raw mosaic in memory simultaneously, which does
/// not scale to a real multi-frame stacking session on a memory-
/// constrained mobile device. With this, a tiled combiner can instead
/// read only the small input region each output tile actually needs
/// from each frame (see [readRegion]), the same "read only what's
/// needed" discipline already used throughout this project's other
/// tiled combiners (`TiledAffineRgbResampler`, `TiledKappaSigmaCombiner`,
/// etc).
///
/// Unlike `FileBackedLinearRgbTileStore` (which enforces writing tiles
/// once, in a specific output-tile-plan order, since it is itself an
/// *output* store being assembled tile by tile), this is primarily a *source*
/// store. Decoded RAW frames can still be committed in one [writeFull] call.
/// Memory-bounded producers such as Work296 may instead write complete-width
/// row chunks through [writeRows] and finish with [commitRowWrites]. After
/// commit, arbitrary rectangular sub-regions can be read back in any order,
/// as many times as needed, for as many output tiles as reference the frame.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it). It has no Node.js reference
/// implementation of its own — unlike this project's numerically-
/// sensitive algorithm modules, this is pure file I/O plumbing (byte
/// offset arithmetic mirroring `FileBackedLinearRgbTileStore`'s own
/// already-covered pattern, just for one scalar channel instead of
/// interleaved RGB triples), which does not benefit from a JavaScript
/// reference the way, say, a resampling or stacking formula would.
/// `test/file_backed_linear_raw_mosaic_store_test.dart` covers this
/// directly.
final class FileBackedLinearRawMosaicStore {
  FileBackedLinearRawMosaicStore._({
    required File file,
    required RandomAccessFile randomAccessFile,
    required this.width,
    required this.height,
    required this.cfaPattern,
    Directory? ownedDirectory,
    bool ownsFiles = true,
    bool isCommitted = false,
  })  : _file = file,
        _randomAccessFile = randomAccessFile,
        _ownedDirectory = ownedDirectory,
        _ownsFiles = ownsFiles,
        _isCommitted = isCommitted;

  static const int bytesPerSample = Float32List.bytesPerElement;

  static Future<FileBackedLinearRawMosaicStore> create({
    required String path,
    required int width,
    required int height,
    required CfaPattern cfaPattern,
  }) =>
      _create(
        path: path,
        width: width,
        height: height,
        cfaPattern: cfaPattern,
      );

  static Future<FileBackedLinearRawMosaicStore> createTemporary({
    required int width,
    required int height,
    required CfaPattern cfaPattern,
  }) async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-linear-raw-mosaic-',
    );
    final String path =
        '${directory.path}${Platform.pathSeparator}linear-raw-mosaic.f32';
    try {
      return await _create(
        path: path,
        width: width,
        height: height,
        cfaPattern: cfaPattern,
        ownedDirectory: directory,
      );
    } catch (_) {
      if (await directory.exists()) await directory.delete(recursive: true);
      rethrow;
    }
  }

  static Future<FileBackedLinearRawMosaicStore> openReadOnly({
    required String path,
    required int width,
    required int height,
    required CfaPattern cfaPattern,
    required bool hasSaturationMask,
    required bool hasSaturatedPixels,
  }) async {
    final File file = File(path);
    final int expectedLength = width * height * bytesPerSample;
    if (!await file.exists() || await file.length() != expectedLength) {
      throw StateError('Raw mosaic backing file is missing or incomplete.');
    }
    final RandomAccessFile handle = await file.open(mode: FileMode.read);
    FileBackedLinearRawMosaicStore? store;
    try {
      store = FileBackedLinearRawMosaicStore._(
        file: file,
        randomAccessFile: handle,
        width: width,
        height: height,
        cfaPattern: cfaPattern,
        ownsFiles: false,
        isCommitted: true,
      );
      if (hasSaturationMask) {
        final File saturationFile = File('$path.sat');
        if (!await saturationFile.exists()) {
          throw StateError('Raw saturation backing file is missing.');
        }
        store._saturationFile = saturationFile;
        store._saturationRandomAccessFile =
            await saturationFile.open(mode: FileMode.read);
        store._hasSaturatedPixels = hasSaturatedPixels;
      }
      return store;
    } catch (_) {
      await store?._saturationRandomAccessFile?.close();
      await handle.close();
      rethrow;
    }
  }

  static Future<FileBackedLinearRawMosaicStore> _create({
    required String path,
    required int width,
    required int height,
    required CfaPattern cfaPattern,
    Directory? ownedDirectory,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Store dimensions must be positive.');
    }
    final File file = File(path);
    await file.create(exclusive: true);
    RandomAccessFile? handle;
    try {
      final RandomAccessFile opened = await file.open(mode: FileMode.write);
      handle = opened;
      await opened.truncate(width * height * bytesPerSample);
      return FileBackedLinearRawMosaicStore._(
        file: file,
        randomAccessFile: opened,
        width: width,
        height: height,
        cfaPattern: cfaPattern,
        ownedDirectory: ownedDirectory,
      );
    } catch (_) {
      if (handle != null) await handle.close();
      if (await file.exists()) await file.delete();
      rethrow;
    }
  }

  final File _file;
  final RandomAccessFile _randomAccessFile;
  final Directory? _ownedDirectory;
  final bool _ownsFiles;
  bool _isCommitted;
  bool _isDisposed = false;
  File? _saturationFile;
  RandomAccessFile? _saturationRandomAccessFile;
  bool _hasSaturatedPixels = false;

  final int width;
  final int height;
  final CfaPattern cfaPattern;

  int get persistentByteLength =>
      width * height * bytesPerSample +
      (_saturationRandomAccessFile == null ? 0 : ((width * height + 7) >> 3));
  bool get isCommitted => _isCommitted;
  bool get hasSaturationMask => _saturationRandomAccessFile != null;
  bool get hasSaturatedPixels => _hasSaturatedPixels;
  String get path => _file.path;

  /// Writes [mosaic]'s entire sample array in one call and commits the
  /// store. [mosaic]'s own `width`/`height`/`cfaPattern` must exactly
  /// match this store's — a mismatch is almost certainly a caller bug
  /// (writing the wrong frame into the wrong store), not something to
  /// silently coerce.
  ///
  /// Unlike [writeRows], this commits a complete already-materialized
  /// [LinearRawMosaic] in one operation. Callers that construct a mosaic in
  /// bounded chunks should use [writeRows] followed by [commitRowWrites].
  Future<void> writeFull(LinearRawMosaic mosaic) async {
    _ensureWritable();
    if (mosaic.width != width || mosaic.height != height) {
      throw ArgumentError(
        "mosaic dimensions (${mosaic.width}x${mosaic.height}) don't match "
        'this store ($width x $height).',
      );
    }
    if (mosaic.cfaPattern != cfaPattern) {
      throw ArgumentError(
        "mosaic CFA pattern (${mosaic.cfaPattern}) doesn't match this "
        'store ($cfaPattern).',
      );
    }
    for (final double value in mosaic.samples) {
      if (!value.isFinite) {
        throw StateError('Raw mosaic contains a non-finite sample.');
      }
    }
    final Uint8List bytes = mosaic.samples.buffer.asUint8List(
      mosaic.samples.offsetInBytes,
      mosaic.samples.lengthInBytes,
    );
    _randomAccessFile.setPositionSync(0);
    _randomAccessFile.writeFromSync(bytes);
    await _randomAccessFile.flush();

    final RawSaturationMask? saturationMask = mosaic.saturationMask;
    if (saturationMask != null) {
      final File saturationFile = File('${_file.path}.sat');
      await saturationFile.create(exclusive: true);
      final RandomAccessFile saturationHandle =
          await saturationFile.open(mode: FileMode.write);
      try {
        saturationHandle.writeFromSync(saturationMask.toPackedBytes());
        await saturationHandle.flush();
      } catch (_) {
        await saturationHandle.close();
        if (await saturationFile.exists()) await saturationFile.delete();
        rethrow;
      }
      _saturationFile = saturationFile;
      _saturationRandomAccessFile = saturationHandle;
      _hasSaturatedPixels = !saturationMask.isEmpty;
    }
    _isCommitted = true;
  }

  /// Writes a complete-width row chunk into an uncommitted store.
  /// This is intended for memory-bounded producers that construct a RAW
  /// mosaic incrementally instead of materializing one full Float32List.
  Future<void> writeRows({
    required int y,
    required int rowCount,
    required Float32List samples,
  }) async {
    _ensureWritable();
    if (y < 0 || rowCount <= 0 || y + rowCount > height) {
      throw RangeError('Requested raw mosaic row write is outside the store.');
    }
    if (samples.length != width * rowCount) {
      throw ArgumentError('Row chunk sample count does not match store width.');
    }
    for (final double value in samples) {
      if (!value.isFinite) {
        throw StateError('Raw mosaic row chunk contains a non-finite sample.');
      }
    }
    final Uint8List bytes = samples.buffer.asUint8List(
      samples.offsetInBytes,
      samples.lengthInBytes,
    );
    _randomAccessFile.setPositionSync(y * width * bytesPerSample);
    _randomAccessFile.writeFromSync(bytes);
  }

  /// Commits a store assembled through [writeRows]. [packedSaturationMask]
  /// is the full-image one-bit-per-pixel mask, or null when every pixel is
  /// valid.
  Future<void> commitRowWrites({
    Uint8List? packedSaturationMask,
    bool hasSaturatedPixels = false,
  }) async {
    _ensureWritable();
    if (packedSaturationMask != null &&
        packedSaturationMask.length != ((width * height + 7) >> 3)) {
      throw ArgumentError('Packed saturation mask has the wrong length.');
    }
    await _randomAccessFile.flush();
    if (packedSaturationMask != null) {
      final File saturationFile = File('${_file.path}.sat');
      await saturationFile.create(exclusive: true);
      final RandomAccessFile saturationHandle =
          await saturationFile.open(mode: FileMode.write);
      try {
        saturationHandle.writeFromSync(packedSaturationMask);
        await saturationHandle.flush();
      } catch (_) {
        await saturationHandle.close();
        if (await saturationFile.exists()) await saturationFile.delete();
        rethrow;
      }
      _saturationFile = saturationFile;
      _saturationRandomAccessFile = saturationHandle;
      _hasSaturatedPixels = hasSaturatedPixels;
    }
    _isCommitted = true;
  }

  /// Reads back the raw samples in the rectangle
  /// `[x, x+width) x [y, y+height)`, row-major, as a plain [Float32List]
  /// (not wrapped in a [LinearRawMosaic], since a sub-region taken in
  /// isolation no longer has a single well-defined CFA phase alignment
  /// story worth a dedicated type — the caller, which already knows this
  /// region's position within the full frame, is responsible for
  /// interpreting each sample's CFA color via [cfaPattern] at the
  /// region's own absolute coordinates).
  ///
  /// Throws [RangeError] if the requested rectangle is not entirely
  /// within `[0, width) x [0, height)` — matching
  /// `FileBackedLinearRgbTileStore.readRegion`'s identical strict-bounds
  /// convention. A caller computing a source region from an inverse
  /// transform (e.g. the tiled CFA drizzle combiner this store exists
  /// to support) is responsible for clamping to the frame's own valid
  /// extent before calling this, the same responsibility
  /// `TiledAffineRgbResampler._sourceBounds` already carries for RGB
  /// resampling.
  Future<Float32List> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    _ensureReadable();
    if (x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > this.width ||
        y + height > this.height) {
      throw RangeError(
        'Requested raw mosaic region is outside the stored image.',
      );
    }
    final Float32List samples = Float32List(width * height);
    final Uint8List bytes = samples.buffer.asUint8List(
      samples.offsetInBytes,
      samples.lengthInBytes,
    );
    final int rowByteLength = width * bytesPerSample;
    for (int row = 0; row < height; row++) {
      final int fileOffset = ((y + row) * this.width + x) * bytesPerSample;
      final int destinationStart = row * rowByteLength;
      _randomAccessFile.setPositionSync(fileOffset);
      final int bytesRead = _randomAccessFile.readIntoSync(
        bytes,
        destinationStart,
        destinationStart + rowByteLength,
      );
      if (bytesRead != rowByteLength) {
        throw StateError(
          'Raw mosaic store ended before the requested region.',
        );
      }
    }
    return samples;
  }

  /// Materializes this one committed frame for algorithms such as star
  /// detection that still require a whole-frame luminance plane. Callers must
  /// release the returned mosaic before loading the next store; unlike keeping
  /// every decoded RAW in a list, this bounds the resident input data to one
  /// frame.
  Future<LinearRawMosaic> readFull() async {
    final Float32List samples = await readRegion(
      x: 0,
      y: 0,
      width: width,
      height: height,
    );
    final RawSaturationMask? saturationMask = await readSaturationRegion(
      x: 0,
      y: 0,
      width: width,
      height: height,
    );
    return LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: cfaPattern,
      samples: samples,
      saturationMask: saturationMask,
    );
  }

  /// Reads the sensor-saturation flags for a rectangular source region.
  /// Returns `null` for legacy mosaics that did not carry a mask.
  Future<RawSaturationMask?> readSaturationRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    _ensureReadable();
    if (x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > this.width ||
        y + height > this.height) {
      throw RangeError(
        'Requested saturation region is outside the stored image.',
      );
    }
    final RandomAccessFile? handle = _saturationRandomAccessFile;
    if (handle == null) return null;

    final Uint8List flags = Uint8List(width * height);
    for (int row = 0; row < height; row++) {
      final int firstBit = (y + row) * this.width + x;
      final int lastBit = firstBit + width - 1;
      final int firstByte = firstBit >> 3;
      final int byteCount = (lastBit >> 3) - firstByte + 1;
      final Uint8List packed = Uint8List(byteCount);
      handle.setPositionSync(firstByte);
      final int bytesRead = handle.readIntoSync(packed);
      if (bytesRead != byteCount) {
        throw StateError(
          'Saturation mask store ended before the requested region.',
        );
      }
      for (int localX = 0; localX < width; localX++) {
        final int sourceBit = firstBit + localX;
        if ((packed[(sourceBit >> 3) - firstByte] & (1 << (sourceBit & 7))) !=
            0) {
          flags[row * width + localX] = 1;
        }
      }
    }
    return RawSaturationMask.fromPredicate(
      width * height,
      (int index) => flags[index] != 0,
    );
  }

  Future<void> abort() => dispose();

  Future<void> dispose() async {
    if (_isDisposed) return;
    _isDisposed = true;
    Object? firstError;
    StackTrace? firstStackTrace;

    Future<void> recordFailure(Future<void> Function() action) async {
      try {
        await action();
      } catch (error, stackTrace) {
        firstError ??= error;
        firstStackTrace ??= stackTrace;
      }
    }

    final RandomAccessFile? saturationHandle = _saturationRandomAccessFile;
    if (saturationHandle != null) {
      await recordFailure(saturationHandle.close);
    }
    await recordFailure(_randomAccessFile.close);

    final File? saturationFile = _saturationFile;
    if (_ownsFiles && saturationFile != null) {
      await recordFailure(() async {
        if (await saturationFile.exists()) await saturationFile.delete();
      });
    }
    if (_ownsFiles) {
      await recordFailure(() async {
        if (await _file.exists()) await _file.delete();
      });
      final Directory? ownedDirectory = _ownedDirectory;
      if (ownedDirectory != null) {
        await recordFailure(() async {
          if (await ownedDirectory.exists()) {
            await ownedDirectory.delete(recursive: true);
          }
        });
      }
    }

    if (firstError != null) {
      Error.throwWithStackTrace(firstError!, firstStackTrace!);
    }
  }

  void _ensureWritable() {
    if (_isDisposed) throw StateError('Raw mosaic store is disposed.');
    if (_isCommitted) {
      throw StateError('Raw mosaic store is already committed.');
    }
  }

  void _ensureReadable() {
    if (_isDisposed) throw StateError('Raw mosaic store is disposed.');
    if (!_isCommitted) throw StateError('Raw mosaic store is not committed.');
  }
}
