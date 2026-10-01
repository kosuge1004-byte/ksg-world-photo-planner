import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'focus_winner_map.dart';
import 'file_backed_focus_winner_map.dart';

FocusWinnerMap regularizeFocusWinnerMap(
  FocusWinnerMap input, {
  int radius = 2,
  double anchorConfidence = 0.55,
  double minimumNeighborSupport = 1.5,
  int maximumIterations = 2,
  bool reuseInputBuffers = false,
}) {
  if (radius < 1 || radius > 16) {
    throw ArgumentError.value(radius, 'radius');
  }
  if (!anchorConfidence.isFinite ||
      anchorConfidence < 0 ||
      anchorConfidence > 1 ||
      !minimumNeighborSupport.isFinite ||
      minimumNeighborSupport < 0 ||
      maximumIterations < 1 ||
      maximumIterations > 16) {
    throw ArgumentError('Invalid focus-map regularization parameters.');
  }

  final int width = input.width;
  final int height = input.height;
  // Each iteration writes only to its new buffers, so the first iteration can
  // read the caller-owned map directly. Avoiding an eager duplicate removes
  // one full label/confidence pair from the peak while preserving input data.
  Int32List labels = input.frameIndices;
  Float32List confidence = input.confidence;
  final Int32List? alternateLabels =
      reuseInputBuffers ? Int32List(labels.length) : null;
  final Float32List? alternateConfidence =
      reuseInputBuffers ? Float32List(confidence.length) : null;
  final int maximumNeighbors = (radius * 2 + 1) * (radius * 2 + 1) - 1;
  final Int32List neighborLabels = Int32List(maximumNeighbors);
  final Float64List neighborWeights = Float64List(maximumNeighbors);

  for (int iteration = 0; iteration < maximumIterations; iteration++) {
    final Int32List nextLabels;
    final Float32List nextConfidence;
    if (reuseInputBuffers) {
      final bool currentIsInput = identical(labels, input.frameIndices);
      nextLabels = currentIsInput ? alternateLabels! : input.frameIndices;
      nextConfidence = currentIsInput ? alternateConfidence! : input.confidence;
      nextLabels.setAll(0, labels);
      nextConfidence.setAll(0, confidence);
    } else {
      nextLabels = Int32List.fromList(labels);
      nextConfidence = Float32List.fromList(confidence);
    }

    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        final int index = y * width + x;
        if (confidence[index] >= anchorConfidence) continue;

        int neighborCount = 0;
        double totalWeight = 0;
        for (int dy = -radius; dy <= radius; dy++) {
          final int yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (int dx = -radius; dx <= radius; dx++) {
            final int xx = x + dx;
            if (xx < 0 || xx >= width || (dx == 0 && dy == 0)) continue;
            final int neighborIndex = yy * width + xx;
            final double neighborConfidence = confidence[neighborIndex];
            if (!(neighborConfidence > 0)) continue;
            final double distance = math.sqrt((dx * dx + dy * dy).toDouble());
            final double weight = neighborConfidence / (1 + distance);
            neighborLabels[neighborCount] = labels[neighborIndex];
            neighborWeights[neighborCount] = weight;
            neighborCount++;
            totalWeight += weight;
          }
        }
        if (totalWeight < minimumNeighborSupport || neighborCount == 0) {
          continue;
        }

        _sortWeightedLabels(
          neighborLabels,
          neighborWeights,
          neighborCount,
        );
        final double half = totalWeight * 0.5;
        double cumulative = 0;
        int medianLabel = neighborLabels[neighborCount - 1];
        for (int neighbor = 0; neighbor < neighborCount; neighbor++) {
          cumulative += neighborWeights[neighbor];
          if (cumulative >= half) {
            medianLabel = neighborLabels[neighbor];
            break;
          }
        }
        if (medianLabel == labels[index]) continue;

        double candidateWeight = 0;
        for (int neighbor = 0; neighbor < neighborCount; neighbor++) {
          if (neighborLabels[neighbor] == medianLabel) {
            candidateWeight += neighborWeights[neighbor];
          }
        }
        final double candidateFraction = candidateWeight / totalWeight;
        if (candidateFraction <= 0.5) continue;

        nextLabels[index] = medianLabel;
        nextConfidence[index] = math.max(
          confidence[index],
          candidateFraction.clamp(0, 1).toDouble(),
        );
      }
    }

    labels = nextLabels;
    confidence = nextConfidence;
  }

  return FocusWinnerMap(
    width: width,
    height: height,
    frameIndices: labels,
    confidence: confidence,
  );
}

