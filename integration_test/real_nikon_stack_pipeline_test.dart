import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder_factory.dart';
import 'package:mobile_stack/core/session/export_pipeline_result.dart';
import 'package:mobile_stack/core/session/star_trail_pipeline.dart';

const String _corpusDirectory =
    String.fromEnvironment('MOBILE_STACK_NIKON_STACK_CORPUS_DIR');
const int _frameCount = int.fromEnvironment(
    'MOBILE_STACK_NIKON_STACK_FRAME_COUNT',
    defaultValue: 0);
const String _outputPath =
    String.fromEnvironment('MOBILE_STACK_NIKON_STACK_OUTPUT_PATH');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('real Nikon NEFs decode, demosaic, stack, and export on Android',
      (WidgetTester tester) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    if (_corpusDirectory.isEmpty || _frameCount < 2 || _outputPath.isEmpty) {
      return;
    }

    final Directory corpus = Directory(_corpusDirectory);
    expect(await corpus.exists(), isTrue);
    final List<File> files = await corpus
        .list(followLinks: false)
        .where((FileSystemEntity entity) =>
            entity is File && entity.path.toLowerCase().endsWith('.nef'))
        .cast<File>()
        .toList()
      ..sort((File left, File right) => left.path.compareTo(right.path));
    expect(files, hasLength(_frameCount));
    await File(_outputPath).parent.create(recursive: true);

    final File output = await runStarTrailPipelineAndExport(
      sourcePaths: files.map((File file) => file.path).toList(),
      decodingConfig: StarTrailFrameDecodingConfig(
        decoderRegistry: createProductionNativeRawDecoderRegistry(),
      ),
      outputTileStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
      exportPath: _outputPath,
      keepHighest: 1,
      minimumCoveringFrames: _frameCount,
      reportStage: (stage, label) {
        // ignore: avoid_print
        print('REAL_NIKON_STACK_STAGE ${stage.name} $label');
      },
    );

    expect(await output.exists(), isTrue);
    expect(await output.length(), greaterThan(70 * 1024 * 1024));
    final RandomAccessFile handle = await output.open();
    try {
      expect(await handle.readByte(), 0x42);
      expect(await handle.readByte(), 0x4d);
    } finally {
      await handle.close();
    }
    // ignore: avoid_print
    print(
        'REAL_NIKON_STACK_PASS ${output.path} ${await output.length()} bytes');
  }, timeout: const Timeout(Duration(minutes: 30)));
}
