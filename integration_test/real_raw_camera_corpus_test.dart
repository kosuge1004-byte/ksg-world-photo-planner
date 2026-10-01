import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/ffi_raw_native_bridge.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';

const String _corpusDirectory =
    String.fromEnvironment('MOBILE_STACK_REAL_RAW_CORPUS_DIR');
const int _expectedFileCount =
    int.fromEnvironment('MOBILE_STACK_REAL_RAW_FILE_COUNT', defaultValue: 0);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('heterogeneous real Sony/Nikon RAW corpus decodes sensor planes',
      (WidgetTester tester) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    if (_corpusDirectory.isEmpty || _expectedFileCount == 0) return;

    final Directory corpus = Directory(_corpusDirectory);
    for (int attempt = 0; attempt < 90 && !await corpus.exists(); attempt++) {
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    expect(
      await corpus.exists(),
      isTrue,
      reason: 'The opt-in real RAW corpus was not staged in time.',
    );

    final List<File> files = await corpus
        .list(followLinks: false)
        .where((FileSystemEntity entity) => entity is File)
        .cast<File>()
        .where((File file) {
      final String extension = file.path.split('.').last.toLowerCase();
      return extension == 'arw' || extension == 'nef' || extension == 'nrw';
    }).toList()
      ..sort((File left, File right) => left.path.compareTo(right.path));
    expect(files, hasLength(_expectedFileCount));

    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      for (final File file in files) {
        final RawFormat format = _formatFor(file.path);
        final int byteLength = await file.length();
        final RawNativeDecodedFrame frame = bridge.decode(
          RawNativeDecodeCommand(
            path: file.path,
            expectedFormat: format,
            expectedByteLength: byteLength,
            outputPrecision: ProcessingPrecision.float32,
            maximumPixelCount: 100 * 1000 * 1000,
          ),
        );
        expect(frame.format, format, reason: file.path);
        expect(frame.width, greaterThan(0), reason: file.path);
        expect(frame.height, greaterThan(0), reason: file.path);
        expect(
          frame.samples,
          hasLength(frame.width * frame.height),
          reason: file.path,
        );
        expect(frame.activeArea.width, greaterThan(0), reason: file.path);
        expect(frame.activeArea.height, greaterThan(0), reason: file.path);
        expect(frame.blackLevels, hasLength(4), reason: file.path);
        expect(
          frame.whiteLevel,
          greaterThan(frame.blackLevels.reduce(
            (double left, double right) => left > right ? left : right,
          )),
          reason: file.path,
        );
        bool allFiniteAndNonNegative = true;
        double minimum = double.infinity;
        double maximum = double.negativeInfinity;
        for (final double value in frame.samples) {
          if (!value.isFinite || value < 0) {
            allFiniteAndNonNegative = false;
            break;
          }
          if (value < minimum) minimum = value;
          if (value > maximum) maximum = value;
        }
        expect(allFiniteAndNonNegative, isTrue, reason: file.path);
        // Printed dimensions make the retained integration log an auditable
        // per-file result instead of a single opaque corpus PASS.
        // ignore: avoid_print
        print(
          'REAL_RAW_PASS ${file.path.split(Platform.pathSeparator).last} '
          '${frame.width}x${frame.height} '
          'black=${frame.blackLevels.join('/')} white=${frame.whiteLevel} '
          'min=$minimum max=$maximum',
        );
      }
    } finally {
      bridge.close();
    }
  }, timeout: const Timeout(Duration(minutes: 30)));
}

RawFormat _formatFor(String path) {
  final String extension = path.split('.').last.toLowerCase();
  return switch (extension) {
    'arw' => RawFormat.arw,
    'nef' => RawFormat.nef,
    'nrw' => RawFormat.nrw,
    _ => throw ArgumentError.value(path, 'path', 'unsupported RAW extension'),
  };
}
