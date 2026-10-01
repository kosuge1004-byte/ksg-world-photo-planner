import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/linear_raw_mosaic.dart';
import 'dng_d65_color_transform.dart';
import 'linear_rgb_color_transform.dart';

class InvalidRawCameraColorProfile extends ArgumentError {
  InvalidRawCameraColorProfile(String super.message);
}

final class RawCameraColorProfile {
  RawCameraColorProfile({
    required List<double> d65XyzToCamera,
    required List<double> phaseWhiteBalance,
  })  : d65XyzToCamera = List<double>.unmodifiable(d65XyzToCamera),
        phaseWhiteBalance = List<double>.unmodifiable(phaseWhiteBalance) {
    if (d65XyzToCamera.length != 9 ||
        d65XyzToCamera.any((double value) => !value.isFinite)) {
      throw InvalidRawCameraColorProfile(
        'd65XyzToCamera must contain 9 finite values.',
      );
    }
    if (phaseWhiteBalance.length != 4 ||
        phaseWhiteBalance.any(
          (double value) => !value.isFinite || value <= 0,
        )) {
      throw InvalidRawCameraColorProfile(
        'phaseWhiteBalance must contain 4 finite positive gains.',
      );
    }
    try {
      // CFA pattern is not known at profile-construction time. Validate only
      // the camera matrix here; the real pattern-specific WB transform is
      // validated later by outputTransform().
      linearSrgbTransformFromDngD65(
        xyzToCameraD65: this.d65XyzToCamera,
        cameraWhiteBalanceRgb: const <double>[1, 1, 1],
      );
    } on InvalidDngColorTransformInput catch (error) {
      throw InvalidRawCameraColorProfile(
        'd65XyzToCamera is not safely invertible: ${error.message}',
      );
    }
  }

  final List<double> d65XyzToCamera;
  final List<double> phaseWhiteBalance;

  bool hasCompatibleMatrix(
    RawCameraColorProfile other, {
    double tolerance = 1e-5,
  }) {
    if (!tolerance.isFinite || tolerance < 0) {
      throw ArgumentError.value(tolerance, 'tolerance');
    }
    for (int index = 0; index < 9; index++) {
      if ((d65XyzToCamera[index] - other.d65XyzToCamera[index]).abs() >
          tolerance) {
        return false;
      }
    }
    return true;
  }

  List<double> rgbWhiteBalance(CfaPattern pattern) {
    final List<List<double>> byColor = <List<double>>[
      <double>[],
      <double>[],
      <double>[],
    ];
    for (int phase = 0; phase < 4; phase++) {
      final int x = phase & 1;
      final int y = phase >> 1;
      byColor[_colorAt(pattern, x, y)].add(phaseWhiteBalance[phase]);
    }
    return <double>[
      for (final List<double> gains in byColor)
        gains.reduce((double left, double right) => left + right) /
            gains.length,
    ];
  }

  List<double> normalizedRgbWhiteBalance(CfaPattern pattern) {
    final List<double> gains = rgbWhiteBalance(pattern);
    final double greenGain = gains[1];
    return <double>[gains[0] / greenGain, 1, gains[2] / greenGain];
  }

  List<double> normalizedPhaseWhiteBalance(CfaPattern pattern) {
    final double greenGain = rgbWhiteBalance(pattern)[1];
    return <double>[
      for (final double gain in phaseWhiteBalance) gain / greenGain,
    ];
  }

  LinearRgbColorTransform outputTransform(CfaPattern pattern) =>
      linearSrgbTransformFromDngD65(
        xyzToCameraD65: d65XyzToCamera,
        cameraWhiteBalanceRgb: normalizedRgbWhiteBalance(pattern),
      );
}

final class RawCameraColorConsensus {
  RawCameraColorConsensus({
    required this.profile,
    required this.representativeIndex,
    required Iterable<int> memberIndices,
  }) : memberIndices = Set<int>.unmodifiable(memberIndices);

