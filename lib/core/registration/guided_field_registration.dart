import 'dart:math' as math;

import 'affine_sampling_transform.dart';
import 'star_detector.dart';
import 'star_transform_estimator.dart';

/// Guided whole-field star registration (Work351).
///
/// Dart port of `tool/raw_samples/guided_field_registration_reference.mjs`
/// (tested by `tool/raw_samples/test/guided_field_registration_reference
/// .test.mjs` against a physically modelled fixed-tripod sky, and by
/// `test/guided_field_registration_test.dart`).
///
/// Why: [estimateSimilarityTransform] fits a rigid model. For a fixed tripod
/// the diurnal sky motion in the image plane is a homography (K R K^-1) plus
/// lens distortion, so with a 3 px acceptance radius the rigid fit explains
/// only a narrow band of the field. The Work350 device log shows exactly
/// this: 6-12 matches in one quadrant (matchSpanY 0.3-9 %), the degree-2
/// local correction never fitted (it needs 24 matches), and corners were
/// resampled with multi-pixel error.
///
/// What: grow the correspondence set over the whole field from a seed (the
/// rigid estimate, or the already-refined homography of the temporally
/// adjacent frame) with progressively more capable models (affine ->
/// homography -> homography + quadratic residual) and progressively tighter
/// radii. Radii wider than [toleranceRadius] are only used with a
/// nearest/second-nearest ratio test. The returned matches are always
/// selected with the strict [toleranceRadius], so the existing quality
/// gates keep their thresholds. The returned global model is a projective
/// [AffineSamplingTransform]; lens distortion is left to the existing
/// degree-2 local residual correction.
class GuidedFieldRegistrationFailed implements Exception {
  GuidedFieldRegistrationFailed(this.message);

  final String message;

  @override
  String toString() => 'GuidedFieldRegistrationFailed: $message';
}

class InvalidGuidedFieldRegistrationInput extends ArgumentError {
  InvalidGuidedFieldRegistrationInput(super.message);
}

/// Result of [refineGuidedFieldRegistration].
final class GuidedFieldRegistrationResult {
  const GuidedFieldRegistrationResult({
    required this.transform,
    required this.projective,
    required this.matches,
    required this.rmsResidual,
  });

  /// Output/reference -> source/target sampling map (projective when
  /// [projective] is true, affine otherwise).
  final AffineSamplingTransform transform;
  final bool projective;

  /// Strict whole-field correspondences (reference index -> target index).
  final List<StarMatch> matches;

  /// RMS (pixels) of [transform] over [matches].
  final double rmsResidual;

  int get inlierCount => matches.length;

  /// Rotation (degrees) of the local linear part at the frame center, for
  /// diagnostics only.
  double rotationDegreesAt(double x, double y) {
    final _Jacobian j = _jacobian(transform, x, y);
    return math.atan2(j.c - j.b, j.a + j.d) * 180 / math.pi;
  }
}

class _Frame {
  _Frame(int width, int height)
      : cx = (width - 1) / 2,
        cy = (height - 1) / 2,
        s = math.max(width, height) / 2,
        width = width.toDouble(),
        height = height.toDouble();

  final double cx;
  final double cy;
  final double s;
  final double width;
  final double height;
}

class _Model {
  _Model(this.h, {this.polyX, this.polyY, required this.homography});

  /// Normalized homography [h00,h01,h02,h10,h11,h12,h20,h21] (h22 = 1).
  final List<double> h;
  final List<double>? polyX;
  final List<double>? polyY;
  final bool homography;

  _Model withPoly(List<double> x, List<double> y) =>
      _Model(h, polyX: x, polyY: y, homography: homography);
}

class _Pair {
  const _Pair(this.rx, this.ry, this.u, this.v, this.tu, this.tv);

  final double rx;
  final double ry;
  final double u;
  final double v;
  final double tu;
  final double tv;
}

