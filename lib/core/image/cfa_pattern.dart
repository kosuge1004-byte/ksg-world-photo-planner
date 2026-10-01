enum CfaColor { red, green, blue }

enum CfaPattern {
  rggb,
  bggr,
  grbg,
  gbrg;

  CfaColor colorAt(int x, int y) {
    final bool evenX = x.isEven;
    final bool evenY = y.isEven;
    return switch (this) {
      CfaPattern.rggb => switch ((evenX, evenY)) {
          (true, true) => CfaColor.red,
          (false, false) => CfaColor.blue,
          _ => CfaColor.green,
        },
      CfaPattern.bggr => switch ((evenX, evenY)) {
          (true, true) => CfaColor.blue,
          (false, false) => CfaColor.red,
          _ => CfaColor.green,
        },
      CfaPattern.grbg => switch ((evenX, evenY)) {
          (false, true) => CfaColor.red,
          (true, false) => CfaColor.blue,
          _ => CfaColor.green,
        },
      CfaPattern.gbrg => switch ((evenX, evenY)) {
          (true, false) => CfaColor.red,
          (false, true) => CfaColor.blue,
          _ => CfaColor.green,
        },
    };
  }
}
