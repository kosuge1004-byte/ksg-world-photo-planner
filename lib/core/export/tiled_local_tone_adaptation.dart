import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'local_tone_adaptation.dart';

/// Work304: exact, file-backed local tone adaptation.
///
/// This preserves the Work99 local-tone equations but removes the previous
/// full-image Float64 luminance/surround/gain residency.  The algorithm is:
///
/// 1. Read RGB in full-width strips, compute luminance, apply the exact
///    horizontal box blur, and write that Float64 plane to a temporary file.
/// 2. Read horizontal-blur strips with vertical halo, apply the exact vertical
///    box blur, and write the surround Float64 plane to a second temporary file.
/// 3. Compute the exact interpolated surround percentile with an external
///    chunk-sort + k-way merge. No full-image `List<double>` is materialized.
/// 4. Read RGB tiles and their matching surround region, compute the same gain
///    equation on demand, and write the gained RGB tile to the output store.
///
/// Peak resident image data is therefore bounded by strips/tiles plus the
/// external-sort run buffers; full-image Float64 planes live on disk only.
Future<LinearRgbTileStore> applyLocalToneAdaptationTiled({
  required LinearRgbTileStore inputStore,
  required LinearRgbTileStoreFactory outputStoreFactory,
  int tileSize = 512,
  int stripHeight = 128,
  int blurRadius = 32,
  double strength = 0.5,
  double referencePercentile = 0.85,
  double minGain = 0.25,
  double maxGain = 4,
  double epsilon = 1e-6,
  List<double> luminanceWeights = bt709LinearLuminanceWeights,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  _validateParameters(
    inputStore: inputStore,
    tileSize: tileSize,
    stripHeight: stripHeight,
    blurRadius: blurRadius,
    strength: strength,
    referencePercentile: referencePercentile,
    minGain: minGain,
    maxGain: maxGain,
    epsilon: epsilon,
    luminanceWeights: luminanceWeights,
  );

  final int width = inputStore.width;
  final int height = inputStore.height;
  final Directory tempDirectory =
      await Directory.systemTemp.createTemp('mobile-stack-local-tone-stream-');
  final _Float64PlaneFile horizontal = await _Float64PlaneFile.create(
    path: '${tempDirectory.path}${Platform.pathSeparator}horizontal.f64',
    width: width,
    height: height,
  );
  final _Float64PlaneFile surround = await _Float64PlaneFile.create(
    path: '${tempDirectory.path}${Platform.pathSeparator}surround.f64',
    width: width,
    height: height,
  );

  LinearRgbTileStore? outputStore;
  bool outputCommitted = false;
  try {
    // Pass 1: RGB -> luminance -> exact horizontal box blur -> file.
    for (int y = 0; y < height; y += stripHeight) {
      _throwIfCancelled(isCancelled);
      final int rows = math.min(stripHeight, height - y);
      final LinearRgbTile rgbStrip = await inputStore.readRegion(
        x: 0,
        y: y,
        width: width,
        height: rows,
      );
      final Float64List luminance = computeLuminance(
        rgbStrip.interleavedRgb,
        width,
        rows,
        luminanceWeights: luminanceWeights,
      );
      final Float64List horizontalRows = Float64List(width * rows);
      for (int localY = 0; localY < rows; localY++) {
        final int rowStart = localY * width;
        for (int x = 0; x < width; x++) {
          double sum = 0;
          int count = 0;
          for (int dx = -blurRadius; dx <= blurRadius; dx++) {
            final int sampleX = (x + dx).clamp(0, width - 1);
            sum += luminance[rowStart + sampleX];
            count += 1;
          }
          horizontalRows[rowStart + x] = sum / count;
        }
      }
      await horizontal.writeRows(y: y, rows: rows, values: horizontalRows);
      reportProgress?.call(0.20 * (y + rows) / height);
    }
    await horizontal.commit();

    // Pass 2: exact vertical box blur with edge clamping -> surround file.
    for (int y = 0; y < height; y += stripHeight) {
      _throwIfCancelled(isCancelled);
      final int rows = math.min(stripHeight, height - y);
      final int readTop = math.max(0, y - blurRadius);
      final int readBottom = math.min(height - 1, y + rows - 1 + blurRadius);
      final int readRows = readBottom - readTop + 1;
      final Float64List region =
          await horizontal.readRows(y: readTop, rows: readRows);
      final Float64List output = Float64List(width * rows);
      for (int localY = 0; localY < rows; localY++) {
        final int globalY = y + localY;
        for (int x = 0; x < width; x++) {
          double sum = 0;
          int count = 0;
          for (int dy = -blurRadius; dy <= blurRadius; dy++) {
            final int sampleY = (globalY + dy).clamp(0, height - 1);
            final int regionY = sampleY - readTop;
            sum += region[regionY * width + x];
            count += 1;
          }
          output[localY * width + x] = sum / count;
        }
      }
      await surround.writeRows(y: y, rows: rows, values: output);
      reportProgress?.call(0.20 + 0.20 * (y + rows) / height);
    }
    await surround.commit();

    // Horizontal plane is no longer needed after the vertical pass.
    await horizontal.dispose();

    // Pass 3: exact percentile without a full-image in-memory sort.
    final double referenceSurround = await _exactPercentileFromPlane(
      plane: surround,
      fraction: referencePercentile,
      tempDirectory: tempDirectory,
      isCancelled: isCancelled,
      reportProgress: (double p) => reportProgress?.call(0.40 + 0.20 * p),
    );

    // Pass 4: calculate gain per output tile from the persisted surround.
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: width,
      imageHeight: height,
      tileSize: tileSize,
      overlap: 0,
    );
    outputStore = await outputStoreFactory(
      width: width,
      height: height,
      plan: plan,
    );

    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      _throwIfCancelled(isCancelled);
      final OverlappedTile tile = plan.tiles[tileIndex];
      final LinearRgbTile region = await inputStore.readRegion(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
      );
      final Float64List surroundRegion = await surround.readRegion(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
      );
      final int pixelCount = tile.outputWidth * tile.outputHeight;
      final Float32List gained = Float32List(region.interleavedRgb.length);
      for (int pixel = 0; pixel < pixelCount; pixel++) {
        final double s = surroundRegion[pixel];
        if (!s.isFinite || s < 0) {
          throw InvalidLocalToneAdaptationInput(
            'surround must contain only finite non-negative values.',
          );
        }
        final double ratio = referenceSurround / (s + epsilon);
        final double raw = math.pow(ratio, strength).toDouble();
        final double gain = math.min(maxGain, math.max(minGain, raw));
        final int base = pixel * 3;
        gained[base] = region.interleavedRgb[base] * gain;
        gained[base + 1] = region.interleavedRgb[base + 1] * gain;
        gained[base + 2] = region.interleavedRgb[base + 2] * gain;
      }
      await outputStore.writeTile(
        LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: gained,
        ),
      );
      reportProgress?.call(
        0.60 + 0.40 * (tileIndex + 1) / plan.tiles.length,
      );
    }
    await outputStore.commit();
    outputCommitted = true;
    return outputStore;
  } finally {
    if (!outputCommitted && outputStore != null) {
      await outputStore.abort();
    }
    await horizontal.dispose();
    await surround.dispose();
    if (await tempDirectory.exists()) {
      await tempDirectory.delete(recursive: true);
    }
  }
}

