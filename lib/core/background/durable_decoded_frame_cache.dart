import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'native_file_hash.dart';

/// A flushed, immutable decoded frame is accepted only with its receipt.
/// Both the input identity and RGB bytes are hashed: equal file lengths and
/// timestamps alone cannot establish that an interrupted result is reusable.
final class DurableDecodedFrameCache {
  DurableDecodedFrameCache({required String statusPath, required this.identity})
      : directory = Directory('${File(statusPath).parent.path}'
            '${Platform.pathSeparator}decoded_frames_v2');

  final Directory directory;
  final String identity;
  String _path(int index, String suffix) =>
      '${directory.path}${Platform.pathSeparator}frame_$index.$suffix';

  // Work360: native SHA-256 (same digest) when available; the Dart stream
  // hash took 10-18 s per ~288 MB decoded frame on device.
  static Future<String> fileHash(File file) async =>
      await nativeFileSha256(file.path) ??
      (await sha256.bind(file.openRead()).first).toString();

  static Future<String> buildIdentity({
    required List<String> paths,
    required Map<String, Object?> options,
  }) async {
    final inputs = <Object>[];
    for (final path in paths) {
      final file = File(path);
      inputs.add({'path': file.absolute.path, 'sha256': await fileHash(file)});
    }
    return sha256
        .convert(utf8.encode(jsonEncode({
          'version': 2,
          'inputs': inputs,
          'options': options,
        })))
        .toString();
  }

  Future<LinearRgbTileStore> create(
      {required int index,
      required int width,
      required int height,
      required OverlappedTilePlan plan}) async {
    if (index < 0) throw ArgumentError.value(index, 'index');
    await directory.create(recursive: true);
    await _remove(index);
    return FileBackedLinearRgbTileStore.create(
        path: _path(index, 'f32'), width: width, height: height, plan: plan);
  }

  Future<void> publish(int index, LinearRgbTileStore store,
      {Map<String, Object?>? descriptor}) async {
    if (store is! FileBackedLinearRgbTileStore ||
        !store.isCommitted ||
        store.path != _path(index, 'f32')) {
      throw StateError('Decoded-frame checkpoint is not committed/owned.');
    }
    final receipt = File(_path(index, 'json'));
    final pending = File('${receipt.path}.pending');
    await pending.writeAsString(
        jsonEncode({
          'version': 2,
          'identity': identity,
          'index': index,
          'width': store.width,
          'height': store.height,
          'bytes': store.persistentByteLength,
          'sha256': await fileHash(File(store.path)),
          if (descriptor != null) 'descriptor': descriptor,
          if (descriptor != null)
            'descriptorSha256':
                sha256.convert(utf8.encode(jsonEncode(descriptor))).toString(),
        }),
        flush: true);
    await pending.rename(receipt.path);
  }

  Future<Map<String, dynamic>?> readDescriptor(int index) async {
    try {
      final value =
          jsonDecode(await File(_path(index, 'json')).readAsString()) as Map;
      final descriptor = (value['descriptor'] as Map).cast<String, dynamic>();
      if (value['identity'] != identity ||
          value['index'] != index ||
          value['descriptorSha256'] !=
              sha256.convert(utf8.encode(jsonEncode(descriptor))).toString()) {
        return null;
      }
      return descriptor;
    } on Object {
      return null;
    }
  }

  Future<LinearRgbTileStore?> restore(int index) async {
    try {
      final receipt = File(_path(index, 'json'));
      final data = File(_path(index, 'f32'));
      if (!await receipt.exists() || !await data.exists()) return null;
      final value = jsonDecode(await receipt.readAsString()) as Map;
      final width = value['width'] as int, height = value['height'] as int;
      if (value['version'] != 2 ||
          value['identity'] != identity ||
          value['index'] != index ||
          width <= 0 ||
          height <= 0 ||
          value['bytes'] != width * height * 12 ||
          await data.length() != value['bytes'] ||
          await fileHash(data) != value['sha256']) {
        return null;
      }
      return FileBackedLinearRgbTileStore.openCommitted(
          path: data.path, width: width, height: height);
    } on Object {
      return null;
    }
  }

  Future<void> _remove(int index) async {
    for (final suffix in ['json', 'json.pending', 'f32']) {
      final file = File(_path(index, suffix));
      if (await file.exists()) await file.delete();
    }
  }
}
