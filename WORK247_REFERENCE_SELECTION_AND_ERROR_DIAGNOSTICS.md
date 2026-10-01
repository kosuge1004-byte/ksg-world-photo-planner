# Work247 — 基準写真選択と詳細エラー診断

## 結果

Work246を基準に、通常の「天の川・星景スタック」と「星の軌跡」へ
基準写真選択画面を追加した。選択は配列indexではなくsource pathで保持し、
処理開始直前に現在のindexへ解決する。削除時は選択をクリアする。

天の川では選択フレームをidentity transformのreferenceとして使用し、他の
フレームをその座標へ登録する。低レベルAPIの`referenceIndex == null`では
Work246の自動画質選択を維持する。星の軌跡の比較明合成アルゴリズムは変更せず、
最終WB、カメラ色プロファイル、DNGメタデータだけを選択RAWへ統一した。

処理失敗は構造化された`ProcessingFailureReport`へ保存する。RAWジョブ失敗と、
RAW 4/4成功・失敗0の後に発生する星検出、位置合わせ、合成、DNG/TIFF/JPEG等の
後段失敗を同じ画面で表示できる。概要、展開可能なスクロール詳細、プレーン
テキストのコピー、コピー完了SnackBarを実装した。

## 画質契約

- RAWデコード、黒/白レベル、WB、色変換、デモザイクは変更していない。
- 星検出閾値、similarity/affine登録、bicubic、kappa-sigma、foreground処理は
  変更していない。
- Linear DNG/TIFF/JPEGのエンコード品質とメタデータ処理は変更していない。
- Sony ARW / Nikon NEF・NRWのネイティブ実装は変更していない。
- Work239の深度合成reference選択は変更していない。
- 実験的CFA Drizzle画面は、選択を消費しないため今回の通常reference画面から
  明示的に除外し、UIだけの選択にならないようにした。

## 診断情報

発生日時（UTC offset付き）、モード、工程、サブ工程、例外型、メッセージ、
stack trace、対象RAW、全入力名、枚数、基準RAW名/index、RAW形式、取得できる
画像サイズ/CFA、出力形式、完了/失敗/キャンセル数、native error code/message、
直前完了工程を記録する。

現在の`RawInputFile`/ネイティブメタデータ契約が公開していないcamera make、
camera model、bit depth、compressionは推測せず`not available`と出力する。

工程はRAW入力、メタデータ、native decode、黒/白、WB/profile、demosaic、
RGB tile、reference準備、星検出、reference alignment準備、frame alignment、
stack、foreground、profile検証、出力準備、Linear DNG/TIFF/JPEG/BMP、temp、
結果引き渡しに分割した。

## 変更ファイル

- `lib/core/diagnostics/processing_failure_report.dart`（新規）
- `lib/core/engine/job_scheduler.dart`
- `lib/core/engine/phase2_validated_job_executor.dart`
- `lib/core/engine/processing_job.dart`
- `lib/core/export/reference_render_profile_selection.dart`
- `lib/core/pipeline/processing_pipeline.dart`
- `lib/core/session/export_pipeline_result.dart`
- `lib/core/session/milky_way_pipeline.dart`
- `lib/core/session/processing_session.dart`
- `lib/features/common/processing_failure_panel.dart`（新規）
- `lib/features/common/processing_progress_screen.dart`
- `lib/features/common/raw_selection_screen.dart`
- `lib/features/common/reference_photo_selection_screen.dart`（新規）
- `lib/features/milkyway/cfa_drizzle_milky_way_screen.dart`
- `test/milky_way_pipeline_test.dart`
- `test/processing_failure_panel_test.dart`（新規）
- `test/processing_failure_report_test.dart`（新規）
- `test/processing_progress_downstream_failure_test.dart`（新規）
- `test/processing_session_test.dart`
- `test/reference_photo_selection_screen_test.dart`（新規）
- `test/reference_render_profile_selection_test.dart`
- `WORK247_REFERENCE_SELECTION_AND_ERROR_DIAGNOSTICS.md`（新規）

## 検証結果

- Flutter dependency resolution（offline）: PASS
- `flutter analyze --no-pub`: PASS、0 issues
- `flutter test --no-pub`: PASS、815/815
- Work247対象回帰テスト: PASS、26/26
- Node source/algorithm regressions: PASS、629/629
- Android arm64 release APK build: PASS
- APK内arm64 `libmobile_stack_raw.so`: PASS、1,032,112 bytes
- Android RAW/demosaic公開シンボル: PASS、12 symbols確認
- APK SHA-256: `C19F25AD6594DD6E63A257E8BBAA70081FF7DA808914CC17FDAB8866355961BC`

## Native / CI

- Android native production compile: PASS（release Gradle/NDK build経由）
- Native host CTest: NOT RUN（このWindows環境にhost C/C++ compilerなし）
- ASan/UBSan native test: NOT RUN（Linux環境なし）
- GitHub Actions CI: NOT RUN
- iOS build/export test: NOT RUN（Windows環境）

## 実機で確認する項目

Sony α7 III / ILCE-7M3の実ARW 4枚について、次を確認する。

1. 天の川・星景で4枚選択後に基準写真画面が開く。
2. 選択した1枚が明確に表示され、決定後に処理が始まる。
3. 同じ手順を星の軌跡でも行う。
4. 成功時に結果を確認する。
5. 失敗時に工程、型、メッセージ、詳細が表示される。
6. 「エラー内容をコピー」とコピー完了表示を確認する。
7. コピー文だけで入力、reference、工程、例外、stack traceを追跡できる。

## 未確認事項・既知のリスク

- Sony α7 III実機 + 実ARW 4枚の天の川/星軌跡: NOT RUN / NOT VERIFIED
- Android実機Clipboard動作: NOT RUN（widget testの標準channel mockではPASS）
- Adobe Lightroom/Camera Rawでの今回APK出力再読込: NOT RUN
- camera make/model、bit depth、compressionは現在のDart入力契約では取得不能なため
  `not available`。値の推測はしていない。
- 物理端末のメモリ、長時間処理、キャンセル、一時ファイル清掃: NOT RUN

以上の未確認項目があるため、物理実機を含むrelease-completeとは宣言しない。
