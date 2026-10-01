import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/stack_job_registry.dart';
import 'package:path/path.dart' as p;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const MethodChannel channel =
      MethodChannel('plugins.flutter.io/path_provider');
  late Directory supportDirectory;

  setUp(() async {
    supportDirectory = await Directory.systemTemp.createTemp(
      'mobile-stack-registry-abandon-',
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      if (call.method == 'getApplicationSupportDirectory' ||
          call.method == 'getApplicationSupportPath') {
        return supportDirectory.path;
      }
      return null;
    });
  });

  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    if (await supportDirectory.exists()) {
      await supportDirectory.delete(recursive: true);
    }
  });

  test('abandon cleanup reclaims data but preserves its tombstone', () async {
    final Directory jobsRoot = Directory(
      p.join(supportDirectory.path, 'background_stack_jobs'),
    );
    final Directory job = Directory(p.join(jobsRoot.path, 'standard-stack-1'));
    final String statusPath = p.join(job.path, 'status.json');
    final String outputPath = p.join(job.path, 'result.dng');
    await Directory(p.join(job.path, 'inputs', 'source'))
        .create(recursive: true);
    await File(p.join(job.path, 'inputs', 'source', 'frame.nef'))
        .writeAsBytes(List<int>.filled(4096, 7));
    await File(outputPath).writeAsBytes(List<int>.filled(2048, 9));
    await File(p.join(job.path, 'checkpoint.f32'))
        .writeAsBytes(List<int>.filled(1024, 3));
    await File(statusPath).writeAsString('{"state":"cancelled"}');
    await File('$statusPath.abandon').writeAsString('1');

    expect(
      await StackJobRegistry.purgeAbandonedJobData(
        statusPath: statusPath,
        outputPath: outputPath,
      ),
      isTrue,
    );
    expect(await File(statusPath).exists(), isTrue);
    expect(await File('$statusPath.abandon').exists(), isTrue);
    expect(await File(outputPath).exists(), isFalse);
    expect(await Directory(p.join(job.path, 'inputs')).exists(), isFalse);
    expect(await File(p.join(job.path, 'checkpoint.f32')).exists(), isFalse);
  });

  test('abandon cleanup refuses a directory outside the managed root',
      () async {
    final Directory external = await Directory.systemTemp.createTemp(
      'mobile-stack-external-',
    );
    addTearDown(() async {
      if (await external.exists()) await external.delete(recursive: true);
    });
    final String statusPath = p.join(external.path, 'status.json');
    final String outputPath = p.join(external.path, 'result.dng');
    await File(statusPath).writeAsString('{}');
    await File(outputPath).writeAsString('keep');

    expect(
      await StackJobRegistry.purgeAbandonedJobData(
        statusPath: statusPath,
        outputPath: outputPath,
      ),
      isFalse,
    );
    expect(await File(outputPath).readAsString(), 'keep');
  });
}