class _Jacobian {
  const _Jacobian(this.a, this.b, this.c, this.d);

  final double a;
  final double b;
  final double c;
  final double d;
}

_Jacobian _jacobian(AffineSamplingTransform t, double x, double y) {
  final double w = t.p20 * x + t.p21 * y + 1;
  final double nx = t.m00 * x + t.m01 * y + t.m02;
  final double ny = t.m10 * x + t.m11 * y + t.m12;
  return _Jacobian(
    (t.m00 * w - nx * t.p20) / (w * w),
    (t.m01 * w - nx * t.p21) / (w * w),
    (t.m10 * w - ny * t.p20) / (w * w),
    (t.m11 * w - ny * t.p21) / (w * w),
  );
}

/// Local scale (Jacobian determinant) of [t] at ([x], [y]).
double guidedJacobianDeterminant(AffineSamplingTransform t, double x, double y) {
  final _Jacobian j = _jacobian(t, x, y);
  return j.a * j.d - j.b * j.c;
}

/// Rejects transforms a fixed-camera sequence cannot produce: perspective
/// terms beyond [maxTilt] per pixel, a projective denominator outside
/// (0.5, 2) at any frame corner, or a local scale at the frame center
/// outside (0.8, 1.25).
void assertPlausibleFixedCameraTransform(
  AffineSamplingTransform t,
  int width,
  int height,
  double maxTilt,
) {
  if (t.p20.abs() > maxTilt || t.p21.abs() > maxTilt) {
    throw GuidedFieldRegistrationFailed('Perspective terms are implausibly large.');
  }
  for (final (double, double) corner in <(double, double)>[
    (0.0, 0.0),
    ((width - 1).toDouble(), 0.0),
    (0.0, (height - 1).toDouble()),
    ((width - 1).toDouble(), (height - 1).toDouble()),
  ]) {
    final double w = t.p20 * corner.$1 + t.p21 * corner.$2 + 1;
    if (!(w > 0.5 && w < 2)) {
      throw GuidedFieldRegistrationFailed(
        'Homography folds or explodes inside the frame.',
      );
    }
  }
  final double det =
      guidedJacobianDeterminant(t, (width - 1) / 2, (height - 1) / 2);
  if (!(det > 0.8 && det < 1.25)) {
    throw GuidedFieldRegistrationFailed(
      'Center scale $det is implausible for a fixed-camera sequence.',
    );
  }
}

List<double>? _solve(List<List<double>> ata, List<double> atb) {
  final int n = atb.length;
  final List<List<double>> m = <List<double>>[
    for (int i = 0; i < n; i++) <double>[...ata[i], atb[i]],
  ];
  for (int c = 0; c < n; c++) {
    int p = c;
    for (int r = c + 1; r < n; r++) {
      if (m[r][c].abs() > m[p][c].abs()) p = r;
    }
    if (!(m[p][c].abs() > 1e-12)) return null;
    final List<double> swap = m[c];
    m[c] = m[p];
    m[p] = swap;
    for (int r = 0; r < n; r++) {
      if (r == c) continue;
      final double f = m[r][c] / m[c][c];
      if (f == 0) continue;
      for (int k = c; k <= n; k++) {
        m[r][k] -= f * m[c][k];
      }
    }
  }
  final List<double> out = <double>[
    for (int i = 0; i < n; i++) m[i][n] / m[i][i],
  ];
  return out.every((double v) => v.isFinite) ? out : null;
}

List<double>? _leastSquares(
  List<List<double>> rows,
  List<double> rhs,
  int terms,
) {
  final List<List<double>> ata = <List<double>>[
    for (int i = 0; i < terms; i++) List<double>.filled(terms, 0),
  ];
  final List<double> atb = List<double>.filled(terms, 0);
  for (int k = 0; k < rows.length; k++) {
    final List<double> a = rows[k];
    for (int i = 0; i < terms; i++) {
      atb[i] += a[i] * rhs[k];
      for (int j = i; j < terms; j++) {
        ata[i][j] += a[i] * a[j];
      }
    }
  }
  for (int i = 0; i < terms; i++) {
    for (int j = 0; j < i; j++) {
      ata[i][j] = ata[j][i];
    }
  }
  return _solve(ata, atb);
}

