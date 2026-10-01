# Work269 Pixel 9最高画質メモリ軽量化

## 目的

最高画質の解像度、Float32出力、Kappa-Sigma 3反復、bicubic補間、
局所位置合わせ、静止前景維持を変更せず、AndroidでのピークRAMと
一時バッファを削減する。

## 実装

- 最高画質の出力タイルを512pxから256pxへ細分化。
- DNG出力をバックプレッシャー付きストリーム／1ストリップflushへ変更。
  出力全体が`IOSink`の待機キューへ蓄積しない。
- 星検出の全画面`previewInvalid`複製を廃止し、既存の1bit RAW飽和
  マスクを直接参照。
- 背景MAD計算で標本配列を偏差配列として再利用。
- 適応的二重位置合わせで、新規生成済みstellarタイルをその場で更新し、
  RGBとcoverageの複製を廃止。
- Kappa-Sigmaのweighted sums配列をmeansへその場変換。
- Deflate DNGの圧縮結果を余分な`Uint8List`へコピーしない。

いずれも演算式、演算順序、入力画素、位置合わせ設定、出力精度を変更しない。

## 検証

- `flutter analyze`: 0 issues
- Flutter: 844 tests passed
- Node: 676 tests passed
- タイル全体処理と細分化処理のFloat32 RGB／生存数が完全一致
- Android x86_64 emulator: 総RAM 2,531,836kB
- 実Sony ARW 4枚、基準frame 1、tileSize 256
- ネイティブ復号からLinear DNG出力まで9分01秒で完走
- 出力サイズ: 312,132,928 bytes
- 観測RSS: 復号時最大約576MB、合成後半約254MB
- OOM、SIGSEGV、FATAL EXCEPTION: 0

Google公式のPixel 9仕様は12GB RAM。物理Pixel 9そのものへのインストール試験は
未実施だが、約2.5GB RAMのエミュレーターで最高画質経路が完走している。

Pixel 9公式仕様:
https://store.google.com/gb/product/pixel_9_specs?hl=en-GB
