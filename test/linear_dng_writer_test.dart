import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/linear_rgb_color_transform.dart';
import 'package:mobile_stack/core/export/linear_dng_writer.dart';
import 'package:mobile_stack/core/image/linear_contribution_tile.dart';
import 'package:mobile_stack/core/image/linear_contribution_tile_store.dart';

import 'support/in_memory_rgb_tile_store.dart';

final class _MemoryContributionStore implements LinearContributionTileStore {
  _MemoryContributionStore({
    required this.width,
    required this.height,
    required Uint16List interleavedCounts,
  }) : _counts = interleavedCounts {
    if (_counts.length != width * height * 3) {
      throw ArgumentError('count length mismatch');
    }
  }

  @override
  final int width;
  @override
  final int height;
  final Uint16List _counts;

  @override
  int get persistentByteLength => _counts.length * Uint16List.bytesPerElement;
  @override
  int get completedTileCount => 1;
  @override
  bool get isCommitted => true;

  @override
  Future<LinearContributionTile> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    final Uint16List out = Uint16List(width * height * 3);
    for (int row = 0; row < height; row++) {
      for (int col = 0; col < width; col++) {
        final int src = (((y + row) * this.width) + x + col) * 3;
        final int dst = (row * width + col) * 3;
        out[dst] = _counts[src];
        out[dst + 1] = _counts[src + 1];
        out[dst + 2] = _counts[src + 2];
      }
    }
    return LinearContributionTile(
        x: x, y: y, width: width, height: height, interleavedCounts: out);
  }

  @override
  Future<void> writeTile(LinearContributionTile tile) =>
      throw UnsupportedError('read only');
  @override
  Future<void> commit() async {}
  @override
  Future<void> abort() async {}
  @override
  Future<void> dispose() async {}
}

Map<int, ({int type, int count, int value})> _ifd0(Uint8List bytes) {
  final ByteData data = ByteData.sublistView(bytes);
  expect(bytes[0], 0x49);
  expect(bytes[1], 0x49);
  expect(data.getUint16(2, Endian.little), 42);
  final int ifd = data.getUint32(4, Endian.little);
  final int count = data.getUint16(ifd, Endian.little);
  final result = <int, ({int type, int count, int value})>{};
  for (int index = 0; index < count; index++) {
    final int offset = ifd + 2 + index * 12;
    result[data.getUint16(offset, Endian.little)] = (
      type: data.getUint16(offset + 2, Endian.little),
      count: data.getUint32(offset + 4, Endian.little),
      value: data.getUint32(offset + 8, Endian.little),
    );
  }
  return result;
}

