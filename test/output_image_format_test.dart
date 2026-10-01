import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';

void main() {
  test('BMPとTIFFの拡張子・MIME・階調区分を一元管理する', () {
    expect(OutputImageFormat.bmp8.extension, 'bmp');
    expect(OutputImageFormat.bmp8.mimeType, 'image/bmp');
    expect(OutputImageFormat.bmp8.isHighBitDepth, isFalse);
    expect(OutputImageFormat.tiff16.extension, 'tiff');
    expect(OutputImageFormat.tiff16.mimeType, 'image/tiff');
    expect(OutputImageFormat.tiff16.isHighBitDepth, isTrue);
    expect(OutputImageFormat.linearDng.extension, 'dng');
    expect(OutputImageFormat.linearDng.mimeType, 'image/x-adobe-dng');
    expect(OutputImageFormat.linearDng.isHighBitDepth, isTrue);
  });

  test('path推定は大文字とtif短縮拡張子を受け入れる', () {
    expect(
      OutputImageFormat.fromPath('/tmp/result.TIFF'),
      OutputImageFormat.tiff16,
    );
    expect(
      OutputImageFormat.fromPath('/tmp/result.tif'),
      OutputImageFormat.tiff16,
    );
    expect(
      OutputImageFormat.fromPath('/tmp/result.BMP'),
      OutputImageFormat.bmp8,
    );
    expect(
      OutputImageFormat.fromPath('/tmp/result.DNG'),
      OutputImageFormat.linearDng,
    );
  });

  test('未知拡張子は指定fallbackへ戻る', () {
    expect(
      OutputImageFormat.fromPath(
        '/tmp/result.data',
        fallback: OutputImageFormat.tiff16,
      ),
      OutputImageFormat.tiff16,
    );
  });
}
