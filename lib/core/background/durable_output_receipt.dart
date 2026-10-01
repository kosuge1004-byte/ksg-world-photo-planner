import 'dart:convert';
import 'dart:io';
import 'durable_decoded_frame_cache.dart';

/// Published only after the final artifact is completely written and flushed.
/// An interrupted completion/status update can reuse this exact artifact.
final class DurableOutputReceipt {
  DurableOutputReceipt(this.outputPath, this.identity);
  final String outputPath, identity;
  String get path => '$outputPath.output-receipt.json';

  Future<bool> isValid() async {
    try {
      final value = jsonDecode(await File(path).readAsString()) as Map;
      final file = File(outputPath);
      return value['version'] == 1 &&
          value['identity'] == identity &&
          value['bytes'] == await file.length() &&
          value['bytes'] > 0 &&
          value['sha256'] == await DurableDecodedFrameCache.fileHash(file);
    } on Object {
      return false;
    }
  }

  Future<void> publish() async {
    final file = File(outputPath);
    final handle = await file.open(mode: FileMode.append);
    try {
      await handle.flush();
    } finally {
      await handle.close();
    }
    final bytes = await file.length();
    if (bytes <= 0) throw StateError('Final output is empty');
    final pending = File('$path.pending.$pid');
    await pending.writeAsString(
        jsonEncode({
          'version': 1,
          'identity': identity,
          'bytes': bytes,
          'sha256': await DurableDecodedFrameCache.fileHash(file),
        }),
        flush: true);
    await pending.rename(path);
  }
}
