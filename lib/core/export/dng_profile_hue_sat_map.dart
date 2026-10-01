import 'dart:math' as math;
import 'dart:typed_data';

import '../raw/raw_decoder_contract.dart';

/// Immutable, bounded Adobe DNG ProfileHueSatMap used only at final render.
///
/// Storage is value-major, then hue, then saturation, with each entry holding
/// `(hue shift in degrees, saturation scale, value scale)`.
final class DngProfileHueSatMap {
  factory DngProfileHueSatMap({
    required int hueDivisions,
    required int saturationDivisions,
    required int valueDivisions,
    required int encoding,
    required List<double> deltas,
    bool isHighDynamicRange = false,
  }) {
    final RawProfileHueSatMap validated = RawProfileHueSatMap(
      hueDivisions: hueDivisions,
      saturationDivisions: saturationDivisions,
      valueDivisions: valueDivisions,
      encoding: encoding,
      deltas: deltas,
    );
    return DngProfileHueSatMap.fromRaw(
      validated,
      isHighDynamicRange: isHighDynamicRange,
    );
  }

  DngProfileHueSatMap.fromRaw(
    RawProfileHueSatMap source, {
    this.isHighDynamicRange = false,
  })  : hueDivisions = source.hueDivisions,
        saturationDivisions = source.saturationDivisions,
        valueDivisions = source.valueDivisions,
        encoding = source.encoding,
        _deltas = Float64List.fromList(source.deltas);

  final int hueDivisions;
  final int saturationDivisions;
  final int valueDivisions;
  final int encoding;
  final bool isHighDynamicRange;
  final Float64List _deltas;

  int get entryCount => hueDivisions * saturationDivisions * valueDivisions;

  /// Applies the Adobe DNG SDK reference transform to one non-negative RGB
  /// triple and writes it at [offset] in [target]. The target must have room
  /// for three values. No per-pixel heap allocation is performed.
  void transformPixel(
    double sourceR,
    double sourceG,
    double sourceB,
    Float64List target, [
    int offset = 0,
  ]) {
    if (offset < 0 || offset + 3 > target.length) {
      throw RangeError.range(offset, 0, target.length - 3, 'offset');
    }

    double r = math.max(0, sourceR);
    double g = math.max(0, sourceG);
    double b = math.max(0, sourceB);
    final bool supportOverrange = isHighDynamicRange && valueDivisions > 1;
    if (supportOverrange) {
      r = _encodeOverrange(r);
      g = _encodeOverrange(g);
      b = _encodeOverrange(b);
    }

    final double value = math.max(r, math.max(g, b));
    final double minimum = math.min(r, math.min(g, b));
    final double gap = value - minimum;
    double hue = 0;
    double saturation = 0;
    if (gap > 0) {
      if (r == value) {
        hue = (g - b) / gap;
        if (hue < 0) hue += 6;
      } else if (g == value) {
        hue = 2 + (b - r) / gap;
      } else {
        hue = 4 + (r - g) / gap;
      }
      saturation = gap / value;
    }

    double encodedValue =
        valueDivisions > 1 && encoding == 1 ? _srgbEncodeUnit(value) : value;
    final double hueScaled = hue * hueDivisions / 6;
    final double saturationScaled = saturation * (saturationDivisions - 1);
    final int hue0 = math.min(hueDivisions - 1, math.max(0, hueScaled.floor()));
    final int hue1 = hue0 == hueDivisions - 1 ? 0 : hue0 + 1;
    final int saturation0 = math.min(
      saturationDivisions - 2,
      math.max(0, saturationScaled.floor()),
    );
    final double hueFraction = hueScaled - hue0;
    final double saturationFraction = saturationScaled - saturation0;

    double valueFraction = 0;
    int value0 = 0;
    int value1 = 0;
    if (valueDivisions > 1) {
      // The table lookup coordinate is always bounded to the table domain.
      // In HDR mode DNG 1.7.1 explicitly requires clamping the input V
      // coordinate to [0, 1] before indexing; SDR profiles are defined on
      // that same normalized domain. Keeping only the lookup coordinate
      // bounded (rather than overwriting encodedValue itself) also avoids
      // accidental extrapolation when this application's stacked linear
      // working values exceed 1.0, while preserving the original value for
      // the subsequent value-scale multiplication.
      final double tableValue = encodedValue.clamp(0, 1).toDouble();
      final double valueScaled = tableValue * (valueDivisions - 1);
      value0 = math.min(
        valueDivisions - 2,
        math.max(0, valueScaled.floor()),
      );
      value1 = value0 + 1;
      valueFraction = (valueScaled - value0).clamp(0, 1).toDouble();
    }

    final double hueShift = _interpolateComponent(
      0,
      hue0,
      hue1,
      saturation0,
      value0,
      value1,
      hueFraction,
      saturationFraction,
      valueFraction,
    );
    final double saturationScale = _interpolateComponent(
      1,
      hue0,
      hue1,
      saturation0,
      value0,
      value1,
      hueFraction,
      saturationFraction,
      valueFraction,
    );
    final double valueScale = _interpolateComponent(
      2,
      hue0,
      hue1,
      saturation0,
      value0,
      value1,
      hueFraction,
      saturationFraction,
      valueFraction,
    );

    hue += hueShift * (6 / 360);
    saturation = math.min(saturation * saturationScale, 1);
    encodedValue *= valueScale;
    if (!isHighDynamicRange) {
      encodedValue = encodedValue.clamp(0, 1).toDouble();
    } else if (encodedValue < 0 || !encodedValue.isFinite) {
      encodedValue = 0;
    }
    final double mappedValue = valueDivisions > 1 && encoding == 1
        ? _srgbDecodeNonnegative(encodedValue)
        : encodedValue;
    _hsvToRgb(hue, saturation, mappedValue, target, offset);

    if (supportOverrange) {
      target[offset] = _decodeOverrange(target[offset]);
      target[offset + 1] = _decodeOverrange(target[offset + 1]);
      target[offset + 2] = _decodeOverrange(target[offset + 2]);
    }
  }

