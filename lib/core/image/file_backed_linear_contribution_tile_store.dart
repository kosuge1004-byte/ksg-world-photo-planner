import 'dart:io';
import 'dart:typed_data';

import '../tiles/overlapped_tile_plan.dart';
import 'linear_contribution_tile.dart';
import 'linear_contribution_tile_store.dart';

/// Transactional row-major uint16 RGB-channel contribution storage.
final class FileBackedLinearContributionTileStore
    implements LinearContributionTileStore {
  FileBackedLinearContributionTileStore._({
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

  static const int bytesPerPixel = 3 * Uint16List.bytesPerElement;

  static Future<FileBackedLinearContributionTileStore> create({
    required String path,
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) =>
      _create(path: path, width: width, height: height, plan: plan);

  static Future<FileBackedLinearContributionTileStore> createTemporary({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-counts-');
    final String path =
        '${directory.path}${Platform.pathSeparator}contributions.u16';
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

  static Future<FileBackedLinearContributionTileStore> _create({
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
      return FileBackedLinearContributionTileStore._(
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

  String get path => _file.path;

  static Future<FileBackedLinearContributionTileStore> openCommitted({
    required String path,
    required int width,
    required int height,
  }) async {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Store dimensions must be positive.');
    }
    final File file = File(path);
    if (!await file.exists()) {
      throw StateError('Contribution store file is missing: $path');
    }
    final int expectedLength = width * height * bytesPerPixel;
    final int actualLength = await file.length();
    if (actualLength != expectedLength) {
      throw StateError(
        'Contribution store length mismatch: $actualLength != $expectedLength',
      );
    }
    final RandomAccessFile handle = await file.open(mode: FileMode.read);
    final FileBackedLinearContributionTileStore store =
        FileBackedLinearContributionTileStore._(
      file: file,
      randomAccessFile: handle,
      width: width,
      height: height,
      expectedTiles: const <OverlappedTile>[],
    );
    store._isCommitted = true;
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

  /// Reopens an existing, not-yet-committed tile file for further writing,
  /// picking up exactly where a previous process instance left off. Mirrors
  /// `FileBackedLinearRgbTileStore.openForResume` — see its doc comment for
  /// the full trust-boundary explanation (in short: this does not and
  /// cannot verify tiles `[0, completedTileCount)` are actually correct;
  /// that guarantee comes entirely from the caller's own durable manifest).
  static Future<FileBackedLinearContributionTileStore> openForResume({
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
      throw StateError('Contribution store file is missing: $path');
    }
    final int expectedLength = width * height * bytesPerPixel;
    final int actualLength = await file.length();
    if (actualLength != expectedLength) {
      throw StateError(
        'Contribution store length mismatch: $actualLength != $expectedLength',
      );
    }
    final RandomAccessFile handle = await file.open(mode: FileMode.append);
    final FileBackedLinearContributionTileStore store =
        FileBackedLinearContributionTileStore._(
      file: file,
      randomAccessFile: handle,
      width: width,
      height: height,
      expectedTiles: plan.tiles,
    );
    store._completedTileCount = completedTileCount;
    return store;
  }

  @override
  int get persistentByteLength => width * height * bytesPerPixel;

  @override
  int get completedTileCount => _completedTileCount;

  @override
  bool get isCommitted => _isCommitted;

  @override
  Future<void> writeTile(LinearContributionTile tile) async {
    _ensureWritable();
    if (_completedTileCount >= _expectedTiles.length) {
      throw StateError('All planned contribution tiles are already written.');
    }
    final OverlappedTile expected = _expectedTiles[_completedTileCount];
    if (tile.x != expected.outputX ||
        tile.y != expected.outputY ||
        tile.width != expected.outputWidth ||
        tile.height != expected.outputHeight) {
      throw StateError('Contribution tiles must be written in plan order.');
    }
    final Uint8List bytes = tile.interleavedCounts.buffer.asUint8List(
      tile.interleavedCounts.offsetInBytes,
      tile.interleavedCounts.lengthInBytes,
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
      throw StateError('Cannot commit incomplete contribution tiles.');
    }
    await _randomAccessFile.flush();
    _isCommitted = true;
  }

  @override
  Future<LinearContributionTile> readRegion({
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
      throw RangeError('Contribution region is outside the stored image.');
    }
    final Uint16List counts = Uint16List(width * height * 3);
    final Uint8List bytes = counts.buffer.asUint8List(
      counts.offsetInBytes,
      counts.lengthInBytes,
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
        throw StateError('Contribution store ended before the region.');
      }
    }
    return LinearContributionTile(
      x: x,
      y: y,
      width: width,
      height: height,
      interleavedCounts: counts,
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
        final Directory? directory = _ownedDirectory;
        if (directory != null && await directory.exists()) {
          await directory.delete();
        }
      }
    }
  }

  void _ensureWritable() {
    if (_isDisposed) throw StateError('Contribution store is disposed.');
    if (_isCommitted) throw StateError('Contribution store is committed.');
  }

  void _ensureReadable() {
    if (_isDisposed) throw StateError('Contribution store is disposed.');
    if (!_isCommitted) throw StateError('Contribution store is not committed.');
  }

  static void _validateCoverage(
    int width,
    int height,
    List<OverlappedTile> tiles,
  ) {
    if (tiles.isEmpty) throw ArgumentError('Tile plan must not be empty.');
    int expectedX = 0;
    int expectedY = 0;
    int rowHeight = tiles.first.outputHeight;
    for (final OverlappedTile tile in tiles) {
      if (tile.outputX != expectedX ||
          tile.outputY != expectedY ||
          tile.outputWidth <= 0 ||
          tile.outputHeight <= 0 ||
          tile.outputX + tile.outputWidth > width ||
          tile.outputY + tile.outputHeight > height ||
          tile.outputHeight != rowHeight) {
        throw ArgumentError('Tile plan has a gap, overlap, or invalid tile.');
      }
      expectedX += tile.outputWidth;
      if (expectedX == width) {
        expectedX = 0;
        expectedY += rowHeight;
        if (expectedY < height) {
          rowHeight = tiles
              .firstWhere(
                (OverlappedTile candidate) => candidate.outputY == expectedY,
              )
              .outputHeight;
        }
      } else if (expectedX > width) {
        throw ArgumentError('Tile plan overlaps the image row.');
      }
    }
    if (expectedX != 0 || expectedY != height) {
      throw ArgumentError('Tile plan does not cover the image.');
    }
  }
}