void _validateParameters({
  required LinearRgbTileStore inputStore,
  required int tileSize,
  required int stripHeight,
  required int blurRadius,
  required double strength,
  required double referencePercentile,
  required double minGain,
  required double maxGain,
  required double epsilon,
  required List<double> luminanceWeights,
}) {
  if (inputStore.width <= 0 || inputStore.height <= 0) {
    throw InvalidLocalToneAdaptationInput(
      'inputStore dimensions must be positive.',
    );
  }
  if (tileSize <= 0 || stripHeight <= 0) {
    throw InvalidLocalToneAdaptationInput(
      'tileSize and stripHeight must be positive.',
    );
  }
  if (blurRadius < 0) {
    throw InvalidLocalToneAdaptationInput(
      'blurRadius must be non-negative.',
    );
  }
  if (!strength.isFinite || strength < 0) {
    throw InvalidLocalToneAdaptationInput(
      'strength must be finite and non-negative.',
    );
  }
  if (!referencePercentile.isFinite ||
      referencePercentile < 0 ||
      referencePercentile > 1) {
    throw InvalidLocalToneAdaptationInput(
      'referencePercentile must be in [0, 1].',
    );
  }
  if (!minGain.isFinite ||
      !maxGain.isFinite ||
      minGain <= 0 ||
      maxGain <= 0 ||
      minGain > maxGain) {
    throw InvalidLocalToneAdaptationInput(
      'minGain and maxGain must be positive with minGain <= maxGain.',
    );
  }
  if (!epsilon.isFinite || epsilon <= 0) {
    throw InvalidLocalToneAdaptationInput(
      'epsilon must be finite and positive.',
    );
  }
  if (luminanceWeights.length != 3 ||
      luminanceWeights.any((double value) => !value.isFinite)) {
    throw InvalidLocalToneAdaptationInput(
      'luminanceWeights must contain exactly three finite values.',
    );
  }
}

void _throwIfCancelled(bool Function()? isCancelled) {
  if (isCancelled?.call() ?? false) {
    throw StateError('Local tone adaptation was cancelled.');
  }
}