  final RawCameraColorProfile profile;
  final int representativeIndex;
  final Set<int> memberIndices;
}

/// Selects the largest compatible camera-matrix group, then uses the median
/// RGB white balance of that group. This prevents one early metadata outlier
/// from becoming the color reference for an otherwise consistent sequence.
RawCameraColorConsensus? selectRawCameraColorConsensus({
  required List<RawCameraColorProfile?> profiles,
  required List<CfaPattern?> patterns,
  double matrixTolerance = 1e-5,
}) {
  if (profiles.length != patterns.length) {
    throw ArgumentError('profiles and patterns must have the same length.');
  }
  if (!matrixTolerance.isFinite || matrixTolerance < 0) {
    throw ArgumentError.value(matrixTolerance, 'matrixTolerance');
  }
  final List<int> candidates = <int>[
    for (int index = 0; index < profiles.length; index++)
      if (profiles[index] != null && patterns[index] != null) index,
  ];
  if (candidates.isEmpty) return null;

  int representativeIndex = candidates.first;
  int largestGroupSize = 0;
  double smallestGroupMatrixDistance = double.infinity;
  for (final int candidateIndex in candidates) {
    final RawCameraColorProfile candidate = profiles[candidateIndex]!;
    final List<int> compatibleIndices = <int>[
      for (final int index in candidates)
        if (candidate.hasCompatibleMatrix(
          profiles[index]!,
          tolerance: matrixTolerance,
        ))
          index,
    ];
    double groupMatrixDistance = 0;
    for (final int index in compatibleIndices) {
      final RawCameraColorProfile member = profiles[index]!;
      for (int coefficient = 0; coefficient < 9; coefficient++) {
        final double delta = candidate.d65XyzToCamera[coefficient] -
            member.d65XyzToCamera[coefficient];
        groupMatrixDistance += delta * delta;
      }
    }
    if (compatibleIndices.length > largestGroupSize ||
        (compatibleIndices.length == largestGroupSize &&
            groupMatrixDistance < smallestGroupMatrixDistance)) {
      largestGroupSize = compatibleIndices.length;
      smallestGroupMatrixDistance = groupMatrixDistance;
      representativeIndex = candidateIndex;
    }
  }

  final RawCameraColorProfile representative = profiles[representativeIndex]!;
  final List<int> memberIndices = <int>[
    for (final int index in candidates)
      if (representative.hasCompatibleMatrix(
        profiles[index]!,
        tolerance: matrixTolerance,
      ))
        index,
  ];
  final CfaPattern representativePattern = patterns[representativeIndex]!;
  final List<List<double>> normalizedPhaseGains =
      List<List<double>>.generate(4, (_) => <double>[]);
  for (final int index in memberIndices) {
    final RawCameraColorProfile profile = profiles[index]!;
    final CfaPattern pattern = patterns[index]!;
    final List<double> perPhase = profile.normalizedPhaseWhiteBalance(pattern);
    for (int representativePhase = 0;
        representativePhase < 4;
        representativePhase++) {
      final int x = representativePhase & 1;
      final int y = representativePhase >> 1;
      final int color = _colorAt(representativePattern, x, y);
      final List<double> matching = <double>[
        for (int sourcePhase = 0; sourcePhase < 4; sourcePhase++)
          if (_colorAt(pattern, sourcePhase & 1, sourcePhase >> 1) == color)
            perPhase[sourcePhase],
      ];
      // Red and blue have one phase; green has two. Preserve the green
      // phase split only when both mosaics share the same Bayer layout.
      final double value = pattern == representativePattern
          ? perPhase[representativePhase]
          : matching.reduce((double a, double b) => a + b) / matching.length;
      normalizedPhaseGains[representativePhase].add(value);
    }
  }
  final List<double> consensusPhaseGains = <double>[
    for (final List<double> gains in normalizedPhaseGains) _median(gains),
  ];
  return RawCameraColorConsensus(
    profile: RawCameraColorProfile(
      d65XyzToCamera: representative.d65XyzToCamera,
      phaseWhiteBalance: consensusPhaseGains,
    ),
    representativeIndex: representativeIndex,
    memberIndices: memberIndices,
  );
}

