import 'dart:async';
import 'native_operation_trace.dart';
import 'processing_storage_admission.dart';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import '../tiles/overlapped_tile_plan.dart';

/// A manifest is published after all corresponding output planes are flushed.
/// Every committed tile in every plane is hashed and checked before reuse.
final class DurableTileCheckpoint {
  DurableTileCheckpoint(this.directory, this.identity);
  final Directory directory;
  final String identity;
  Map<String, dynamic>? _data;
  late OverlappedTilePlan _plan;
  late int _width, _height;
  late Map<String, int> _planes;
  String get path => '${directory.path}${Platform.pathSeparator}tiles_v2.json';
  String planePath(String name) =>
      '${directory.path}${Platform.pathSeparator}$name';

  Future<int?> load(
      {required int width,
      required int height,
      required OverlappedTilePlan plan,
      required Map<String, int> planes}) async {
    _width = width;
    _height = height;
    _plan = plan;
    _planes = planes;
    final geometry = [
      for (final tile in plan.tiles)
        [tile.outputX, tile.outputY, tile.outputWidth, tile.outputHeight]
    ];
    try {
      final m = (jsonDecode(await File(path).readAsString()) as Map)
          .cast<String, dynamic>();
      if (m['version'] != 2 ||
          m['identity'] != identity ||
          m['width'] != width ||
          m['height'] != height ||
          m['geometrySha256'] != _digest(geometry) ||
          jsonEncode(m['planes']) != jsonEncode(planes)) {
        return null;
      }
      final completed = m['completedTileCount'] as int;
      if (completed < 0 || completed > plan.tiles.length) return null;
      for (final entry in planes.entries) {
        if (await File(planePath(entry.key)).length() !=
            width * height * entry.value) {
          return null;
        }
      }
      String chain = '';
      for (int i = 0; i < completed; i++) {
        final receipt =
            (jsonDecode(await File(_receiptPath(i)).readAsString()) as Map);
        final hashes = await _hashTile(i);
        if (receipt['index'] != i ||
            jsonEncode(receipt['hashes']) != jsonEncode(hashes)) {
          return null;
        }
        chain = _digest([chain, i, hashes]);
      }
      if (chain != m['receiptChain']) return null;
      _data = m;
      return completed;
    } on Object {
      return null;
    }
  }

  Future<void> startFresh() async {
    if (Zone.current[nativeOperationStatusPath] != null) {
      await ensureProcessingStorage(
          width: _width,
          height: _height,
          bytesPerPixel: _planes.values.fold<int>(0, (a, b) => a + b));
    }
    if (await directory.exists()) await directory.delete(recursive: true);
    await directory.create(recursive: true);
    _data = {
      'version': 2,
      'identity': identity,
      'width': _width,
      'height': _height,
      'geometrySha256': _digest([
        for (final tile in _plan.tiles)
          [tile.outputX, tile.outputY, tile.outputWidth, tile.outputHeight]
      ]),
      'planes': _planes,
      'completedTileCount': 0,
      'receiptChain': '',
    };
  }

  Future<void> publishInitial() => _persist();
  static String _digest(Object value) =>
      sha256.convert(utf8.encode(jsonEncode(value))).toString();
  String _receiptPath(int index) =>
      '${directory.path}${Platform.pathSeparator}tile_$index.json';
  Future<void> record(int completed) async {
    if (completed != (_data!['completedTileCount'] as int) + 1 ||
        completed > _plan.tiles.length) {
      throw StateError('Checkpoint tile order mismatch');
    }
    final hashes = await _hashTile(completed - 1);
    final receipt = File(_receiptPath(completed - 1));
    final pending = File('${receipt.path}.pending.$pid');
    await pending.writeAsString(
        jsonEncode({'index': completed - 1, 'hashes': hashes}),
        flush: true);
    await pending.rename(receipt.path);
    _data!['receiptChain'] =
        _digest([_data!['receiptChain'], completed - 1, hashes]);
    _data!['completedTileCount'] = completed;
    await _persist();
  }

  Future<Map<String, String>> _hashTile(int index) async {
    final tile = _plan.tiles[index];
    final result = <String, String>{};
    for (final entry in _planes.entries) {
      final f = await File(planePath(entry.key)).open();
      try {
        Stream<List<int>> rows() async* {
          for (int row = 0; row < tile.outputHeight; row++) {
            await f.setPosition(
                ((tile.outputY + row) * _width + tile.outputX) * entry.value);
            final Uint8List bytes =
                await f.read(tile.outputWidth * entry.value);
            if (bytes.length != tile.outputWidth * entry.value) {
              throw StateError('Truncated checkpoint tile');
            }
            yield bytes;
          }
        }

        result[entry.key] = (await sha256.bind(rows()).first).toString();
      } finally {
        await f.close();
      }
    }
    return result;
  }

  Future<void> _persist() async {
    final pending = File('$path.pending.$pid');
    await pending.writeAsString(jsonEncode(_data), flush: true);
    await pending.rename(path);
  }

  Future<void> clear() async {
    if (await directory.exists()) await directory.delete(recursive: true);
    _data = null;
  }
}
