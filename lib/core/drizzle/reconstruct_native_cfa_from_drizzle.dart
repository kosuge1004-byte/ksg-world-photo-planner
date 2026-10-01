import 'dart:typed_data';

import '../drizzle/drizzle_accumulator.dart' show DrizzleResult;
import '../drizzle/drizzle_gap_fill.dart' show fillChannelGaps;
import '../image/cfa_pattern.dart';
import '../image/linear_raw_mosaic.dart';
import 'cfa_drizzle.dart' show CfaDrizzleResult;

/// Dart port of `tool/raw_samples/reconstruct_native_cfa_from_drizzle_
/// reference.mjs`.
///
/// Bridges CFA drizzle output (Work85/87) to this project's real
/// adaptive demosaic engine (`mobile_stack_adaptive_demosaic_
/// engine.dart`) for the first time — until now, the CFA drizzle
/// pipeline finished with `drizzle_gap_fill.dart`'s (Work91/92)
/// same-channel-only local average, never actually reaching the real,
/// structure-tensor-based demosaic engine sitting unused downstream.
///
/// See the Node reference's own doc comment for the full design
/// rationale, including why this bridge is scoped to `outputScale = 1`
/// (no supersampling) specifically: at native resolution, every output
/// position has a well-defined "native CFA phase" matching what
/// [referenceCfaPattern] would assign it in an ordinary undrizzled raw
/// frame, so reading only that channel's drizzled value at each
/// position produces a [LinearRawMosaic] the existing demosaic engine
/// can consume completely unmodified — a supersampled grid
/// (`outputScale > 1`) does not have that well-defined native phase at
/// every position, and reconciling that with the demosaic engine's own
/// regular-pattern assumption is a separate, larger architectural
/// question this module does not attempt to solve.
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/reconstruct_native_cfa_from_drizzle_
/// test.dart` before relying on this in production.

class InvalidCfaReconstructionInput extends ArgumentError {
  InvalidCfaReconstructionInput(String super.message);
}

/// Reconstructs a single, native-resolution [LinearRawMosaic] from
/// [drizzleResult] (a `cfaDrizzle`-shaped result — see this file's own
/// doc comment for the full design).
///
/// - [referenceCfaPattern]: which of the four standard Bayer patterns
///   defines each position's "native phase" — must match the reference
///   frame's own actual CFA pattern.
/// - [outputScale]: must be exactly `1`.
/// - [gapFillKernelRadius], [gapFillMinimumCoverage]: forwarded to
///   `fillChannelGaps` for filling a position whose own native-phase
///   channel has insufficient coverage.
///
/// Throws [InvalidCfaReconstructionInput] if [outputScale] is not `1`,
/// or [drizzleResult] does not have exactly three channels (matching
/// [CfaColor]'s three values — a mismatch here would mean a caller
/// hand-built a [CfaDrizzleResult] directly rather than through
/// `cfaDrizzle`/`drizzleCfaTiled` itself, since those always produce
/// exactly three).
LinearRawMosaic reconstructNativeCfaMosaicFromDrizzle(
  CfaDrizzleResult drizzleResult,
  CfaPattern referenceCfaPattern,
  double outputScale, {
  int gapFillKernelRadius = 2,
  double gapFillMinimumCoverage = 1e-6,
}) {
  if (outputScale != 1) {
    throw InvalidCfaReconstructionInput(
      'reconstructNativeCfaMosaicFromDrizzle only supports outputScale '
      '= 1 (supersampled output has no well-defined native CFA phase at '
      'every position); got $outputScale.',
    );
  }
  if (drizzleResult.channels.length != 3) {
    throw InvalidCfaReconstructionInput(
      'drizzleResult must have exactly 3 channels.',
    );
  }
  final int width = drizzleResult.width;
  final int height = drizzleResult.height;

  // 各チャンネルを、そのチャンネル自身の近傍だけでギャップ埋めして
  // おく(fillChannelGaps自身の「他チャンネルとは混ぜない」という
  // 既存の契約をそのまま踏襲する)。
  final List<DrizzleResult> filledChannels = <DrizzleResult>[
    for (final DrizzleResult channel in drizzleResult.channels)
      fillChannelGaps(
        channel,
        width,
        height,
        kernelRadius: gapFillKernelRadius,
        minimumCoverage: gapFillMinimumCoverage,
      ),
  ];

  final Float32List samples = Float32List(width * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final int index = y * width + x;
      final int channelIndex = referenceCfaPattern.colorAt(x, y).index;
      final double value = filledChannels[channelIndex].value[index];
      const double maximumFloat32 = 3.4028234663852886e38;
      if (!value.isFinite || value.abs() > maximumFloat32) {
        throw InvalidCfaReconstructionInput(
          'Reconstructed CFA sample exceeds finite Float32 range.',
        );
      }
      samples[index] = value;
    }
  }

  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: referenceCfaPattern,
    samples: samples,
  );
}
