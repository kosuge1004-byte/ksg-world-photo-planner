import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/export/bmp_writer.dart';
import 'package:mobile_stack/core/export/tiff16_writer.dart';
import 'package:mobile_stack/features/common/result_file_actions.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('結果BMPをネイティブの永続保存先へコピーする', (
    WidgetTester tester,
  ) async {
    final String? location = await tester.runAsync(() async {
      final String stamp = DateTime.now().microsecondsSinceEpoch.toString();
      final File source = File(
        '${Directory.systemTemp.path}${Platform.pathSeparator}'
        'mobile-stack-save-source-$stamp.bmp',
      );
      await source.writeAsBytes(
        encodeBmp(
          width: 1,
          height: 1,
          rgb8: Uint8List.fromList(<int>[16, 32, 64]),
        ),
      );
      try {
        return await PlatformResultFileActions().saveCopy(
          sourceFile: source,
          suggestedName: 'MobileStack_integration_test_$stamp.bmp',
        );
      } finally {
        if (await source.exists()) await source.delete();
      }
    });
    expect(location, isNotNull);
    expect(location, contains('MobileStack_integration_test_'));
  });

  testWidgets('結果TIFFをimage/tiffとしてネイティブ保存先へコピーする', (
    WidgetTester tester,
  ) async {
    final String? location = await tester.runAsync(() async {
      final String stamp = DateTime.now().microsecondsSinceEpoch.toString();
      final Tiff16Header header = encodeTiff16Header(width: 1, height: 1);
      final File source = File(
        '${Directory.systemTemp.path}${Platform.pathSeparator}'
        'mobile-stack-save-source-$stamp.tiff',
      );
      await source.writeAsBytes(
        <int>[...header.bytes, 0, 0, 0, 0, 0, 0],
      );
      try {
        return await PlatformResultFileActions().saveCopy(
          sourceFile: source,
          suggestedName: 'MobileStack_integration_test_$stamp.tiff',
        );
      } finally {
        if (await source.exists()) await source.delete();
      }
    });
    expect(location, isNotNull);
    expect(location, endsWith('.tiff'));
  });
}
