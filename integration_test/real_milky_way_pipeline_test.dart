import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/export/dng_final_render_profile.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder_factory.dart';
import 'package:mobile_stack/core/raw/raw_file_probe.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/session/export_pipeline_result.dart';
import 'package:mobile_stack/core/session/milky_way_pipeline.dart';

const String _corpusDirectory =
    String.fromEnvironment('MOBILE_STACK_MILKY_WAY_CORPUS_DIR');
const int _frameCount =
    int.fromEnvironment('MOBILE_STACK_MILKY_WAY_FRAME_COUNT', defaultValue: 0);
const String _outputPath =
    String.fromEnvironment('MOBILE_STACK_MILKY_WAY_OUTPUT_PATH');
const String _pullAcknowledgement =
    String.fromEnvironment('MOBILE_STACK_MILKY_WAY_PULL_ACK');
const int _referenceIndex = int.fromEnvironment(
  'MOBILE_STACK_MILKY_WAY_REFERENCE_INDEX',
  defaultValue: -1,
);
const int _tileSize = int.fromEnvironment(
  'MOBILE_STACK_MILKY_WAY_TILE_SIZE',
  defaultValue: 512,
);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('実ARW2夜景をネイティブ・デモザイクして位置合わせ合成する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    if (_corpusDirectory.isEmpty || _frameCount < 2 || _outputPath.isEmpty) {
      return;
    }
    final Directory corpus = Directory(_corpusDirectory);
    for (int attempt = 0; attempt < 90 && !await corpus.exists(); attempt++) {
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
    expect(files, hasLength(_frameCount));
    await File(_outputPath).parent.create(recursive: true);

    final metadataProbe = createProductionNativeRawMetadataProbe();
    final referenceProbe = await const RawFileProbe().probe(files.first.path);
    final referenceMetadata = await metadataProbe.probe(referenceProbe);
    final DngFinalRenderProfile renderProfile =
        DngFinalRenderProfile.fromMetadata(
      sourceId: files.first.path,
      metadata: referenceMetadata.metadata,
      cfaPattern: referenceMetadata.cfaPattern,
    );
    if (OutputImageFormat.fromPath(_outputPath) ==
        OutputImageFormat.linearDng) {
      expect(renderProfile.linearDngColorTransform, isNotNull);
    }

    final File output = await runMilkyWayPipelineAndExport(
      sourcePaths: files.map((File file) => file.path).toList(),
      decodingConfig: MilkyWayFrameDecodingConfig(
        decoderRegistry: createProductionNativeRawDecoderRegistry(),
        metadataProbe: metadataProbe,
      ),
      outputTileStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
      exportPath: _outputPath,
      outputFormat: OutputImageFormat.fromPath(_outputPath),
      renderProfile: renderProfile,
      interpolation: ResamplingInterpolation.bicubic,
      tileSize: _tileSize,
      referenceIndex: _referenceIndex < 0 ? null : _referenceIndex,
    );
    expect(await output.exists(), isTrue);
    expect(await output.length(), greaterThan(60 * 1024 * 1024));
    // ignore: avoid_print
    print(
      'REAL_REFERENCE_STACK_PASS ${output.path} '
      '${await output.length()} bytes reference=$_referenceIndex '
      'tileSize=$_tileSize',
    );

    if (_pullAcknowledgement.isNotEmpty) {
      final File acknowledgement = File(_pullAcknowledgement);
      for (int attempt = 0;
          attempt < 120 && !await acknowledgement.exists();
          attempt++) {
        await Future<void>.delayed(const Duration(seconds: 1));
      }
      expect(await acknowledgement.exists(), isTrue,
          reason: 'The result image was not collected in time.');
    }
  }, timeout: const Timeout(Duration(minutes: 20)));
}
