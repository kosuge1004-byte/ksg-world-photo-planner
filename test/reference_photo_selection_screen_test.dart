import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/io/raw_input_contract.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/features/common/reference_photo_selection_screen.dart';

void main() {
  testWidgets('4枚の3枚目を単一選択しstable pathを返す', (WidgetTester tester) async {
    const List<RawInputFile> files = <RawInputFile>[
      RawInputFile(path: '/raw/one.arw', byteLength: 1),
      RawInputFile(path: '/raw/two.arw', byteLength: 1),
      RawInputFile(path: '/raw/three.arw', byteLength: 1),
      RawInputFile(path: '/raw/four.arw', byteLength: 1),
    ];
    String? selectedPath;

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (BuildContext context) => Scaffold(
            body: ElevatedButton(
              onPressed: () async {
                selectedPath = await Navigator.of(context).push<String>(
                  MaterialPageRoute<String>(
                    builder: (_) => const ReferencePhotoSelectionScreen(
                      files: files,
                      mode: ProcessingMode.milkyWay,
                    ),
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('基準写真を選択'), findsOneWidget);
    expect(find.text('位置合わせ・最終出力の基準にする1枚を選択してください'), findsOneWidget);
    final Finder confirm = find.text('この写真を基準にする');
    expect(
      tester
          .widget<FilledButton>(
            find.ancestor(of: confirm, matching: find.byType(FilledButton)),
          )
          .onPressed,
      isNull,
    );

    await tester.tap(find.text('three.arw'));
    await tester.pump();
    expect(
      tester
          .widget<FilledButton>(
            find.ancestor(of: confirm, matching: find.byType(FilledButton)),
          )
          .onPressed,
      isNotNull,
    );
    await tester.tap(confirm);
    await tester.pumpAndSettle();

    expect(selectedPath, '/raw/three.arw');
  });
}
