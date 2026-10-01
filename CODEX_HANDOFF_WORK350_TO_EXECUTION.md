# Work350 → Codex 実行引き継ぎ（APK化）

最新基準は Work350。Version: 0.8.45+201（pubspec.yaml が正本、mobilestack_work: 350）。
最終スタックDNGのBaselineExposureは0 EVを維持。
入力: MobileStack_SOURCE_0_8_45_201_WORK350.zip（Work349 = 0.8.44+200 からの差分）。

最新ユーザー指示: 「APKにする」。あわせて以下の方針は継続:
- 画質や処理結果精度を落とす選択はしない（結果はWork349とビット一致が条件）。
- Google Play で配布可能であること。
- 長時間処理画面に ETA/残り時間を表示しない（CODEX_HANDOFF_WORK264）。
- 実行した検査と未実行の検査を区別する。過去版のPASSを流用しない。

---------------------------------------------------------------------------
## 1. Work350 の変更（これ以外は Work349 と同一）

| ファイル | 内容 |
|---|---|
| lib/core/stacking/tiled_kappa_sigma_combiner.dart | effectiveBandPixels()。32MiB の位置合わせ済みフレームキャッシュに全フレームが収まるようバンドを縮小。1行も収まらない場合は従来の再読込経路。天の川・流星の両方に適用 |
| lib/core/session/milky_way_pipeline.dart | ①キャッシュ 0→32MiB（理由の記録なく無効化されていた）②合成ログに msPerTile / bandPixels ③登録用星検出を最大2フレーム並列（Isolate.spawn、kill可能、200ms間隔のキャンセル確認、finallyで全ワーカー停止） |
| lib/core/background/standard_stack_background_worker.dart | 天の川デコードキャッシュ publish の所要時間ログ（全ファイル SHA-256 を含む） |
| native/CMakeLists.txt | Sanitizer 有効時のみ、mobile_stack_raw をリンクする C 実行ファイルを C++ ドライバでリンク（Clang UBSan vptr ランタイム不足の修正）。通常ビルドは不変 |
| test/tiled_kappa_sigma_combiner_cache_equivalence_test.dart | 新規。旧設定（キャッシュ無効・8192px帯）とのビット一致、読込回数、300枚で32MiB以内、予算不足時フォールバック |
| tool/work350_combine_throughput_contract.test.mjs | 新規。上記と FGS 種別・ETA不在・Sanitizer設定の静的契約 |
| pubspec.yaml / CODEX_START_HERE.txt / RELEASE_GATES_CURRENT.md / WORK350_VALIDATION_RESULTS.json | 版数・記録 |

背景: Work349 の実機ログで合成が 約38秒/タイル × 1504タイル ≈ 16時間。kappa-sigma は反復ごとに平均・分散・候補数の3パス＋最終平均で全フレームを読み、キャッシュ無効のため1タイル×50枚で最大約1000回の二重位置合わせリサンプルが発生していた。Android 15+ の mediaProcessing 6時間上限で31%地点で停止。

## 2. 変更禁止（不変条件）

- kappa=2.5、maximumIterations=3、robustSmallStackInitialization、synchronizeRgbRejection、FP32、元解像度、BaselineExposure 0 EV。
- ProcessorService の foregroundServiceType は mediaProcessing。specialUse にしない（Play審査上の理由）。
- SupervisorService の specialUse（Work316から既存）は削除しない。停止検知・自動再開に必須。
- ETA/残り時間/etaMin をUI・ログに追加しない。現在工程の文言は Work349 と同一。
- テストが落ちた場合に、閾値・期待値・比較方法を緩めて通さない。原因を報告する。

## 3. 実行手順（この順で。各段の合格基準を満たさなければ次へ進まない）

### A. Node 契約
```
bash tool/run_all_node_tests.sh
```
合格: 782/782（Work350 実行済み）。

### B. Flutter 静的解析
```
flutter pub get
flutter analyze
```
合格: 指摘0（Work349 は0）。Work350 の Dart 変更は構文解析のみ実施済みで、型検査は未実施。指摘が Work350 変更箇所なら最小修正し、内容を記録。

### C. Flutter テスト
```
flutter test test/tiled_kappa_sigma_combiner_cache_equivalence_test.dart test/tiled_kappa_sigma_combiner_test.dart
flutter test
```
合格: 前者は全件PASS（ビット一致が必須。ここが落ちたら APK 作成に進まず報告）。全体は Work349 の 952 件＋新規分が全PASS。

