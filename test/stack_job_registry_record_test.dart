import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/stack_job_registry.dart';

void main() {
  test('StackJobRecord round-trips persistent recovery metadata', () {
    const StackJobRecord record = StackJobRecord(
      uniqueName: 'cfa-drizzle-123',
      statusPath: '/support/background_stack_jobs/cfa-drizzle-123/status.json',
      outputPath: '/support/background_stack_jobs/cfa-drizzle-123/result.dng',
      sourcePaths: <String>['/raw/a.arw', '/raw/b.arw'],
      createdEpochMs: 123456789,
    );

    final StackJobRecord? restored = StackJobRecord.fromMap(record.toMap());

    expect(restored, isNotNull);
    expect(restored!.uniqueName, record.uniqueName);
    expect(restored.statusPath, record.statusPath);
    expect(restored.outputPath, record.outputPath);
    expect(restored.sourcePaths, record.sourcePaths);
    expect(restored.frameCount, 2);
    expect(restored.createdEpochMs, record.createdEpochMs);
  });

  test('StackJobRecord rejects incomplete recovery metadata', () {
    expect(
      StackJobRecord.fromMap(<String, dynamic>{
        'uniqueName': 'cfa-drizzle-123',
        'statusPath': '/status.json',
      }),
      isNull,
    );
  });
}
