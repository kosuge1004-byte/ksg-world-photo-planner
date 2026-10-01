import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/affine_sampling_transform.dart';
import 'package:mobile_stack/core/registration/guided_field_registration.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';
import 'package:mobile_stack/core/registration/registration_hard_quality.dart';
import 'package:mobile_stack/core/registration/star_detector.dart';
import 'package:mobile_stack/core/registration/star_transform_estimator.dart';
import 'package:mobile_stack/core/session/milky_way_pipeline.dart';

/// Work351. Dart counterpart of
/// `tool/raw_samples/test/guided_field_registration_reference.test.mjs`
/// (same synthetic fixed-tripod sky model: catalogue directions rotated about
/// the celestial pole and projected through a rectilinear lens with one
/// radial distortion term).

const int _w = 6000;
const int _h = 4000;

class _Lcg {
  _Lcg(int seed) : _s = seed & 0xffffffff;
  int _s;
  double next() {
    _s = (_s * 1664525 + 1013904223) & 0xffffffff;
    return _s / 4294967296;
  }

  double gauss() {
    final double u = math.max(next(), 1e-12);
    final double v = next();
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v);
  }
}

class _SkyStar {
  _SkyStar(this.star, this.id);
  final DetectedStar star;
  final int id;
}

List<List<_SkyStar>> _sky({
  int frames = 40,
  double intervalSec = 20,
  double focalPx = 2333,
  double foregroundFraction = 0,
}) {
  final _Lcg r = _Lcg(7);
  const double alt = 25 * math.pi / 180;
  const double az = 160 * math.pi / 180;
  final List<double> forward = <double>[
    math.cos(alt) * math.sin(az),
    math.cos(alt) * math.cos(az),
    math.sin(alt),
  ];
  final List<double> right = <double>[math.cos(az), -math.sin(az), 0];
  final List<double> up = <double>[
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];
  const double lat = 35 * math.pi / 180;
  final List<double> pole = <double>[0, math.cos(lat), math.sin(lat)];
  final List<List<double>> dirs = <List<double>>[];
  final List<double> flux = <double>[];
  for (int i = 0; i < 6000; i++) {
    final List<double> v = <double>[r.gauss(), r.gauss(), r.gauss()];
    final double n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    dirs.add(<double>[v[0] / n, v[1] / n, v[2] / n]);
    flux.add(math.exp(-3 * r.next()) * r.next() * r.next());
  }
  final List<List<_SkyStar>> sequence = <List<_SkyStar>>[];
  for (int f = 0; f < frames; f++) {
    final double t = -(f * intervalSec) * 2 * math.pi / 86164;
    final double c = math.cos(t), s = math.sin(t), cc = 1 - c;
    final double x = pole[0], y = pole[1], z = pole[2];
    final List<List<double>> rot = <List<double>>[
      <double>[c + x * x * cc, x * y * cc - z * s, x * z * cc + y * s],
      <double>[y * x * cc + z * s, c + y * y * cc, y * z * cc - x * s],
      <double>[z * x * cc - y * s, z * y * cc + x * s, c + z * z * cc],
    ];
    final List<_SkyStar> stars = <_SkyStar>[];
    for (int id = 0; id < dirs.length; id++) {
      final List<double> d = dirs[id];
      final List<double> wv = <double>[
        for (int k = 0; k < 3; k++)
          rot[k][0] * d[0] + rot[k][1] * d[1] + rot[k][2] * d[2],
      ];
      final double cz =
          wv[0] * forward[0] + wv[1] * forward[1] + wv[2] * forward[2];
      if (cz <= 0.1) continue;
      final double cx = wv[0] * right[0] + wv[1] * right[1] + wv[2] * right[2];
      final double cy = -(wv[0] * up[0] + wv[1] * up[1] + wv[2] * up[2]);
      double xn = cx / cz, yn = cy / cz;
      final double rr = (xn * xn + yn * yn) * focalPx * focalPx / (3000 * 3000);
      if (rr > 2.5) continue;
      final double dist = 1 - 0.02 * rr;
      xn *= dist;
      yn *= dist;
      final double px = _w / 2 + focalPx * xn + 0.15 * r.gauss();
      final double py = _h / 2 + focalPx * yn + 0.15 * r.gauss();
      if (px < 8 ||
          py < 8 ||
          px > _w - 9 ||
          py > _h * (1 - foregroundFraction) - 9) {
        continue;
      }
      if (r.next() < 0.1) continue;
      stars.add(_SkyStar(
        DetectedStar(
          x: px,
          y: py,
          flux: flux[id] * (1 + 0.1 * r.gauss()),
          peakValue: 1,
          roundness: 0.05,
          sharpness: 0.5,
        ),
        id,
      ));
    }
    stars.sort((_SkyStar a, _SkyStar b) => b.star.flux.compareTo(a.star.flux));
    sequence.add(stars);
  }
  return sequence;
}