(double, double) _normalize(_Frame frame, double x, double y) =>
    ((x - frame.cx) / frame.s, (y - frame.cy) / frame.s);

(double, double) _predictNormalized(_Model model, double u, double v) {
  final List<double> h = model.h;
  final double w = h[6] * u + h[7] * v + 1;
  double pu = (h[0] * u + h[1] * v + h[2]) / w;
  double pv = (h[3] * u + h[4] * v + h[5]) / w;
  final List<double>? px = model.polyX;
  final List<double>? py = model.polyY;
  if (px != null && py != null) {
    final List<double> b = <double>[1, u, v, u * u, u * v, v * v];
    for (int i = 0; i < 6; i++) {
      pu += b[i] * px[i];
      pv += b[i] * py[i];
    }
  }
  return (pu, pv);
}

(double, double) _predict(_Model model, _Frame frame, double x, double y) {
  final (double u, double v) = _normalize(frame, x, y);
  final (double pu, double pv) = _predictNormalized(model, u, v);
  return (pu * frame.s + frame.cx, pv * frame.s + frame.cy);
}

_Model? _fitAffine(List<_Pair> pairs) {
  final List<List<double>> rows = <List<double>>[
    for (final _Pair p in pairs) <double>[p.u, p.v, 1],
  ];
  final List<double>? hx =
      _leastSquares(rows, <double>[for (final _Pair p in pairs) p.tu], 3);
  final List<double>? hy =
      _leastSquares(rows, <double>[for (final _Pair p in pairs) p.tv], 3);
  if (hx == null || hy == null) return null;
  return _Model(
    <double>[hx[0], hx[1], hx[2], hy[0], hy[1], hy[2], 0, 0],
    homography: false,
  );
}

_Model? _fitHomography(List<_Pair> pairs) {
  final List<List<double>> rows = <List<double>>[];
  final List<double> rhs = <double>[];
  for (final _Pair p in pairs) {
    rows.add(<double>[p.u, p.v, 1, 0, 0, 0, -p.u * p.tu, -p.v * p.tu]);
    rhs.add(p.tu);
    rows.add(<double>[0, 0, 0, p.u, p.v, 1, -p.u * p.tv, -p.v * p.tv]);
    rhs.add(p.tv);
  }
  final List<double>? linear = _leastSquares(rows, rhs, 8);
  if (linear == null) return null;
  List<double> h = linear;
  for (int iteration = 0; iteration < 3; iteration++) {
    final List<List<double>> jr = <List<double>>[];
    final List<double> rr = <double>[];
    for (final _Pair p in pairs) {
      final double w = h[6] * p.u + h[7] * p.v + 1;
      if (!(w > 0.2)) return null;
      final double px = (h[0] * p.u + h[1] * p.v + h[2]) / w;
      final double py = (h[3] * p.u + h[4] * p.v + h[5]) / w;
      jr.add(<double>[
        p.u / w, p.v / w, 1 / w, 0, 0, 0, -p.u * px / w, -p.v * px / w, //
      ]);
      rr.add(p.tu - px);
      jr.add(<double>[
        0, 0, 0, p.u / w, p.v / w, 1 / w, -p.u * py / w, -p.v * py / w, //
      ]);
      rr.add(p.tv - py);
    }
    final List<double>? delta = _leastSquares(jr, rr, 8);
    if (delta == null) break;
    final List<double> current = h;
    h = <double>[for (int i = 0; i < 8; i++) current[i] + delta[i]];
    if (delta.map((double d) => d.abs()).reduce(math.max) < 1e-12) break;
  }
  if (!h.every((double v) => v.isFinite)) return null;
  return _Model(h, homography: true);
}

