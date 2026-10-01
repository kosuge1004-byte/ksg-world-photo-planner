import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../registration/luminance_plane.dart';

final class FocusMeasurePlane {
  FocusMeasurePlane({
    required this.width,
    required this.height,
    required Float32List scores,
  }) : scores = scores {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Focus-measure dimensions must be positive.');
    }
    if (scores.length != width * height) {
      throw ArgumentError(
          'Focus-measure sample count does not match dimensions.');
    }
    for (final double score in scores) {
      if (!score.isFinite || score < 0) {
        throw ArgumentError(
            'Focus-measure scores must be finite and non-negative.');
      }
    }
  }

  final int width;
  final int height;
  final Float32List scores;

  double scoreAt(int x, int y) {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      throw RangeError('Focus-measure coordinate is outside the plane.');
    }
    return scores[y * width + x];
  }
}

FocusMeasurePlane modifiedLaplacianFocusMeasure(
  LuminancePlane luminance, {
  int supportRadius = 2,
  Uint8List? validMask,
}) {
  if (supportRadius < 0 || supportRadius > 32) {
    throw ArgumentError.value(supportRadius, 'supportRadius');
  }
  final int width = luminance.width;
  final int height = luminance.height;
  final int pixelCount = width * height;
  if (validMask != null && validMask.length != pixelCount) {
    throw ArgumentError('Focus-measure valid mask does not match dimensions.');
  }
  final int integralWidth = width + 1;
  final Float64List integral = Float64List(integralWidth * (height + 1));
  final Int32List validIntegral = Int32List(integralWidth * (height + 1));
  for (int y = 0; y < height; y++) {
    double rowSum = 0;
    for (int x = 0; x < width; x++) {
      final int index = y * width + x;
      double response = 0;
      int responseValid = 0;
      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        if (validMask == null ||
            (validMask[index] != 0 &&
                validMask[index - 1] != 0 &&
                validMask[index + 1] != 0 &&
                validMask[index - width] != 0 &&
                validMask[index + width] != 0)) {
          final double center = luminance.samples[index];
          final double left = luminance.samples[index - 1];
          final double right = luminance.samples[index + 1];
          final double up = luminance.samples[index - width];
          final double down = luminance.samples[index + width];
          if (!center.isFinite ||
              !left.isFinite ||
              !right.isFinite ||
              !up.isFinite ||
              !down.isFinite) {
            throw ArgumentError('Luminance contains a non-finite sample.');
          }
          final double horizontal = (left - 2 * center + right).abs();
          final double vertical = (up - 2 * center + down).abs();
          response = horizontal + vertical;
          responseValid = 1;
        }
      }
      rowSum += response;
      integral[(y + 1) * integralWidth + (x + 1)] =
          integral[y * integralWidth + (x + 1)] + rowSum;
      validIntegral[(y + 1) * integralWidth + (x + 1)] =
          validIntegral[y * integralWidth + (x + 1)] +
              validIntegral[(y + 1) * integralWidth + x] -
              validIntegral[y * integralWidth + x] +
              responseValid;
    }
  }

  final Float32List scores = Float32List(pixelCount);
  for (int y = 0; y < height; y++) {
    final int y0 = math.max(0, y - supportRadius);
    final int y1 = math.min(height - 1, y + supportRadius);
    for (int x = 0; x < width; x++) {
      final int x0 = math.max(0, x - supportRadius);
      final int x1 = math.min(width - 1, x + supportRadius);
      final int a = y0 * integralWidth + x0;
      final int b = y0 * integralWidth + (x1 + 1);
      final int c = (y1 + 1) * integralWidth + x0;
      final int d = (y1 + 1) * integralWidth + (x1 + 1);
      final double sum = integral[d] - integral[b] - integral[c] + integral[a];
      final int validCount = validIntegral[d] -
          validIntegral[b] -
          validIntegral[c] +
          validIntegral[a];
      if (validCount == 0 ||
          (validMask != null && validMask[y * width + x] == 0)) {
        scores[y * width + x] = 0;
        continue;
      }
      final double score = sum / validCount;
      if (!score.isFinite || score < 0 || score > _maximumFloat32) {
        throw StateError('Focus measure exceeded finite Float32 range.');
      }
      scores[y * width + x] = score;
    }
  }

  return FocusMeasurePlane(width: width, height: height, scores: scores);
}