final class _Float64PlaneFile {
  _Float64PlaneFile._({
    required this.path,
    required this.width,
    required this.height,
    required RandomAccessFile handle,
  }) : _handle = handle;

  static const int _bytesPerValue = Float64List.bytesPerElement;

  static Future<_Float64PlaneFile> create({
    required String path,
    required int width,
    required int height,
  }) async {
    final File file = File(path);
    await file.create(exclusive: true);
    final RandomAccessFile handle = await file.open(mode: FileMode.write);
    await handle.truncate(width * height * _bytesPerValue);
    return _Float64PlaneFile._(
      path: path,
      width: width,
      height: height,
      handle: handle,
    );
  }

  final String path;
  final int width;
  final int height;
  RandomAccessFile? _handle;
  bool _committed = false;

  Future<void> writeRows({
    required int y,
    required int rows,
    required Float64List values,
  }) async {
    final RandomAccessFile handle = _requireHandle();
    if (_committed) throw StateError('Float64 plane is already committed.');
    if (y < 0 || rows <= 0 || y + rows > height) {
      throw RangeError('Float64 plane row write is outside the image.');
    }
    if (values.length != width * rows) {
      throw ArgumentError('Float64 plane row length mismatch.');
    }
    if (values.any((double value) => !value.isFinite || value < 0)) {
      throw InvalidLocalToneAdaptationInput(
        'Local-tone plane contains invalid values.',
      );
    }
    final Uint8List bytes = values.buffer.asUint8List(
      values.offsetInBytes,
      values.lengthInBytes,
    );
    handle.setPositionSync(y * width * _bytesPerValue);
    handle.writeFromSync(bytes);
  }

  Future<void> commit() async {
    final RandomAccessFile handle = _requireHandle();
    await handle.flush();
    _committed = true;
  }

  Future<Float64List> readRows({
    required int y,
    required int rows,
  }) async {
    if (!_committed) throw StateError('Float64 plane is not committed.');
    if (y < 0 || rows <= 0 || y + rows > height) {
      throw RangeError('Float64 plane row read is outside the image.');
    }
    return _readValues(
      startValue: y * width,
      count: rows * width,
    );
  }

  Future<Float64List> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    if (!_committed) throw StateError('Float64 plane is not committed.');
    if (x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > this.width ||
        y + height > this.height) {
      throw RangeError('Float64 plane region is outside the image.');
    }
    final Float64List output = Float64List(width * height);
    for (int row = 0; row < height; row++) {
      final Float64List source = await _readValues(
        startValue: (y + row) * this.width + x,
        count: width,
      );
      output.setRange(row * width, (row + 1) * width, source);
    }
    return output;
  }

  Future<Float64List> readLinearChunk({
    required int startValue,
    required int count,
  }) async {
    if (!_committed) throw StateError('Float64 plane is not committed.');
    return _readValues(startValue: startValue, count: count);
  }

  Future<Float64List> _readValues({
    required int startValue,
    required int count,
  }) async {
    final RandomAccessFile handle = _requireHandle();
    if (startValue < 0 || count < 0 || startValue + count > width * height) {
      throw RangeError('Float64 plane read is outside the file.');
    }
    final Float64List output = Float64List(count);
    final Uint8List bytes = output.buffer.asUint8List();
    handle.setPositionSync(startValue * _bytesPerValue);
    final int read = handle.readIntoSync(bytes);
    if (read != bytes.length) {
      throw StateError('Float64 plane ended before the requested data.');
    }
    return output;
  }

  RandomAccessFile _requireHandle() {
    final RandomAccessFile? handle = _handle;
    if (handle == null) throw StateError('Float64 plane is disposed.');
    return handle;
  }

  Future<void> dispose() async {
    final RandomAccessFile? handle = _handle;
    if (handle == null) return;
    _handle = null;
    await handle.close();
    final File file = File(path);
    if (await file.exists()) await file.delete();
  }
}

