enum ProcessingMode {
  milkyWay,
  starTrail,
  meteor,
  focusStack,
}

extension ProcessingModeLabel on ProcessingMode {
  String get label => switch (this) {
        ProcessingMode.milkyWay => '天の川・星景スタック',
        ProcessingMode.starTrail => '星の軌跡',
        ProcessingMode.meteor => '流星群',
        ProcessingMode.focusStack => '深度合成',
      };

  int get minimumInputCount => 2;

  String get shortDescription => switch (this) {
        ProcessingMode.milkyWay => '星を揃えてノイズを減らし、地上と星空を自然に合成します。',
        ProcessingMode.starTrail => '撮影順のフレームを比較明合成して星の軌跡を作ります。',
        ProcessingMode.meteor => '流星候補を検出し、選んだ流星だけを背景へ合成します。',
        ProcessingMode.focusStack => 'ピント位置の異なる複数枚を高精度に合成し、全体にピントの合った1枚を作ります。',
      };
}
