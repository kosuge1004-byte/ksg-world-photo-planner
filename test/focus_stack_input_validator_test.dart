import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_stack_input_validator.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/io/raw_input_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_metadata_probe.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

RawInputFile _file({
  required String name,
  RawFormat format = RawFormat.arw,
  int width = 6000,
  int height = 4000,
  CfaPattern cfaPattern = CfaPattern.rggb,
  RawActiveArea? activeArea,
  int orientation = 1,
  bool includeProbe = true,
  bool includeMetadata = true,
}) {
  final RawActiveArea resolvedActiveArea = activeArea ??
      RawActiveArea(left: 0, top: 0, width: width, height: height);
  return RawInputFile(
    path: '/focus/$name',
    displayName: name,
    byteLength: 1024,
    probe: includeProbe
        ? RawProbeResult(
            path: '/focus/$name',
            format: format,
            byteLength: 1024,
            isReadable: true,
            signatureMatched: true,
          )
        : null,
    metadata: includeMetadata
        ? RawMetadataProbeResult(
            width: width,
            height: height,
            cfaPattern: cfaPattern,
            metadata: RawFrameMetadata(
              format: format,
              activeArea: resolvedActiveArea,
              orientation: orientation,
              blackLevels: const <double>[512, 512, 512, 512],
              whiteLevel: 16383,
            ),
            probeId: 'focus-input-validator-test',
          )
        : null,
  );
}

void main() {
  test('focus stack requires at least two inputs', () {
    final FocusStackInputValidation result =
        validateFocusStackInputs(const <RawInputFile>[]);
    expect(result.isValid, isFalse);
    expect(result.minimumInputCount, 2);
  });

  test('accepts structurally identical probed inputs', () {
    final FocusStackInputValidation result = validateFocusStackInputs(
      <RawInputFile>[
        _file(name: 'near.arw'),
        _file(name: 'far.arw'),
      ],
    );

    expect(result.isValid, isTrue);
    expect(result.issues, isEmpty);
  });

  final Map<String, RawInputFile> mismatches = <String, RawInputFile>{
    'RAW format': _file(name: 'format.dng', format: RawFormat.dng),
    'sensor dimensions': _file(
      name: 'dimensions.arw',
      width: 6001,
      activeArea: const RawActiveArea(
        left: 0,
        top: 0,
        width: 6000,
        height: 4000,
      ),
    ),
    'CFA pattern': _file(
      name: 'cfa.arw',
      cfaPattern: CfaPattern.bggr,
    ),
    'ActiveArea': _file(
      name: 'active-area.arw',
      activeArea: const RawActiveArea(
        left: 1,
        top: 0,
        width: 5999,
        height: 4000,
      ),
    ),
    'orientation': _file(name: 'orientation.arw', orientation: 6),
  };

  for (final MapEntry<String, RawInputFile> scenario in mismatches.entries) {
    test('rejects a ${scenario.key} mismatch', () {
      final FocusStackInputValidation result = validateFocusStackInputs(
        <RawInputFile>[
          _file(name: 'reference.arw'),
          scenario.value,
        ],
      );

      expect(result.isValid, isFalse);
      expect(result.issues, hasLength(1));
      expect(result.issues.single.fileName, scenario.value.name);
    });
  }

  test('rejects an input without probe metadata', () {
    final RawInputFile missing = _file(
      name: 'missing-metadata.arw',
      includeMetadata: false,
    );
    final FocusStackInputValidation result = validateFocusStackInputs(
      <RawInputFile>[
        _file(name: 'reference.arw'),
        missing,
      ],
    );

    expect(result.isValid, isFalse);
    expect(result.issues, hasLength(1));
    expect(result.issues.single.fileName, missing.name);
  });
}