Future<double> _exactPercentileFromPlane({
  required _Float64PlaneFile plane,
  required double fraction,
  required Directory tempDirectory,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  final int valueCount = plane.width * plane.height;
  if (valueCount <= 0) {
    throw InvalidLocalToneAdaptationInput('surround must not be empty.');
  }
  final double position = fraction * (valueCount - 1);
  final int lowerRank = position.floor();
  final int upperRank = position.ceil();
  const int valuesPerRun = 262144;
  final List<File> runFiles = <File>[];

  int processed = 0;
  for (int start = 0; start < valueCount; start += valuesPerRun) {
    _throwIfCancelled(isCancelled);
    final int count = math.min(valuesPerRun, valueCount - start);
    final Float64List values =
        await plane.readLinearChunk(startValue: start, count: count);
    values.sort();
    final File file = File(
      '${tempDirectory.path}${Platform.pathSeparator}'
      'percentile-${runFiles.length}.f64',
    );
    final RandomAccessFile out = await file.open(mode: FileMode.write);
    try {
      final Uint8List bytes = values.buffer.asUint8List(
        values.offsetInBytes,
        values.lengthInBytes,
      );
      out.writeFromSync(bytes);
      await out.flush();
    } finally {
      await out.close();
    }
    runFiles.add(file);
    processed += count;
    reportProgress?.call(0.5 * processed / valueCount);
  }

  final List<_SortedRunCursor> cursors = <_SortedRunCursor>[];
  final _MinHeap heap = _MinHeap();
  try {
    for (int i = 0; i < runFiles.length; i++) {
      final _SortedRunCursor cursor = await _SortedRunCursor.open(runFiles[i]);
      cursors.add(cursor);
      final double? value = await cursor.nextValue();
      if (value != null) heap.add(_HeapNode(value: value, runIndex: i));
    }

    double lower = 0;
    double upper = 0;
    for (int rank = 0; rank <= upperRank; rank++) {
      if ((rank & 0x3fff) == 0) {
        _throwIfCancelled(isCancelled);
        reportProgress?.call(
          0.5 + 0.5 * (rank + 1) / (upperRank + 1),
        );
      }
      final _HeapNode node = heap.removeFirst();
      if (rank == lowerRank) lower = node.value;
      if (rank == upperRank) upper = node.value;
      final double? next = await cursors[node.runIndex].nextValue();
      if (next != null) {
        heap.add(_HeapNode(value: next, runIndex: node.runIndex));
      }
    }
    final double weight = position - lowerRank;
    return lower * (1 - weight) + upper * weight;
  } finally {
    for (final _SortedRunCursor cursor in cursors) {
      await cursor.close();
    }
    for (final File file in runFiles) {
      if (await file.exists()) await file.delete();
    }
  }
}

final class _SortedRunCursor {
  _SortedRunCursor._(this._handle, this._valueCount);

  static const int _bufferValues = 4096;

  static Future<_SortedRunCursor> open(File file) async {
    final int byteLength = await file.length();
    if (byteLength % Float64List.bytesPerElement != 0) {
      throw StateError('Sorted percentile run has invalid byte length.');
    }
    return _SortedRunCursor._(
      await file.open(mode: FileMode.read),
      byteLength ~/ Float64List.bytesPerElement,
    );
  }

  final RandomAccessFile _handle;
  final int _valueCount;
  int _consumed = 0;
  Float64List _buffer = Float64List(0);
  int _bufferIndex = 0;

  Future<double?> nextValue() async {
    if (_consumed >= _valueCount) return null;
    if (_bufferIndex >= _buffer.length) {
      final int count = math.min(_bufferValues, _valueCount - _consumed);
      final Float64List next = Float64List(count);
      final Uint8List bytes = next.buffer.asUint8List();
      final int read = _handle.readIntoSync(bytes);
      if (read != bytes.length) {
        throw StateError('Sorted percentile run ended unexpectedly.');
      }
      _buffer = next;
      _bufferIndex = 0;
    }
    final double value = _buffer[_bufferIndex++];
    _consumed += 1;
    return value;
  }

  Future<void> close() => _handle.close();
}

final class _HeapNode {
  const _HeapNode({required this.value, required this.runIndex});
  final double value;
  final int runIndex;
}

final class _MinHeap {
  final List<_HeapNode> _nodes = <_HeapNode>[];

  void add(_HeapNode node) {
    _nodes.add(node);
    int index = _nodes.length - 1;
    while (index > 0) {
      final int parent = (index - 1) >> 1;
      if (_compare(_nodes[parent], node) <= 0) break;
      _nodes[index] = _nodes[parent];
      index = parent;
    }
    _nodes[index] = node;
  }

  _HeapNode removeFirst() {
    if (_nodes.isEmpty) throw StateError('Percentile heap is empty.');
    final _HeapNode first = _nodes.first;
    final _HeapNode last = _nodes.removeLast();
    if (_nodes.isNotEmpty) {
      int index = 0;
      while (true) {
        final int left = index * 2 + 1;
        if (left >= _nodes.length) break;
        final int right = left + 1;
        int child = left;
        if (right < _nodes.length &&
            _compare(_nodes[right], _nodes[left]) < 0) {
          child = right;
        }
        if (_compare(last, _nodes[child]) <= 0) break;
        _nodes[index] = _nodes[child];
        index = child;
      }
      _nodes[index] = last;
    }
    return first;
  }

  int _compare(_HeapNode a, _HeapNode b) {
    final int valueOrder = a.value.compareTo(b.value);
    return valueOrder != 0 ? valueOrder : a.runIndex.compareTo(b.runIndex);
  }
}