/// Sorts the reused neighbor buffers with the exact label-ascending,
/// weight-descending ordering used by the former `_WeightedLabel` list. This
/// preserves both median selection and floating-point accumulation order.
void _sortWeightedLabels(
  Int32List labels,
  Float64List weights,
  int count,
) {
  int gap = 1;
  while (gap < count ~/ 3) {
    gap = gap * 3 + 1;
  }
  while (gap >= 1) {
    for (int index = gap; index < count; index++) {
      final int label = labels[index];
      final double weight = weights[index];
      int destination = index;
      while (destination >= gap) {
        final int previous = destination - gap;
        final int previousLabel = labels[previous];
        final double previousWeight = weights[previous];
        if (previousLabel < label ||
            (previousLabel == label && previousWeight >= weight)) {
          break;
        }
        labels[destination] = previousLabel;
        weights[destination] = previousWeight;
        destination = previous;
      }
      labels[destination] = label;
      weights[destination] = weight;
    }
    gap ~/= 3;
  }
}

/// Memory-bounded equivalent of the production two-iteration regularizer.
///
/// The first pass writes the alternate full-resolution label/confidence pair
/// to temporary files instead of allocating another image-sized typed-array
/// pair. The second pass reads those Float32/Int32 rows back through a rolling
/// neighborhood cache and writes the final samples into the caller-owned input
/// buffers. This preserves the same per-pixel read-before-write semantics as
/// [regularizeFocusWinnerMap] with `reuseInputBuffers: true` while avoiding the
/// second resident winner-map pair.
Future<FocusWinnerMap> regularizeFocusWinnerMapFileBackedTwoPass(
  FocusWinnerMap input, {
  int radius = 2,
  double anchorConfidence = 0.55,
  double minimumNeighborSupport = 1.5,
  Directory? temporaryDirectory,
  void Function()? checkCancelled,
}) async {
  if (radius < 1 || radius > 16) {
    throw ArgumentError.value(radius, 'radius');
  }
  if (!anchorConfidence.isFinite ||
      anchorConfidence < 0 ||
      anchorConfidence > 1 ||
      !minimumNeighborSupport.isFinite ||
      minimumNeighborSupport < 0) {
    throw ArgumentError('Invalid focus-map regularization parameters.');
  }

  final Directory ownedDirectory = temporaryDirectory ??
      await Directory.systemTemp.createTemp('mobile-stack-focus-regularize-');
  final bool ownsDirectory = temporaryDirectory == null;
  final File labelsFile = File(
    '${ownedDirectory.path}${Platform.pathSeparator}labels-pass1.i32',
  );
  final File confidenceFile = File(
    '${ownedDirectory.path}${Platform.pathSeparator}confidence-pass1.f32',
  );
  RandomAccessFile? labelsWriter;
  RandomAccessFile? confidenceWriter;
  RandomAccessFile? labelsReader;
  RandomAccessFile? confidenceReader;
  try {
    labelsWriter = await labelsFile.open(mode: FileMode.write);
    confidenceWriter = await confidenceFile.open(mode: FileMode.write);
    await _writeRegularizedPassFromMemory(
      input: input,
      labelsWriter: labelsWriter,
      confidenceWriter: confidenceWriter,
      radius: radius,
      anchorConfidence: anchorConfidence,
      minimumNeighborSupport: minimumNeighborSupport,
      checkCancelled: checkCancelled,
    );
    await labelsWriter.close();
    labelsWriter = null;
    await confidenceWriter.close();
    confidenceWriter = null;

    labelsReader = await labelsFile.open(mode: FileMode.read);
    confidenceReader = await confidenceFile.open(mode: FileMode.read);
    await _writeRegularizedPassFromFilesIntoInput(
      input: input,
      labelsReader: labelsReader,
      confidenceReader: confidenceReader,
      radius: radius,
      anchorConfidence: anchorConfidence,
      minimumNeighborSupport: minimumNeighborSupport,
      checkCancelled: checkCancelled,
    );
    return input;
  } finally {
    await _cleanupRegularizerFilesBestEffort(
      handles: <RandomAccessFile?>[
        labelsWriter,
        confidenceWriter,
        labelsReader,
        confidenceReader,
      ],
      files: <File>[labelsFile, confidenceFile],
      ownedDirectory: ownsDirectory ? ownedDirectory : null,
    );
  }
}

