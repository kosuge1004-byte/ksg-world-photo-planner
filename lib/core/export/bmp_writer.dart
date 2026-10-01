import 'dart:typed_data';

/// Dart port of `tool/raw_samples/bmp_writer_reference.mjs`.
///
/// A 24-bit uncompressed BMP (Windows Bitmap, BITMAPINFOHEADER variant)
/// encoder, written from scratch rather than depending on an image
/// encoding library: this project has no image-format dependency at all
/// (confirmed by inspecting `pubspec.yaml`), and this sandbox has no
/// access to `pub.dev` to add and verify one (see WORK55_PROGRESS.md).
/// BMP was chosen specifically because, unlike PNG or JPEG, it needs no
/// compression codec to implement correctly — the format is a
/// fixed-size header plus a literal, uncompressed pixel array — making
/// it realistic to get exactly right through careful, spec-verified
/// implementation without the ability to execute and directly confirm
/// the output against a real image viewer here. The Node reference this
/// ports was independently verified against Pillow (a real, external,
/// mature image library) with zero pixel mismatches across a
/// non-4-byte-aligned test gradient — see WORK55_PROGRESS.md for that
/// verification's details, which this Dart port could not repeat itself
/// (no way to execute Dart here) but was translated line-for-line
/// against.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference. Run `test/bmp_writer_test.dart`
/// (mirroring the Node fixtures, including the exact hand-computed byte
/// sequence check) before relying on this in production.

class InvalidBmpInput extends ArgumentError {
  InvalidBmpInput(super.message);
}

const int _fileHeaderSize = 14;
const int _dibHeaderSize = 40; // BITMAPINFOHEADER
const int _pixelDataOffset = _fileHeaderSize + _dibHeaderSize;
const int _bytesPerPixel = 3; // 24-bit RGB, no alpha

int _rowStrideBytes(int width) {
  final int rawRowBytes = width * _bytesPerPixel;
  // BMP pixel rows are padded to a multiple of 4 bytes.
  final int padding = (4 - (rawRowBytes % 4)) % 4;
  return rawRowBytes + padding;
}

int bmpRowStrideBytes(int width) {
  if (width <= 0 || width > 0x7fff) {
    throw InvalidBmpInput('width must be between 1 and 32767.');
  }
  return _rowStrideBytes(width);
}

Uint8List encodeBmpHeader({required int width, required int height}) {
  if (width <= 0 || height <= 0 || width > 0x7fff || height > 0x7fff) {
    throw InvalidBmpInput(
      'width and height must each be between 1 and 32767.',
    );
  }
  final int pixelDataSize = _rowStrideBytes(width) * height;
  final int fileSize = _pixelDataOffset + pixelDataSize;
  final Uint8List bytes = Uint8List(_pixelDataOffset);
  final ByteData view = ByteData.sublistView(bytes);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, fileSize, Endian.little);
  view.setUint32(10, _pixelDataOffset, Endian.little);
  view.setUint32(14, _dibHeaderSize, Endian.little);
  view.setInt32(18, width, Endian.little);
  view.setInt32(22, height, Endian.little);
  view.setUint16(26, 1, Endian.little);
  view.setUint16(28, 24, Endian.little);
  view.setUint32(30, 0, Endian.little);
  view.setUint32(34, pixelDataSize, Endian.little);
  view.setInt32(38, 2835, Endian.little);
  view.setInt32(42, 2835, Endian.little);
  return bytes;
}

/// Encodes [rgb8] (an interleaved, top-to-bottom-row-order RGB byte list
/// — exactly `width * height * 3` bytes, red first in each triple,
/// matching `tone_map.dart`'s `toneMapToDisplayRgb` output shape) as a
/// complete, standalone 24-bit BMP file, returned as a [Uint8List] of
/// file bytes ready to write to disk.
///
/// Throws [InvalidBmpInput] if [width]/[height] are not positive
/// integers (or exceed a conservative 32767 safety limit — see the
/// implementation for why) or [rgb8]'s length does not match `width *
/// height * 3`.
Uint8List encodeBmp({
  required int width,
  required int height,
  required Uint8List rgb8,
}) {
  if (width <= 0 || height <= 0) {
    throw InvalidBmpInput('width and height must be positive integers.');
  }
  if (width > 0x7fff || height > 0x7fff) {
    // BITMAPINFOHEADER's width/height are signed 32-bit, so this limit
    // is far more conservative than the format itself requires; chosen
    // simply because no real output from this project's pipeline should
    // ever approach it, and it catches an accidental unit mix-up (e.g.
    // passing a byte count where a pixel count was expected) early.
    throw InvalidBmpInput('width and height must each be at most 32767.');
  }
  if (rgb8.length != width * height * _bytesPerPixel) {
    throw InvalidBmpInput('rgb8 length must equal width * height * 3.');
  }

  final int strideBytes = _rowStrideBytes(width);
  final int pixelDataSize = strideBytes * height;
  final int fileSize = _pixelDataOffset + pixelDataSize;

  final Uint8List bytes = Uint8List(fileSize);
  final ByteData view = ByteData.sublistView(bytes);

  // --- BITMAPFILEHEADER (14 bytes) ---
  bytes[0] = 0x42; // 'B'
  bytes[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, Endian.little);
  view.setUint16(6, 0, Endian.little); // reserved1
  view.setUint16(8, 0, Endian.little); // reserved2
  view.setUint32(10, _pixelDataOffset, Endian.little);

  // --- BITMAPINFOHEADER (40 bytes) ---
  view.setUint32(14, _dibHeaderSize, Endian.little);
  view.setInt32(18, width, Endian.little);
  // A positive height means the pixel array is stored bottom-up (the
  // classic, maximum-compatibility BMP row order); see the row-writing
  // loop below, which writes source row (height-1-outputRow) into each
  // successive output row to produce exactly that order.
  view.setInt32(22, height, Endian.little);
  view.setUint16(26, 1, Endian.little); // color planes, must be 1
  view.setUint16(28, 24, Endian.little); // bits per pixel
  view.setUint32(30, 0, Endian.little); // compression: BI_RGB (none)
  view.setUint32(34, pixelDataSize, Endian.little);
  view.setInt32(38, 2835, Endian.little); // ~72 DPI horizontal
  view.setInt32(42, 2835, Endian.little); // ~72 DPI vertical
  view.setUint32(46, 0, Endian.little); // colors used (0 = 2^n, n/a)
  view.setUint32(50, 0, Endian.little); // important colors (0 = all)

  // --- Pixel data: bottom-up rows, BGR byte order, row-padded to a
  // multiple of 4 bytes ---
  for (int outputRow = 0; outputRow < height; outputRow++) {
    final int sourceRow = height - 1 - outputRow;
    final int rowStart = _pixelDataOffset + outputRow * strideBytes;
    for (int x = 0; x < width; x++) {
      final int sourceIndex = (sourceRow * width + x) * _bytesPerPixel;
      final int destIndex = rowStart + x * _bytesPerPixel;
      bytes[destIndex] = rgb8[sourceIndex + 2]; // B
      bytes[destIndex + 1] = rgb8[sourceIndex + 1]; // G
      bytes[destIndex + 2] = rgb8[sourceIndex]; // R
    }
    // Padding bytes (if any) are already zero from Uint8List's
    // zero-initialization; nothing further to write there.
  }

  return bytes;
}
