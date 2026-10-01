import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/ffi_raw_native_bridge.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';

const String _path = String.fromEnvironment('MOBILE_STACK_NIKON_RAW_PATH');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('real Nikon NEF/NRW decodes as a preserved Bayer sensor plane',
      (WidgetTester tester) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    if (_path.isEmpty) return;

    final File file = File(_path);
    expect(await file.exists(), isTrue);
    final String extension = file.path.split('.').last.toLowerCase();
    final RawFormat format = extension == 'nrw' ? RawFormat.nrw : RawFormat.nef;
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(bridge.supportsBroadNikonRaw, isTrue);
      final RawNativeDecodedFrame frame = bridge.decode(
        RawNativeDecodeCommand(
          path: file.path,
          expectedFormat: format,
          expectedByteLength: await file.length(),
          outputPrecision: ProcessingPrecision.float32,
          maximumPixelCount: 100 * 1000 * 1000,
        ),
      );
      expect(frame.format, format);
      expect(frame.width, greaterThan(0));
      expect(frame.height, greaterThan(0));
      expect(frame.samples, hasLength(frame.width * frame.height));
      expect(frame.activeArea.width, frame.width);
      expect(frame.activeArea.height, frame.height);
      expect(frame.blackLevels, hasLength(4));
      expect(frame.whiteLevel,
          greaterThan(frame.blackLevels.reduce((a, b) => a > b ? a : b)));
      expect(
          frame.samples.every((double value) => value.isFinite && value >= 0),
          isTrue);
    } finally {
      bridge.close();
    }
  });
}