Future<void> _cleanupRegularizerFilesBestEffort({
  required Iterable<RandomAccessFile?> handles,
  required Iterable<File> files,
  Directory? ownedDirectory,
}) async {
  Object? firstError;
  StackTrace? firstStackTrace;
  for (final RandomAccessFile? handle in handles) {
    if (handle == null) continue;
    try {
      await handle.close();
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
  }
  for (final File file in files) {
    try {
      if (await file.exists()) await file.delete();
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
  }
  if (ownedDirectory != null) {
    try {
      if (await ownedDirectory.exists()) {
        await ownedDirectory.delete(recursive: true);
      }
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
  }
  if (firstError != null) {
    Error.throwWithStackTrace(firstError, firstStackTrace!);
  }
}

Future<void> _writeRegularizedPassFromMemory({
  required FocusWinnerMap input,
  required RandomAccessFile labelsWriter,
  required RandomAccessFile confidenceWriter,
  required int radius,
  required double anchorConfidence,
  required double minimumNeighborSupport,
  void Function()? checkCancelled,
}) async {
  final int width = input.width;
  final int height = input.height;
  final int maximumNeighbors = (radius * 2 + 1) * (radius * 2 + 1) - 1;
  final Int32List neighborLabels = Int32List(maximumNeighbors);
  final Float64List neighborWeights = Float64List(maximumNeighbors);
  final Int32List outputLabels = Int32List(width);
  final Float32List outputConfidence = Float32List(width);

  for (int y = 0; y < height; y++) {
    checkCancelled?.call();
    final int rowStart = y * width;
    outputLabels.setRange(0, width, input.frameIndices, rowStart);
    outputConfidence.setRange(0, width, input.confidence, rowStart);
    for (int x = 0; x < width; x++) {
      final int index = rowStart + x;
      _regularizeOnePixel(
        x: x,
        y: y,
        width: width,
        height: height,
        radius: radius,
        anchorConfidence: anchorConfidence,
        minimumNeighborSupport: minimumNeighborSupport,
        labelAt: (int xx, int yy) => input.frameIndices[yy * width + xx],
        confidenceAt: (int xx, int yy) => input.confidence[yy * width + xx],
        currentLabel: input.frameIndices[index],
        currentConfidence: input.confidence[index],
        neighborLabels: neighborLabels,
        neighborWeights: neighborWeights,
        onReplacement: (int label, double confidence) {
          outputLabels[x] = label;
          outputConfidence[x] = confidence;
        },
      );
    }
    await labelsWriter.writeFrom(outputLabels.buffer.asUint8List());
    await confidenceWriter.writeFrom(outputConfidence.buffer.asUint8List());
  }
}

final class _RegularizerRow {
  const _RegularizerRow(this.labels, this.confidence);
  final Int32List labels;
  final Float32List confidence;
}

Future<void> _writeRegularizedPassFromFilesIntoInput({
  required FocusWinnerMap input,
  required RandomAccessFile labelsReader,
  required RandomAccessFile confidenceReader,
  required int radius,
  required double anchorConfidence,
  required double minimumNeighborSupport,
  void Function()? checkCancelled,
}) async {
  final int width = input.width;
  final int height = input.height;
  final int maximumNeighbors = (radius * 2 + 1) * (radius * 2 + 1) - 1;
  final Int32List neighborLabels = Int32List(maximumNeighbors);
  final Float64List neighborWeights = Float64List(maximumNeighbors);
  final Map<int, _RegularizerRow> rows = <int, _RegularizerRow>{};

  Future<_RegularizerRow> loadRow(int y) async {
    final _RegularizerRow? cached = rows[y];
    if (cached != null) return cached;
    final Int32List labels = Int32List(width);
    final Float32List confidence = Float32List(width);
    final int labelsOffset = y * width * Int32List.bytesPerElement;
    final int confidenceOffset = y * width * Float32List.bytesPerElement;
    await labelsReader.setPosition(labelsOffset);
    await confidenceReader.setPosition(confidenceOffset);
    await _readExact(labelsReader, labels.buffer.asUint8List());
    await _readExact(confidenceReader, confidence.buffer.asUint8List());
    final _RegularizerRow row = _RegularizerRow(labels, confidence);
    rows[y] = row;
    return row;
  }

  for (int y = 0; y < height; y++) {
    checkCancelled?.call();
    final int firstRow = math.max(0, y - radius);
    final int lastRow = math.min(height - 1, y + radius);
    for (int yy = firstRow; yy <= lastRow; yy++) {
      await loadRow(yy);
    }
    rows.removeWhere((int yy, _RegularizerRow _) => yy < firstRow);
    final _RegularizerRow current = rows[y]!;
    final int outputStart = y * width;
    input.frameIndices
        .setRange(outputStart, outputStart + width, current.labels);
    input.confidence.setRange(
      outputStart,
      outputStart + width,
      current.confidence,
    );
    for (int x = 0; x < width; x++) {
      _regularizeOnePixel(
        x: x,
        y: y,
        width: width,
        height: height,
        radius: radius,
        anchorConfidence: anchorConfidence,
        minimumNeighborSupport: minimumNeighborSupport,
        labelAt: (int xx, int yy) => rows[yy]!.labels[xx],
        confidenceAt: (int xx, int yy) => rows[yy]!.confidence[xx],
        currentLabel: current.labels[x],
        currentConfidence: current.confidence[x],
        neighborLabels: neighborLabels,
        neighborWeights: neighborWeights,
        onReplacement: (int label, double confidence) {
          input.frameIndices[outputStart + x] = label;
          input.confidence[outputStart + x] = confidence;
        },
      );
    }
  }
}

void _regularizeOnePixel({
  required int x,
  required int y,
  required int width,
  required int height,
  required int radius,
  required double anchorConfidence,
  required double minimumNeighborSupport,
  required int Function(int x, int y) labelAt,
  required double Function(int x, int y) confidenceAt,
  required int currentLabel,
  required double currentConfidence,
  required Int32List neighborLabels,
  required Float64List neighborWeights,
  required void Function(int label, double confidence) onReplacement,
}) {
  if (currentConfidence >= anchorConfidence) return;
  int neighborCount = 0;
  double totalWeight = 0;
  for (int dy = -radius; dy <= radius; dy++) {
    final int yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (int dx = -radius; dx <= radius; dx++) {
      final int xx = x + dx;
      if (xx < 0 || xx >= width || (dx == 0 && dy == 0)) continue;
      final double neighborConfidence = confidenceAt(xx, yy);
      if (!(neighborConfidence > 0)) continue;
      final double distance = math.sqrt((dx * dx + dy * dy).toDouble());
      final double weight = neighborConfidence / (1 + distance);
      neighborLabels[neighborCount] = labelAt(xx, yy);
      neighborWeights[neighborCount] = weight;
      neighborCount++;
      totalWeight += weight;
    }
  }
  if (totalWeight < minimumNeighborSupport || neighborCount == 0) return;
  _sortWeightedLabels(neighborLabels, neighborWeights, neighborCount);
  final double half = totalWeight * 0.5;
  double cumulative = 0;
  int medianLabel = neighborLabels[neighborCount - 1];
  for (int neighbor = 0; neighbor < neighborCount; neighbor++) {
    cumulative += neighborWeights[neighbor];
    if (cumulative >= half) {
      medianLabel = neighborLabels[neighbor];
      break;
    }
  }
  if (medianLabel == currentLabel) return;
  double candidateWeight = 0;
  for (int neighbor = 0; neighbor < neighborCount; neighbor++) {
    if (neighborLabels[neighbor] == medianLabel) {
      candidateWeight += neighborWeights[neighbor];
    }
  }
  final double candidateFraction = candidateWeight / totalWeight;
  if (candidateFraction <= 0.5) return;
  onReplacement(
    medianLabel,
    math.max(currentConfidence, candidateFraction.clamp(0, 1).toDouble()),
  );
}

Future<void> _readExact(RandomAccessFile file, Uint8List destination) async {
  int offset = 0;
  while (offset < destination.length) {
    final int read =
        await file.readInto(destination, offset, destination.length);
    if (read == 0) {
      throw StateError('Focus regularization file ended inside a row.');
    }
    offset += read;
  }
}

/// Two-pass regularization with both input and output winner maps file-backed.
/// This removes the remaining full-image Int32/Float32 winner pair from the
/// production focus-stack path.
Future<FileBackedFocusWinnerMap> regularizeFileBackedFocusWinnerMapTwoPass(
  FileBackedFocusWinnerMap input, {
  int radius = 2,
  double anchorConfidence = 0.55,
  double minimumNeighborSupport = 1.5,
  Directory? temporaryDirectory,
  void Function()? checkCancelled,
}) async {
  if (radius < 1 || radius > 16) {
    throw ArgumentError.value(radius, 'radius');
  }
  if (!anchorConfidence.isFinite ||
      anchorConfidence < 0 ||
      anchorConfidence > 1 ||
      !minimumNeighborSupport.isFinite ||
      minimumNeighborSupport < 0) {
    throw ArgumentError('Invalid focus-map regularization parameters.');
  }
  FileBackedFocusWinnerMap? pass1;
  FileBackedFocusWinnerMap? pass2;
  try {
    pass1 = await FileBackedFocusWinnerMap.createTemporary(
      width: input.width,
      height: input.height,
      directory: temporaryDirectory,
      prefix: 'regularized-pass1',
    );
    await _regularizeFilePass(
      input: input,
      output: pass1,
      radius: radius,
      anchorConfidence: anchorConfidence,
      minimumNeighborSupport: minimumNeighborSupport,
      checkCancelled: checkCancelled,
    );

    pass2 = await FileBackedFocusWinnerMap.createTemporary(
      width: input.width,
      height: input.height,
      directory: temporaryDirectory,
      prefix: 'regularized-pass2',
    );
    await _regularizeFilePass(
      input: pass1,
      output: pass2,
      radius: radius,
      anchorConfidence: anchorConfidence,
      minimumNeighborSupport: minimumNeighborSupport,
      checkCancelled: checkCancelled,
    );
    await pass1.dispose();
    pass1 = null;
    return pass2;
  } catch (_) {
    await pass1?.dispose();
    await pass2?.dispose();
    rethrow;
  }
}

Future<void> _regularizeFilePass({
  required FileBackedFocusWinnerMap input,
  required FileBackedFocusWinnerMap output,
  required int radius,
  required double anchorConfidence,
  required double minimumNeighborSupport,
  void Function()? checkCancelled,
}) async {
  final int width = input.width;
  final int height = input.height;
  final int maximumNeighbors = (radius * 2 + 1) * (radius * 2 + 1) - 1;
  final Int32List neighborLabels = Int32List(maximumNeighbors);
  final Float64List neighborWeights = Float64List(maximumNeighbors);

  await output.writeAllFromChunks(
    producer: (RandomAccessFile labelsWriter,
        RandomAccessFile confidenceWriter) async {
      for (int y = 0; y < height; y++) {
        checkCancelled?.call();
        final int firstRow = math.max(0, y - radius);
        final int lastRow = math.min(height - 1, y + radius);
        final FocusWinnerRegion region = await input.readRegion(
          x: 0,
          y: firstRow,
          width: width,
          height: lastRow - firstRow + 1,
        );
        final int currentLocalY = y - firstRow;
        final Int32List outputLabels = Int32List(width);
        final Float32List outputConfidence = Float32List(width);
        final int currentStart = currentLocalY * width;
        outputLabels.setRange(
          0,
          width,
          region.frameIndices,
          currentStart,
        );
        outputConfidence.setRange(
          0,
          width,
          region.confidence,
          currentStart,
        );

        for (int x = 0; x < width; x++) {
          final int localIndex = currentStart + x;
          _regularizeOnePixel(
            x: x,
            y: y,
            width: width,
            height: height,
            radius: radius,
            anchorConfidence: anchorConfidence,
            minimumNeighborSupport: minimumNeighborSupport,
            labelAt: (int xx, int yy) {
              final int localY = yy - firstRow;
              return region.frameIndices[localY * width + xx];
            },
            confidenceAt: (int xx, int yy) {
              final int localY = yy - firstRow;
              return region.confidence[localY * width + xx];
            },
            currentLabel: region.frameIndices[localIndex],
            currentConfidence: region.confidence[localIndex],
            neighborLabels: neighborLabels,
            neighborWeights: neighborWeights,
            onReplacement: (int label, double confidence) {
              outputLabels[x] = label;
              outputConfidence[x] = confidence;
            },
          );
        }
        await labelsWriter.writeFrom(outputLabels.buffer.asUint8List());
        await confidenceWriter.writeFrom(outputConfidence.buffer.asUint8List());
      }
    },
  );
}
