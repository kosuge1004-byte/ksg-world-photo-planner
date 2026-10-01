import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';

/// Full-resolution row-major mask: 255 means gap drawing increased at least
/// one RGB channel; 0 means it did not. The receipt is published last.
final class SyntheticGapMask {
  SyntheticGapMask._(this.outputPath, this.width, this.height, this.identity,
      this._pending, this._handle);
  final String outputPath, identity;
  final int width, height;
  final File _pending;
  final RandomAccessFile _handle;
  int _writtenPixels = 0;
  bool _closed = false;

  static String dataPath(String outputPath) => '$outputPath.gap-mask.u8';
  static String receiptPath(String outputPath) => '$outputPath.gap-mask.json';
  static String _digestIdentity(String identity) =>
      sha256.convert(utf8.encode(identity)).toString();

  static Future<SyntheticGapMask> create(
      {required String outputPath,
      required int width,
      required int height,
      required String identity}) async {
    if (width <= 0 || height <= 0) throw ArgumentError('Invalid gap mask size');
    final file = File('${dataPath(outputPath)}.pending.$pid');
    await file.parent.create(recursive: true);
    final handle = await file.open(mode: FileMode.write);
    await handle.truncate(width * height);
    return SyntheticGapMask._(
        outputPath, width, height, identity, file, handle);
  }

  void writeTile(int x, int y, int w, int h, Uint8List mask) {
    if (_closed ||
        x < 0 ||
        y < 0 ||
        w <= 0 ||
        h <= 0 ||
        x + w > width ||
        y + h > height ||
        mask.length != w * h ||
        mask.any((v) => v != 0 && v != 1)) {
      throw StateError('Invalid synthetic gap mask tile');
    }
    final encoded = Uint8List(mask.length);
    for (int i = 0; i < mask.length; i++) {
      if (mask[i] != 0) encoded[i] = 255;
    }
    for (int row = 0; row < h; row++) {
      _handle.setPositionSync((y + row) * width + x);
      _handle.writeFromSync(encoded, row * w, (row + 1) * w);
    }
    _writtenPixels += w * h;
  }

  Future<void> commit() async {
    if (_closed || _writtenPixels != width * height) {
      throw StateError('Synthetic gap mask is incomplete');
    }
    await _handle.flush();
    await _handle.close();
    _closed = true;
    final digest = (await sha256.bind(_pending.openRead()).first).toString();
    await _pending.rename(dataPath(outputPath));
    final pendingReceipt = File('${receiptPath(outputPath)}.pending.$pid');
    await pendingReceipt.writeAsString(
        jsonEncode({
          'version': 1,
          'width': width,
          'height': height,
          'bytes': width * height,
          'identitySha256': _digestIdentity(identity),
          'sha256': digest,
          'meaning':
              '255: gap fill increased at least one RGB channel; 0: unchanged',
        }),
        flush: true);
    await pendingReceipt.rename(receiptPath(outputPath));
  }

  Future<void> abort() async {
    if (!_closed) {
      await _handle.close();
      _closed = true;
    }
    if (await _pending.exists()) await _pending.delete();
  }

  static Future<bool> isValid(
      {required String outputPath,
      required int width,
      required int height,
      required String identity}) async {
    try {
      final value =
          jsonDecode(await File(receiptPath(outputPath)).readAsString()) as Map;
      final file = File(dataPath(outputPath));
      return value['version'] == 1 &&
          value['width'] == width &&
          value['height'] == height &&
          value['bytes'] == width * height &&
          value['identitySha256'] == _digestIdentity(identity) &&
          await file.length() == width * height &&
          (await sha256.bind(file.openRead()).first).toString() ==
              value['sha256'];
    } on Object {
      return false;
    }
  }

  static Future<bool> hasValidReceipt(
      String outputPath, String identity) async {
    try {
      final value =
          jsonDecode(await File(receiptPath(outputPath)).readAsString()) as Map;
      final width = value['width'] as int, height = value['height'] as int;
      if (width <= 0 || height <= 0) return false;
      return isValid(
          outputPath: outputPath,
          width: width,
          height: height,
          identity: identity);
    } on Object {
      return false;
    }
  }
}