  double _interpolateComponent(
    int component,
    int hue0,
    int hue1,
    int saturation0,
    int value0,
    int value1,
    double hueFraction,
    double saturationFraction,
    double valueFraction,
  ) {
    double at(int value, int hue, int saturation) => _deltas[
        (((value * hueDivisions + hue) * saturationDivisions + saturation) *
                3) +
            component];
    double hueBlend(int value, int saturation) =>
        at(value, hue0, saturation) * (1 - hueFraction) +
        at(value, hue1, saturation) * hueFraction;
    double valueHueBlend(int saturation) {
      final double low = hueBlend(value0, saturation);
      if (valueDivisions < 2) return low;
      return low * (1 - valueFraction) +
          hueBlend(value1, saturation) * valueFraction;
    }

    return valueHueBlend(saturation0) * (1 - saturationFraction) +
        valueHueBlend(saturation0 + 1) * saturationFraction;
  }
}

double _encodeOverrange(double value) =>
    value * (256 + value) / (256 * (1 + value));

double _decodeOverrange(double value) {
  final double x = math.max(0, value);
  return 16 * (8 * x - 8 + math.sqrt(64 * x * x - 127 * x + 64));
}

double _srgbEncodeUnit(double value) {
  final double x = value.clamp(0, 1).toDouble();
  return x <= 0.0031308 ? x * 12.92 : 1.055 * math.pow(x, 1 / 2.4) - 0.055;
}

double _srgbDecodeNonnegative(double value) {
  final double x = math.max(0, value);
  return x <= 0.04045
      ? x / 12.92
      : math.pow((x + 0.055) / 1.055, 2.4).toDouble();
}

void _hsvToRgb(
  double hue,
  double saturation,
  double value,
  Float64List target,
  int offset,
) {
  if (saturation <= 0) {
    target[offset] = value;
    target[offset + 1] = value;
    target[offset + 2] = value;
    return;
  }
  double h = hue % 6;
  if (h < 0) h += 6;
  final int sector = h.floor() % 6;
  final double fraction = h - h.floor();
  final double p = value * (1 - saturation);
  final double q = value * (1 - saturation * fraction);
  final double t = value * (1 - saturation * (1 - fraction));
  switch (sector) {
    case 0:
      target[offset] = value;
      target[offset + 1] = t;
      target[offset + 2] = p;
    case 1:
      target[offset] = q;
      target[offset + 1] = value;
      target[offset + 2] = p;
    case 2:
      target[offset] = p;
      target[offset + 1] = value;
      target[offset + 2] = t;
    case 3:
      target[offset] = p;
      target[offset + 1] = q;
      target[offset + 2] = value;
    case 4:
      target[offset] = t;
      target[offset + 1] = p;
      target[offset + 2] = value;
    case 5:
      target[offset] = value;
      target[offset + 1] = p;
      target[offset + 2] = q;
  }
}
