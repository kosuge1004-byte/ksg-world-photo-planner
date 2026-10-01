import 'dart:typed_data';

import '../raw/raw_decoder_contract.dart';
import 'dng_profile_hue_sat_map.dart';

/// A profile-wide DNG creative look table.
///
/// This distinct type reuses the verified Adobe HueSatMap interpolation
/// kernel while preventing render-order confusion with ProfileHueSatMap.
final class DngProfileLookTable {
  factory DngProfileLookTable({
    required int hueDivisions,
    required int saturationDivisions,
    required int valueDivisions,
    required int encoding,
    required List<double> deltas,
    bool isHighDynamicRange = false,
  }) {
    final RawProfileLookTable validated = RawProfileLookTable(
      hueDivisions: hueDivisions,
      saturationDivisions: saturationDivisions,
      valueDivisions: valueDivisions,
      encoding: encoding,
      deltas: deltas,
    );
    return DngProfileLookTable.fromRaw(
      validated,
      isHighDynamicRange: isHighDynamicRange,
    );
  }

  DngProfileLookTable.fromRaw(
    RawProfileLookTable source, {
    bool isHighDynamicRange = false,
  }) : _kernel = DngProfileHueSatMap(
          hueDivisions: source.hueDivisions,
          saturationDivisions: source.saturationDivisions,
          valueDivisions: source.valueDivisions,
          encoding: source.encoding,
          deltas: source.deltas,
          isHighDynamicRange: isHighDynamicRange,
        );

  final DngProfileHueSatMap _kernel;

  bool get isHighDynamicRange => _kernel.isHighDynamicRange;

  void transformPixel(
    double sourceR,
    double sourceG,
    double sourceB,
    Float64List target, [
    int offset = 0,
  ]) =>
      _kernel.transformPixel(sourceR, sourceG, sourceB, target, offset);
}
