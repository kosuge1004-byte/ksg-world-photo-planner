import 'dart:typed_data';

/// Compact, immutable one-bit-per-pixel record of sensor saturation.
///
/// The mask is captured in the sensor RAW domain before black subtraction.
/// For DNG files with a LinearizationTable, the stored encoding is first mapped
/// to its linearized RAW value and saturation is then compared with WhiteLevel.
/// It must not be inferred after black subtraction, white normalization, white
/// balance, or flat-field correction because those operations change sample
/// values without changing whether the sensor site clipped during exposure.
final class RawSaturationMask {
  RawSaturationMask._(this.pixelCount, Uint8List bits, this.saturatedCount)
      : _bits = bits,
        _runs = null;

  RawSaturationMask._sparse(
    this.pixelCount,
    Uint32List runs,
    this.saturatedCount,
  )   : _bits = null,
        _runs = runs;

  /// Builds a packed saturation mask directly from an FP32 RAW plane while
  /// validating finiteness in the same pass. This avoids the extra full-frame
  /// validation scan and the per-pixel predicate callback used by the generic
  /// constructor. The saturation rule remains exactly `sample >= whiteLevel`.
  factory RawSaturationMask.fromFiniteFloat32Threshold(
    Float32List samples,
    double whiteLevel,
  ) {
    if (!whiteLevel.isFinite || whiteLevel <= 0) {
      throw ArgumentError.value(whiteLevel, 'whiteLevel');
    }
    final int pixelCount = samples.length;
    final Uint8List bits = Uint8List((pixelCount + 7) >> 3);
    int saturatedCount = 0;
    for (int index = 0; index < pixelCount; index++) {
      final double sample = samples[index];
      if (!sample.isFinite) {
        throw StateError('RAW sample buffer contains a non-finite value.');
      }
      if (sample < whiteLevel) continue;
      bits[index >> 3] |= 1 << (index & 7);
      saturatedCount++;
    }
    return RawSaturationMask._(pixelCount, bits, saturatedCount);
  }

  /// Takes ownership of an already-packed one-bit-per-pixel mask.
  ///
  /// This is intended for hot full-frame calibration paths that already build
  /// packed bits while transforming samples. No pixel-sized temporary byte
  /// mask or second full-frame predicate scan is required. [packedBytes] must
  /// not be mutated after this call.
  factory RawSaturationMask.takePackedBytes({
    required int pixelCount,
    required Uint8List packedBytes,
    required int saturatedCount,
  }) {
    if (pixelCount < 0) {
      throw ArgumentError.value(pixelCount, 'pixelCount');
    }
    final int expectedBytes = (pixelCount + 7) >> 3;
    if (packedBytes.length != expectedBytes) {
      throw ArgumentError.value(
        packedBytes.length,
        'packedBytes.length',
        'Expected $expectedBytes packed bytes for $pixelCount pixels.',
      );
    }
    if (saturatedCount < 0 || saturatedCount > pixelCount) {
      throw ArgumentError.value(saturatedCount, 'saturatedCount');
    }
    return RawSaturationMask._(pixelCount, packedBytes, saturatedCount);
  }

  factory RawSaturationMask.fromPredicate(
    int pixelCount,
    bool Function(int index) isSaturated,
  ) {
    if (pixelCount < 0) {
      throw ArgumentError.value(pixelCount, 'pixelCount');
    }
    final Uint8List bits = Uint8List((pixelCount + 7) >> 3);
    int saturatedCount = 0;
    for (int index = 0; index < pixelCount; index++) {
      if (!isSaturated(index)) continue;
      bits[index >> 3] |= 1 << (index & 7);
      saturatedCount++;
    }
    return RawSaturationMask._(pixelCount, bits, saturatedCount);
  }

  final int pixelCount;
  final Uint8List? _bits;
  final Uint32List? _runs;
  final int saturatedCount;

  int get packedByteLength => (pixelCount + 7) >> 3;
  bool get isEmpty => saturatedCount == 0;

