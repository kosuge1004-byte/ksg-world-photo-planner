import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/features/common/result_file_actions.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const MethodChannel channel = MethodChannel(
    'com.mobilestack.app/result_files-test',
  );

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('saveCopyはファイル全体をDartへ読み込まずパスをMethodChannelへ渡す', () async {
    final Directory temp = await Directory.systemTemp.createTemp(
      'mobile-stack-result-actions-',
    );
    final File source = File('${temp.path}${Platform.pathSeparator}result.bmp');
    await source.writeAsBytes(<int>[0x42, 0x4d]);
    MethodCall? received;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      received = call;
      return 'Pictures/Mobile Stack/saved.bmp';
    });
    try {
      final PlatformResultFileActions actions = PlatformResultFileActions(
        channel: channel,
      );
      final String location = await actions.saveCopy(
        sourceFile: source,
        suggestedName: 'saved.bmp',
      );
      expect(location, 'Pictures/Mobile Stack/saved.bmp');
      expect(received?.method, 'saveResult');
      expect(
        received?.arguments,
        <String, Object>{
          'sourcePath': source.path,
          'displayName': 'saved.bmp',
          'mimeType': 'image/bmp',
        },
      );
    } finally {
      await temp.delete(recursive: true);
    }
  });

  test('TIFF保存はimage/tiffとtiff表示名をMethodChannelへ渡す', () async {
    final Directory temp = await Directory.systemTemp.createTemp(
      'mobile-stack-result-actions-tiff-',
    );
    final File source =
        File('${temp.path}${Platform.pathSeparator}result.tiff');
    await source.writeAsBytes(<int>[0x49, 0x49, 42, 0]);
    MethodCall? received;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      received = call;
      return 'Pictures/Mobile Stack/saved.tiff';
    });
    try {
      final PlatformResultFileActions actions = PlatformResultFileActions(
        channel: channel,
      );
      await actions.saveCopy(
        sourceFile: source,
        suggestedName: 'saved.tiff',
      );
      expect(
        received?.arguments,
        <String, Object>{
          'sourcePath': source.path,
          'displayName': 'saved.tiff',
          'mimeType': 'image/tiff',
        },
      );
    } finally {
      await temp.delete(recursive: true);
    }
  });

  test('DNG保存はファイルパスとimage/x-adobe-dngをMethodChannelへ渡す', () async {
    final Directory temp = await Directory.systemTemp.createTemp(
      'mobile-stack-result-actions-dng-',
    );
    final File source = File('${temp.path}${Platform.pathSeparator}result.dng');
    await source.writeAsBytes(<int>[0x49, 0x49, 42, 0]);
    MethodCall? received;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      received = call;
      return 'Pictures/Mobile Stack/saved.dng';
    });
    try {
      final PlatformResultFileActions actions = PlatformResultFileActions(
        channel: channel,
      );
      final String location = await actions.saveCopy(
        sourceFile: source,
        suggestedName: 'saved.dng',
      );
      expect(location, 'Pictures/Mobile Stack/saved.dng');
      expect(
        received?.arguments,
        <String, Object>{
          'sourcePath': source.path,
          'displayName': 'saved.dng',
          'mimeType': 'image/x-adobe-dng',
        },
      );
    } finally {
      await temp.delete(recursive: true);
    }
  });

  test('存在しない結果はネイティブ保存や共有を呼ばず拒否する', () async {
    bool shared = false;
    final PlatformResultFileActions actions = PlatformResultFileActions(
      channel: channel,
      shareResultFile: ({required sourceFile, sharePositionOrigin}) async {
        shared = true;
      },
    );
    final File missing = File(
      '${Directory.systemTemp.path}${Platform.pathSeparator}'
      'mobile-stack-definitely-missing.bmp',
    );
    await expectLater(
      actions.saveCopy(sourceFile: missing, suggestedName: 'result.bmp'),
      throwsA(isA<ResultFileActionException>()),
    );
    await expectLater(
      actions.share(sourceFile: missing),
      throwsA(isA<ResultFileActionException>()),
    );
    expect(shared, isFalse);
  });

  test('shareは既存ファイルのパスと表示位置を共有実装へ渡す', () async {
    final Directory temp = await Directory.systemTemp.createTemp(
      'mobile-stack-result-share-',
    );
    final File source = File('${temp.path}${Platform.pathSeparator}result.bmp');
    await source.writeAsBytes(<int>[0x42, 0x4d]);
    File? sharedFile;
    Rect? sharedOrigin;
    try {
      final PlatformResultFileActions actions = PlatformResultFileActions(
        channel: channel,
        shareResultFile: ({required sourceFile, sharePositionOrigin}) async {
          sharedFile = sourceFile;
          sharedOrigin = sharePositionOrigin;
        },
      );
      const Rect origin = Rect.fromLTWH(10, 20, 30, 40);
      await actions.share(sourceFile: source, sharePositionOrigin: origin);
      expect(sharedFile?.path, source.path);
      expect(sharedOrigin, origin);
    } finally {
      await temp.delete(recursive: true);
    }
  });
}