### D. Native
通常ビルド＋CTest（Work349 と同じ Windows 手順で可）: 8/8。
Sanitizer（Linux/WSL、Clang と GCC）:
```
cmake -S native -B build-san -G Ninja -DMOBILE_STACK_RAW_ENABLE_SANITIZERS=ON
cmake --build build-san && ctest --test-dir build-san
```
合格: ビルド成功・8/8。Work350 作業環境では GCC/Clang × Sanitizer OFF/ON の4構成で実行済み（各8/8）。Codex 環境に Linux が無ければ「未実行」と記録。

### E. リリース APK
```
flutter build apk --release --target-platform android-arm64 --dart-define=MOBILE_STACK_ENABLE_DNG_METADATA=true
```
成果物名: MobileStack_0.8.45_201_WORK350_combine-cache_arm64_release.apk

### F. APK 検証
- versionName 0.8.45 / versionCode 201。
- 実 targetSdk を `aapt2 dump badging` または `apkanalyzer manifest target-sdk` で確認し、提出時点の Google Play 要件を満たすか記録（build.gradle.kts は flutter.targetSdkVersion 依存のため必須）。
- ABI: arm64-v8a のみ。
- `tool/check_native_exports.sh <libmobile_stack_raw.so>`: Work349 と同じ 13 exports。
- `apksigner verify --print-certs`: PASS。証明書 SHA-256 を記録。
- マージ後 Manifest: ProcessorService=mediaProcessing、SupervisorService=specialUse＋PROPERTY_SPECIAL_USE_FGS_SUBTYPE、FOREGROUND_SERVICE_SPECIAL_USE 権限。

### G. エミュレータ起動スモーク（Work349 と同じ API 36 AVD）
install → cold launch → MainActivity resumed → fatal crash なし。

### H. 実機（接続されている場合のみ。無ければ全項目「未実行」）
1. 同一50枚（天の川・移動体除去ON）を Work349 APK と Work350 APK で処理し、最終 DNG の SHA-256 を比較。**一致が必須**。
2. ログ確認: `standard-combine tile ... msPerTile=`、`milkyDecodedCache publish frame=... elapsedMs=`、`starDetection frame N done`。全体所要時間を記録。
3. 星検出中にキャンセル → 以後 starDetection ログが止まり、CPU 使用が続かないこと。
4. 画面OFF・バックグラウンドで完走。
5. FGS timeout 到達 → アプリ復帰で自動再開。
6. `adb shell am kill` 等でプロセス停止 → チェックポイントから復旧、出力が 1. と一致。
7. 流星モードでも同一入力で Work349 と出力一致。

## 4. 記録
WORK350_VALIDATION_RESULTS.json を Work349 と同じ粒度で更新（nodeSuite / staticAnalysis / flutterSuite / native / releaseArtifact / releaseRuntimeSmoke / apk sha256 / notRun）。実行していない項目は notRun に入れ、PASS と書かない。allMandatoryReleaseGatesComplete は H まで完了しない限り false。

## 5. 既知の制約・判断待ち（Codex は変更しない。報告のみ）
- **Play 配布**: SupervisorService の specialUse は Play Console での申告が必要で、審査通過は保証されない。
- 停止された星検出ワーカーは自身の finally を実行しないため、読取専用ファイルハンドルは Dart VM の isolate 終了処理で解放される（実機未確認）。
- ワーカー内例外時、除外理由の文字列が RemoteError 経由になる（除外判定は同一）。
- 位置合わせ: Work349 ログでマッチ星が縦3%の帯に集中（matchSpanY≈0.03）。未対応（出力が変わるためユーザー判断待ち）。
- 移動体除去ONで300枚は FP32 中間が約86GB必要で、大半の端末では容量的に不可。未対応。
- publish/SHA-256 の重なり実行、合成タイル並列化、開始前の容量・時間見積もりは、H-2 の実測後に判断。

## 6. Work350 作業環境で実行済みの検査（再実行で上書きすること）
- Node 782/782、Native 4構成×CTest 8/8、Dart 構文解析（tree-sitter-dart）エラー0、元ZIPとの差分棚卸し。
- 外部検査の指摘4件（ワーカーのキャンセル伝播、ETA表示、specialUse記述の不一致、Sanitizerリンク）は修正済み。