_Model? _fitPolyResidual(_Model base, List<_Pair> pairs) {
  final List<List<double>> rows = <List<double>>[
    for (final _Pair p in pairs)
      <double>[1, p.u, p.v, p.u * p.u, p.u * p.v, p.v * p.v],
  ];
  final _Model bare = _Model(base.h, homography: base.homography);
  final List<(double, double)> predicted = <(double, double)>[
    for (final _Pair p in pairs) _predictNormalized(bare, p.u, p.v),
  ];
  final List<double>? x = _leastSquares(
    rows,
    <double>[for (int i = 0; i < pairs.length; i++) pairs[i].tu - predicted[i].$1],
    6,
  );
  final List<double>? y = _leastSquares(
    rows,
    <double>[for (int i = 0; i < pairs.length; i++) pairs[i].tv - predicted[i].$2],
    6,
  );
  if (x == null || y == null) return null;
  return base.withPoly(x, y);
}

double _residualPx(_Model model, _Frame frame, _Pair p) {
  final (double pu, double pv) = _predictNormalized(model, p.u, p.v);
  final double du = pu - p.tu;
  final double dv = pv - p.tv;
  return math.sqrt(du * du + dv * dv) * frame.s;
}

double _median(List<double> values) {
  final List<double> s = <double>[...values]..sort();
  final int n = s.length;
  return n.isOdd ? s[(n - 1) ~/ 2] : (s[n ~/ 2 - 1] + s[n ~/ 2]) / 2;
}

_Model? _robust(
  _Model? Function(List<_Pair>) fit,
  List<_Pair> pairs,
  _Frame frame, {
  required double residualFloorPx,
  required int minKeep,
}) {
  List<_Pair> active = pairs;
  _Model? model;
  for (int iteration = 0; iteration < 4; iteration++) {
    if (active.length < minKeep) return null;
    model = fit(active);
    if (model == null) return null;
    final _Model current = model;
    final List<double> res = <double>[
      for (final _Pair p in active) _residualPx(current, frame, p),
    ];
    final double med = _median(res);
    final double mad =
        _median(<double>[for (final double r in res) (r - med).abs()]);
    final double limit = math.max(residualFloorPx, med + 3 * 1.4826 * mad);
    final List<_Pair> kept = <_Pair>[
      for (int i = 0; i < active.length; i++)
        if (res[i] <= limit) active[i],
    ];
    if (kept.length == active.length) break;
    active = kept;
  }
  return model;
}

class _NearestTwo {
  const _NearestTwo(this.index, this.distance, this.secondDistance);

  final int index;
  final double distance;
  final double secondDistance;
}

class _TargetGrid {
  _TargetGrid(this.stars, this.cell) {
    for (int i = 0; i < stars.length; i++) {
      final (int, int) key = (
        (stars[i].x / cell).floor(),
        (stars[i].y / cell).floor(),
      );
      (_buckets[key] ??= <int>[]).add(i);
    }
  }

  final List<StarPoint> stars;
  final double cell;
  final Map<(int, int), List<int>> _buckets = <(int, int), List<int>>{};

  _NearestTwo nearestTwo(double x, double y, double radius) {
    final int reach = (radius / cell).ceil();
    final int gx = (x / cell).floor();
    final int gy = (y / cell).floor();
    int best = -1;
    double bestD = double.infinity;
    double secondD = double.infinity;
    for (int dy = -reach; dy <= reach; dy++) {
      for (int dx = -reach; dx <= reach; dx++) {
        final List<int>? bucket = _buckets[(gx + dx, gy + dy)];
        if (bucket == null) continue;
        for (final int i in bucket) {
          final double ex = stars[i].x - x;
          final double ey = stars[i].y - y;
          final double d = math.sqrt(ex * ex + ey * ey);
          if (d < bestD || (d == bestD && i < best)) {
            secondD = bestD;
            bestD = d;
            best = i;
          } else if (d < secondD) {
            secondD = d;
          }
        }
      }
    }
    return _NearestTwo(best, bestD, secondD);
  }
}

