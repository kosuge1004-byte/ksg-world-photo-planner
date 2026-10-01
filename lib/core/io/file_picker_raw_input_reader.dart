import 'package:file_picker/file_picker.dart';

import '../raw/embedded_jpeg_preview_extractor.dart';
import '../raw/format_aware_raw_preview_extractor.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_file_probe.dart';
import '../raw/raw_metadata_probe.dart';
import '../raw/raw_probe_result.dart';
import 'raw_file_extensions.dart';
import 'raw_input_contract.dart';

class FilePickerRawInputReader implements RawInputReader {
  const FilePickerRawInputReader({
    this.probe = const RawFileProbe(),
    this.previewExtractor = const FormatAwareRawPreviewExtractor(),
    this.metadataProbe,
    this.allowedExtensions = probeSupportedRawExtensions,
    this.maximumTotalPreviewBytes = 64 * 1024 * 1024,
  })  : assert(allowedExtensions.length > 0),
        assert(maximumTotalPreviewBytes > 0);

  final RawFileProbe probe;
  final RawPreviewExtractor previewExtractor;
  final RawMetadataProbe? metadataProbe;
  final Set<String> allowedExtensions;
  final int maximumTotalPreviewBytes;

  @override
  Future<RawSelectionResult> selectRawFiles() async {
    final FilePickerResult? result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: FileType.custom,
      allowedExtensions: allowedExtensions.toList(growable: false),
      withData: false,
      withReadStream: false,
    );

    if (result == null) return const RawSelectionResult.empty();

    final List<RawInputFile> files = <RawInputFile>[];
    final List<RawInputRejection> rejected = <RawInputRejection>[];
    int previewBytesInMemory = 0;
    for (final PlatformFile selected in result.files) {
      final String? path = selected.path;
      if (path == null) {
        rejected.add(
          RawInputRejection(
            path: selected.name,
            displayName: selected.name,
            reason: '端末上のファイルパスを取得できません。',
          ),
        );
        continue;
      }
      if (!hasAllowedRawExtension(path, allowedExtensions)) {
        rejected.add(
          RawInputRejection(
            path: path,
            displayName: selected.name,
            reason: '対応していない拡張子です。',
          ),
        );
        continue;
      }

      final RawProbeResult probeResult = await probe.probe(path);
      if (!probeResult.isAccepted) {
        rejected.add(
          RawInputRejection(
            path: path,
            displayName: selected.name,
            reason: probeResult.warning ?? 'RAWファイルとして確認できません。',
          ),
        );
        continue;
      }
      RawMetadataProbeResult? metadata;
      final RawMetadataProbe? nativeProbe = metadataProbe;
      if (nativeProbe != null && nativeProbe.supports(probeResult.format)) {
        try {
          metadata = await nativeProbe.probe(probeResult);
        } on RawDecodeFailure catch (error) {
          rejected.add(
            RawInputRejection(
              path: path,
              displayName: selected.name,
              reason: 'RAWメタデータを確認できません: ${error.message}',
            ),
          );
          continue;
        } on RawDecoderUnavailable catch (error) {
          rejected.add(
            RawInputRejection(
              path: path,
              displayName: selected.name,
              reason: error.message,
            ),
          );
          continue;
        }
      }
      final RawEmbeddedPreview? preview =
          await previewExtractor.extract(probeResult);
      final previewBytes = preview != null &&
              previewBytesInMemory + preview.bytes.length <=
                  maximumTotalPreviewBytes
          ? preview.bytes
          : null;
      previewBytesInMemory += previewBytes?.length ?? 0;
      files.add(
        RawInputFile(
          path: path,
          byteLength: probeResult.byteLength,
          displayName: selected.name,
          probe: probeResult,
          metadata: metadata,
          thumbnailBytes: previewBytes,
        ),
      );
    }
    return RawSelectionResult(
      files: List<RawInputFile>.unmodifiable(files),
      rejected: List<RawInputRejection>.unmodifiable(rejected),
    );
  }
}
