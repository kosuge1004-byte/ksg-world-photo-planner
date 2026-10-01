# Work364 → Codex 実行引き継ぎ（APK化・検証）

最新基準は Work364。Version: 0.8.46+202（pubspec.yaml が正本、mobilestack_work: 364）。
最終スタックDNGのBaselineExposureは0 EVを維持。
入力: MobileStack_SOURCE_0_8_46_202_WORK364.zip（Work350 = 0.8.45+201 からの差分。差分一覧は WORK351_364_CHANGED_FILES.txt、総覧は WORK351_358_SUMMARY.md）。

方針（継続）:
- 画質・処理結果精度を落とす選択はしない。**既定設定の出力は Work350 とビット一致が条件**。高画質化の新機能はすべて既定OFF（設定で選択）。
- Google Play で配布可能であること（ProcessorService は mediaProcessing のまま）。
- 長時間処理画面に ETA/残り時間を表示しない。既定経路の工程文言は Work350 と同一（新工程名は新機能ON時のみ）。
- 実行した検査と未実行の検査を区別する。過去版のPASSを流用しない。

---------------------------------------------------------------------------
## 1. 変更（詳細は各 WORK35x/36x_*.md）

| Work | 区分 | 内容 | 既定 |
|---|---|---|---|
| 351 | 天の川 | 全視野の高精度位置合わせ（ホモグラフィ、格子状の星選択、隣接フレーム起点、被覆ゲート、時系列中央の基準） | OFF |
| 352 | 共通 | mediaProcessing 上限後の再開（:processor で透明 Activity を一瞬表示）、上限時文言 | 常時 |
| 353 | 深度合成 | 写真間の明るさ・色の自動整合 | OFF |
| 354 | 深度合成 | ピラミッド（多重解像度）合成 | OFF |
| 355 | 星の軌跡 | ホットピクセル自動除去（時間方向判定） | OFF |
| 356 | 星の軌跡 | 流れ星を残す判定／空の背景を平均／地上部を全フレーム平均 | OFF |
| 357 | 流星 | 背景になじませる足し込み合成（OFF）、放射点との整合表示（常時・表示のみ） | 一部OFF |
| 358 | 共通 | 進捗通知のプラットフォーム呼び出しに3秒上限、WorkManager 進捗は WorkManager ホスト時のみ、ピラミッド合成の進捗 | 常時 |
| 359 | 共通 | 上限停止時「タップしてアプリを開くと再開」通知（新チャンネル stack_attention、タップで起動） | 常時 |
| 360 | 共通 | 保存データ検証の SHA-256 をネイティブ化（同一ハッシュ値） | 常時 |
| 361 | 天の川 | 合成（κ-σ）のタイル並列化（ワーカー Isolate、タイル順書込、メモリ予算で自動調整） | 常時 |
| 362 | 共通 | RAW ストリーム経路の前提条件を診断ログに記録 | 常時 |
| 363 | 共通 | 診断ログをテキストファイルで共有、前回分のログを保持 | 常時 |
| 364 | 星の軌跡 | 光跡候補のないフレームを解析中に先行合成し2回目のデコードを削減（±0同値検出時は従来順に自動切替） | 常時 |

常時有効の変更は出力画像に影響しない設計（352/358/359/362/363 は画像処理外、360 は同一ハッシュ値、361 は同一関数のタイル並列、364 は順序非依存の最大値＋±0同値フォールバック）。

## 2. 変更禁止（不変条件）
- kappa=2.5、maximumIterations=3、robustSmallStackInitialization、synchronizeRgbRejection、FP32、元解像度、BaselineExposure 0 EV。
- ProcessorService の foregroundServiceType は mediaProcessing。specialUse にしない。SupervisorService の specialUse は維持。
- ETA/残り時間/etaMin をUI・ログに追加しない。
- テストが落ちた場合に、閾値・期待値・比較方法を緩めて通さない。原因を報告する。
- 新機能の既定値（OFF）を変更しない（実機での画質比較後にユーザーが判断）。

## 3. 実行手順（この順で。各段の合格基準を満たさなければ次へ進まない）

