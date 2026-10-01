import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/dng_final_render_profile.dart';
import 'package:mobile_stack/core/export/reference_render_profile_selection.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';

DngFinalRenderProfile _profile(String sourceId) =>
    DngFinalRenderProfile.fromMetadata(
      sourceId: sourceId,
      metadata: RawFrameMetadata(
        format: RawFormat.dng,
        activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
        orientation: 1,
        blackLevels: const <double>[0, 0, 0, 0],
        whiteLevel: 1,
      ),
      cfaPattern: CfaPattern.rggb,
    );

void main() {
  test('lowest successful frame index wins regardless of completion order', () {
    final List<DngFinalRenderProfile?> slots =
        List<DngFinalRenderProfile?>.filled(4, null);
    slots[3] = _profile('frame-3');
    expect(selectLowestIndexRenderProfile(slots)!.sourceId, 'frame-3');
    slots[1] = _profile('frame-1');
    expect(selectLowestIndexRenderProfile(slots)!.sourceId, 'frame-1');
    slots[2] = _profile('frame-2');
    expect(selectLowestIndexRenderProfile(slots)!.sourceId, 'frame-1');
  });

  test('returns null when no frame produced a profile', () {
    expect(
      selectLowestIndexRenderProfile(<DngFinalRenderProfile?>[null, null]),
      isNull,
    );
  });

  _alignedReferenceProfileTests();
}

void _alignedReferenceProfileTests() {
  test('shipping selector requires every successful source profile', () {
    expect(
      () => requireAlignedReferenceRenderProfile(
        profiles: <DngFinalRenderProfile?>[_profile('frame-0'), null],
        sourcePaths: const <String>['frame-0', 'frame-1'],
        referenceIndex: 1,
      ),
      throwsStateError,
    );
  });

  test('shipping selector rejects a profile from another source path', () {
    expect(
      () => requireAlignedReferenceRenderProfile(
        profiles: <DngFinalRenderProfile?>[
          _profile('frame-0'),
          _profile('wrong-frame'),
        ],
        sourcePaths: const <String>['frame-0', 'frame-1'],
        referenceIndex: 1,
      ),
      throwsStateError,
    );
  });

  test('shipping selector returns the explicitly selected aligned frame', () {
    final DngFinalRenderProfile selected = requireAlignedReferenceRenderProfile(
      profiles: <DngFinalRenderProfile?>[
        _profile('frame-0'),
        _profile('frame-1'),
      ],
      sourcePaths: const <String>['frame-0', 'frame-1'],
      referenceIndex: 1,
    );
    expect(selected.sourceId, 'frame-1');
  });

  test('shipping selector rejects an out-of-range reference index', () {
    expect(
      () => requireAlignedReferenceRenderProfile(
        profiles: <DngFinalRenderProfile?>[
          _profile('frame-0'),
          _profile('frame-1'),
        ],
        sourcePaths: const <String>['frame-0', 'frame-1'],
        referenceIndex: 2,
      ),
      throwsRangeError,
    );
  });
}
