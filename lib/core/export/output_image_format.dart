enum OutputImageFormat {
  jpeg(
    extension: 'jpg',
    mimeType: 'image/jpeg',
    label: 'JPEG — 速度・容量優先',
    detail: '処理後すぐに確認・共有したい場合におすすめ。ファイルサイズを小さくできますが、大幅な色・明るさ調整には不向きです。',
  ),
  bmp8(
    extension: 'bmp',
    mimeType: 'image/bmp',
    label: 'BMP 8bit',
    detail: '互換性・アプリ内確認',
  ),
  tiff16(
    extension: 'tiff',
    mimeType: 'image/tiff',
    label: 'TIFF 16bit — 高画質な汎用編集用',
    detail: '高画質を維持しながら、多くの画像編集ソフトで扱いやすい形式。本格的なレタッチに向いています。',
  ),
  linearDng(
    extension: 'dng',
    mimeType: 'image/x-adobe-dng',
    label: 'Linear DNG — 最高画質・RAW編集用',
    detail:
        '合成結果の情報をできるだけ保持してRAW現像する形式。LightroomやCamera Rawなどで本格的に仕上げる場合に適しています。',
  );

  const OutputImageFormat({
    required this.extension,
    required this.mimeType,
    required this.label,
    required this.detail,
  });

  final String extension;
  final String mimeType;
  final String label;
  final String detail;

  bool get isHighBitDepth =>
      this == OutputImageFormat.tiff16 || this == OutputImageFormat.linearDng;

  static OutputImageFormat fromPath(
    String filePath, {
    OutputImageFormat fallback = OutputImageFormat.bmp8,
  }) {
    final String lower = filePath.toLowerCase();
    if (lower.endsWith('.tiff') || lower.endsWith('.tif')) {
      return OutputImageFormat.tiff16;
    }
    if (lower.endsWith('.dng')) return OutputImageFormat.linearDng;
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      return OutputImageFormat.jpeg;
    }
    if (lower.endsWith('.bmp')) return OutputImageFormat.bmp8;
    return fallback;
  }
}
