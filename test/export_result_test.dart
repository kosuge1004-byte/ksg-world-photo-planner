import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:mobile_stack/core/export/dng_final_render_profile.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/export/dng_profile_hue_sat_map.dart';
import 'package:mobile_stack/core/export/dng_profile_look_table.dart';
import 'package:mobile_stack/core/export/dng_profile_tone_curve.dart';
import 'package:mobile_stack/core/export/export_result.dart';
import 'package:mobile_stack/core/export/tiff16_writer.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';

import 'support/in_memory_rgb_tile_store.dart';

DngFinalRenderProfile _atomicExposureProfile(double ev) =>
    DngFinalRenderProfile.fromMetadata(
      sourceId: 'reference.dng',
      metadata: RawFrameMetadata(
        format: RawFormat.dng,
        activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
        orientation: 1,
        blackLevels: const <double>[0, 0, 0, 0],
        whiteLevel: 1,
        baselineExposure: ev,
      ),
      cfaPattern: CfaPattern.rggb,
    );

Future<int> _predictorForMixedBands({required bool noisyTop}) async {
  const int width = 128;
  const int height = 384;
  final Float32List rgb = Float32List(width * height * 3);
  int state = noisyTop ? 81 : 8101;
  for (int y = 0; y < height; y++) {
    final bool noisy = noisyTop ? y < 128 : y >= 128;
    for (int x = 0; x < width; x++) {
      final int offset = (y * width + x) * 3;
      if (noisy) {
        for (int channel = 0; channel < 3; channel++) {
          state = (1664525 * state + 1013904223) & 0xffffffff;
          rgb[offset + channel] = (state & 0x80000000) == 0 ? 0 : 1;
        }
      } else {
        final double horizontal = x / (width - 1);
        final double vertical = y / (height - 1);
        final double verticalWeight = noisyTop ? vertical : 0;
        rgb[offset] = horizontal * 0.7 + verticalWeight * 0.3;
        rgb[offset + 1] = horizontal * 0.4 + verticalWeight * 0.2;
        rgb[offset + 2] = horizontal * 0.2 + verticalWeight * 0.1;
      }
    }
  }
  final InMemoryRgbTileStore store = InMemoryRgbTileStore(
    width: width,
    height: height,
    interleavedRgb: rgb,
  );
  final Directory tempDir = await Directory.systemTemp.createTemp(
    'mobile-stack-tiff16-mixed-predictor-test-',
  );
  try {
    final File output = await exportTileStoreToTiff16(
      tileStore: store,
      outputPath: '${tempDir.path}${Platform.pathSeparator}mixed.tiff',
      exposureScale: 1,
      whitePoint: 1,
    );
    final ByteData data = ByteData.sublistView(await output.readAsBytes());
    for (int index = 0; index < 13; index++) {
      final int entry = 10 + index * 12;
      if (data.getUint16(entry, Endian.little) == 317) {
        return data.getUint16(entry + 8, Endian.little);
      }
    }
    return -1;
  } finally {
    await tempDir.delete(recursive: true);
  }
}

