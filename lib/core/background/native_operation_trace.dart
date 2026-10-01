import 'dart:async';
import 'stack_operation_journal.dart';
import '../raw/raw_native_contract.dart';
import 'processing_storage_admission.dart';

const Symbol nativeOperationStatusPath = #mobileStackNativeOperationStatusPath;
const Symbol nativeOperationGeometry = #mobileStackNativeOperationGeometry;

/// Records the caller's operation before starting a separate native isolate.
/// The caller remains responsive while synchronous FFI executes elsewhere.
Future<T> traceNativeOperation<T>(
    {required String operation,
    String? stage,
    required Future<T> Function() call}) async {
  final path = Zone.current[nativeOperationStatusPath] as String?;
  if (path == null) return call();
  final journal = StackOperationJournal(path);
  final timer = Stopwatch()..start();
  final geometry =
      Zone.current[nativeOperationGeometry] as Map<String, (int, int)>?;
  final dimensions = geometry?[stage];
  if (operation != 'rawMetadata' && dimensions != null) {
    await ensureProcessingStorage(width: dimensions.$1, height: dimensions.$2);
  }
  await journal.enter(operation: operation, stage: stage);
  try {
    final result = await call();
    if (result is RawNativeMetadataFrame && stage != null) {
      if (geometry != null) geometry[stage] = (result.width, result.height);
    }
    await journal.complete(
        operation: operation,
        stage: '${stage ?? operation}; elapsedMs=${timer.elapsedMilliseconds}');
    return result;
  } on Object catch (error) {
    try {
      await journal.failed(
          operation: operation, stage: '${stage ?? operation}; $error');
    } on Object {/* Preserve the original native failure. */}
    rethrow;
  }
}
