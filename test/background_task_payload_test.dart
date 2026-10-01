import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/background_task_payload.dart';

void main() {
  test('file-backed WorkManager payload preserves large RAW path lists',
      () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-workmanager-payload-',
    );
    addTearDown(() => directory.delete(recursive: true));

    final List<String> sourcePaths = List<String>.generate(
      400,
      (int index) =>
          '/storage/emulated/0/DCIM/very-long-session-name/frame_${index.toString().padLeft(4, '0')}.ARW',
    );
    final Map<String, dynamic> fullPayload = <String, dynamic>{
      'sourcePaths': sourcePaths,
      'outputPath': '${directory.path}/result.dng',
      'statusPath': '${directory.path}/status.json',
      'referenceIndex': 0,
    };

    final String payloadPath = await BackgroundTaskPayload.write(
      jobDirectory: directory,
      payload: fullPayload,
    );

    final Map<String, dynamic> workManagerInput = <String, dynamic>{
      BackgroundTaskPayload.inputDataKey: payloadPath,
      'statusPath': fullPayload['statusPath'],
    };
    expect(workManagerInput.containsKey('sourcePaths'), isFalse);

    final Map<String, dynamic> resolved =
        await BackgroundTaskPayload.resolve(workManagerInput);
    expect(resolved['sourcePaths'], sourcePaths);
    expect(resolved['outputPath'], fullPayload['outputPath']);
    expect(resolved['statusPath'], fullPayload['statusPath']);
  });

  test('legacy inline payload remains readable', () async {
    final Map<String, dynamic> legacy = <String, dynamic>{
      'sourcePaths': <String>['a.arw', 'b.arw'],
      'statusPath': '/tmp/status.json',
    };
    expect(await BackgroundTaskPayload.resolve(legacy), legacy);
  });

  test('rewriting a payload leaves a complete replacement', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-payload-replace-',
    );
    addTearDown(() => directory.delete(recursive: true));
    await BackgroundTaskPayload.write(
      jobDirectory: directory,
      payload: <String, dynamic>{'generation': 1},
    );
    final String path = await BackgroundTaskPayload.write(
      jobDirectory: directory,
      payload: <String, dynamic>{'generation': 2, 'complete': true},
    );
    final Map<String, dynamic> restored =
        await BackgroundTaskPayload.resolve(<String, dynamic>{
      BackgroundTaskPayload.inputDataKey: path,
    });
    expect(restored, <String, dynamic>{'generation': 2, 'complete': true});
  });

  test('separate task payloads in one job directory do not overwrite',
      () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-separate-payloads-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final String analysis = await BackgroundTaskPayload.write(
      jobDirectory: directory,
      payload: <String, dynamic>{'task': 'analysis'},
    );
    final String composite = await BackgroundTaskPayload.write(
      jobDirectory: directory,
      outputFileName: 'meteor_composite_input.json',
      payload: <String, dynamic>{'task': 'composite'},
    );
    expect(analysis, isNot(composite));
    expect(
      (await BackgroundTaskPayload.resolve(<String, dynamic>{
        BackgroundTaskPayload.inputDataKey: analysis,
      }))['task'],
      'analysis',
    );
    expect(
      (await BackgroundTaskPayload.resolve(<String, dynamic>{
        BackgroundTaskPayload.inputDataKey: composite,
      }))['task'],
      'composite',
    );
  });

  test('payload output name cannot escape the job directory', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-payload-name-',
    );
    addTearDown(() => directory.delete(recursive: true));

    for (final String invalidName in <String>[
      '.',
      '..',
      '../outside.json',
      r'..\outside.json',
      r'C:\outside.json',
    ]) {
      expect(
        () => BackgroundTaskPayload.write(
          jobDirectory: directory,
          outputFileName: invalidName,
          payload: <String, dynamic>{'task': 'invalid'},
        ),
        throwsArgumentError,
        reason: invalidName,
      );
    }
  });
}
