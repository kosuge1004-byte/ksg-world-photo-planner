import 'dart:io';

import '../image/file_backed_linear_raw_mosaic_store.dart';
import 'raw_decoder_contract.dart';

/// Owns the temporary directory around a native decode-to-file result.
/// [store] itself is opened read-only because calibration must write to a
/// separate destination store; this prevents an interrupted transformation
/// from corrupting the pristine decoded sensor values.
final class FileBackedRawDecode {
  FileBackedRawDecode._({
    required this.result,
    required this.store,
    required this.directory,
  });

  final RawFileBackedDecodeResult result;
  final FileBackedLinearRawMosaicStore store;
  final Directory directory;

  static Future<FileBackedRawDecode> decode({
    required RawFileBackedDecoder decoder,
    required RawDecodeRequest request,
  }) async {
    final Directory directory = await Directory.systemTemp
        .createTemp('mobile-stack-native-raw-stream-');
    final String path =
        '${directory.path}${Platform.pathSeparator}decoded-sensor.f32';
    try {
      final RawFileBackedDecodeResult result =
          await decoder.decodeToFileBacked(request, outputPath: path);
      final int expectedBytes = result.width *
          result.height *
          FileBackedLinearRawMosaicStore.bytesPerSample;
      final File file = File(path);
      if (!await file.exists() || await file.length() != expectedBytes) {
        throw const RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message: 'ストリームRAW出力ファイルのサイズが不正です。',
        );
      }
      final FileBackedLinearRawMosaicStore store =
          await FileBackedLinearRawMosaicStore.openReadOnly(
        path: path,
        width: result.width,
        height: result.height,
        cfaPattern: result.cfaPattern,
        hasSaturationMask: false,
        hasSaturatedPixels: false,
      );
      return FileBackedRawDecode._(
        result: result,
        store: store,
        directory: directory,
      );
    } catch (_) {
      if (await directory.exists()) {
        await directory.delete(recursive: true);
      }
      rethrow;
    }
  }

  Future<void> dispose() async {
    try {
      await store.dispose();
    } finally {
      if (await directory.exists()) {
        await directory.delete(recursive: true);
      }
    }
  }
}