List<StarMatch> _guidedMatch(
  _Model model,
  _Frame frame,
  List<StarPoint> referenceStars,
  _TargetGrid grid,
  double radius,
  double ratio,
) {
  final Map<int, StarMatch> byTarget = <int, StarMatch>{};
  for (int referenceIndex = 0;
      referenceIndex < referenceStars.length;
      referenceIndex++) {
    final StarPoint r = referenceStars[referenceIndex];
    final (double qx, double qy) = _predict(model, frame, r.x, r.y);
    if (!qx.isFinite || !qy.isFinite) continue;
    final _NearestTwo n = grid.nearestTwo(qx, qy, radius);
    if (n.index < 0 || n.distance > radius) continue;
    if (ratio < 1 && !(n.distance <= ratio * n.secondDistance)) continue;
    final StarMatch? previous = byTarget[n.index];
    if (previous == null ||
        n.distance < previous.distance ||
        (n.distance == previous.distance &&
            referenceIndex < previous.referenceIndex)) {
      byTarget[n.index] = StarMatch(
        referenceIndex: referenceIndex,
        targetIndex: n.index,
        distance: n.distance,
      );
    }
  }
  final List<StarMatch> matches = byTarget.values.toList()
    ..sort((StarMatch a, StarMatch b) =>
        a.referenceIndex.compareTo(b.referenceIndex));
  return matches;
}

bool _spanOk(List<_Pair> pairs, _Frame frame, double fraction) {
  if (pairs.isEmpty) return false;
  double minX = double.infinity;
  double maxX = double.negativeInfinity;
  double minY = double.infinity;
  double maxY = double.negativeInfinity;
  for (final _Pair p in pairs) {
    minX = math.min(minX, p.rx);
    maxX = math.max(maxX, p.rx);
    minY = math.min(minY, p.ry);
    maxY = math.max(maxY, p.ry);
  }
  return maxX - minX >= fraction * frame.width &&
      maxY - minY >= fraction * frame.height;
}

List<List<double>> _mul3(List<List<double>> a, List<List<double>> b) =>
    <List<double>>[
      for (int i = 0; i < 3; i++)
        <double>[
          for (int j = 0; j < 3; j++)
            a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j],
        ],
    ];

List<double> _pixelToNormalized(AffineSamplingTransform t, _Frame frame) {
  final double s = frame.s;
  final List<List<double>> p = <List<double>>[
    <double>[t.m00, t.m01, t.m02],
    <double>[t.m10, t.m11, t.m12],
    <double>[t.p20, t.p21, 1],
  ];
  final List<List<double>> tn = <List<double>>[
    <double>[1 / s, 0, -frame.cx / s],
    <double>[0, 1 / s, -frame.cy / s],
    <double>[0, 0, 1],
  ];
  final List<List<double>> ti = <List<double>>[
    <double>[s, 0, frame.cx],
    <double>[0, s, frame.cy],
    <double>[0, 0, 1],
  ];
  final List<List<double>> h = _mul3(_mul3(tn, p), ti);
  final double z = h[2][2];
  return <double>[
    h[0][0] / z, h[0][1] / z, h[0][2] / z, //
    h[1][0] / z, h[1][1] / z, h[1][2] / z, //
    h[2][0] / z, h[2][1] / z,
  ];
}