List<DetectedStar> _select(List<_SkyStar> frame) =>
    selectSpatiallyDistributedStars(
      <DetectedStar>[for (final _SkyStar s in frame.take(1200)) s.star],
      imageWidth: _w,
      imageHeight: _h,
    );

double _p95(List<double> v) {
  v.sort();
  return v[(v.length * 0.95).floor()];
}

void main() {
  group('AffineSamplingTransform projective extension', () {
    test('affine evaluation and checkpoint form are unchanged', () {
      final AffineSamplingTransform t = AffineSamplingTransform.similarity(
        rotationDegrees: 0.37,
        sourceOffsetX: 3.25,
        sourceOffsetY: -1.5,
        centerX: 2999.5,
        centerY: 1999.5,
      );
      expect(t.isProjective, isFalse);
      expect(t.sourceX(123.25, 456.5), t.m00 * 123.25 + t.m01 * 456.5 + t.m02);
      expect(t.sourceY(123.25, 456.5), t.m10 * 123.25 + t.m11 * 456.5 + t.m12);
      expect(t.checkpointCoefficients,
          <double>[t.m00, t.m01, t.m02, t.m10, t.m11, t.m12]);
    });

    test('projective evaluation and inverse round-trip', () {
      final AffineSamplingTransform t = AffineSamplingTransform(
        m00: 1.001,
        m01: -0.004,
        m02: 12.5,
        m10: 0.003,
        m11: 0.999,
        m12: -7.25,
        p20: 2e-6,
        p21: -1.5e-6,
      );
      expect(t.isProjective, isTrue);
      expect(t.checkpointCoefficients.length, 8);
      final AffineSamplingTransform inv = t.inverse();
      for (final (double, double) p in <(double, double)>[
        (0.0, 0.0),
        (5999.0, 0.0),
        (0.0, 3999.0),
        (5999.0, 3999.0),
        (3000.0, 2000.0),
      ]) {
        final double sx = t.sourceX(p.$1, p.$2);
        final double sy = t.sourceY(p.$1, p.$2);
        expect(inv.sourceX(sx, sy), closeTo(p.$1, 1e-6));
        expect(inv.sourceY(sx, sy), closeTo(p.$2, 1e-6));
      }
    });
  });

  test('rigid registration collapses to a band; guided chain keeps the '
      'whole field sub-pixel', () {
    final List<List<_SkyStar>> sequence = _sky();
    const int referenceIndex = 2;
    final List<DetectedStar> reference = _select(sequence[referenceIndex]);

    final StarSimilarityTransformEstimate far = estimateSimilarityTransform(
      <DetectedStar>[for (final _SkyStar s in sequence[2].take(150)) s.star],
      <DetectedStar>[for (final _SkyStar s in sequence[30].take(150)) s.star],
      toleranceRadius: 3,
      minInliers: 5,
    );
    expect(far.inlierCount, lessThan(20));

    AffineSamplingTransform seed = AffineSamplingTransform.identity();
    bool after = true;
    for (final ({int index, int neighbour}) step
        in guidedRegistrationOrder(sequence.length, referenceIndex)) {
      if ((step.index > referenceIndex) != after) {
        after = step.index > referenceIndex;
        seed = AffineSamplingTransform.identity();
      }
      final List<DetectedStar> target = _select(sequence[step.index]);
      final GuidedFieldRegistrationResult result =
          refineGuidedFieldRegistration(
        referenceStars: reference,
        targetStars: target,
        seed: seed,
        imageWidth: _w,
        imageHeight: _h,
      );
      seed = result.transform;
      expect(result.inlierCount, greaterThanOrEqualTo(100),
          reason: 'frame ${step.index}');
      final List<LocalResidualMatch> residuals = buildLocalResidualMatches(
        matches: result.matches,
        referenceStars: reference,
        targetStars: target,
        globalTransform: result.transform,
      );
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(residuals);
      final Map<int, DetectedStar> truth = <int, DetectedStar>{
        for (final _SkyStar s in sequence[step.index]) s.id: s.star,
      };
      final List<double> errors = <double>[];
      for (final _SkyStar s in sequence[referenceIndex]) {
        final DetectedStar? q = truth[s.id];
        if (q == null) continue;
        final LocalResidualCorrection d = field.evaluate(s.star.x, s.star.y);
        final double ex =
            result.transform.sourceX(s.star.x, s.star.y) + d.dx - q.x;
        final double ey =
            result.transform.sourceY(s.star.x, s.star.y) + d.dy - q.y;
        errors.add(math.sqrt(ex * ex + ey * ey));
      }
      expect(_p95(errors), lessThanOrEqualTo(1.2), reason: 'frame ${step.index}');
      final RegistrationCoverageGateResult gate =
          evaluateRegistrationCoverageGate(
        matches: result.matches,
        referenceStars: reference,
        imageWidth: _w,
        imageHeight: _h,
      );
      expect(gate.passed, isTrue, reason: gate.reasons.join(';'));
    }
  });

  test('spatial selection keeps sparse regions and stays flux-sorted', () {
    final List<DetectedStar> stars = <DetectedStar>[
      for (int i = 0; i < 300; i++)
        DetectedStar(
          x: 10.0 + (i % 20) * 20,
          y: 10.0 + (i ~/ 20) * 20,
          flux: 100.0 + i,
          peakValue: 1,
          roundness: 0,
          sharpness: 0.5,
        ),
      for (int i = 0; i < 60; i++)
        DetectedStar(
          x: 1000.0 + (i % 10) * 480,
          y: 800.0 + (i ~/ 10) * 520,
          flux: 1 + i * 0.01,
          peakValue: 1,
          roundness: 0,
          sharpness: 0.5,
        ),
    ];
    final List<DetectedStar> selected = selectSpatiallyDistributedStars(
      stars,
      imageWidth: _w,
      imageHeight: _h,
      limit: 150,
    );
    expect(selected.length, 150);
    expect(selected.where((DetectedStar s) => s.x >= 1000).length, 60);
    for (int i = 1; i < selected.length; i++) {
      expect(selected[i - 1].flux >= selected[i].flux, isTrue);
    }
  });

  test('coverage gate is relative to the reference star field', () {
    final List<DetectedStar> reference = <DetectedStar>[
      for (int i = 0; i < 100; i++)
        DetectedStar(
          x: 100.0 + (i % 10) * 580,
          y: 100.0 + (i ~/ 10) * 180,
          flux: 1,
          peakValue: 1,
          roundness: 0,
          sharpness: 0.5,
        ),
    ];
    final List<StarMatch> all = <StarMatch>[
      for (int i = 0; i < 100; i++)
        StarMatch(referenceIndex: i, targetIndex: i, distance: 0),
    ];
    final RegistrationCoverageGateResult pass =
        evaluateRegistrationCoverageGate(
      matches: all,
      referenceStars: reference,
      imageWidth: _w,
      imageHeight: _h,
    );
    expect(pass.passed, isTrue);
    expect(pass.supportedQuadrants, <int>[0, 1]);
    final RegistrationCoverageGateResult band =
        evaluateRegistrationCoverageGate(
      matches: <StarMatch>[
        for (final StarMatch m in all)
          if (reference[m.referenceIndex].x < 1500) m,
      ],
      referenceStars: reference,
      imageWidth: _w,
      imageHeight: _h,
    );
    expect(band.passed, isFalse);
  });

  test('plausibility rejects extreme perspective and scale', () {
    expect(
      () => assertPlausibleFixedCameraTransform(
        AffineSamplingTransform(
            m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0, p20: 1e-4),
        _w,
        _h,
        5e-5,
      ),
      throwsA(isA<GuidedFieldRegistrationFailed>()),
    );
    expect(
      () => assertPlausibleFixedCameraTransform(
        AffineSamplingTransform(
            m00: 1.3, m01: 0, m02: 0, m10: 0, m11: 1.3, m12: 0),
        _w,
        _h,
        5e-5,
      ),
      throwsA(isA<GuidedFieldRegistrationFailed>()),
    );
  });

  test('registration model names round-trip and default to legacy', () {
    expect(milkyWayRegistrationModelFromName(null),
        MilkyWayRegistrationModel.legacyRigid);
    expect(milkyWayRegistrationModelFromName('unknown'),
        MilkyWayRegistrationModel.legacyRigid);
    expect(milkyWayRegistrationModelFromName('guidedWholeField'),
        MilkyWayRegistrationModel.guidedWholeField);
  });
}
