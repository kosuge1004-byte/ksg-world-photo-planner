class RawDefectPoint {
  const RawDefectPoint({
    required this.x,
    required this.y,
  });

  final int x;
  final int y;
}

/// 画像左上原点の明示的な欠陥画素座標。
///
/// 単一RAWからの自動推定は星や点光源を誤検出し得るため、この契約では
/// カメラ／RAWメタデータなどが明示した座標だけを保持する。
class RawDefectMap {
  RawDefectMap(Iterable<RawDefectPoint> points)
      : points = _validatedPoints(points);

  final List<RawDefectPoint> points;

  static List<RawDefectPoint> _validatedPoints(
    Iterable<RawDefectPoint> source,
  ) {
    final List<RawDefectPoint> copy = source.toList(growable: false)
      ..sort((RawDefectPoint first, RawDefectPoint second) {
        final int rowOrder = first.y.compareTo(second.y);
        return rowOrder != 0 ? rowOrder : first.x.compareTo(second.x);
      });
    for (int index = 0; index < copy.length; index++) {
      final RawDefectPoint point = copy[index];
      if (point.x < 0 || point.y < 0) {
        throw ArgumentError.value(
          source,
          'points',
          '欠陥画素座標は非負である必要があります。',
        );
      }
      if (index > 0) {
        final RawDefectPoint previous = copy[index - 1];
        if (previous.x == point.x && previous.y == point.y) {
          throw ArgumentError.value(
            source,
            'points',
            '欠陥画素座標が重複しています。',
          );
        }
      }
    }
    return List<RawDefectPoint>.unmodifiable(copy);
  }
}

RawDefectMap mergeRawDefectMaps(Iterable<RawDefectMap> maps) {
  final Map<(int, int), RawDefectPoint> unique = <(int, int), RawDefectPoint>{};
  for (final RawDefectMap map in maps) {
    for (final RawDefectPoint point in map.points) {
      unique[(point.x, point.y)] = point;
    }
  }
  return RawDefectMap(unique.values);
}
