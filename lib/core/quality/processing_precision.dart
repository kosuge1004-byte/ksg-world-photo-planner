enum ProcessingPrecision {
  sourceInteger,
  float32,
  float64,
}

extension ProcessingPrecisionLabel on ProcessingPrecision {
  String get label => switch (this) {
        ProcessingPrecision.sourceInteger => '元RAW整数精度',
        ProcessingPrecision.float32 => '32bit浮動小数点',
        ProcessingPrecision.float64 => '64bit浮動小数点',
      };
}
