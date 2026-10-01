import 'dart:convert';
import 'dart:io';

/// File-backed payload transport for Android WorkManager tasks.
///
/// AndroidX WorkManager limits serialized [Data] to 10 KiB. RAW stack jobs can
/// contain many long source paths, so the full task payload must never be put
/// into WorkManager inputData. Only the short payload/status file paths are
/// passed through WorkManager; the worker reads the full JSON payload here.
final class BackgroundTaskPayload {
  BackgroundTaskPayload._();

  static const String fileName = 'work_input.json';
  static const String inputDataKey = 'payloadPath';

  static Future<String> write({
    required Directory jobDirectory,
    required Map<String, dynamic> payload,
    String outputFileName = fileName,
  }) async {
    if (outputFileName.isEmpty ||
        outputFileName == '.' ||
        outputFileName == '..' ||
        File(outputFileName).path != outputFileName ||
        outputFileName.contains('/') ||
        outputFileName.contains('\\') ||
        outputFileName.contains(':')) {
      throw ArgumentError.value(
        outputFileName,
        'outputFileName',
        'must be a plain file name',
      );
    }
    final File target = File(
      '${jobDirectory.path}${Platform.pathSeparator}$outputFileName',
    );
    final File temporary = File(
      '${target.path}.tmp.${DateTime.now().microsecondsSinceEpoch}',
    );
    await temporary.writeAsString(jsonEncode(payload), flush: true);
    // On Android/iOS the rename is an atomic replacement. Keeping the old
    // payload in place until this fully-flushed replacement is ready avoids a
    // process-death window with no resumable payload.
    try {
      await temporary.rename(target.path);
    } on FileSystemException {
      // Windows does not replace an existing destination with rename(). This
      // fallback is used by desktop tests/development only; Android/iOS keep
      // the atomic replacement above.
      if (await target.exists()) await target.delete();
      await temporary.rename(target.path);
    }
    return target.path;
  }

  static Future<Map<String, dynamic>> resolve(
    Map<String, dynamic> workManagerInput,
  ) async {
    final Object? rawPayloadPath = workManagerInput[inputDataKey];
    if (rawPayloadPath == null) {
      // Backward compatibility for already-enqueued jobs created by an older
      // app build before file-backed payload transport was introduced.
      return Map<String, dynamic>.from(workManagerInput);
    }
    if (rawPayloadPath is! String || rawPayloadPath.isEmpty) {
      throw const FormatException('Invalid background task payload path.');
    }

    final File payloadFile = File(rawPayloadPath);
    final String json = await payloadFile.readAsString();
    final Object? decoded = jsonDecode(json);
    if (decoded is! Map) {
      throw const FormatException(
          'Background task payload is not a JSON object.');
    }

    final Map<String, dynamic> payload = <String, dynamic>{};
    for (final MapEntry<dynamic, dynamic> entry in decoded.entries) {
      if (entry.key is! String) {
        throw const FormatException(
          'Background task payload contains a non-string key.',
        );
      }
      payload[entry.key as String] = entry.value;
    }

    // Keep the authoritative status path available even if a payload written
    // by a future/older version omits it. Other small transport metadata can
    // likewise be preserved without reintroducing the 10 KiB risk.
    final Object? statusPath = workManagerInput['statusPath'];
    if (!payload.containsKey('statusPath') && statusPath is String) {
      payload['statusPath'] = statusPath;
    }
    return payload;
  }
}
