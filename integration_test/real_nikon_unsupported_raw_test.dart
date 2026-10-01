import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/ffi_raw_native_bridge.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';

const String _path =
    String.fromEnvironment('MOBILE_STACK_NIKON_UNSUPPORTED_RAW_PATH');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('unsupported Nikon HE/HE* NEF returns an explicit decode error',
      (WidgetTester tester) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    if (_path.isEmpty) return;

    final File file = File(_path);
    expect(await file.exists(), isTrue);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(
        () => bridge.decode(
          RawNativeDecodeCommand(
            path: file.path,
            expectedFormat: RawFormat.nef,
            expectedByteLength: file.lengthSync(),
            outputPrecision: ProcessingPrecision.float32,
            maximumPixelCount: 100 * 1000 * 1000,
          ),
        ),
        throwsA(
          isA<RawDecodeFailure>()
              .having(
                (RawDecodeFailure failure) => failure.code,
                'code',
                RawDecodeErrorCode.unsupportedFormat,
              )
              .having(
                (RawDecodeFailure failure) => failure.nativeCode,
                'nativeCode',
                4007,
              ),
        ),
      );
    } finally {
      bridge.close();
    }
  });
}
