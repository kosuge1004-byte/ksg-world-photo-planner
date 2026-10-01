# Work274 — Androidバックグラウンド処理＋完了通知

## 基準
- Work273 (`MobileStack_Work273_STAR_TRAIL_AIRCRAFT_SATELLITE_REMOVAL.zip`) を基準に実装。
- version: `0.8.10+165`
- 画質計算式は変更しない。実行ライフサイクル、状態永続化、通知、結果復元を拡張。

## 実装した動作

### 通常の天の川スタック
- Android: WorkManager長時間foreground workerへ移行。
- アプリ切替・画面OFF・UI破棄と処理本体を分離。
- 進捗率、工程、処理枚数、経過時間、最終更新、heartbeatを永続化。
- 完成時に高優先度の完了通知。
- Work273と同じ `ProcessingQualityLevel`、Kappa-Sigma、Bicubic、ローカル位置合わせ、静止前景維持、移動体除去設定を使用。

### 星の軌跡
- Android: WorkManager長時間foreground workerへ移行。
- Work273の「飛行機・人工衛星自動除去」ON/OFFをそのまま引き継ぐ。
- 比較明合成処理自体は変更なし。
- 完成時に完了通知。

### 流星群
二段階をそれぞれ独立バックグラウンド処理化。
1. RAWデコード＋流星候補解析
   - 完了通知: 「流星候補の解析が完了しました。候補を確認してください。」
   - 解析結果JSONとfile-backed RGBストアをジョブディレクトリへ永続化。
   - アプリ再起動後もホームの回復カードから候補レビューを復元可能。
2. ユーザーが候補を選んだ後の最終合成
   - 選択候補、背景フレーム選定、Kappa-Sigma背景、流星合成、書き出しをWorkManagerで実行。
   - 完了通知: 「流星群の最終画像が完成しました。」

### 深度合成
二段階をそれぞれ独立バックグラウンド処理化。
1. 合焦位置解析
   - `analyzeFocusMarking`をWorkManagerへ移行。
   - 高精度マスクと最大1024pxのexact previewを永続化してレビュー画面を復元可能にした。
   - 完了通知: 「合焦位置の解析が完了しました。使用する写真を確認してください。」
2. ユーザー確認後の最終深度合成
   - `runFocusStackPipeline`＋既存出力処理をWorkManagerで実行。
   - 最終完成時に完了通知。

### CFA Drizzle天の川
- 既存のWorkManager経路を維持。
- 新しい通知ラベル一般化と回復基盤の変更が既存経路を壊していないことを既存Node source-contract testsで確認。

## 通知
- 処理中: 同一通知IDでforeground進捗通知。
- 完了: 処理中通知を完了通知へ置換。
- 失敗: 失敗通知へ置換。
- 通知権限の拒否／local notification失敗は画像処理の成否に影響させない。
- Android通知権限は開始時に要求。

## 回復
- `StackJobRegistry` に jobKind / mode / label / output format / storage preset / source paths を保持。
- queued/running/completed/failed/cancelledをstatus JSONへ永続化。
- heartbeatは10秒間隔。
- アプリ再起動時はホーム画面の回復カードから進捗・結果・レビューへ戻れる。
- WorkManager native stateと永続statusが矛盾した場合は既存reconciliationを使用。

## 画質不変の確認
Work273とWork274で次の8ファイルをSHA-256比較し、完全一致を確認済み。
- `lib/core/session/milky_way_pipeline.dart`
- `lib/core/session/star_trail_pipeline.dart`
- `lib/core/session/meteor_pipeline.dart`
- `lib/core/focus_stack/focus_stack_pipeline.dart`
- `lib/core/focus_stack/focus_marking_analysis_pipeline.dart`
- `lib/core/session/export_pipeline_result.dart`
- `lib/core/stacking/tiled_kappa_sigma_combiner.dart`
- `lib/core/stacking/tiled_lighten_blend_combiner.dart`

`FileBackedLinearRgbTileStore`には、流星解析結果を別isolate/アプリ再起動後に再利用するための `openCommitted` と `closeRetainingFile` のみ追加。

## 実行した検査
### PASS
- `background_android_configuration_source_contract.test.mjs`: 2/2
- `background_stack_recovery_hardening_source_contract.test.mjs`: 3/3
- `background_stack_status_source_contract.test.mjs`: 5/5
- `background_stack_terminal_cleanup_source_contract.test.mjs`: 4/4
- `work274_background_processing_source_contract.test.mjs`: PASS
- 主要変更Dartファイルの括弧/区切り静的バランス検査: PASS
- 上記8画質アルゴリズムファイル SHA-256同一: PASS

### 未実行
この環境にFlutter SDK / Dart SDKがないため、以下は未実行。
- `flutter analyze`
- `flutter test`
- Android APKビルド
- Android実機での「ホームへ移動」「画面OFF」「プロセス再生成」長時間試験

したがってDartコンパイル・実機WorkManager挙動は、次のFlutter/Codex/Android環境で必ず最終ゲートを通すこと。

## Android OS上の制約
WorkManager foreground処理でも、ユーザーがAndroid設定からアプリを「強制停止」した場合は継続できない。これはAndroid OSの仕様上回避しない。通常のホーム移動、別アプリへの切替、画面OFF、UI route破棄とは区別する。

## 次の検証ゲート
1. `flutter analyze`
2. 全Flutter tests
3. debug/release APK build
4. 実機で各モードを開始→ホームへ移動→画面OFF→処理継続確認
5. 完了通知タップ／アプリ再起動後の回復カード確認
6. 流星候補解析→アプリ終了/再起動→レビュー復元→最終合成→通知
7. 深度合焦解析→アプリ終了/再起動→レビュー復元→最終合成→通知
8. Work273同一RAWでWork274 foreground相当出力とのpixel/metric A/B（画質最終保証）
