import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/session/processing_session.dart';
import 'package:mobile_stack/features/common/stack_settings_screen.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

void main() {
  setUp(() {
    SharedPreferencesAsyncPlatform.instance =
        InMemorySharedPreferencesAsync.empty();
  });

  testWidgets('各種設定画面で出力方式をTIFF 16bitへ変更できる', (
    WidgetTester tester,
  ) async {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.milkyWay,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: StackSettingsScreen(session: session),
      ),
    );

    DropdownButton<OutputImageFormat> dropdown = tester.widget(
      find.byType(DropdownButton<OutputImageFormat>),
    );
    expect(dropdown.value, OutputImageFormat.linearDng);

    await tester.tap(find.byType(DropdownButton<OutputImageFormat>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('TIFF 16bit — 高画質な汎用編集用').last);
    await tester.pumpAndSettle();

    dropdown = tester.widget(
      find.byType(DropdownButton<OutputImageFormat>),
    );
    expect(dropdown.value, OutputImageFormat.tiff16);
  });

  testWidgets('天の川設定には移動体自動削除ON/OFFがある', (
    WidgetTester tester,
  ) async {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.milkyWay,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: StackSettingsScreen(session: session),
      ),
    );

    expect(find.text('移動体（飛行機等）自動削除'), findsOneWidget);
    expect(session.automaticMovingObjectRemoval, isTrue);

    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    expect(session.automaticMovingObjectRemoval, isFalse);
  });
}
