import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/raw/ffi_raw_native_bridge.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';

const String _path = String.fromEnvironment('MOBILE_STACK_UNCOMPRESSED_ARW_PATH');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('real uncompressed Sony ARW decodes with production native ABI',
      (WidgetTester tester) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    if (_path.isEmpty) return;
    final File file = File(_path);
    expect(await file.exists(), isTrue);
    final FfiRawNativeBridge bridge = FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeDecodedFrame frame = bridge.decode(
        RawNativeDecodeCommand(
          path: file.path,
          expectedFormat: RawFormat.arw,
          expectedByteLength: await file.length(),
          outputPrecision: ProcessingPrecision.float32,
          maximumPixelCount: 64 * 1000 * 1000,
        ),
      );
      expect(frame.width, greaterThan(0));
      expect(frame.height, greaterThan(0));
      expect(frame.samples, hasLength(frame.width * frame.height));
      expect(frame.activeArea.width, greaterThan(0));
      expect(frame.activeArea.height, greaterThan(0));
      expect(frame.whiteLevel, greaterThan(frame.blackLevels.first));
      expect(frame.samples.every((double v) => v.isFinite), isTrue);
      expect(frame.samples.every((double v) => v >= 0 && v <= frame.whiteLevel), isTrue);
    } finally {
      bridge.close();
    }
  });
}