### A. Node 契約
```
bash tool/run_all_node_tests.sh
```
合格: 872/872（Work364 作業環境で実行済み。Work350 の 782 件はすべて含まれ、変更していない。Work355 契約の1件のみ Work356 の変数名変更に合わせて同一内容で更新）。

### B. Flutter 静的解析
```
flutter pub get
flutter analyze
```
合格: 指摘0。Work364 作業環境に Flutter/Dart SDK が無く**型検査は未実施**。引数名・識別子・変数スコープ・final 規則は自作スクリプトで照合済み。指摘が出た場合は最小修正し記録。

### C. Flutter テスト
```
flutter test test/milky_way_parallel_combine_equivalence_test.dart test/tiled_kappa_sigma_combiner_cache_equivalence_test.dart
flutter test
```
合格: 前者は全件PASS（並列合成と逐次合成のバイト一致。落ちたら APK 作成に進まず報告）。新規: guided_field_registration / focus_photometric_normalization / focus_pyramid_blend / star_trail_hot_pixels / star_trail_mean_background / meteor_additive_composite / milky_way_parallel_combine_equivalence の各 _test.dart。

### D. Native
```
cmake -S native -B build && cmake --build build && ctest --test-dir build
```
合格: 9/9（Work350 の 8 件＋mobile_stack_util_sha256_test）。Work364 作業環境で GCC Release 構成を実行済み（9/9）。`tool/check_native_exports.sh`: 13 exports（Work350 と同一。新関数 mobile_stack_util_* は検査対象外の接頭辞）。Sanitizer 構成は未実行。

### E. リリース APK
```
flutter build apk --release --target-platform android-arm64 --dart-define=MOBILE_STACK_ENABLE_DNG_METADATA=true
```
成果物名: MobileStack_0.8.46_202_WORK364_arm64_release.apk

### F. APK 検証
- versionName 0.8.46 / versionCode 202、ABI arm64-v8a のみ、署名検証。
- マージ後 Manifest: ProcessorService=mediaProcessing、ProcessorForegroundResetActivity が android:process=":processor"・exported=false。
- libmobile_stack_raw.so に mobile_stack_util_sha256_file が存在。

### G. エミュレータ起動スモーク
install → cold launch → fatal crash なし。

### H. 実機（接続時のみ。無ければ「未実行」）
1. **既定設定（新機能すべてOFF）**で、天の川・星の軌跡・流星・深度合成を Work350 APK と同一入力で処理し、最終 DNG の SHA-256 が一致すること（必須）。
2. 星の軌跡: ログの `starTrail fused path enabled` / `starTrail fused premerge frame=` 件数、2回目のデコード枚数、総時間。処理中に強制終了→再開して完走し、1. と一致すること。
3. 天の川: `stage: stackCombination workers=`、`standard-combine ... msPerTile=`、`milkyDecodedCache publish ... elapsedMs=`、`rawPath stream-precondition` の内容。
4. FGS 上限: `device_config put activity_manager media_processing_fgs_timeout_duration 60000` で上限到達 → 通知（音・タップで起動）→ アプリ起動で再開（logcat `Requested :processor foreground reset`）。終了後 `device_config delete ...`。
5. 診断ログ共有: 設定と失敗画面から2ファイル（直近・前回）が共有できること。
6. 新機能ONの画質比較（ユーザー判断用。合否基準なし）。

## 4. 記録
WORK364_VALIDATION_RESULTS.json を更新（実行していない項目は notRun、PASS と書かない）。allMandatoryReleaseGatesComplete は H まで完了しない限り false。

## 5. 既知の制約・判断待ち（Codex は変更しない。報告のみ）
- Work352 の再開方式は、Android が lastTopTime を記録する時点に依存し、実機でのみ確認可能。
- Work361 の並列ワーカー内では前景二重位置合わせ中の失敗工程ラベルを切り替えない（結果に影響なし）。
- Work364 は星の軌跡の再開ロジック（premerge / fusedRolling 段階）に手を入れている。H-2 の再開テストを重点的に。
- 流星モードは背景に候補のない全フレームを使うため、枚数が多いと長時間になる（未対応、実測待ち）。
- 新機能（351/353–357）の既定値はOFF。実機の画質比較後にユーザー判断。