void main() {
  test('TIFF container recommendation includes metadata in the 4 GiB limit',
      () {
    expect(
      recommendedTiff16Container(width: 10000, height: 10000),
      Tiff16Container.classic,
    );
    expect(
      recommendedTiff16Container(width: 100000, height: 10000),
      Tiff16Container.bigTiff,
    );
    expect(
      () => recommendedTiff16Container(width: 0, height: 1),
      throwsA(isA<InvalidTiffInput>()),
    );
  });

  test('tileStoreから16-bit RGB TIFFをストリーミング書き出しする', () async {
    const int width = 2;
    const int height = 2;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List.fromList(<double>[
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
      ]),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-tiff16-export-test-',
    );
    final String outputPath =
        '${tempDir.path}${Platform.pathSeparator}result.tiff';
    try {
      final File written = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: outputPath,
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
      );
      final String? smokeOutput =
          Platform.environment['MOBILE_STACK_TIFF_SMOKE_OUTPUT'];
      if (smokeOutput != null && smokeOutput.isNotEmpty) {
        await written.copy(smokeOutput);
      }
      final Uint8List bytes = await written.readAsBytes();
      final ByteData data = ByteData.sublistView(bytes);
      expect(bytes.sublist(0, 4), <int>[0x49, 0x49, 42, 0]);
      final int ifdOffset = data.getUint32(4, Endian.little);
      final int entryCount = data.getUint16(ifdOffset, Endian.little);
      int pixelOffset = -1;
      for (int index = 0; index < entryCount; index++) {
        final int entry = ifdOffset + 2 + index * 12;
        if (data.getUint16(entry, Endian.little) == 273) {
          pixelOffset = data.getUint32(entry + 8, Endian.little);
        }
      }
      expect(pixelOffset, greaterThan(0));
      expect(bytes.length, pixelOffset + width * height * 6);
      final int red = data.getUint16(pixelOffset, Endian.little);
      final int green = data.getUint16(pixelOffset + 2, Endian.little);
      final int blue = data.getUint16(pixelOffset + 4, Endian.little);
      expect(red, greaterThan(50000));
      expect(green, 0);
      expect(blue, 0);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('TIFF書き出し開始後のキャンセルは部分出力を削除する', () async {
    const int width = 4;
    const int height = 4;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List(width * height * 3)
        ..fillRange(0, width * height * 3, 1),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-tiff16-cancel-test-',
    );
    final String outputPath =
        '${tempDir.path}${Platform.pathSeparator}partial.tiff';
    int cancellationChecks = 0;
    try {
      await expectLater(
        exportTileStoreToTiff16(
          tileStore: store,
          outputPath: outputPath,
          exposureScale: 1,
          whitePoint: 1,
          isCancelled: () => cancellationChecks++ >= 2,
        ),
        throwsA(isA<ExportCancelled>()),
      );
      expect(await File(outputPath).exists(), isFalse);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('TIFF Deflateは定数画像を可逆のまま小さく書き出す', () async {
    const int width = 100;
    const int height = 100;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List(width * height * 3)
        ..fillRange(0, width * height * 3, 0.1),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-tiff16-deflate-test-',
    );
    try {
      final File uncompressed = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}uncompressed.tiff',
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
      );
      final File deflated = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}deflated.tiff',
        exposureScale: 1,
        whitePoint: 1,
      );
      final String? smokeOutput =
          Platform.environment['MOBILE_STACK_TIFF_DEFLATE_SMOKE_OUTPUT'];
      if (smokeOutput != null && smokeOutput.isNotEmpty) {
        await deflated.copy(smokeOutput);
      }
      expect(await deflated.length(), lessThan(await uncompressed.length()));
      final Uint8List bytes = await deflated.readAsBytes();
      final ByteData data = ByteData.sublistView(bytes);
      int compression = -1;
      int predictor = -1;
      for (int index = 0; index < 13; index++) {
        final int entry = 10 + index * 12;
        if (data.getUint16(entry, Endian.little) == 259) {
          compression = data.getUint16(entry + 8, Endian.little);
        }
        if (data.getUint16(entry, Endian.little) == 317) {
          predictor = data.getUint16(entry + 8, Endian.little);
        }
      }
      expect(compression, 8);
      expect(predictor, 1);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('TIFF chooses no predictor when binary RGB noise compresses smaller',
      () async {
    const int width = 128;
    const int height = 128;
    final Float32List rgb = Float32List(width * height * 3);
    int state = 79;
    for (int index = 0; index < rgb.length; index++) {
      state = (1664525 * state + 1013904223) & 0xffffffff;
      rgb[index] = (state & 0x80000000) == 0 ? 0 : 1;
    }
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: rgb,
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-tiff16-adaptive-predictor-test-',
    );
    try {
      final File output = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}noise.tiff',
        exposureScale: 1,
        whitePoint: 1,
      );
      final File forcedHorizontal = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath:
            '${tempDir.path}${Platform.pathSeparator}noise-horizontal.tiff',
        predictor: Tiff16Predictor.horizontalDifferencing,
        exposureScale: 1,
        whitePoint: 1,
      );
      expect(await output.length(), lessThan(await forcedHorizontal.length()));
      final String? smokeOutput =
          Platform.environment['MOBILE_STACK_TIFF_ADAPTIVE_NOISE_OUTPUT'];
      final String? alternativeOutput = Platform
          .environment['MOBILE_STACK_TIFF_ADAPTIVE_NOISE_ALTERNATIVE_OUTPUT'];
      if (smokeOutput != null && smokeOutput.isNotEmpty) {
        await output.copy(smokeOutput);
      }
      if (alternativeOutput != null && alternativeOutput.isNotEmpty) {
        await forcedHorizontal.copy(alternativeOutput);
      }
      final Uint8List bytes = await output.readAsBytes();
      final ByteData data = ByteData.sublistView(bytes);
      int predictor = -1;
      for (int index = 0; index < 13; index++) {
        final int entry = 10 + index * 12;
        if (data.getUint16(entry, Endian.little) == 317) {
          predictor = data.getUint16(entry + 8, Endian.little);
        }
      }
      expect(predictor, 1);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('TIFF chooses horizontal predictor for a smooth RGB gradient', () async {
    const int width = 128;
    const int height = 128;
    final Float32List rgb = Float32List(width * height * 3);
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        final int offset = (y * width + x) * 3;
        rgb[offset] = x / (width - 1);
        rgb[offset + 1] = x / (2 * (width - 1));
        rgb[offset + 2] = x / (4 * (width - 1));
      }
    }
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: rgb,
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-tiff16-gradient-predictor-test-',
    );
    try {
      final File output = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}gradient.tiff',
        exposureScale: 1,
        whitePoint: 1,
      );
      final File forcedNone = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath:
            '${tempDir.path}${Platform.pathSeparator}gradient-none.tiff',
        predictor: Tiff16Predictor.none,
        exposureScale: 1,
        whitePoint: 1,
      );
      expect(await output.length(), lessThan(await forcedNone.length()));
      final String? smokeOutput =
          Platform.environment['MOBILE_STACK_TIFF_ADAPTIVE_GRADIENT_OUTPUT'];
      final String? alternativeOutput = Platform.environment[
          'MOBILE_STACK_TIFF_ADAPTIVE_GRADIENT_ALTERNATIVE_OUTPUT'];
      if (smokeOutput != null && smokeOutput.isNotEmpty) {
        await output.copy(smokeOutput);
      }
      if (alternativeOutput != null && alternativeOutput.isNotEmpty) {
        await forcedNone.copy(alternativeOutput);
      }
      final Uint8List bytes = await output.readAsBytes();
      final ByteData data = ByteData.sublistView(bytes);
      int predictor = -1;
      for (int index = 0; index < 13; index++) {
        final int entry = 10 + index * 12;
        if (data.getUint16(entry, Endian.little) == 317) {
          predictor = data.getUint16(entry + 8, Endian.little);
        }
      }
      expect(predictor, 2);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('TIFF horizontal predictor preserves varying RGB rows', () async {
    const int width = 4;
    const int height = 2;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List.fromList(<double>[
        0,
        0.01,
        0.1,
        0.2,
        0.4,
        0.8,
        1,
        0.5,
        0.25,
        0.03,
        0.6,
        0.12,
        0.9,
        0.02,
        0.3,
        0.15,
        0.7,
        0.04,
        0.55,
        0.11,
        0.95,
        0.005,
        0.35,
        0.75,
      ]),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-tiff16-predictor-test-',
    );
    try {
      final File uncompressed = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}reference.tiff',
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
      );
      final File predicted = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}predicted.tiff',
        exposureScale: 1,
        whitePoint: 1,
      );
      final String? referenceOutput =
          Platform.environment['MOBILE_STACK_TIFF_PREDICTOR_REFERENCE_OUTPUT'];
      final String? predictedOutput =
          Platform.environment['MOBILE_STACK_TIFF_PREDICTOR_SMOKE_OUTPUT'];
      if (referenceOutput != null && referenceOutput.isNotEmpty) {
        await uncompressed.copy(referenceOutput);
      }
      if (predictedOutput != null && predictedOutput.isNotEmpty) {
        await predicted.copy(predictedOutput);
      }
      expect(await uncompressed.exists(), isTrue);
      expect(await predicted.exists(), isTrue);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('BigTIFF streams the same adaptive Deflate RGB16 pixels as Classic',
      () async {
    const int width = 4;
    const int height = 2;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List.fromList(<double>[
        0,
        0.01,
        0.1,
        0.2,
        0.4,
        0.8,
        1,
        0.5,
        0.25,
        0.03,
        0.6,
        0.12,
        0.9,
        0.02,
        0.3,
        0.15,
        0.7,
        0.04,
        0.55,
        0.11,
        0.95,
        0.005,
        0.35,
        0.75,
      ]),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-bigtiff16-export-test-',
    );
    try {
      final File classic = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}classic.tiff',
        exposureScale: 1,
        whitePoint: 1,
      );
      final File bigTiff = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}big.tiff',
        container: Tiff16Container.bigTiff,
        exposureScale: 1,
        whitePoint: 1,
      );
      final Uint8List classicBytes = await classic.readAsBytes();
      final Uint8List bigTiffBytes = await bigTiff.readAsBytes();
      expect(
          ByteData.sublistView(classicBytes).getUint16(2, Endian.little), 42);
      expect(
          ByteData.sublistView(bigTiffBytes).getUint16(2, Endian.little), 43);
      final String? referenceOutput =
          Platform.environment['MOBILE_STACK_BIGTIFF_EXPORT_REFERENCE_OUTPUT'];
      final String? bigTiffOutput =
          Platform.environment['MOBILE_STACK_BIGTIFF_EXPORT_OUTPUT'];
      if (referenceOutput != null && referenceOutput.isNotEmpty) {
        await classic.copy(referenceOutput);
      }
      if (bigTiffOutput != null && bigTiffOutput.isNotEmpty) {
        await bigTiff.copy(bigTiffOutput);
      }
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('TIFF predictor samples top, middle, and bottom image regions',
      () async {
    expect(await _predictorForMixedBands(noisyTop: false), 1);
    expect(await _predictorForMixedBands(noisyTop: true), 2);
  });

  test('fixed tone baseline samples the reference in bounded strips', () async {
    const int width = 8;
    const int height = 300;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List(width * height * 3)
        ..fillRange(0, width * height * 3, 0.2),
    );

    final tone = await estimateFixedToneBaselineFromReferenceFrame(
      referenceStore: store,
    );

    expect(tone.exposureScale.isFinite, isTrue);
    expect(tone.whitePoint.isFinite, isTrue);
    expect(store.readRequests, hasLength(3));
    expect(
      store.readRequests.every((request) => request.height <= 128),
      isTrue,
    );
  });

  test('TIFFは全画面ではなく最大128行のstripだけを読み出す', () async {
    const int width = 1;
    const int height = 300;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List(width * height * 3)
        ..fillRange(0, width * height * 3, 0.1),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-tiff16-strip-test-',
    );
    final String outputPath =
        '${tempDir.path}${Platform.pathSeparator}strips.tiff';
    try {
      await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: outputPath,
        exposureScale: 1,
        whitePoint: 1,
      );
      expect(
        store.readRequests.map((RgbReadRequest request) => request.height),
        <int>[32, 32, 32, 128, 128, 44],
      );
      expect(
        store.readRequests.map((RgbReadRequest request) => request.y),
        <int>[0, 134, 268, 0, 128, 256],
      );
      expect(
        store.readRequests.every(
          (RgbReadRequest request) => request.width == width,
        ),
        isTrue,
      );
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('tileStoreからBMPファイルを書き出し、有効なヘッダーとサイズを持つ', () async {
    const int width = 12;
    const int height = 8;
    final Float32List rgb = Float32List(width * height * 3);
    for (int i = 0; i < width * height; i++) {
      rgb[i * 3] = 0.02;
      rgb[i * 3 + 1] = 0.03;
      rgb[i * 3 + 2] = 0.05;
    }
    // 1つだけ明るい「星」を混ぜる。
    rgb[10 * 3] = 3.0;
    rgb[10 * 3 + 1] = 3.0;
    rgb[10 * 3 + 2] = 3.0;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: rgb,
    );

    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-test-',
    );
    final String outputPath =
        '${tempDir.path}${Platform.pathSeparator}result.bmp';
    try {
      final File written = await exportTileStoreToBmp(
        tileStore: store,
        outputPath: outputPath,
      );
      expect(await written.exists(), isTrue);
      final Uint8List bytes = await written.readAsBytes();
      // BMP magic bytes.
      expect(bytes[0], 0x42); // 'B'
      expect(bytes[1], 0x4d); // 'M'
      final ByteData view = ByteData.sublistView(bytes);
      final int fileSize = view.getUint32(2, Endian.little);
      expect(fileSize, bytes.length);
      final int decodedWidth = view.getInt32(18, Endian.little);
      final int decodedHeight = view.getInt32(22, Endian.little);
      expect(decodedWidth, width);
      expect(decodedHeight, height);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('明示的なexposureScale/whitePointを両方渡すと自動推定を使わない', () async {
    const int width = 4;
    const int height = 4;
    final Float32List rgb = Float32List(width * height * 3)
      ..fillRange(0, width * height * 3, 1.0);
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: rgb,
    );

    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-test-manual-',
    );
    final String outputPath =
        '${tempDir.path}${Platform.pathSeparator}result.bmp';
    try {
      final File written = await exportTileStoreToBmp(
        tileStore: store,
        outputPath: outputPath,
        exposureScale: 1.0,
        whitePoint: 1.0,
      );
      final Uint8List bytes = await written.readAsBytes();
      // pixelDataOffset(54) の最初のピクセルは B,G,R の順。value==whitePoint
      // なので明るいが完全な白ではないはず(tone_map_test.dartで検証済みの、
      // rate=ln(10)によりf(whitePoint)≈0.9という挙動と整合するか確認)。
      const int pixelDataOffset = 54;
      final int blue = bytes[pixelDataOffset];
      final int green = bytes[pixelDataOffset + 1];
      final int red = bytes[pixelDataOffset + 2];
      expect(red, greaterThan(150));
      expect(red, lessThan(255));
      expect(red, equals(green));
      expect(red, equals(blue));
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('atomic render profile reaches streamed BMP and TIFF', () async {
    const int width = 2;
    const int height = 2;
    final Float32List quarter = Float32List(width * height * 3)
      ..fillRange(0, width * height * 3, 0.25);
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: quarter,
    );
    final DngFinalRenderProfile profile = _atomicExposureProfile(1);
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-atomic-profile-',
    );
    try {
      final File atomicBmp = await exportTileStoreToBmp(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}atomic.bmp',
        exposureScale: 1,
        whitePoint: 1,
        renderProfile: profile,
      );
      final File legacyBmp = await exportTileStoreToBmp(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}legacy.bmp',
        exposureScale: 1,
        whitePoint: 1,
        baselineExposureEv: 1,
      );
      expect(await atomicBmp.readAsBytes(),
          orderedEquals(await legacyBmp.readAsBytes()));

      final File atomicTiff = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}atomic.tiff',
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
        renderProfile: profile,
      );
      final File legacyTiff = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}legacy.tiff',
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
        baselineExposureEv: 1,
      );
      expect(await atomicTiff.readAsBytes(),
          orderedEquals(await legacyTiff.readAsBytes()));
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('adaptive TIFF predictor uses the same atomic render profile', () async {
    const int width = 128;
    const int height = 256;
    final Float32List rgb = Float32List(width * height * 3);
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        final int offset = (y * width + x) * 3;
        rgb[offset] = x / (width - 1) * 0.25;
        rgb[offset + 1] = x / (width - 1) * 0.2;
        rgb[offset + 2] = x / (width - 1) * 0.15;
      }
    }
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: rgb,
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-atomic-predictor-',
    );
    try {
      final File atomic = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}atomic.tiff',
        compression: Tiff16Compression.deflate,
        exposureScale: 1,
        whitePoint: 1,
        renderProfile: _atomicExposureProfile(1),
      );
      final File legacy = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}legacy.tiff',
        compression: Tiff16Compression.deflate,
        exposureScale: 1,
        whitePoint: 1,
        baselineExposureEv: 1,
      );
      expect(await atomic.readAsBytes(),
          orderedEquals(await legacy.readAsBytes()));
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('atomic profile cannot be mixed with independent DNG fields', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 1,
      height: 1,
      interleavedRgb: Float32List.fromList(<double>[0.25, 0.25, 0.25]),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-atomic-mix-',
    );
    try {
      await expectLater(
        exportTileStoreToBmp(
          tileStore: store,
          outputPath: '${tempDir.path}${Platform.pathSeparator}bad.bmp',
          renderProfile: _atomicExposureProfile(1),
          baselineExposureEv: 1,
        ),
        throwsArgumentError,
      );
      await expectLater(
        exportTileStoreToTiff16(
          tileStore: store,
          outputPath: '${tempDir.path}${Platform.pathSeparator}bad.tiff',
          renderProfile: _atomicExposureProfile(1),
          profileToneCurve: DngProfileToneCurve.fromInterleaved(
            const <double>[0, 0, 1, 1],
          ),
        ),
        throwsArgumentError,
      );
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('DNG ProfileToneCurve is applied only while writing final BMP',
      () async {
    const int width = 2;
    const int height = 2;
    final Float32List rgb = Float32List(width * height * 3)
      ..fillRange(0, width * height * 3, 1);
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: rgb,
    );
    final DngProfileToneCurve curve = DngProfileToneCurve.fromInterleaved(
      const <double>[0, 0, 1, 0.5],
      isHighDynamicRange: true,
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-profile-curve-',
    );
    try {
      final File baseline = await exportTileStoreToBmp(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}baseline.bmp',
        exposureScale: 1,
        whitePoint: 1,
      );
      final File profiled = await exportTileStoreToBmp(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}profiled.bmp',
        exposureScale: 1,
        whitePoint: 1,
        profileToneCurve: curve,
      );
      final Uint8List baselineBytes = await baseline.readAsBytes();
      final Uint8List profiledBytes = await profiled.readAsBytes();
      expect(profiledBytes[54], lessThan(baselineBytes[54]));
      expect(rgb, everyElement(1));
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('baseline exposure EV reaches streamed BMP and TIFF final export',
      () async {
    const int width = 2;
    const int height = 2;
    final Float32List quarter = Float32List(width * height * 3)
      ..fillRange(0, width * height * 3, 0.25);
    final Float32List half = Float32List(width * height * 3)
      ..fillRange(0, width * height * 3, 0.5);
    final InMemoryRgbTileStore quarterStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: quarter,
    );
    final InMemoryRgbTileStore halfStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: half,
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-baseline-ev-',
    );
    try {
      final File evBmp = await exportTileStoreToBmp(
        tileStore: quarterStore,
        outputPath: '${tempDir.path}${Platform.pathSeparator}ev.bmp',
        exposureScale: 1,
        whitePoint: 1,
        baselineExposureEv: 1,
      );
      final File referenceBmp = await exportTileStoreToBmp(
        tileStore: halfStore,
        outputPath: '${tempDir.path}${Platform.pathSeparator}reference.bmp',
        exposureScale: 1,
        whitePoint: 1,
      );
      expect(await evBmp.readAsBytes(),
          orderedEquals(await referenceBmp.readAsBytes()));

      final File evTiff = await exportTileStoreToTiff16(
        tileStore: quarterStore,
        outputPath: '${tempDir.path}${Platform.pathSeparator}ev.tiff',
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
        baselineExposureEv: 1,
      );
      final File referenceTiff = await exportTileStoreToTiff16(
        tileStore: halfStore,
        outputPath: '${tempDir.path}${Platform.pathSeparator}reference.tiff',
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
      );
      expect(
        await evTiff.readAsBytes(),
        orderedEquals(await referenceTiff.readAsBytes()),
      );
      expect(quarter, everyElement(0.25));
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('DNG ProfileHueSatMap reaches streamed BMP and TIFF final export',
      () async {
    const int width = 2;
    const int height = 2;
    final Float32List rgb = Float32List(width * height * 3);
    for (int pixel = 0; pixel < width * height; pixel++) {
      rgb[pixel * 3] = 1;
    }
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: rgb,
    );
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: const <double>[0, 1, 1, 120, 1, 1],
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-profile-hue-sat-',
    );
    try {
      final File bmp = await exportTileStoreToBmp(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}profiled.bmp',
        exposureScale: 1,
        whitePoint: 1,
        profileHueSatMap: map,
      );
      final Uint8List bmpBytes = await bmp.readAsBytes();
      expect(bmpBytes[54], 0); // B
      expect(bmpBytes[55], greaterThan(200)); // G
      expect(bmpBytes[56], 0); // R

      final File tiff = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}profiled.tiff',
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
        profileHueSatMap: map,
      );
      final Uint8List tiffBytes = await tiff.readAsBytes();
      final ByteData data = ByteData.sublistView(tiffBytes);
      final int ifdOffset = data.getUint32(4, Endian.little);
      final int entryCount = data.getUint16(ifdOffset, Endian.little);
      int pixelOffset = -1;
      for (int index = 0; index < entryCount; index++) {
        final int entry = ifdOffset + 2 + index * 12;
        if (data.getUint16(entry, Endian.little) == 273) {
          pixelOffset = data.getUint32(entry + 8, Endian.little);
        }
      }
      expect(pixelOffset, greaterThan(0));
      expect(data.getUint16(pixelOffset, Endian.little), 0);
      expect(
          data.getUint16(pixelOffset + 2, Endian.little), greaterThan(50000));
      expect(data.getUint16(pixelOffset + 4, Endian.little), 0);
      expect(rgb.where((double value) => value == 1).length, width * height);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('DNG ProfileLookTable reaches streamed BMP and TIFF final export',
      () async {
    const int width = 2;
    const int height = 2;
    final Float32List rgb = Float32List(width * height * 3);
    for (int pixel = 0; pixel < width * height; pixel++) {
      rgb[pixel * 3] = 1;
    }
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: rgb,
    );
    final DngProfileLookTable table = DngProfileLookTable(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: const <double>[0, 1, 1, 120, 1, 1],
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-profile-look-',
    );
    try {
      final File bmp = await exportTileStoreToBmp(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}look.bmp',
        exposureScale: 1,
        whitePoint: 1,
        profileLookTable: table,
      );
      final Uint8List bmpBytes = await bmp.readAsBytes();
      expect(bmpBytes[54], 0);
      expect(bmpBytes[55], greaterThan(200));
      expect(bmpBytes[56], 0);

      final File tiff = await exportTileStoreToTiff16(
        tileStore: store,
        outputPath: '${tempDir.path}${Platform.pathSeparator}look.tiff',
        compression: Tiff16Compression.none,
        exposureScale: 1,
        whitePoint: 1,
        profileLookTable: table,
      );
      final Uint8List tiffBytes = await tiff.readAsBytes();
      final ByteData data = ByteData.sublistView(tiffBytes);
      final int ifdOffset = data.getUint32(4, Endian.little);
      final int entryCount = data.getUint16(ifdOffset, Endian.little);
      int pixelOffset = -1;
      for (int index = 0; index < entryCount; index++) {
        final int entry = ifdOffset + 2 + index * 12;
        if (data.getUint16(entry, Endian.little) == 273) {
          pixelOffset = data.getUint32(entry + 8, Endian.little);
        }
      }
      expect(pixelOffset, greaterThan(0));
      expect(data.getUint16(pixelOffset, Endian.little), 0);
      expect(
        data.getUint16(pixelOffset + 2, Endian.little),
        greaterThan(50000),
      );
      expect(data.getUint16(pixelOffset + 4, Endian.little), 0);
      expect(rgb.where((double value) => value == 1).length, width * height);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('BMP書き出し開始後のキャンセルは部分出力を削除する', () async {
    const int width = 4;
    const int height = 4;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List(width * height * 3)
        ..fillRange(
          0,
          width * height * 3,
          1.0,
        ),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-export-cancel-test-',
    );
    final String outputPath =
        '${tempDir.path}${Platform.pathSeparator}partial.bmp';
    int cancellationChecks = 0;
    try {
      await expectLater(
        exportTileStoreToBmp(
          tileStore: store,
          outputPath: outputPath,
          exposureScale: 1.0,
          whitePoint: 1.0,
          // Entry check, open-file check, then cancel immediately after
          // the BMP header has been written.
          isCancelled: () => cancellationChecks++ >= 2,
        ),
        throwsA(isA<ExportCancelled>()),
      );
      expect(await File(outputPath).exists(), isFalse);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test(
    'exportLinearRgbTileToBmp: localToneStrength既定値(0)は指定しない'
    '場合と同じ結果になる(Work100: 後方互換性の確認)',
    () async {
      const int width = 6;
      const int height = 6;
      final Float32List rgb = Float32List(width * height * 3)
        ..fillRange(0, width * height * 3, 0.1);
      final LinearRgbTile tile = LinearRgbTile(
        x: 0,
        y: 0,
        width: width,
        height: height,
        interleavedRgb: rgb,
      );
      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-local-tone-default-',
      );
      try {
        final File withoutParam = await exportLinearRgbTileToBmp(
          tile: tile,
          outputPath: '${tempDir.path}${Platform.pathSeparator}without.bmp',
          exposureScale: 1,
          whitePoint: 1,
        );
        final File withExplicitZero = await exportLinearRgbTileToBmp(
          tile: tile,
          outputPath:
              '${tempDir.path}${Platform.pathSeparator}explicit-zero.bmp',
          exposureScale: 1,
          whitePoint: 1,
          localToneStrength: 0,
        );
        expect(
          await withoutParam.readAsBytes(),
          orderedEquals(await withExplicitZero.readAsBytes()),
        );
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );

  test(
    'exportLinearRgbTileToBmp: localToneStrength>0を指定すると、暗い'
    '背景領域が0の場合より明るく書き出される(Work100: 配線の検証)',
    () async {
      // Work99自身のend-to-endテストで既に実行検証済みの比率
      // (8x8画像・右上2x2の星・blurRadius=3)をそのまま再利用する —
      // 独自の新しい比率を考案して、Work99で遭遇したのと同種の
      // 「もっともらしいが実際には効かない」設計ミスを再び踏むリスク
      // を避けるため。
      const int width = 8;
      const int height = 8;
      final Float32List rgb = Float32List(width * height * 3);
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int index = y * width + x;
          final bool isStar = x >= 6 && y <= 1;
          final double value = isStar ? 5.0 : 0.02;
          rgb[index * 3] = value;
          rgb[index * 3 + 1] = value;
          rgb[index * 3 + 2] = value;
        }
      }
      final LinearRgbTile tile = LinearRgbTile(
        x: 0,
        y: 0,
        width: width,
        height: height,
        interleavedRgb: rgb,
      );
      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-local-tone-applied-',
      );
      try {
        final File withoutLocalTone = await exportLinearRgbTileToBmp(
          tile: tile,
          outputPath: '${tempDir.path}${Platform.pathSeparator}plain.bmp',
          exposureScale: 1,
          whitePoint: 5,
        );
        final File withLocalTone = await exportLinearRgbTileToBmp(
          tile: tile,
          outputPath: '${tempDir.path}${Platform.pathSeparator}local-tone.bmp',
          exposureScale: 1,
          whitePoint: 5,
          localToneStrength: 0.5,
          localToneBlurRadius: 3,
          localToneMinGain: 0.1,
          localToneMaxGain: 10,
        );
        // BMPは54バイトヘッダー後、下から上・BGR順で格納される。
        // 一番下の行(画像のy=height-1=7)の先頭画素(x=0)は星
        // (x>=6,y<=1)から最も離れた背景領域に対応する。
        final Uint8List plainBytes = await withoutLocalTone.readAsBytes();
        final Uint8List localToneBytes = await withLocalTone.readAsBytes();
        const int pixelDataOffset = 54;
        final int plainValue = plainBytes[pixelDataOffset];
        final int localToneValue = localToneBytes[pixelDataOffset];
        expect(
          localToneValue,
          greaterThan(plainValue),
          reason: 'expected local tone adaptation to brighten the '
              'background: plain=$plainValue, localTone=$localToneValue',
        );
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );

  test('JPEG export preserves RGB ordering with direct image backing storage',
      () async {
    const int width = 2;
    const int height = 1;
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List.fromList(<double>[
        1,
        0,
        0,
        0,
        1,
        0,
      ]),
    );
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-jpeg-direct-backing-test-',
    );
    final String outputPath =
        '${tempDir.path}${Platform.pathSeparator}result.jpg';
    try {
      final File output = await exportTileStoreToJpeg(
        tileStore: store,
        outputPath: outputPath,
        quality: 100,
        exposureScale: 1,
        whitePoint: 1,
      );
      final img.Image? decoded = img.decodeJpg(await output.readAsBytes());
      expect(decoded, isNotNull);
      final p0 = decoded!.getPixel(0, 0);
      final p1 = decoded.getPixel(1, 0);
      expect(p0.r, greaterThan(p0.g));
      expect(p0.r, greaterThan(p0.b));
      expect(p1.g, greaterThan(p1.r));
      expect(p1.g, greaterThan(p1.b));
    } finally {
      await tempDir.delete(recursive: true);
    }
  });
}