AffineSamplingTransform _normalizedToPixel(List<double> h, _Frame frame) {
  final double s = frame.s;
  final List<List<double>> hn = <List<double>>[
    <double>[h[0], h[1], h[2]],
    <double>[h[3], h[4], h[5]],
    <double>[h[6], h[7], 1],
  ];
  final List<List<double>> tn = <List<double>>[
    <double>[1 / s, 0, -frame.cx / s],
    <double>[0, 1 / s, -frame.cy / s],
    <double>[0, 0, 1],
  ];
  final List<List<double>> ti = <List<double>>[
    <double>[s, 0, frame.cx],
    <double>[0, s, frame.cy],
    <double>[0, 0, 1],
  ];
  final List<List<double>> p = _mul3(_mul3(ti, hn), tn);
  final double z = p[2][2];
  return AffineSamplingTransform(
    m00: p[0][0] / z,
    m01: p[0][1] / z,
    m02: p[0][2] / z,
    m10: p[1][0] / z,
    m11: p[1][1] / z,
    m12: p[1][2] / z,
    p20: p[2][0] / z,
    p21: p[2][1] / z,
  );
}

/// Refines [seed] into a whole-field registration of [targetStars] onto
/// [referenceStars] (reference/output -> target/source direction).
///
/// [seed] is either the rigid [StarSimilarityTransformEstimate] of the pair
/// or an already-refined [AffineSamplingTransform] (typically the result of
/// the temporally adjacent frame). Throws [GuidedFieldRegistrationFailed]
/// when fewer than [minInliers] strict matches remain or the result is not
/// a plausible fixed-camera transform.
GuidedFieldRegistrationResult refineGuidedFieldRegistration({
  required List<StarPoint> referenceStars,
  required List<StarPoint> targetStars,
  required Object seed,
  required int imageWidth,
  required int imageHeight,
  double toleranceRadius = 3,
  List<double> guidedRadii = const <double>[24, 12, 6],
  double ratioTest = 0.5,
  int minInliers = 5,
  int minAffineMatches = 8,
  int minHomographyMatches = 12,
  int minPolyMatches = 24,
  double minModelSpanFraction = 0.35,
  int maxGrowthIterations = 4,
  double maxPerspectiveTiltPerPixel = 5e-5,
}) {
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw InvalidGuidedFieldRegistrationInput(
      'imageWidth/imageHeight must be positive integers.',
    );
  }
  if (!(toleranceRadius > 0) ||
      guidedRadii.isEmpty ||
      !guidedRadii.every((double r) => r > toleranceRadius) ||
      !(ratioTest > 0 && ratioTest < 1) ||
      minInliers < 3 ||
      minAffineMatches < 4 ||
      minHomographyMatches < 8 ||
      minPolyMatches < 12 ||
      !(minModelSpanFraction > 0 && minModelSpanFraction <= 1) ||
      maxGrowthIterations < 1 ||
      !(maxPerspectiveTiltPerPixel > 0)) {
    throw InvalidGuidedFieldRegistrationInput(
      'Guided registration parameters are invalid.',
    );
  }
  for (final List<StarPoint> list in <List<StarPoint>>[
    referenceStars,
    targetStars,
  ]) {
    for (final StarPoint s in list) {
      if (!s.x.isFinite || !s.y.isFinite) {
        throw InvalidGuidedFieldRegistrationInput(
          'Star coordinates must be finite.',
        );
      }
    }
  }
  final _Frame frame = _Frame(imageWidth, imageHeight);
  _Model model;
  if (seed is AffineSamplingTransform) {
    model = _Model(_pixelToNormalized(seed, frame), homography: true);
  } else if (seed is StarSimilarityTransformEstimate) {
    if (!<double>[
      seed.rotationDegrees,
      seed.sourceOffsetX,
      seed.sourceOffsetY,
      seed.centerX,
      seed.centerY,
    ].every((double v) => v.isFinite)) {
      throw InvalidGuidedFieldRegistrationInput('Seed must be finite.');
    }
    final AffineSamplingTransform rigid = AffineSamplingTransform.similarity(
      rotationDegrees: seed.rotationDegrees,
      sourceOffsetX: seed.sourceOffsetX,
      sourceOffsetY: seed.sourceOffsetY,
      centerX: seed.centerX,
      centerY: seed.centerY,
    );
    model = _Model(_pixelToNormalized(rigid, frame), homography: false);
  } else {
    throw InvalidGuidedFieldRegistrationInput(
      'Seed must be a StarSimilarityTransformEstimate or '
      'an AffineSamplingTransform.',
    );
  }

  final double cell = guidedRadii.reduce(math.max);
  final _TargetGrid grid = _TargetGrid(targetStars, cell);
  List<_Pair> toPairs(List<StarMatch> matches) => <_Pair>[
        for (final StarMatch m in matches)
          () {
            final StarPoint r = referenceStars[m.referenceIndex];
            final StarPoint t = targetStars[m.targetIndex];
            final (double u, double v) = _normalize(frame, r.x, r.y);
            final (double tu, double tv) = _normalize(frame, t.x, t.y);
            return _Pair(r.x, r.y, u, v, tu, tv);
          }(),
      ];
  final double floor = toleranceRadius / 3;

  List<StarMatch> matches = <StarMatch>[];
  for (final double radius in <double>[...guidedRadii, toleranceRadius]) {
    final double ratio = radius > toleranceRadius ? ratioTest : 1;
    int previous = -1;
    for (int iteration = 0; iteration < maxGrowthIterations; iteration++) {
      matches = _guidedMatch(model, frame, referenceStars, grid, radius, ratio);
      final List<_Pair> pairs = toPairs(matches);
      final bool spread = _spanOk(pairs, frame, minModelSpanFraction);
      _Model? next;
      if (spread && pairs.length >= minHomographyMatches) {
        next = _robust(
          _fitHomography,
          pairs,
          frame,
          residualFloorPx: floor,
          minKeep: minHomographyMatches,
        );
        if (next != null && pairs.length >= minPolyMatches) {
          final _Model? withPoly = _robust(
            (List<_Pair> p) {
              final _Model? base = _fitHomography(p);
              return base == null ? null : _fitPolyResidual(base, p);
            },
            pairs,
            frame,
            residualFloorPx: floor,
            minKeep: minPolyMatches,
          );
          if (withPoly != null) next = withPoly;
        }
      }
      if (next == null && pairs.length >= minAffineMatches) {
        next = _robust(
          _fitAffine,
          pairs,
          frame,
          residualFloorPx: floor,
          minKeep: minAffineMatches,
        );
      }
      if (next != null) model = next;
      if (matches.length == previous) break;
      previous = matches.length;
    }
  }

  matches = _guidedMatch(model, frame, referenceStars, grid, toleranceRadius, 1);
  if (matches.length < minInliers) {
    throw GuidedFieldRegistrationFailed(
      'Only ${matches.length} strict matches after guided refinement '
      '(need $minInliers).',
    );
  }
  final List<_Pair> pairs = toPairs(matches);
  _Model? global = _spanOk(pairs, frame, minModelSpanFraction) &&
          pairs.length >= minHomographyMatches
      ? _fitHomography(pairs)
      : null;
  global ??= _fitAffine(pairs);
  if (global == null) {
    throw GuidedFieldRegistrationFailed('Global refit is singular.');
  }
  final AffineSamplingTransform pixel = _normalizedToPixel(global.h, frame);
  assertPlausibleFixedCameraTransform(
    pixel,
    imageWidth,
    imageHeight,
    maxPerspectiveTiltPerPixel,
  );
  final _Model finalModel = global;
  double sumSquares = 0;
  for (final _Pair p in pairs) {
    final double r = _residualPx(finalModel, frame, p);
    sumSquares += r * r;
  }
  return GuidedFieldRegistrationResult(
    transform: pixel,
    projective: global.homography,
    matches: List<StarMatch>.unmodifiable(matches),
    rmsResidual: math.sqrt(sumSquares / pairs.length),
  );
}