LinearRawMosaic harmonizeMosaicWhiteBalance({
  required LinearRawMosaic mosaic,
  required RawCameraColorProfile source,
  required RawCameraColorProfile target,
  required CfaPattern targetPattern,
}) {
  if (!source.hasCompatibleMatrix(target)) {
    throw InvalidRawCameraColorProfile(
      'Cannot harmonize mosaics with different camera color matrices.',
    );
  }
  final List<double> phaseScales = whiteBalanceHarmonizationPhaseScales(
    source: source,
    target: target,
    sourcePattern: mosaic.cfaPattern,
    targetPattern: targetPattern,
  );
  const double maximumFloat32 = 3.4028234663852886e38;
  final Float32List samples = Float32List(mosaic.samples.length);
  for (int y = 0; y < mosaic.height; y++) {
    for (int x = 0; x < mosaic.width; x++) {
      final int index = y * mosaic.width + x;
      final double sourceSample = mosaic.samples[index];
      if (!sourceSample.isFinite) {
        throw InvalidRawCameraColorProfile(
          'Cannot harmonize a mosaic containing non-finite RAW samples.',
        );
      }
      final int phase = ((y & 1) << 1) | (x & 1);
      final double harmonized = sourceSample * phaseScales[phase];
      if (!harmonized.isFinite || harmonized.abs() > maximumFloat32) {
        throw InvalidRawCameraColorProfile(
          'White-balance harmonization exceeds finite Float32 range.',
        );
      }
      samples[index] = harmonized;
    }
  }
  return LinearRawMosaic(
    width: mosaic.width,
    height: mosaic.height,
    cfaPattern: mosaic.cfaPattern,
    samples: samples,
    saturationMask: mosaic.saturationMask,
  );
}

/// Returns the four Bayer-phase multipliers used to bring one frame's white
/// balance into the selected stack consensus. Keeping these multipliers
/// separate lets the file-backed CFA path apply them while reading tiles,
/// without allocating a second full-resolution mosaic.
List<double> whiteBalanceHarmonizationPhaseScales({
  required RawCameraColorProfile source,
  required RawCameraColorProfile target,
  required CfaPattern sourcePattern,
  required CfaPattern targetPattern,
}) {
  if (!source.hasCompatibleMatrix(target)) {
    throw InvalidRawCameraColorProfile(
      'Cannot harmonize mosaics with different camera color matrices.',
    );
  }
  final List<double> targetRgbGains =
      target.normalizedRgbWhiteBalance(targetPattern);
  final List<double> sourcePhaseGains =
      source.normalizedPhaseWhiteBalance(sourcePattern);
  return List<double>.generate(4, (int phase) {
    final int x = phase & 1;
    final int y = phase >> 1;
    final int color = _colorAt(sourcePattern, x, y);
    return targetRgbGains[color] / sourcePhaseGains[phase];
  }, growable: false);
}

int _colorAt(CfaPattern pattern, int x, int y) {
  final bool evenX = x.isEven;
  final bool evenY = y.isEven;
  return switch (pattern) {
    CfaPattern.rggb => evenX && evenY ? 0 : (!evenX && !evenY ? 2 : 1),
    CfaPattern.bggr => evenX && evenY ? 2 : (!evenX && !evenY ? 0 : 1),
    CfaPattern.grbg => !evenX && evenY ? 0 : (evenX && !evenY ? 2 : 1),
    CfaPattern.gbrg => evenX && !evenY ? 0 : (!evenX && evenY ? 2 : 1),
  };
}

double _median(List<double> values) {
  final List<double> sorted = List<double>.from(values)..sort();
  final int middle = sorted.length ~/ 2;
  return sorted.length.isOdd
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
}
