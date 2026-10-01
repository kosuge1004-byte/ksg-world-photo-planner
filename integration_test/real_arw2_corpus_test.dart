import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/ffi_raw_native_bridge.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';

const String _corpusDirectory =
    String.fromEnvironment('MOBILE_STACK_ARW2_CORPUS_DIR');
const int _expectedFrameCount =
    int.fromEnvironment('MOBILE_STACK_ARW2_FRAME_COUNT', defaultValue: 0);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('任意の実Sony ARW2コーパスを順次フルセンサー復号する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    if (_corpusDirectory.isEmpty || _expectedFrameCount == 0) return;

    final Directory corpus = Directory(_corpusDirectory);
    for (int attempt = 0; attempt < 60 && !await corpus.exists(); attempt++) {
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    expect(await corpus.exists(), isTrue,
        reason: 'The opt-in private corpus was not staged in time.');

    final List<File> files = await corpus
        .list(followLinks: false)
        .where((FileSystemEntity entity) =>
            entity is File && entity.path.toLowerCase().endsWith('.arw'))
        .cast<File>()
        .toList();
    files.sort((File left, File right) => left.path.compareTo(right.path));
    expect(files, hasLength(_expectedFrameCount));

    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(bridge.supportsSonyArw2, isTrue);
      int? width;
      int? height;
      for (final File file in files) {
        final int byteLength = await file.length();
        final RawNativeDecodedFrame frame = bridge.decode(
          RawNativeDecodeCommand(
            path: file.path,
            expectedFormat: RawFormat.arw,
            expectedByteLength: byteLength,
            outputPrecision: ProcessingPrecision.float32,
            maximumPixelCount: 64 * 1000 * 1000,
          ),
        );
        width ??= frame.width;
        height ??= frame.height;
        expect(frame.width, width);
        expect(frame.height, height);
        expect(frame.activeArea.width, greaterThan(0));
        expect(frame.activeArea.height, greaterThan(0));
        expect(frame.blackLevels, hasLength(4));
        expect(frame.whiteLevel, greaterThan(frame.blackLevels.first));
        expect(frame.samples, hasLength(frame.width * frame.height));
      }
    } finally {
      bridge.close();
    }
  });
}