/// Spatially distributed selection from [stars]: the image is divided into
/// [columns] x [rows] cells; each cell contributes up to [perCellQuota] of
/// its brightest stars in round-robin rank order; any remaining budget is
/// filled by global brightness. The result is flux-sorted descending (ties
/// by input order), as [estimateSimilarityTransform]'s hypothesis search
/// uses the brightest entries first.
List<DetectedStar> selectSpatiallyDistributedStars(
  List<DetectedStar> stars, {
  required int imageWidth,
  required int imageHeight,
  int columns = 8,
  int rows = 6,
  int perCellQuota = 12,
  int limit = 400,
}) {
  if (imageWidth <= 0 ||
      imageHeight <= 0 ||
      columns < 1 ||
      rows < 1 ||
      perCellQuota < 1 ||
      limit < 1) {
    throw InvalidGuidedFieldRegistrationInput(
      'Spatial star selection parameters are invalid.',
    );
  }
  int byFlux(int a, int b) {
    final int order = stars[b].flux.compareTo(stars[a].flux);
    return order != 0 ? order : a.compareTo(b);
  }

  final List<int> order = List<int>.generate(stars.length, (int i) => i)
    ..sort(byFlux);
  final List<List<int>> cells = <List<int>>[
    for (int i = 0; i < columns * rows; i++) <int>[],
  ];
  for (final int i in order) {
    final DetectedStar s = stars[i];
    final int c =
        ((s.x / imageWidth) * columns).floor().clamp(0, columns - 1).toInt();
    final int r =
        ((s.y / imageHeight) * rows).floor().clamp(0, rows - 1).toInt();
    cells[r * columns + c].add(i);
  }
  final Set<int> chosen = <int>{};
  for (int rank = 0; rank < perCellQuota && chosen.length < limit; rank++) {
    for (final List<int> cell in cells) {
      if (rank < cell.length && chosen.length < limit) chosen.add(cell[rank]);
    }
  }
  for (final int i in order) {
    if (chosen.length >= limit) break;
    chosen.add(i);
  }
  final List<int> result = chosen.toList()..sort(byFlux);
  return <DetectedStar>[for (final int i in result) stars[i]];
}

