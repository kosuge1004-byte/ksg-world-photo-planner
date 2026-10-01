# Work259 - Export memory / I/O batch audit

## Scope
Work258以降の最終出力経路を、画質を変えずにメモリ、I/O、キャンセル応答の観点から再監査した。

## 1. Linear DNG preflightの全画面再読込を統合
従来のLinear DNGは、(a) highlight headroom決定の全画面走査、(b) 埋め込みthumbnail生成のため最大256回のfull-width 1-row read、(c) 本体encode、の順でfile-backed RGBを再読込していた。

Work259では(a)と(b)を1回のstrip走査へ統合した。headroom判定式、linear-sRGB transform、thumbnailのnearest-neighbour座標、99 percentile露出、sRGB encodingは変更していない。

24MP級では、thumbnail用の最大256回の追加full-width row I/Oを除去する。最終encodeの1 passは当然必要なので、DNG本体は「preflight 1 pass + encode 1 pass」に限定される。

## 2. DNG pixel encode中のキャンセル応答
従来は64-row strip単位でのみキャンセルを確認していた。Work259では大きなstrip内でも約262,144 pixelごとにキャンセルを確認する。数値処理は変更しない。

## 3. CFA Drizzle direct-RGB DNG validityをstreaming化
従来のCFA Drizzle direct-RGB Linear DNGは `buildCfaDrizzleRgbTransparencyMask()` で `width*height` bytesの全画面Uint8ListをRAMに保持していた。

Work259では `LinearDngTransparencyMaskSource` を追加し、`CfaDrizzleRgbTransparencyMaskSource` がDNG writerから要求された128 rowsだけをcoverage/saturation storesから読んで0/255へ変換する。

6048x4024なら約24,337,152 bytes (23.2 MiB) のfull-frame mask保持をdirect-RGB CFA Drizzle経路から除去する。RGB3ch coverage、minimumCoverage、saturation fractionの判定式は従来と同一。

## 4. 後方互換
既存の `transparencyMask`, `binaryValidityMask`, `contributionStore` は削除していない。新しいmask sourceとは排他的に扱う。

Native-CFA reconstruction + adaptive demosaic側は、demosaic support radiusのdilationが全画面依存のため今回のstreaming対象にはしていない。既存mask生成へキャンセル伝播のみ追加した。

## Tests added
- `linear_dng_writer_test.dart`: preflight+encodeのread回数が `2 * stripCount` であることを確認し、thumbnail専用row readの再発を検出。
- `cfa_drizzle_dng_validity_streaming_test.dart`: direct coverage validityとsaturation rejectionの意味論を確認。

## Execution status
Flutter/Dart SDKはこの環境に存在しないため `flutter test`, `flutter analyze`, APK buildは未実行。静的ソース検査のみ実施。
