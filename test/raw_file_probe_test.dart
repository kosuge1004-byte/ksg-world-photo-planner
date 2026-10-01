import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/raw/raw_file_probe.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

void main() {
  const RawFileProbe probe = RawFileProbe();
  late Directory temporaryDirectory;

  setUp(() async {
    temporaryDirectory =
        await Directory.systemTemp.createTemp('mobile_stack_raw_probe_');
  });

  tearDown(() async {
    if (await temporaryDirectory.exists()) {
      await temporaryDirectory.delete(recursive: true);
    }
  });

  Future<File> writeRaw(String name, List<int> header) async {
    final List<int> bytes = <int>[
      ...header,
      ...List<int>.filled(64 - header.length, 0),
    ];
    return File('${temporaryDirectory.path}${Platform.pathSeparator}$name')
        .writeAsBytes(bytes);
  }

  test('TIFFコンテナのDNGを受理する', () async {
    final File file = await writeRaw(
      'frame.dng',
      const <int>[0x49, 0x49, 0x2A, 0x00],
    );

    final RawProbeResult result = await probe.probe(file.path);

    expect(result.format, RawFormat.dng);
    expect(result.signatureMatched, isTrue);
    expect(result.isAccepted, isTrue);
    expect(result.byteLength, 64);
  });

  test('CR2固有署名を確認する', () async {
    final File valid = await writeRaw(
      'valid.cr2',
      const <int>[
        0x49,
        0x49,
        0x2A,
        0x00,
        0,
        0,
        0,
        0,
        0x43,
        0x52,
        0x02,
        0x00,
      ],
    );
    final File invalid = await writeRaw(
      'invalid.cr2',
      const <int>[0x49, 0x49, 0x2A, 0x00],
    );

    expect((await probe.probe(valid.path)).isAccepted, isTrue);
    expect((await probe.probe(invalid.path)).isAccepted, isFalse);
  });

  test('CR3のISO BMFF署名を受理する', () async {
    final File file = await writeRaw(
      'frame.cr3',
      const <int>[
        0,
        0,
        0,
        24,
        0x66,
        0x74,
        0x79,
        0x70,
        0x63,
        0x72,
        0x78,
        0x20,
      ],
    );

    expect((await probe.probe(file.path)).isAccepted, isTrue);
  });

  test('一般的なISO BMFFファイルをCR3として受理しない', () async {
    final File file = await writeRaw(
      'renamed.cr3',
      const <int>[
        0,
        0,
        0,
        24,
        0x66,
        0x74,
        0x79,
        0x70,
        0x69,
        0x73,
        0x6F,
        0x6D,
      ],
    );

    expect((await probe.probe(file.path)).isAccepted, isFalse);
  });

  test('ORFとRW2の固有ヘッダーを受理する', () async {
    final File orf = await writeRaw(
      'frame.orf',
      const <int>[0x49, 0x49, 0x52, 0x4F],
    );
    final File rw2 = await writeRaw(
      'frame.rw2',
      const <int>[0x49, 0x49, 0x55, 0x00],
    );

    expect((await probe.probe(orf.path)).isAccepted, isTrue);
    expect((await probe.probe(rw2.path)).isAccepted, isTrue);
  });

  test('拡張子と署名が一致しないファイルを拒否する', () async {
    final File file = await writeRaw(
      'fake.nef',
      const <int>[
        0x89,
        0x50,
        0x4E,
        0x47,
        0x0D,
        0x0A,
        0x1A,
        0x0A,
      ],
    );

    final RawProbeResult result = await probe.probe(file.path);

    expect(result.isReadable, isTrue);
    expect(result.signatureMatched, isFalse);
    expect(result.isAccepted, isFalse);
    expect(result.warning, contains('一致しません'));
  });

  test('未接続形式は既知コンテナでも拒否する', () async {
    final File file = await writeRaw(
      'frame.x3f',
      const <int>[0x49, 0x49, 0x2A, 0x00],
    );

    final RawProbeResult result = await probe.probe(file.path);

    expect(result.format, RawFormat.unknown);
    expect(result.isAccepted, isFalse);
    expect(result.warning, contains('対象外'));
  });
}
