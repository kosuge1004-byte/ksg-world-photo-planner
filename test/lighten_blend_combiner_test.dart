import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart'
    show CoveredLinearRgbTile;
import 'package:mobile_stack/core/stacking/lighten_blend_combiner.dart';

/// Dart port of `tool/raw_samples/test/lighten_blend_reference.test.mjs`.

CoveredLinearRgbTile _makeFrame(
  List<List<double>> pixelTriples,
  List<int> coverage,
) {
  final Float32List rgb = Float32List.fromList(
    pixelTriples.expand((List<double> triple) => triple).toList(),
  );
  final LinearRgbTile tile = LinearRgbTile(
    x: 0,
    y: 0,
    width: pixelTriples.length,
    height: 1,
    interleavedRgb: rgb,
  );
  return CoveredLinearRgbTile(
    tile: tile,
    coverage: Uint8List.fromList(coverage),
  );
}

void main() {
  test('rejects an empty frame list', () {
    expect(
      () => lightenBlendCombineCoveredRgb(frames: <CoveredLinearRgbTile>[]),
      throwsA(isA<InvalidLightenBlendInput>()),
    );
  });

  test('rejects mismatched RGB sample counts between frames', () {
    final CoveredLinearRgbTile frameA = _makeFrame(
      <List<double>>[
        <double>[1, 1, 1],
        <double>[2, 2, 2],
      ],
      <int>[1, 1],
    );
    final CoveredLinearRgbTile frameB = _makeFrame(
      <List<double>>[
        <double>[1, 1, 1]
      ],
      <int>[1],
    );
    expect(
      () => lightenBlendCombineCoveredRgb(
        frames: <CoveredLinearRgbTile>[frameA, frameB],
      ),
      throwsA(isA<InvalidLightenBlendInput>()),
    );
  });

  test('a single frame passes through unchanged', () {
    final CoveredLinearRgbTile frame = _makeFrame(
      <List<double>>[
        <double>[10, 20, 30],
        <double>[1, 2, 3],
      ],
      <int>[1, 1],
    );
    final LightenBlendResult result = lightenBlendCombineCoveredRgb(
      frames: <CoveredLinearRgbTile>[frame],
    );
    expect(result.rgb, orderedEquals(<double>[10, 20, 30, 1, 2, 3]));
    expect(result.coverage, orderedEquals(<int>[1, 1]));
  });

  test(
    'takes the per-channel maximum across frames (standard lighten blend)',
    () {
      final CoveredLinearRgbTile frameA = _makeFrame(
        <List<double>>[
          <double>[10, 5, 100]
        ],
        <int>[1],
      );
      final CoveredLinearRgbTile frameB = _makeFrame(
        <List<double>>[
          <double>[3, 50, 20]
        ],
        <int>[1],
      );
      final CoveredLinearRgbTile frameC = _makeFrame(
        <List<double>>[
          <double>[7, 8, 9]
        ],
        <int>[1],
      );
      final LightenBlendResult result = lightenBlendCombineCoveredRgb(
        frames: <CoveredLinearRgbTile>[frameA, frameB, frameC],
      );
      // Each channel's maximum is taken independently, not "pick the
      // brightest frame as a whole" -- this is what makes a star trail
      // trace correctly even as different stars cross the same pixel at
      // different times across the sequence.
      expect(result.rgb, orderedEquals(<double>[10, 50, 100]));
      expect(result.coverage, orderedEquals(<int>[3]));
    },
  );

  test('simulates a star sweeping across three pixels over three frames', () {
    // Pixel 0 lit in frame 1 only, pixel 1 in frame 2 only, pixel 2 in
    // frame 3 only -- a minimal model of a point source's trail. Lighten
    // blend should trace out the full trail (every pixel keeps its one
    // bright frame), not average it away to a dim streak.
    const double background = 0.1;
    const double starValue = 5.0;
    final CoveredLinearRgbTile frame1 = _makeFrame(
      <List<double>>[
        <double>[starValue, starValue, starValue],
        <double>[background, background, background],
        <double>[background, background, background],
      ],
      <int>[1, 1, 1],
    );
    final CoveredLinearRgbTile frame2 = _makeFrame(
      <List<double>>[
        <double>[background, background, background],
        <double>[starValue, starValue, starValue],
        <double>[background, background, background],
      ],
      <int>[1, 1, 1],
    );
    final CoveredLinearRgbTile frame3 = _makeFrame(
      <List<double>>[
        <double>[background, background, background],
        <double>[background, background, background],
        <double>[starValue, starValue, starValue],
      ],
      <int>[1, 1, 1],
    );
    final LightenBlendResult result = lightenBlendCombineCoveredRgb(
      frames: <CoveredLinearRgbTile>[frame1, frame2, frame3],
    );
    for (int pixel = 0; pixel < 3; pixel++) {
      for (int channel = 0; channel < 3; channel++) {
        expect(
          (result.rgb[pixel * 3 + channel] - starValue).abs(),
          lessThan(1e-9),
          reason: "pixel $pixel channel $channel should show the star's "
              'peak',
        );
      }
    }
  });

  test('a pixel uncovered by any frame reports zero coverage and value', () {
    final CoveredLinearRgbTile frameA = _makeFrame(
      <List<double>>[
        <double>[10, 10, 10],
        <double>[5, 5, 5],
      ],
      <int>[1, 0],
    );
    final CoveredLinearRgbTile frameB = _makeFrame(
      <List<double>>[
        <double>[20, 20, 20],
        <double>[8, 8, 8],
      ],
      <int>[1, 0],
    );
    final LightenBlendResult result = lightenBlendCombineCoveredRgb(
      frames: <CoveredLinearRgbTile>[frameA, frameB],
    );
    expect(result.rgb.sublist(0, 3), orderedEquals(<double>[20, 20, 20]));
    expect(result.coverage[0], 2);
    expect(result.rgb.sublist(3, 6), orderedEquals(<double>[0, 0, 0]));
    expect(result.coverage[1], 0);
  });

  test('minimumCoveringFrames zeroes out under-covered pixels', () {
    final CoveredLinearRgbTile frameA = _makeFrame(
      <List<double>>[
        <double>[10, 10, 10],
        <double>[5, 5, 5],
      ],
      <int>[1, 1],
    );
    // Pixel 1 only covered in frame A.
    final CoveredLinearRgbTile frameB = _makeFrame(
      <List<double>>[
        <double>[20, 20, 20],
        <double>[8, 8, 8],
      ],
      <int>[1, 0],
    );
    final LightenBlendResult result = lightenBlendCombineCoveredRgb(
      frames: <CoveredLinearRgbTile>[frameA, frameB],
      minimumCoveringFrames: 2,
    );
    expect(result.rgb.sublist(0, 3), orderedEquals(<double>[20, 20, 20]));
    expect(result.coverage[0], 2);
    expect(result.rgb.sublist(3, 6), orderedEquals(<double>[0, 0, 0]));
    expect(result.coverage[1], 0);
  });

  test(
    'keepHighest=2 rejects a single-frame outlier spike that standard '
    'lighten blend would keep forever',
    () {
      CoveredLinearRgbTile ordinary() => _makeFrame(
            <List<double>>[
              <double>[0.5, 0.5, 0.5]
            ],
            <int>[1],
          );
      final CoveredLinearRgbTile spike = _makeFrame(
        <List<double>>[
          <double>[99, 99, 99]
        ],
        <int>[1],
      );
      final List<CoveredLinearRgbTile> frames = <CoveredLinearRgbTile>[
        ordinary(),
        ordinary(),
        spike,
        ordinary(),
        ordinary(),
        ordinary(),
      ];

      final LightenBlendResult standard = lightenBlendCombineCoveredRgb(
        frames: frames,
      );
      expect(standard.rgb, orderedEquals(<double>[99, 99, 99]));

      final LightenBlendResult robust = lightenBlendCombineCoveredRgb(
        frames: frames,
        keepHighest: 2,
        minimumCoveringFrames: 2,
      );
      // The 2nd-highest value across the six frames is the ordinary 0.5,
      // not the one-off 99 spike.
      expect(robust.rgb, orderedEquals(<double>[0.5, 0.5, 0.5]));
    },
  );

  test(
    'keepHighest still traces a trail that persists across >= keepHighest '
    'frames',
    () {
      final List<CoveredLinearRgbTile> frames = <CoveredLinearRgbTile>[
        _makeFrame(<List<double>>[
          <double>[0.1, 0.1, 0.1]
        ], <int>[
          1
        ]),
        _makeFrame(<List<double>>[
          <double>[4.0, 4.0, 4.0]
        ], <int>[
          1
        ]),
        _makeFrame(<List<double>>[
          <double>[4.2, 4.2, 4.2]
        ], <int>[
          1
        ]),
        _makeFrame(<List<double>>[
          <double>[4.1, 4.1, 4.1]
        ], <int>[
          1
        ]),
        _makeFrame(<List<double>>[
          <double>[0.1, 0.1, 0.1]
        ], <int>[
          1
        ]),
      ];
      final LightenBlendResult result = lightenBlendCombineCoveredRgb(
        frames: frames,
        keepHighest: 2,
        minimumCoveringFrames: 2,
      );
      // 2nd-highest of {0.1, 4.0, 4.2, 4.1, 0.1} sorted desc: 4.2, 4.1,
      // 4.0, 0.1, 0.1 -> 2nd highest is 4.1.
      for (final double value in result.rgb) {
        expect(
          (value - 4.1).abs(),
          lessThan(1e-5),
          reason: 'expected ~4.1, got $value',
        );
      }
    },
  );

  test('rejects a non-positive keepHighest', () {
    final CoveredLinearRgbTile frame = _makeFrame(
      <List<double>>[
        <double>[1, 1, 1]
      ],
      <int>[1],
    );
    expect(
      () => lightenBlendCombineCoveredRgb(
        frames: <CoveredLinearRgbTile>[frame],
        keepHighest: 0,
      ),
      throwsA(isA<InvalidLightenBlendInput>()),
    );
  });

  test('is cancellable between frames', () {
    final CoveredLinearRgbTile frame = _makeFrame(
      <List<double>>[
        <double>[1, 1, 1]
      ],
      <int>[1],
    );
    int calls = 0;
    expect(
      () => lightenBlendCombineCoveredRgb(
        frames: <CoveredLinearRgbTile>[frame, frame, frame],
        isCancelled: () {
          calls += 1;
          return calls > 1;
        },
      ),
      throwsA(isA<LightenBlendCancelled>()),
    );
  });

  test(
    'large synthetic sequence: flat background stays flat, trail traces '
    'correctly',
    () {
      const int width = 20;
      const int height = 20;
      const int pixelCount = width * height;
      const int frameCount = 30;
      const double background = 0.15;

      CoveredLinearRgbTile makeBackgroundFrame() {
        final Float32List rgb = Float32List(pixelCount * 3)
          ..fillRange(0, pixelCount * 3, background);
        final Uint8List coverage = Uint8List(pixelCount)
          ..fillRange(0, pixelCount, 1);
        final LinearRgbTile tile = LinearRgbTile(
          x: 0,
          y: 0,
          width: pixelCount,
          height: 1,
          interleavedRgb: rgb,
        );
        return CoveredLinearRgbTile(tile: tile, coverage: coverage);
      }

      final List<CoveredLinearRgbTile> frames = <CoveredLinearRgbTile>[];
      final List<int> trailPixels = <int>[];
      for (int frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        final CoveredLinearRgbTile frame = makeBackgroundFrame();
        // A star sweeps diagonally across the frame, one pixel per frame.
        final int x = frameIndex % width;
        final int y = (frameIndex ~/ width) % height;
        final int pixel = y * width + x;
        trailPixels.add(pixel);
        frame.tile.interleavedRgb[pixel * 3] = 3.0;
        frame.tile.interleavedRgb[pixel * 3 + 1] = 3.0;
        frame.tile.interleavedRgb[pixel * 3 + 2] = 3.0;
        frames.add(frame);
      }

      final LightenBlendResult result = lightenBlendCombineCoveredRgb(
        frames: frames,
      );
      for (int pixel = 0; pixel < pixelCount; pixel++) {
        final bool onTrail = trailPixels.contains(pixel);
        final double expected = onTrail ? 3.0 : background;
        expect(
          (result.rgb[pixel * 3] - expected).abs(),
          lessThan(1e-5),
          reason: 'pixel $pixel: expected $expected, got '
              '${result.rgb[pixel * 3]}',
        );
        expect(result.coverage[pixel], frameCount);
      }
    },
  );
}