/// Writes the same Float32 focus scores as [modifiedLaplacianFocusMeasure]
/// while keeping only integral-image rows in memory. The full integral planes
/// live in temporary files and are removed before this future completes.
Future<void> writeModifiedLaplacianFocusMeasureFile({
  required LuminancePlane luminance,
  required int supportRadius,
  required File outputFile,
  Uint8List? validMask,
  void Function()? checkCancelled,
}) async {
  if (supportRadius < 0 || supportRadius > 32) {
    throw ArgumentError.value(supportRadius, 'supportRadius');
  }
  final int width = luminance.width;
  final int height = luminance.height;
  final int pixelCount = width * height;
  if (validMask != null && validMask.length != pixelCount) {
    throw ArgumentError('Focus-measure valid mask does not match dimensions.');
  }

  final int integralWidth = width + 1;
  final int sumRowBytes = integralWidth * Float64List.bytesPerElement;
  final int validRowBytes = integralWidth * Int32List.bytesPerElement;
  final File sumFile = File('${outputFile.path}.sum.f64');
  final File validFile = File('${outputFile.path}.valid.i32');
  RandomAccessFile? sumWriter;
  RandomAccessFile? validWriter;
  try {
    sumWriter = await sumFile.open(mode: FileMode.write);
    validWriter = await validFile.open(mode: FileMode.write);
    Float64List previousSum = Float64List(integralWidth);
    Float64List currentSum = Float64List(integralWidth);
    Int32List previousValid = Int32List(integralWidth);
    Int32List currentValid = Int32List(integralWidth);
    await sumWriter.writeFrom(previousSum.buffer.asUint8List());
    await validWriter.writeFrom(previousValid.buffer.asUint8List());

    for (int y = 0; y < height; y++) {
      if ((y & 31) == 0) checkCancelled?.call();
      double rowSum = 0;
      currentSum[0] = 0;
      currentValid[0] = 0;
      for (int x = 0; x < width; x++) {
        final int index = y * width + x;
        double response = 0;
        int responseValid = 0;
        if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
          if (validMask == null ||
              (validMask[index] != 0 &&
                  validMask[index - 1] != 0 &&
                  validMask[index + 1] != 0 &&
                  validMask[index - width] != 0 &&
                  validMask[index + width] != 0)) {
            final double center = luminance.samples[index];
            final double left = luminance.samples[index - 1];
            final double right = luminance.samples[index + 1];
            final double up = luminance.samples[index - width];
            final double down = luminance.samples[index + width];
            if (!center.isFinite ||
                !left.isFinite ||
                !right.isFinite ||
                !up.isFinite ||
                !down.isFinite) {
              throw ArgumentError('Luminance contains a non-finite sample.');
            }
            final double horizontal = (left - 2 * center + right).abs();
            final double vertical = (up - 2 * center + down).abs();
            response = horizontal + vertical;
            responseValid = 1;
          }
        }
        rowSum += response;
        currentSum[x + 1] = previousSum[x + 1] + rowSum;
        currentValid[x + 1] = previousValid[x + 1] +
            currentValid[x] -
            previousValid[x] +
            responseValid;
      }
      await sumWriter.writeFrom(currentSum.buffer.asUint8List());
      await validWriter.writeFrom(currentValid.buffer.asUint8List());
      final Float64List sumSwap = previousSum;
      previousSum = currentSum;
      currentSum = sumSwap;
      final Int32List validSwap = previousValid;
      previousValid = currentValid;
      currentValid = validSwap;
    }
    await sumWriter.flush();
    await validWriter.flush();
    await sumWriter.close();
    sumWriter = null;
    await validWriter.close();
    validWriter = null;

    final RandomAccessFile sumReader = await sumFile.open(mode: FileMode.read);
    final RandomAccessFile validReader =
        await validFile.open(mode: FileMode.read);
    final RandomAccessFile scoreWriter =
        await outputFile.open(mode: FileMode.write);
    try {
      final Float64List topSum = Float64List(integralWidth);
      final Float64List bottomSum = Float64List(integralWidth);
      final Int32List topValid = Int32List(integralWidth);
      final Int32List bottomValid = Int32List(integralWidth);
      final Float32List scoreRow = Float32List(width);
      for (int y = 0; y < height; y++) {
        if ((y & 31) == 0) checkCancelled?.call();
        final int y0 = math.max(0, y - supportRadius);
        final int y1 = math.min(height - 1, y + supportRadius);
        await _readTypedRow(sumReader, topSum, y0 * sumRowBytes);
        await _readTypedRow(sumReader, bottomSum, (y1 + 1) * sumRowBytes);
        await _readTypedRow(validReader, topValid, y0 * validRowBytes);
        await _readTypedRow(
          validReader,
          bottomValid,
          (y1 + 1) * validRowBytes,
        );
        for (int x = 0; x < width; x++) {
          final int x0 = math.max(0, x - supportRadius);
          final int x1 = math.min(width - 1, x + supportRadius);
          final double sum =
              bottomSum[x1 + 1] - topSum[x1 + 1] - bottomSum[x0] + topSum[x0];
          final int validCount = bottomValid[x1 + 1] -
              topValid[x1 + 1] -
              bottomValid[x0] +
              topValid[x0];
          if (validCount == 0 ||
              (validMask != null && validMask[y * width + x] == 0)) {
            scoreRow[x] = 0;
            continue;
          }
          final double score = sum / validCount;
          if (!score.isFinite || score < 0 || score > _maximumFloat32) {
            throw StateError('Focus measure exceeded finite Float32 range.');
          }
          scoreRow[x] = score;
        }
        await scoreWriter.writeFrom(scoreRow.buffer.asUint8List());
      }
      await scoreWriter.flush();
    } finally {
      await _closeRandomAccessFilesBestEffort(
        <RandomAccessFile?>[scoreWriter, validReader, sumReader],
      );
    }
  } finally {
    try {
      await _closeRandomAccessFilesBestEffort(
        <RandomAccessFile?>[sumWriter, validWriter],
      );
    } finally {
      await _deleteFilesBestEffort(<File>[validFile, sumFile]);
    }
  }
}