/// Registration order for guided mode: outward from [referenceIndex], each
/// frame paired with its temporally adjacent neighbour on the reference side.
List<({int index, int neighbour})> guidedRegistrationOrder(
  int frameCount,
  int referenceIndex,
) {
  if (frameCount < 1 || referenceIndex < 0 || referenceIndex >= frameCount) {
    throw InvalidGuidedFieldRegistrationInput(
      'Invalid registration order input.',
    );
  }
  return <({int index, int neighbour})>[
    for (int i = referenceIndex + 1; i < frameCount; i++)
      (index: i, neighbour: i - 1),
    for (int i = referenceIndex - 1; i >= 0; i--) (index: i, neighbour: i + 1),
  ];
}

/// Guided-mode automatic reference preference: among candidates whose
/// intrinsic quality is within [qualityTolerance] (relative) of the best,
/// prefer the one closest to the temporal center. All other candidates keep
/// their relative order after them.
List<int> preferTemporalCenterReference(
  List<int> rankedIndices,
  Map<int, double> qualityByIndex,
  int frameCount, {
  double qualityTolerance = 0.03,
}) {
  if (rankedIndices.isEmpty) return <int>[];
  final double best = qualityByIndex[rankedIndices.first]!;
  final double center = (frameCount - 1) / 2;
  final List<int> near = <int>[
    for (final int i in rankedIndices)
      if (qualityByIndex[i]! >= best * (1 - qualityTolerance)) i,
  ];
  final List<int> rest = <int>[
    for (final int i in rankedIndices)
      if (!near.contains(i)) i,
  ];
  near.sort((int a, int b) {
    final int order = (a - center).abs().compareTo((b - center).abs());
    return order != 0 ? order : a.compareTo(b);
  });
  return <int>[...near, ...rest];
}
