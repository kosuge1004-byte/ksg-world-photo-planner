import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/lightroom_storage_preset.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/session/processing_session.dart';
import 'package:mobile_stack/features/common/stack_settings_screen.dart';
import 'package:mobile_stack/features/focus_stack/focus_stack_settings_screen.dart';

void main() {
  testWidgets('星の軌跡の各種設定に比較明合成の説明を表示する', (WidgetTester tester) async {
    final session = ProcessingSession(mode: ProcessingMode.starTrail);
    await tester.pumpWidget(
      MaterialApp(home: StackSettingsScreen(session: session)),
    );
    expect(find.text('画質'), findsOneWidget);
    expect(find.text('出力方式'), findsOneWidget);
    expect(find.text('ファイル容量'), findsOneWidget);
    expect(find.text('合成方式'), findsOneWidget);
    expect(find.textContaining('比較明合成（固定）'), findsOneWidget);
    expect(find.text('飛行機・人工衛星自動除去'), findsOneWidget);
    expect(session.automaticStarTrailAircraftRemoval, isTrue);
  });

  testWidgets('流星群の各種設定は原寸解析固定と候補選択方式を表示する', (WidgetTester tester) async {
    final session = ProcessingSession(mode: ProcessingMode.meteor);
    await tester.pumpWidget(
      MaterialApp(home: StackSettingsScreen(session: session)),
    );
    expect(find.text('最高画質（固定）'), findsOneWidget);
    expect(find.text('出力方式'), findsOneWidget);
    expect(find.text('ファイル容量'), findsOneWidget);
    expect(find.text('流星候補の選択'), findsOneWidget);
    expect(find.text('移動体（飛行機等）自動削除'), findsNothing);
  });

  testWidgets('深度合成の各種設定に固有の省略候補設定を表示する', (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: FocusStackSettingsScreen(
          outputFormat: OutputImageFormat.linearDng,
          storagePreset: LightroomStoragePreset.maximum,
          showOmissionCandidates: true,
          autoExcludeOmissionCandidates: false,
        ),
      ),
    );
    expect(find.text('最高画質（固定）'), findsOneWidget);
    expect(find.text('出力方式'), findsOneWidget);
    expect(find.text('ファイル容量'), findsOneWidget);
    expect(find.text('省略可能な写真を表示'), findsOneWidget);
    expect(find.text('省略可能な写真を自動除外'), findsOneWidget);
  });
}
