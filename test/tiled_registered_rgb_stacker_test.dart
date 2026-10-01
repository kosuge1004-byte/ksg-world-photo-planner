import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/affine_sampling_transform.dart';
import 'package:mobile_stack/core/stacking/tiled_registered_rgb_stacker.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

import 'support/in_memory_rgb_tile_store.dart';

Float32List _reference(int width, int height) {
  final Float32List rgb = Float32List(width * height * 3);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final double value = x + y * 10.0;
      final int base = (y * width + x) * 3;
      rgb[base] = value;
      rgb[base + 1] = value + 100;
      rgb[base + 2] = value + 200;
    }
  }
  return rgb;
}

Float32List _shiftRight(Float32List source, int width, int height) {
  final Float32List shifted = Float32List(source.length);
  for (int y = 0; y < height; y++) {
    for (int x = 1; x < width; x++) {
      final int destination = (y * width + x) * 3;
      final int original = (y * width + x - 1) * 3;
      shifted.setRange(destination, destination + 3, source, original);
    }
  }
  return shifted;
}

OverlappedTile _tile() => const OverlappedTile(
      outputX: 0,
      outputY: 0,
      outputWidth: 3,
      outputHeight: 2,
      inputX: 0,
      inputY: 0,
      inputWidth: 3,
      inputHeight: 2,
    );

void main() {
  test('小領域の逆写像と棄却合成をフルフレームなしで直結する', () async {
    const int width = 9;
    const int height = 8;
    final Float32List reference = _reference(width, height);
    final InMemoryRgbTileStore referenceStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: reference,
    );
    final InMemoryRgbTileStore shiftedStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: _shiftRight(reference, width, height),
    );
    final result = await const TiledRegisteredRgbStacker().combineTile(
      frames: <RegisteredRgbFrame>[
        RegisteredRgbFrame(
          store: referenceStore,
          transform: AffineSamplingTransform.identity(),
          weight: 1,
        ),
        RegisteredRgbFrame(
          store: shiftedStore,
          transform: AffineSamplingTransform.similarity(
            rotationDegrees: 0,
            sourceOffsetX: 1,
            sourceOffsetY: 0,
            centerX: 0,
            centerY: 0,
          ),
          weight: 1,
        ),
      ],
      outputTile: _tile(),
      outputImageWidth: width,
      outputImageHeight: height,
    );

    for (int y = 0; y < 2; y++) {
      for (int x = 0; x < 3; x++) {
        final int sourceBase = (y * width + x) * 3;
        for (int channel = 0; channel < 3; channel++) {
          expect(
            result.tile.channelAt(x, y, channel),
            reference[sourceBase + channel],
          );
        }
      }
    }
    expect(result.contributingSamples, everyElement(2));
    expect(referenceStore.readRequests, isNotEmpty);
    expect(shiftedStore.readRequests, isNotEmpty);
    expect(
      referenceStore.readRequests.every(
        (RgbReadRequest read) => read.width * read.height < width * height,
      ),
      isTrue,
    );
    expect(
      shiftedStore.readRequests.every(
        (RgbReadRequest read) => read.width * read.height < width * height,
      ),
      isTrue,
    );
  });

  test('空フレームと不正品質重みを拒否する', () {
    expect(
      () => const TiledRegisteredRgbStacker().combineTile(
        frames: const <RegisteredRgbFrame>[],
        outputTile: _tile(),
        outputImageWidth: 5,
        outputImageHeight: 4,
      ),
      throwsArgumentError,
    );
    expect(
      () => RegisteredRgbFrame(
        store: InMemoryRgbTileStore(
          width: 1,
          height: 1,
          interleavedRgb: Float32List(3),
        ),
        transform: AffineSamplingTransform.identity(),
        weight: 0,
      ),
      throwsArgumentError,
    );
  });
}
