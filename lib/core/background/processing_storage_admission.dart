import '../engine/default_resource_reader.dart';
import 'processing_failure_policy.dart';

/// Called in the background job immediately before allocating a new plane.
/// A UI preflight from a previous attempt is not evidence of current capacity.
Future<void> ensureProcessingStorage(
    {required int width, required int height, int bytesPerPixel = 32}) async {
  if (width <= 0 || height <= 0 || bytesPerPixel <= 0) {
    throw ArgumentError('Invalid processing allocation');
  }
  final requiredBytes = width * height * bytesPerPixel + 512 * 1024 * 1024;
  final snapshot = await readDefaultResourceSnapshot();
  final available = snapshot.availableStorageBytes;
  if (available == null) {
    throw const ProcessingResourcePause(
        '処理用ストレージの空き容量を確認できません。保存済みデータを保持して停止しました。');
  }
  if (available < requiredBytes) {
    throw ProcessingResourcePause(
        '処理用ストレージが不足しています。必要余裕 ${requiredBytes ~/ (1024 * 1024)} MB、空き ${available ~/ (1024 * 1024)} MB。空き容量を確保して再開してください。');
  }
}