Future<void> _closeRandomAccessFilesBestEffort(
  Iterable<RandomAccessFile?> handles,
) async {
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
  if (firstError != null) {
    Error.throwWithStackTrace(firstError, firstStackTrace!);
  }
}

Future<void> _deleteFilesBestEffort(Iterable<File> files) async {
  Object? firstError;
  StackTrace? firstStackTrace;
  for (final File file in files) {
    try {
      if (await file.exists()) await file.delete();
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
  }
  if (firstError != null) {
    Error.throwWithStackTrace(firstError, firstStackTrace!);
  }
}

/// Computes the same [FocusMeasurePlane] as
/// [modifiedLaplacianFocusMeasure] without retaining its full-resolution
/// Float64 and Int32 integral images in the Dart heap.
///
/// The file writer is bit-exact with the in-memory implementation. Only the
/// final Float32 score plane is loaded after both integral sidecars have been
/// closed and removed.
Future<FocusMeasurePlane> computeModifiedLaplacianFocusMeasureMemoryBounded(
  LuminancePlane luminance, {
  int supportRadius = 2,
  Uint8List? validMask,
  void Function()? checkCancelled,
}) async {
  final Directory directory =
      await Directory.systemTemp.createTemp('mobile-stack-focus-measure-');
  final File output = File(
    '${directory.path}${Platform.pathSeparator}scores.f32',
  );
  try {
    await writeModifiedLaplacianFocusMeasureFile(
      luminance: luminance,
      supportRadius: supportRadius,
      outputFile: output,
      validMask: validMask,
      checkCancelled: checkCancelled,
    );
    final Uint8List bytes = await output.readAsBytes();
    final int expectedBytes =
        luminance.width * luminance.height * Float32List.bytesPerElement;
    if (bytes.lengthInBytes != expectedBytes) {
      throw StateError('Focus-measure score file has an invalid length.');
    }
    final Float32List scores = Float32List.view(
      bytes.buffer,
      bytes.offsetInBytes,
      bytes.lengthInBytes ~/ Float32List.bytesPerElement,
    );
    return FocusMeasurePlane(
      width: luminance.width,
      height: luminance.height,
      scores: scores,
    );
  } finally {
    if (await directory.exists()) await directory.delete(recursive: true);
  }
}

Future<void> _readTypedRow(
  RandomAccessFile reader,
  TypedData row,
  int byteOffset,
) async {
  await reader.setPosition(byteOffset);
  final Uint8List bytes = row.buffer.asUint8List(
    row.offsetInBytes,
    row.lengthInBytes,
  );
  int readOffset = 0;
  while (readOffset < bytes.length) {
    final int read = await reader.readInto(bytes, readOffset, bytes.length);
    if (read == 0) {
      throw StateError('Focus integral file ended before its last row.');
    }
    readOffset += read;
  }
}

const double _maximumFloat32 = 3.4028234663852886e38;
