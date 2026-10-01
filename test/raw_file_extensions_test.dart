import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/io/raw_file_extensions.dart';

void main() {
  test('known RAW extensions are case-insensitive', () {
    expect(isSupportedRawPath('/photo/DSC001.ARW'), isTrue);
    expect(isSupportedRawPath('/photo/IMG_001.cr3'), isTrue);
    expect(isSupportedRawPath('/photo/frame.nef'), isTrue);
    expect(isSupportedRawPath('/photo/output.jpg'), isFalse);
  });

  test('picker exposes only formats the native decoder actually supports', () {
    // See raw_file_extensions.dart's doc comment on
    // probeSupportedRawExtensions: this used to include every
    // metadata-probe-capable format (cr3 among them), even though only
    // ARW/NEF/NRW can actually be decoded by
    // native/src/mobile_stack_raw_ffi_stub.c's mobile_stack_raw_decode —
    // letting the picker select a file that would always fail once
    // processing actually reached the decode stage.
    expect(isProbeSupportedRawPath('/photo/DSC001.ARW'), isTrue);
    expect(isProbeSupportedRawPath('/photo/frame.nef'), isTrue);
    expect(isProbeSupportedRawPath('/photo/frame.nrw'), isTrue);
    expect(isProbeSupportedRawPath('/photo/IMG_001.cr3'), isFalse);
    expect(isProbeSupportedRawPath('/photo/frame.x3f'), isFalse);
    expect(isProbeSupportedRawPath('/photo/frame.raw'), isFalse);
  });

  test('a feature can restrict the exposed RAW extension set', () {
    const Set<String> arwOnly = <String>{'arw'};

    expect(hasAllowedRawExtension('/photo/DSC001.ARW', arwOnly), isTrue);
    expect(hasAllowedRawExtension('/photo/DSC001.dng', arwOnly), isFalse);
    expect(hasAllowedRawExtension('/photo/no_extension', arwOnly), isFalse);
  });
}