  RawSaturationMask dilatedChebyshev({
    required int width,
    required int height,
    required int radius,
  }) {
    if (width <= 0 || height <= 0 || width * height != pixelCount) {
      throw ArgumentError('Saturation-mask dimensions do not match.');
    }
    if (radius < 0) {
      throw ArgumentError.value(radius, 'radius');
    }
    if (radius == 0 || isEmpty) return this;

    final Uint8List outputBits = Uint8List((pixelCount + 7) >> 3);
    int outputCount = 0;
    void setBit(int index) {
      final int byteIndex = index >> 3;
      final int bit = 1 << (index & 7);
      if ((outputBits[byteIndex] & bit) != 0) return;
      outputBits[byteIndex] |= bit;
      outputCount++;
    }

    for (int index = 0; index < pixelCount; index++) {
      if (!isSaturatedIndex(index)) continue;
      final int y = index ~/ width;
      final int x = index - y * width;
      final int y0 = (y - radius).clamp(0, height - 1).toInt();
      final int y1 = (y + radius).clamp(0, height - 1).toInt();
      final int x0 = (x - radius).clamp(0, width - 1).toInt();
      final int x1 = (x + radius).clamp(0, width - 1).toInt();
      for (int yy = y0; yy <= y1; yy++) {
        int row = yy * width + x0;
        for (int xx = x0; xx <= x1; xx++, row++) {
          setBit(row);
        }
      }
    }
    // A dilated saturation influence mask is normally a small number of
    // horizontal regions around bright stars. Keeping those regions as
    // start/end runs avoids retaining one full sensor-sized bit plane for
    // every frame in a 64-frame stack. Fall back to packed bits for dense
    // masks, where runs would use more memory.
    final List<int> runValues = <int>[];
    for (int y = 0; y < height; y++) {
      int x = 0;
      while (x < width) {
        int index = y * width + x;
        while (
            x < width && (outputBits[index >> 3] & (1 << (index & 7))) == 0) {
          x++;
          index++;
        }
        if (x >= width) break;
        final int start = index;
        while (
            x < width && (outputBits[index >> 3] & (1 << (index & 7))) != 0) {
          x++;
          index++;
        }
        runValues
          ..add(start)
          ..add(index);
      }
    }
    if (runValues.length * Uint32List.bytesPerElement < outputBits.length) {
      return RawSaturationMask._sparse(
        pixelCount,
        Uint32List.fromList(runValues),
        outputCount,
      );
    }
    return RawSaturationMask._(pixelCount, outputBits, outputCount);
  }

  bool isSaturatedIndex(int index) {
    RangeError.checkValidIndex(index, this, 'index', pixelCount);
    final Uint8List? bits = _bits;
    if (bits != null) {
      return (bits[index >> 3] & (1 << (index & 7))) != 0;
    }
    final Uint32List runs = _runs!;
    int low = 0;
    int high = runs.length ~/ 2 - 1;
    while (low <= high) {
      final int middle = (low + high) >> 1;
      final int start = runs[middle * 2];
      final int end = runs[middle * 2 + 1];
      if (index < start) {
        high = middle - 1;
      } else if (index >= end) {
        low = middle + 1;
      } else {
        return true;
      }
    }
    return false;
  }

  void copyPackedBytesTo(Uint8List target) {
    if (target.length != packedByteLength) {
      throw ArgumentError('Packed saturation-mask byte length does not match.');
    }
    final Uint8List? bits = _bits;
    if (bits != null) {
      target.setAll(0, bits);
      return;
    }
    target.fillRange(0, target.length, 0);
    final Uint32List runs = _runs!;
    for (int run = 0; run < runs.length; run += 2) {
      for (int index = runs[run]; index < runs[run + 1]; index++) {
        target[index >> 3] |= 1 << (index & 7);
      }
    }
  }

  Uint8List toPackedBytes() {
    final Uint8List packed = Uint8List(packedByteLength);
    copyPackedBytesTo(packed);
    return packed;
  }
}
