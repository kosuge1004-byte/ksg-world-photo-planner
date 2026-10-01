import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder_factory.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_metadata_probe.dart';

void main() {
  test('feature-flagged DNG metadata probe can be disabled', () {
    expect(
      createFeatureFlaggedNativeRawMetadataProbe(enabled: false),
      isNull,
    );
  });

  test('feature-flagged metadata probe exposes only DNG', () {
    final RawMetadataProbe? probe =
        createFeatureFlaggedNativeRawMetadataProbe(enabled: true);

    expect(probe, isNotNull);
    expect(probe!.supports(RawFormat.dng), isTrue);
    expect(probe.supports(RawFormat.arw), isFalse);
    expect(probe.supports(RawFormat.cr3), isFalse);
  });

  test('production metadata probe supports Sony/Nikon and optional DNG', () {
    final RawMetadataProbe arwOnly = createProductionNativeRawMetadataProbe(
      enableDngMetadata: false,
    );
    final RawMetadataProbe withDng = createProductionNativeRawMetadataProbe(
      enableDngMetadata: true,
    );

    expect(arwOnly.supports(RawFormat.arw), isTrue);
    expect(arwOnly.supports(RawFormat.nef), isTrue);
    expect(arwOnly.supports(RawFormat.nrw), isTrue);
    expect(arwOnly.supports(RawFormat.dng), isFalse);
    expect(withDng.supports(RawFormat.arw), isTrue);
    expect(withDng.supports(RawFormat.nef), isTrue);
    expect(withDng.supports(RawFormat.dng), isTrue);
    expect(withDng.supports(RawFormat.cr3), isFalse);
  });
}
