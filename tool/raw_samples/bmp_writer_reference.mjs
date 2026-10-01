/// Reference 24-bit uncompressed BMP (Windows Bitmap, BITMAPINFOHEADER
/// variant) encoder for Mobile Stack's final output stage.
///
/// Written from scratch, matching the well-documented, decades-stable
/// Windows BMP binary format exactly, rather than depending on an image
/// encoding library: this project has no image-format dependency at all
/// today (confirmed by inspecting `pubspec.yaml`), and this sandbox has
/// no access to `pub.dev` to add and verify one (see
/// WORK55_PROGRESS.md for how this was confirmed, not merely assumed).
/// BMP was chosen specifically because, unlike PNG or JPEG, it needs no
/// compression codec (DEFLATE, Huffman coding, discrete cosine
/// transform, ...) to implement correctly — the format is a fixed-size
/// header plus a literal, uncompressed pixel array — making it
/// realistic to get exactly right through careful, spec-verified
/// implementation without the ability to execute and directly confirm
/// the output against a real image viewer. The resulting files are
/// larger than a compressed format would produce and are not this
/// project's intended long-term output format, but they are real,
/// standard, universally-openable image files today, which is what
/// closes WORK52_PROGRESS.md's step 3 ("write the combined output
/// somewhere durable") meaningfully rather than only in principle.
///
/// Reference: the BITMAPFILEHEADER/BITMAPINFOHEADER structures are part
/// of the stable, unchanged-since-Windows-3.0 BMP specification; this
/// implementation targets exactly that baseline (no color tables, no
/// compression, no alpha, no ICC profiles) for maximum compatibility.

export class InvalidBmpInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidBmpInput';
  }
}

const FILE_HEADER_SIZE = 14;
const DIB_HEADER_SIZE = 40; // BITMAPINFOHEADER
const PIXEL_DATA_OFFSET = FILE_HEADER_SIZE + DIB_HEADER_SIZE;
const BYTES_PER_PIXEL = 3; // 24-bit RGB, no alpha

function rowStrideBytes(width) {
  const rawRowBytes = width * BYTES_PER_PIXEL;
  // BMP pixel rows are padded to a multiple of 4 bytes.
  const padding = (4 - (rawRowBytes % 4)) % 4;
  return rawRowBytes + padding;
}

/// Encodes `rgb8` (an interleaved, top-to-bottom-row-order RGB byte
/// array — `Uint8Array` or `Uint8ClampedArray`, exactly `width * height
/// * 3` bytes, red first in each triple, matching {@link
/// module:tone_map_reference.toneMapToDisplayRgb}'s output shape) as a
/// complete, standalone 24-bit BMP file, returned as a `Uint8Array` of
/// file bytes ready to write to disk.
///
/// Throws {@link InvalidBmpInput} if `width`/`height` are not positive
/// integers or `rgb8`'s length does not match `width * height * 3`.
export function encodeBmp({ width, height, rgb8 }) {
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0) {
    throw new InvalidBmpInput('width and height must be positive integers.');
  }
  if (width > 0x7fff || height > 0x7fff) {
    // BITMAPINFOHEADER's width/height are signed 32-bit, so this limit
    // is far more conservative than the format itself requires; chosen
    // simply because no real output from this project's pipeline should
    // ever approach it, and it catches an accidental unit mix-up (e.g.
    // passing a byte count where a pixel count was expected) early.
    throw new InvalidBmpInput('width and height must each be at most 32767.');
  }
  if (!(rgb8 instanceof Uint8Array) && !(rgb8 instanceof Uint8ClampedArray)) {
    throw new InvalidBmpInput('rgb8 must be a Uint8Array or Uint8ClampedArray.');
  }
  if (rgb8.length !== width * height * BYTES_PER_PIXEL) {
    throw new InvalidBmpInput(
      'rgb8 length must equal width * height * 3.',
    );
  }

  const strideBytes = rowStrideBytes(width);
  const pixelDataSize = strideBytes * height;
  const fileSize = PIXEL_DATA_OFFSET + pixelDataSize;

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // --- BITMAPFILEHEADER (14 bytes) ---
  bytes[0] = 0x42; // 'B'
  bytes[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint16(6, 0, true); // reserved1
  view.setUint16(8, 0, true); // reserved2
  view.setUint32(10, PIXEL_DATA_OFFSET, true);

  // --- BITMAPINFOHEADER (40 bytes) ---
  view.setUint32(14, DIB_HEADER_SIZE, true);
  view.setInt32(18, width, true);
  // A positive height means the pixel array is stored bottom-up (the
  // classic, maximum-compatibility BMP row order); see the row-writing
  // loop below, which writes source row (height-1-outputRow) into each
  // successive output row to produce exactly that order.
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true); // color planes, must be 1
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(30, 0, true); // compression: BI_RGB (none)
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 2835, true); // ~72 DPI horizontal (2835 px/meter)
  view.setInt32(42, 2835, true); // ~72 DPI vertical
  view.setUint32(46, 0, true); // colors used (0 = 2^n, n/a for 24-bit)
  view.setUint32(50, 0, true); // important colors (0 = all)

  // --- Pixel data: bottom-up rows, BGR byte order, row-padded to a
  // multiple of 4 bytes ---
  for (let outputRow = 0; outputRow < height; outputRow++) {
    const sourceRow = height - 1 - outputRow;
    const rowStart = PIXEL_DATA_OFFSET + outputRow * strideBytes;
    for (let x = 0; x < width; x++) {
      const sourceIndex = (sourceRow * width + x) * BYTES_PER_PIXEL;
      const destIndex = rowStart + x * BYTES_PER_PIXEL;
      bytes[destIndex] = rgb8[sourceIndex + 2]; // B
      bytes[destIndex + 1] = rgb8[sourceIndex + 1]; // G
      bytes[destIndex + 2] = rgb8[sourceIndex]; // R
    }
    // Padding bytes (if any) are already zero from ArrayBuffer's
    // zero-initialization; nothing further to write there.
  }

  return bytes;
}