void main() {
  test('Float32 LinearRaw DNG header has the required color/profile contract',
      () {
    final LinearDngHeader header = encodeLinearDngFloat32Header(
      width: 32,
      height: 16,
      rowsPerStrip: 8,
    );
    final tags = _ifd0(header.bytes);
    expect(tags[262]!.value & 0xffff, 34892); // LinearRaw
    expect(tags[277]!.value & 0xffff, 3);
    expect(tags[339]!.count, 3); // SampleFormat x3
    expect(tags[50706]!.value, 0x00000401); // bytes 1,4,0,0
    expect(tags[50707]!.value, 0x00000401);
    expect(tags[50708]!.count, greaterThan(1)); // UniqueCameraModel
    expect(tags[50721]!.count, 9); // ColorMatrix1
    expect(
        tags[50728], isNull); // Synthetic D65 coordinates need no neutral gain.
    expect(tags[50729]!.count, 2); // AsShotWhiteXY = D65
    expect(tags[50778]!.value & 0xffff, 21); // D65
    expect(tags[51110]!.value, 1); // DefaultBlackRender=None
  });

  test('UniqueCameraModel is a NUL-terminated synthetic linear-sRGB model', () {
    final LinearDngHeader header = encodeLinearDngFloat32Header(
      width: 1,
      height: 1,
    );
    final tags = _ifd0(header.bytes);
    final model = tags[50708]!;
    final Uint8List encoded = Uint8List.sublistView(
      header.bytes,
      model.value,
      model.value + model.count,
    );
    expect(encoded.last, 0);
    expect(utf8.decode(encoded.sublist(0, encoded.length - 1)),
        'MobileStack Linear sRGB');
  });

  test('classic transparency SubIFD is resident before RGB pixel data', () {
    final LinearDngHeader header = encodeLinearDngFloat32Header(
      width: 32,
      height: 16,
      rowsPerStrip: 8,
      includeTransparencyMask: true,
    );
    final tags = _ifd0(header.bytes);
    final int subIfd = tags[330]!.value;
    expect(subIfd, greaterThan(0));
    expect(subIfd, lessThan(header.pixelDataOffset));
    final ByteData data = ByteData.sublistView(header.bytes);
    expect(data.getUint16(subIfd, Endian.little), 10);
    int? maskDataOffset;
    for (int index = 0; index < 10; index++) {
      final int entry = subIfd + 2 + index * 12;
      if (data.getUint16(entry, Endian.little) == 273) {
        maskDataOffset = data.getUint32(entry + 8, Endian.little);
      }
    }
    expect(maskDataOffset, header.transparencyMaskDataOffset);
    expect(maskDataOffset, greaterThanOrEqualTo(header.imageDataEndOffset));
  });

  test('classic thumbnail IFD and RGB8 pixels are header-resident', () {
    final LinearDngHeader header = encodeLinearDngFloat32Header(
      width: 32,
      height: 16,
      rowsPerStrip: 8,
      thumbnail: LinearDngThumbnail(
        width: 2,
        height: 1,
        interleavedSrgb8: Uint8List.fromList(<int>[1, 2, 3, 4, 5, 6]),
      ),
    );
    final ByteData data = ByteData.sublistView(header.bytes);
    final int ifd0 = data.getUint32(4, Endian.little);
    final int count0 = data.getUint16(ifd0, Endian.little);
    final int thumbnailIfd =
        data.getUint32(ifd0 + 2 + count0 * 12, Endian.little);
    expect(thumbnailIfd, header.thumbnailIfdOffset);
    expect(thumbnailIfd, lessThan(header.pixelDataOffset));
    expect(data.getUint16(thumbnailIfd, Endian.little), 13);
    final tags = <int, int>{};
    for (int index = 0; index < 13; index++) {
      final int entry = thumbnailIfd + 2 + index * 12;
      tags[data.getUint16(entry, Endian.little)] =
          data.getUint32(entry + 8, Endian.little);
    }
    expect(tags[254], 1);
    expect(tags[256], 2);
    expect(tags[257], 1);
    expect(tags[259]! & 0xffff, 1);
    expect(tags[262]! & 0xffff, 2);
    expect(tags[50970]! & 0xffff, 1);
    expect(tags[273], header.thumbnailDataOffset);
    expect(
      header.bytes.sublist(
          header.thumbnailDataOffset!, header.thumbnailDataOffset! + 6),
      orderedEquals(<int>[1, 2, 3, 4, 5, 6]),
    );
  });

  test('64-bit DNG header follows the DNG BigTIFF extension contract', () {
    final LinearDngHeader header = encodeBigLinearDngFloat32Header(
      width: 32,
      height: 16,
      rowsPerStrip: 8,
    );
    final ByteData data = ByteData.sublistView(header.bytes);
    expect(header.bytes[0], 0x49);
    expect(header.bytes[1], 0x49);
    expect(data.getUint16(2, Endian.little), 43);
    expect(data.getUint16(4, Endian.little), 8);
    expect(data.getUint16(6, Endian.little), 0);
    expect(data.getUint64(8, Endian.little), 16);
    final int ifd0 = data.getUint64(8, Endian.little);
    final int count0 = data.getUint64(ifd0, Endian.little);
    int? sampleFormat;
    for (int index = 0; index < count0; index++) {
      final int entry = ifd0 + 8 + index * 20;
      if (data.getUint16(entry, Endian.little) == 339) {
        sampleFormat = data.getUint64(entry + 12, Endian.little);
      }
    }
    expect(sampleFormat, 3 | (3 << 16) | (3 << 32));
  });

  test('64-bit thumbnail IFD and RGB8 pixels are header-resident', () {
    final LinearDngHeader header = encodeBigLinearDngFloat32Header(
      width: 32,
      height: 16,
      rowsPerStrip: 8,
      thumbnail: LinearDngThumbnail(
        width: 2,
        height: 1,
        interleavedSrgb8: Uint8List.fromList(<int>[6, 5, 4, 3, 2, 1]),
      ),
    );
    final ByteData data = ByteData.sublistView(header.bytes);
    final int ifd0 = data.getUint64(8, Endian.little);
    final int count0 = data.getUint64(ifd0, Endian.little);
    final int thumbnailIfd =
        data.getUint64(ifd0 + 8 + count0 * 20, Endian.little);
    expect(thumbnailIfd, header.thumbnailIfdOffset);
    expect(thumbnailIfd, lessThan(header.pixelDataOffset));
    expect(data.getUint64(thumbnailIfd, Endian.little), 13);
    final tags = <int, int>{};
    for (int index = 0; index < 13; index++) {
      final int entry = thumbnailIfd + 8 + index * 20;
      tags[data.getUint16(entry, Endian.little)] =
          data.getUint64(entry + 12, Endian.little);
    }
    expect(tags[258], 8 | (8 << 16) | (8 << 32));
    expect(tags[273], header.thumbnailDataOffset);
    expect(
      header.bytes.sublist(
          header.thumbnailDataOffset!, header.thumbnailDataOffset! + 6),
      orderedEquals(<int>[6, 5, 4, 3, 2, 1]),
    );
  });

  test('64-bit transparency SubIFD is resident before RGB pixel data', () {
    final LinearDngHeader header = encodeBigLinearDngFloat32Header(
      width: 32,
      height: 16,
      rowsPerStrip: 8,
      includeTransparencyMask: true,
    );
    final ByteData data = ByteData.sublistView(header.bytes);
    final int ifd0 = data.getUint64(8, Endian.little);
    final int count = data.getUint64(ifd0, Endian.little);
    int? subIfd;
    for (int index = 0; index < count; index++) {
      final int entry = ifd0 + 8 + index * 20;
      if (data.getUint16(entry, Endian.little) == 330) {
        subIfd = data.getUint64(entry + 12, Endian.little);
      }
    }
    expect(subIfd, isNotNull);
    expect(subIfd, lessThan(header.pixelDataOffset));
    expect(data.getUint64(subIfd!, Endian.little), 10);
    int? maskDataOffset;
    for (int index = 0; index < 10; index++) {
      final int entry = subIfd + 8 + index * 20;
      if (data.getUint16(entry, Endian.little) == 273) {
        maskDataOffset = data.getUint64(entry + 12, Endian.little);
      }
    }
    expect(maskDataOffset, header.transparencyMaskDataOffset);
    expect(maskDataOffset, greaterThanOrEqualTo(header.imageDataEndOffset));
  });

  test('complete transparency-mask DNG writes header IFD, RGB, then mask',
      () async {
    final Directory temp =
        await Directory.systemTemp.createTemp('mobile-stack-linear-dng-');
    final File output = File('${temp.path}${Platform.pathSeparator}masked.dng');
    try {
      await exportTileStoreToLinearDng(
        tileStore: InMemoryRgbTileStore(
          width: 2,
          height: 2,
          interleavedRgb: Float32List.fromList(<double>[
            .1,
            .2,
            .3,
            .4,
            .5,
            .6,
            .7,
            .8,
            .9,
            1,
            1.1,
            1.2,
          ]),
        ),
        outputPath: output.path,
        inputToLinearSrgb: LinearRgbColorTransform.identity(),
        rowsPerStrip: 2,
        transparencyMask: Uint8List.fromList(<int>[255, 0, 255, 0]),
      );
      final Uint8List bytes = await output.readAsBytes();
      final ByteData data = ByteData.sublistView(bytes);
      final tags = _ifd0(bytes);
      final int ifd0 = data.getUint32(4, Endian.little);
      final int count0 = data.getUint16(ifd0, Endian.little);
      final int thumbnailIfd =
          data.getUint32(ifd0 + 2 + count0 * 12, Endian.little);
      expect(thumbnailIfd, greaterThan(0));
      expect(data.getUint16(thumbnailIfd, Endian.little), 13);
      expect(tags[330]!.type, 4);
      expect(tags[330]!.count, 2);
      expect(data.getUint32(tags[330]!.value, Endian.little), thumbnailIfd);
      final int subIfd = data.getUint32(tags[330]!.value + 4, Endian.little);
      final int rgbOffset = tags[273]!.value;
      final int baselineExposureOffset = tags[50730]!.value;
      expect(
        data.getInt32(baselineExposureOffset, Endian.little),
        0,
        reason:
            'raw-domain headroom placement must not become Adobe display gain',
      );
      expect(data.getInt32(baselineExposureOffset + 4, Endian.little), 1);
      expect(subIfd, lessThan(rgbOffset));
      int? thumbnailOffset;
      for (int index = 0; index < 13; index++) {
        final int entry = thumbnailIfd + 2 + index * 12;
        if (data.getUint16(entry, Endian.little) == 273) {
          thumbnailOffset = data.getUint32(entry + 8, Endian.little);
        }
      }
      expect(thumbnailOffset, lessThan(rgbOffset));
      expect(
        bytes
            .sublist(thumbnailOffset!, thumbnailOffset + 12)
            .any((int value) => value > 0),
        isTrue,
      );
      int? maskOffset;
      for (int index = 0; index < 10; index++) {
        final int entry = subIfd + 2 + index * 12;
        if (data.getUint16(entry, Endian.little) == 273) {
          maskOffset = data.getUint32(entry + 8, Endian.little);
        }
      }
      expect(maskOffset, rgbOffset + 2 * 2 * 3 * 4);
      expect(
        bytes.sublist(maskOffset!, maskOffset + 4),
        orderedEquals(<int>[255, 0, 255, 0]),
      );
      expect(bytes.length, maskOffset + 4);
      expect(data.getFloat32(rgbOffset, Endian.little), closeTo(.05, 1e-7));
      expect(
        data.getFloat32(rgbOffset + 11 * 4, Endian.little),
        closeTo(.6, 1e-7),
      );
    } finally {
      await temp.delete(recursive: true);
    }
  });

  test('contribution store streams transparency mask without full mask input',
      () async {
    final Directory temp = await Directory.systemTemp
        .createTemp('mobile-stack-linear-dng-stream-mask-');
    final File output =
        File('${temp.path}${Platform.pathSeparator}streamed.dng');
    try {
      final _MemoryContributionStore contributions = _MemoryContributionStore(
        width: 2,
        height: 2,
        interleavedCounts: Uint16List.fromList(<int>[
          1,
          1,
          1,
          1,
          0,
          1,
          2,
          2,
          2,
          0,
          0,
          0,
        ]),
      );
      await exportTileStoreToLinearDng(
        tileStore: InMemoryRgbTileStore(
          width: 2,
          height: 2,
          interleavedRgb: Float32List.fromList(<double>[
            .1,
            .1,
            .1,
            .2,
            .2,
            .2,
            .3,
            .3,
            .3,
            .4,
            .4,
            .4,
          ]),
        ),
        outputPath: output.path,
        inputToLinearSrgb: LinearRgbColorTransform.identity(),
        rowsPerStrip: 2,
        contributionStore: contributions,
      );
      final Uint8List bytes = await output.readAsBytes();
      final ByteData data = ByteData.sublistView(bytes);
      final tags = _ifd0(bytes);
      final int subIfd = data.getUint32(tags[330]!.value + 4, Endian.little);
      int? maskOffset;
      for (int index = 0; index < 10; index++) {
        final int entry = subIfd + 2 + index * 12;
        if (data.getUint16(entry, Endian.little) == 273) {
          maskOffset = data.getUint32(entry + 8, Endian.little);
        }
      }
      expect(maskOffset, isNotNull);
      expect(
        bytes.sublist(maskOffset!, maskOffset + 4),
        orderedEquals(<int>[255, 0, 255, 0]),
      );
    } finally {
      await temp.delete(recursive: true);
    }
  });

  test('container recommendation uses 64-bit DNG only past classic TIFF range',
      () {
    expect(
      recommendedLinearDngContainer(width: 6000, height: 4000),
      LinearDngContainer.classic,
    );
    expect(
      recommendedLinearDngContainer(width: 30000, height: 15000),
      LinearDngContainer.bigTiff,
    );
  });

  test(
      'Classic DNG refuses dimensions whose uncompressed Float32 RGB output exceeds uint32',
      () {
    expect(
      () => encodeLinearDngFloat32Header(
        width: 1000000,
        height: 1000000,
      ),
      throwsA(isA<InvalidLinearDngInput>()),
    );
  });

  test('Linear DNG preflight fuses headroom and thumbnail into strip pass',
      () async {
    const int width = 16;
    const int height = 300;
    const int rowsPerStrip = 64;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List.fromList(
        List<double>.generate(
            width * height * 3, (int index) => 0.1 + (index % 17) * 0.01),
      ),
    );
    final Directory temp = await Directory.systemTemp
        .createTemp('mobile-stack-dng-fused-preflight-');
    final File output = File('${temp.path}${Platform.pathSeparator}fused.dng');
    try {
      await exportTileStoreToLinearDng(
        tileStore: store,
        outputPath: output.path,
        inputToLinearSrgb: LinearRgbColorTransform.identity(),
        rowsPerStrip: rowsPerStrip,
      );
      final int strips = (height + rowsPerStrip - 1) ~/ rowsPerStrip;
      expect(
        store.readRequests.length,
        strips * 2,
        reason:
            'one strip pass is preflight and one is final encode; thumbnail must not issue separate full-width row reads',
      );
      expect(store.readRequests.every((r) => r.width == width), isTrue);
      expect(store.readRequests.every((r) => r.height <= rowsPerStrip), isTrue);
    } finally {
      await temp.delete(recursive: true);
    }
  });

  test('Deflate DNG restores bit-identical Float32 strip samples', () async {
    const int width = 4;
    const int height = 4;
    const int rowsPerStrip = 2;
    final Float32List source = Float32List.fromList(
      List<double>.generate(width * height * 3, (int index) => index / 100),
    );
    final Directory temp = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-deflate-test-',
    );
    final File output =
        File('${temp.path}${Platform.pathSeparator}lossless.dng');
    try {
      await exportTileStoreToLinearDng(
        tileStore: InMemoryRgbTileStore(
          width: width,
          height: height,
          interleavedRgb: source,
        ),
        outputPath: output.path,
        inputToLinearSrgb: LinearRgbColorTransform.identity(),
        rowsPerStrip: rowsPerStrip,
        compression: LinearDngCompression.deflate,
      );
      final Uint8List bytes = await output.readAsBytes();
      final ByteData data = ByteData.sublistView(bytes);
      final tags = _ifd0(bytes);
      expect(tags[259]!.value & 0xffff, 8);
      final int stripCount = tags[273]!.count;
      final int offsetsArray = tags[273]!.value;
      final int countsArray = tags[279]!.value;
      final BytesBuilder restored = BytesBuilder(copy: false);
      for (int strip = 0; strip < stripCount; strip++) {
        final int offset =
            data.getUint32(offsetsArray + strip * 4, Endian.little);
        final int count =
            data.getUint32(countsArray + strip * 4, Endian.little);
        restored
            .add(ZLibDecoder().convert(bytes.sublist(offset, offset + count)));
      }
      final ByteData decoded = ByteData.sublistView(restored.takeBytes());
      for (int index = 0; index < source.length; index++) {
        expect(decoded.getFloat32(index * 4, Endian.little), source[index]);
      }
    } finally {
      await temp.delete(recursive: true);
    }
  });
}
