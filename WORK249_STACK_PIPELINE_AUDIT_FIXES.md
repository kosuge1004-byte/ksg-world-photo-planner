# Work249 — Stack pipeline audit fixes

## Scope
Work248を基準に、スタック処理をゼロベースで静的監査した際に確認した2点を修正。画質アルゴリズム自体は変更していない。

## Fix 1: 飽和影響マスクを通常UIの天の川経路へ接続
`runPhase2ValidatedJob()` が生成する `RawSaturationMask` を `ProcessingProgressScreen` でフレーム毎に保持し、`registerAndCombineDecodedFramesAndExport()` を経由して `registerAndCombineDecodedFrames()` へ渡す。これにより、コア側に既に存在していた飽和画素除外ロジックが通常アプリ経路でも有効になる。

変更点:
- `processing_progress_screen.dart`: `_saturationInfluenceMasks` を追加。`onSaturationMaskReady` で保存。天の川/星景スタック後段へ渡す。
- `export_pipeline_result.dart`: `registerAndCombineDecodedFramesAndExport()` に `saturationInfluenceMasks` を追加し、そのままコアへ転送。

## Fix 2: RAW前処理内の疑似後段ステージを除去
`createPhase2QualityValidationPipeline()` と `createPhase2QualityValidationPipelineWithCorrections()` に存在した、実際には短時間待機するだけの次のステージを削除。
- registration
- stack_accumulation
- noise_reduction
- final_linear_image

実際の星検出・位置合わせ・スタック・出力は従来通り後段の本物の実装で行われる。したがって画質処理そのものは削除していない。進捗/診断表示と実処理の対応を正した。

## Regression test
`test/phase2_quality_pipeline_test.dart` に、通常RAW前処理がdemosaicで終了し、疑似後段4ステージを含まないことを検証するテストを追加。

## Not changed
- デモザイク品質
- similarity registration
- bicubic resampling
- foreground preservation
- kappa-sigma combination
- DNG/TIFF/JPEG export quality
- Work248 scheduler race fix
- final render profile fail-closed validation

## Verification status
この実行環境ではFlutter/Dart SDKの有無を別途確認すること。実行できない場合はテストをPASS扱いにしない。
