import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/io/raw_input_contract.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/session/processing_session.dart';
import 'package:mobile_stack/core/quality/processing_quality_level.dart';
import 'package:mobile_stack/core/export/lightroom_storage_preset.dart';

void main() {
  test('画質5段階とLightroom容量プリセットを処理前に選べる', () {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.milkyWay,
    );
    session.setQualityLevel(ProcessingQualityLevel.light);
    session.setStoragePreset(LightroomStoragePreset.balanced);
    expect(session.qualityLevel, ProcessingQualityLevel.light);
    expect(session.outputFormat, OutputImageFormat.tiff16);
  });

  test('出力形式はBMP既定で、処理開始前にTIFFへ変更できる', () {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.milkyWay,
    );
    expect(session.outputFormat, OutputImageFormat.linearDng);
    int notifications = 0;
    session.addListener(() => notifications++);
    session.setOutputFormat(OutputImageFormat.tiff16);
    expect(session.outputFormat, OutputImageFormat.tiff16);
    expect(notifications, 1);
  });

  test('天の川の移動体自動削除は既定ONで処理前にOFFへ変更できる', () {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.milkyWay,
    );
    expect(session.automaticMovingObjectRemoval, isTrue);
    session.setAutomaticMovingObjectRemoval(false);
    expect(session.automaticMovingObjectRemoval, isFalse);
  });

  test('重複パスを追加しない', () {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.milkyWay,
    );
    const RawInputFile file = RawInputFile(
      path: '/a/file.arw',
      byteLength: 100,
    );

    session.addFiles(const <RawInputFile>[file, file]);

    expect(session.files, hasLength(1));
    expect(session.totalBytes, 100);
    expect(session.status, SessionStatus.ready);
  });

  test('最後のファイルを削除すると空状態へ戻る', () {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.starTrail,
    );
    session.addFiles(const <RawInputFile>[
      RawInputFile(path: '/a/file.nef', byteLength: 200),
    ]);

    session.removeFile('/a/file.nef');

    expect(session.files, isEmpty);
    expect(session.status, SessionStatus.empty);
    expect(session.canStart, isFalse);
  });

  test('2枚以上選択すると処理を開始できる', () {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.meteor,
    );

    session.addFiles(const <RawInputFile>[
      RawInputFile(path: '/a/one.dng', byteLength: 100),
    ]);
    expect(session.canStart, isFalse);

    session.addFiles(const <RawInputFile>[
      RawInputFile(path: '/a/two.dng', byteLength: 200),
    ]);
    expect(session.canStart, isTrue);
  });

  test('基準写真はpathで保持し、並び替え後にindexを解決する', () {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.milkyWay,
    );
    session.addFiles(const <RawInputFile>[
      RawInputFile(path: '/a/one.arw', byteLength: 1),
      RawInputFile(path: '/a/two.arw', byteLength: 1),
      RawInputFile(path: '/a/three.arw', byteLength: 1),
      RawInputFile(path: '/a/four.arw', byteLength: 1),
    ]);

    session.setReferencePath('/a/three.arw');
    expect(session.referencePath, '/a/three.arw');
    expect(session.referenceIndex, 2);

    session.moveFile(2, 0);
    expect(session.referencePath, '/a/three.arw');
    expect(session.referenceIndex, 0);
  });

  test('基準RAWを削除すると選択をクリアして再選択を要求する', () {
    final ProcessingSession session = ProcessingSession(
      mode: ProcessingMode.starTrail,
    );
    session.addFiles(const <RawInputFile>[
      RawInputFile(path: '/a/one.nef', byteLength: 1),
      RawInputFile(path: '/a/two.nef', byteLength: 1),
      RawInputFile(path: '/a/three.nef', byteLength: 1),
    ]);
    session.setReferencePath('/a/two.nef');

    session.removeFile('/a/two.nef');

    expect(session.referencePath, isNull);
    expect(session.referenceIndex, isNull);
  });
}
