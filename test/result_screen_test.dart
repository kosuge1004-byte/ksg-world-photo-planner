import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/bmp_writer.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/features/common/result_file_actions.dart';
import 'package:mobile_stack/features/common/result_screen.dart';

final class _FakeResultFileActions implements ResultFileActions {
  final Completer<String> saveCompleter = Completer<String>();
  int saveCalls = 0;
  int shareCalls = 0;
  String? suggestedName;
  Rect? shareOrigin;

  @override
  Future<String> saveCopy({
    required File sourceFile,
    required String suggestedName,
  }) {
    saveCalls++;
    this.suggestedName = suggestedName;
    return saveCompleter.future;
  }

  @override
  Future<void> share({
    required File sourceFile,
    Rect? sharePositionOrigin,
  }) async {
    shareCalls++;
    shareOrigin = sharePositionOrigin;
  }
}

Future<File> _writeTestBmp(Directory directory) async {
  final File image =
      File('${directory.path}${Platform.pathSeparator}result.bmp');
  await image.writeAsBytes(
    encodeBmp(
      width: 1,
      height: 1,
      rgb8: Uint8List.fromList(<int>[255, 255, 255]),
    ),
  );
  return image;
}

Future<File> _writeTestTiff(Directory directory) async {
  final File image =
      File('${directory.path}${Platform.pathSeparator}result.tiff');
  await image.writeAsBytes(<int>[0x49, 0x49, 42, 0]);
  return image;
}

void main() {
  testWidgets('TIFF結果は16bit案内を表示し、保存名もtiffになる', (
    WidgetTester tester,
  ) async {
    late Directory temp;
    late File image;
    await tester.runAsync(() async {
      temp = await Directory.systemTemp.createTemp(
        'mobile-stack-result-screen-tiff-',
      );
      image = await _writeTestTiff(temp);
    });
    final _FakeResultFileActions actions = _FakeResultFileActions();
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: ResultScreen(
            mode: ProcessingMode.meteor,
            imageFile: image,
            frameCount: 5,
            actions: actions,
            deleteTemporaryResultOnDispose: false,
          ),
        ),
      );
      expect(find.text('16bit TIFFを作成しました'), findsOneWidget);
      expect(find.textContaining('BigTIFFへ自動切替'), findsOneWidget);
      expect(find.textContaining('TIFF 16bit'), findsOneWidget);
      await tester.drag(find.byType(ListView), const Offset(0, -600));
      await tester.pumpAndSettle();
      final Finder save = find.text('端末に保存');
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pump();
      expect(
        actions.suggestedName,
        matches(r'^MobileStack_meteor_\d{8}_\d{6}\.tiff$'),
      );
      actions.saveCompleter.complete('Pictures/Mobile Stack/saved.tiff');
      await tester.pump();
    } finally {
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await tester.pump();
      await tester.runAsync(() => temp.delete(recursive: true));
    }
  });

  testWidgets('保存中は全アクションを無効化し、完了後に保存場所を表示する', (
    WidgetTester tester,
  ) async {
    late Directory temp;
    late File image;
    await tester.runAsync(() async {
      temp = await Directory.systemTemp.createTemp(
        'mobile-stack-result-screen-test-',
      );
      image = await _writeTestBmp(temp);
    });
    final _FakeResultFileActions actions = _FakeResultFileActions();
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: ResultScreen(
            mode: ProcessingMode.milkyWay,
            imageFile: image,
            frameCount: 8,
            actions: actions,
            deleteTemporaryResultOnDispose: false,
          ),
        ),
      );
      final Finder save = find.text('端末に保存');
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pump();
      expect(actions.saveCalls, 1);
      final PopScope<void> busyPopScope = tester.widget<PopScope<void>>(
        find.byWidgetPredicate((Widget widget) => widget is PopScope<void>),
      );
      expect(busyPopScope.canPop, isFalse);
      expect(actions.suggestedName,
          matches(r'^MobileStack_milkyWay_\d{8}_\d{6}\.bmp$'));
      expect(find.text('保存中…'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, '共有'), findsOneWidget);
      expect(
        tester.widget<PopScope<void>>(find.byType(PopScope<void>)).canPop,
        isFalse,
      );

      actions.saveCompleter.complete('Pictures/Mobile Stack/saved.bmp');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      final PopScope<void> idlePopScope = tester.widget<PopScope<void>>(
        find.byWidgetPredicate((Widget widget) => widget is PopScope<void>),
      );
      expect(idlePopScope.canPop, isTrue);
      expect(find.text('Pictures/Mobile Stack/saved.bmp'), findsOneWidget);
      expect(find.textContaining('保存しました:'), findsOneWidget);
      expect(
        tester.widget<PopScope<void>>(find.byType(PopScope<void>)).canPop,
        isTrue,
      );
    } finally {
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await tester.pump();
      await tester.runAsync(() => temp.delete(recursive: true));
    }
  });

  testWidgets('共有ボタンはiPad用表示位置を含めて共有サービスを呼ぶ', (
    WidgetTester tester,
  ) async {
    late Directory temp;
    late File image;
    await tester.runAsync(() async {
      temp = await Directory.systemTemp.createTemp(
        'mobile-stack-result-screen-share-',
      );
      image = await _writeTestBmp(temp);
    });
    final _FakeResultFileActions actions = _FakeResultFileActions();
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: ResultScreen(
            mode: ProcessingMode.starTrail,
            imageFile: image,
            frameCount: 3,
            actions: actions,
            deleteTemporaryResultOnDispose: false,
          ),
        ),
      );
      final Finder share = find.text('共有');
      await tester.ensureVisible(share);
      await tester.tap(share);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(actions.shareCalls, 1);
      expect(actions.shareOrigin, isNotNull);
      expect(actions.shareOrigin!.isEmpty, isFalse);
    } finally {
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await tester.pump();
      await tester.runAsync(() => temp.delete(recursive: true));
    }
  });

  test('所有する一時結果と空ディレクトリを削除する', () async {
    final Directory temp = await Directory.systemTemp.createTemp(
      'mobile-stack-result-',
    );
    final File image = await _writeTestBmp(temp);
    await deleteOwnedTemporaryResult(image);
    expect(await image.exists(), isFalse);
    expect(await temp.exists(), isFalse);
  });
}
