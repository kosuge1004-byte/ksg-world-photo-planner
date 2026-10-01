import 'dart:io';
import 'dart:typed_data';

import '../tiles/overlapped_tile_plan.dart';
import 'linear_rgb_tile.dart';
import 'linear_rgb_tile_store.dart';

final class FileBackedLinearRgbTileStore implements LinearRgbTileStore {
  FileBackedLinearRgbTileStore._({
    required File file,
    required RandomAccessFile randomAccessFile,
    required this.width,
    required this.height,
    required List<OverlappedTile> expectedTiles,
    Directory? ownedDirectory,
  })  : _file = file,
        _randomAccessFile = randomAccessFile,
        _expectedTiles = expectedTiles,
        _ownedDirectory = ownedDirectory;

  static const int bytesPerPixel = 3 * Float32List.bytesPerElement;

  static Future<FileBackedLinearRgbTileStore> create({
    required String path,
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) =>
      _create(
        path: path,
        width: width,
        height: height,
        plan: plan,
      );

  static Future<FileBackedLinearRgbTileStore> createTemporary({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-linear-rgb-');
    final String path =
        '${directory.path}${Platform.pathSeparator}linear-rgb.f32';
    try {
      return await _create(
        path: path,
        width: width,
        height: height,
        plan: plan,
        ownedDirectory: directory,
      );
    } catch (_) {
      if (await directory.exists()) await directory.delete(recursive: true);
      rethrow;
    }
  }

  static Future<FileBackedLinearRgbTileStore> _create({
    required String path,
    required int width,
    required int height,
    required OverlappedTilePlan plan,
    Directory? ownedDirectory,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Store dimensions must be positive.');
    }
    _validateCoverage(width, height, plan.tiles);
    final File file = File(path);
    await file.create(exclusive: true);
    RandomAccessFile? handle;
    try {
      final RandomAccessFile opened = await file.open(mode: FileMode.write);
      handle = opened;
      await opened.truncate(width * height * bytesPerPixel);
      return FileBackedLinearRgbTileStore._(
        file: file,
        randomAccessFile: opened,
        width: width,
        height: height,
        expectedTiles: plan.tiles,
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
  final List<OverlappedTile> _expectedTiles;
  final Directory? _ownedDirectory;
  bool _isCommitted = false;
  bool _isDisposed = false;
  int _completedTileCount = 0;

  @override
  final int width;

  @override
  final int height;

  @override
  int get persistentByteLength => width * height * bytesPerPixel;

  @override
  int get completedTileCount => _completedTileCount;

  @override
  bool get isCommitted => _isCommitted;

  String get path => _file.path;

  static Future<FileBackedLinearRgbTileStore> openCommitted({
    required String path,
    required int width,
    required int height,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Store dimensions must be positive.');
    }
    final File file = File(path);
    if (!await file.exists()) {
      throw StateError('RGB tile store file is missing: $path');
    }
    final int expectedLength = width * height * bytesPerPixel;
    final int actualLength = await file.length();
    if (actualLength != expectedLength) {
      throw StateError(
          'RGB tile store length mismatch: $actualLength != $expectedLength');
    }
    final RandomAccessFile handle = await file.open(mode: FileMode.read);
    final FileBackedLinearRgbTileStore store = FileBackedLinearRgbTileStore._(
      file: file,
      randomAccessFile: handle,
      width: width,
      height: height,
      expectedTiles: const <OverlappedTile>[],
    );
    store._isCommitted = true;
    return store;
  }

  /// Reopens an existing, not-yet-committed tile file for further writing,
  /// picking up exactly where a previous process instance left off.
  ///
  /// This exists solely to let a durable, resumable checkpoint (see
  /// `CfaDrizzleTiledCheckpointStore`) continue writing tiles into a file a
  /// prior run already partially wrote, instead of starting over from tile
  /// zero. It does not — and cannot — verify that the bytes already on disk
  /// for tiles `[0, completedTileCount)` are actually correct: that
  /// guarantee comes entirely from the caller only ever advancing
  /// [completedTileCount] in its own durable manifest immediately after each
  /// corresponding [writeTile] call returns, for this exact [path]/[plan].
  /// [plan] must be the identical tile plan (same `width`, `height`,
  /// `tileSize` as the original run: `OverlappedTilePlan.create` is a pure
  /// function of those three, so recomputing it from unchanged identity
  /// inputs reproduces the same tile order deterministically) — a different
  /// plan would silently misalign which bytes belong to which tile.
  static Future<FileBackedLinearRgbTileStore> openForResume({
    required String path,
    required int width,
    required int height,
    required OverlappedTilePlan plan,
    required int completedTileCount,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Store dimensions must be positive.');
    }
    _validateCoverage(width, height, plan.tiles);
    if (completedTileCount < 0 || completedTileCount > plan.tiles.length) {
      throw ArgumentError.value(completedTileCount, 'completedTileCount');
    }
    final File file = File(path);
    if (!await file.exists()) {
      throw StateError('RGB tile store file is missing: $path');
    }
    final int expectedLength = width * height * bytesPerPixel;
    final int actualLength = await file.length();
    if (actualLength != expectedLength) {
      throw StateError(
          'RGB tile store length mismatch: $actualLength != $expectedLength');
    }
    final RandomAccessFile handle = await file.open(mode: FileMode.append);
    final FileBackedLinearRgbTileStore store = FileBackedLinearRgbTileStore._(
      file: file,
      randomAccessFile: handle,
      width: width,
      height: height,
      expectedTiles: plan.tiles,
    );
    store._completedTileCount = completedTileCount;
    return store;
  }

  Future<void> flushCheckpoint() async {
    if (_isDisposed) throw StateError('Checkpoint store is closed');
    await _randomAccessFile.flush();
  }

  Future<void> closeRetainingFile() async {
    if (_isDisposed) return;
    _isDisposed = true;
    await _randomAccessFile.close();
  }

  @override
  Future<void> writeTile(LinearRgbTile tile) async {
    _ensureWritable();
    if (_completedTileCount >= _expectedTiles.length) {
      throw StateError('All planned RGB tiles are already written.');
    }
    final OverlappedTile expected = _expectedTiles[_completedTileCount];
    if (tile.x != expected.outputX ||
        tile.y != expected.outputY ||
        tile.width != expected.outputWidth ||
        tile.height != expected.outputHeight) {
      throw StateError('RGB tiles must be written once in plan order.');
    }
    if (tile.interleavedRgb.any((double value) => !value.isFinite)) {
      throw StateError('RGB tile contains a non-finite sample.');
    }

    final Uint8List bytes = tile.interleavedRgb.buffer.asUint8List(
      tile.interleavedRgb.offsetInBytes,
      tile.interleavedRgb.lengthInBytes,
    );
    final int rowByteLength = tile.width * bytesPerPixel;
    for (int row = 0; row < tile.height; row++) {
      final int fileOffset = ((tile.y + row) * width + tile.x) * bytesPerPixel;
      final int sourceStart = row * rowByteLength;
      _randomAccessFile.setPositionSync(fileOffset);
      _randomAccessFile.writeFromSync(
        bytes,
        sourceStart,
        sourceStart + rowByteLength,
      );
    }
    _completedTileCount++;
  }

  @override
  Future<void> commit() async {
    _ensureWritable();
    if (_completedTileCount != _expectedTiles.length) {
      throw StateError('Cannot commit an incomplete RGB tile set.');
    }
    await _randomAccessFile.flush();
    _isCommitted = true;
  }

  @override
  Future<LinearRgbTile> readRegion({
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
      throw RangeError('Requested RGB region is outside the stored image.');
    }
    final Float32List samples = Float32List(width * height * 3);
    final Uint8List bytes = samples.buffer.asUint8List(
      samples.offsetInBytes,
      samples.lengthInBytes,
    );
    final int rowByteLength = width * bytesPerPixel;
    for (int row = 0; row < height; row++) {
      final int fileOffset = ((y + row) * this.width + x) * bytesPerPixel;
      final int destinationStart = row * rowByteLength;
      _randomAccessFile.setPositionSync(fileOffset);
      final int bytesRead = _randomAccessFile.readIntoSync(
        bytes,
        destinationStart,
        destinationStart + rowByteLength,
      );
      if (bytesRead != rowByteLength) {
        throw StateError('RGB tile store ended before the requested region.');
      }
    }
    return LinearRgbTile(
      x: x,
      y: y,
      width: width,
      height: height,
      interleavedRgb: samples,
    );
  }

  @override
  Future<void> abort() => dispose();

  @override
  Future<void> dispose() async {
    if (_isDisposed) return;
    _isDisposed = true;
    try {
      await _randomAccessFile.close();
    } finally {
      try {
        if (await _file.exists()) await _file.delete();
      } finally {
        final Directory? ownedDirectory = _ownedDirectory;
        if (ownedDirectory != null && await ownedDirectory.exists()) {
          await ownedDirectory.delete();
        }
      }
    }
  }

  void _ensureWritable() {
    if (_isDisposed) throw StateError('RGB tile store is disposed.');
    if (_isCommitted) throw StateError('RGB tile store is already committed.');
  }

  void _ensureReadable() {
    if (_isDisposed) throw StateError('RGB tile store is disposed.');
    if (!_isCommitted) throw StateError('RGB tile store is not committed.');
  }

  static void _validateCoverage(
    int width,
    int height,
    List<OverlappedTile> tiles,
  ) {
    if (tiles.isEmpty) {
      throw ArgumentError('RGB tile plan must not be empty.');
    }
    int expectedX = 0;
    int expectedY = 0;
    int rowHeight = tiles.first.outputHeight;
    for (final OverlappedTile tile in tiles) {
      if (tile.outputX != expectedX ||
          tile.outputY != expectedY ||
          tile.outputWidth <= 0 ||
          tile.outputHeight <= 0 ||
          tile.outputX + tile.outputWidth > width ||
          tile.outputY + tile.outputHeight > height) {
        throw ArgumentError(
            'RGB tile plan has a gap, overlap, or invalid tile.');
      }
      if (tile.outputHeight != rowHeight) {
        throw ArgumentError(
            'Every tile in an output row must have one height.');
      }
      expectedX += tile.outputWidth;
      if (expectedX == width) {
        expectedX = 0;
        expectedY += rowHeight;
        if (expectedY < height) {
          rowHeight = tiles
              .firstWhere(
                  (OverlappedTile candidate) => candidate.outputY == expectedY)
              .outputHeight;
        }
      } else if (expectedX > width) {
        throw ArgumentError('RGB tile plan overlaps the image row.');
      }
    }
    if (expectedX != 0 || expectedY != height) {
      throw ArgumentError('RGB tile plan does not cover the full image.');
    }
  }
}
