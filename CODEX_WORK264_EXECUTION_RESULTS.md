# MobileStack Work264 実行結果

- 実行日: 2026-08-28 (Asia/Tokyo)
- 入力基準: `MobileStack_Codex_Handoff_Work264.zip`
- 入力ZIP SHA-256: `5E6D177B3E7629409EF817C82F859E21AE6C2CA0D779FF1FED6ACF1EF071AA47`
- 修正後成果物番号: Work265
- 判定: **検証可能なローカル／エミュレータgateはPASS。物理Pixel、複数枚α7 III stack、Adobe readbackはNOT RUNのためrelease-completeではない。**

## 1. 実行環境

| 項目 | 実体 |
|---|---|
| OS | Windows / PowerShell |
| Flutter | 3.44.7 |
| Dart | 3.12.2 |
| Java | Microsoft OpenJDK 21.0.12 |
| Android SDK | API 36 |
| Android NDK | 28.2.13676358 |
| CMake / CTest | 3.22.1 |
| Node.js | 24.18.0 |
| 接続端末 | Android Emulator `emulator-5554`, API 36, x86_64 |
| 物理Pixel | 未接続 |
| Bash | 未導入 |
| Windows host C/C++ toolchain | Visual Studio / NMake / host compiler未導入 |

## 2. 事前検査

指示どおり、ソース変更前に次を最初に実行した。

```text
bash tool/work187_codex_preflight.sh
```

結果はFAIL（`bash` command not found）。Windows環境にBashが無いためで、コード不良ではない。以降は同スクリプトの各gateをPowerShellから個別実行し、ログを `work187_logs/` に保存した。

変更前 `flutter analyze` で次を再現した。

- `file_backed_linear_raw_mosaic_store.dart`: `Object?` を `Error.throwWithStackTrace` へ渡すコンパイルエラー。
- `milky_way_pipeline.dart`: unnecessary braces lint 1件。

変更前Node全試験では8件FAIL。Work258/259/264で既に変更されたstreaming／cleanup実装に対し、source-contract testがWork257以前の識別子や存在しないcheckpointを要求していた。

## 3. 実装した最小修正

### production source

- `lib/core/image/file_backed_linear_raw_mosaic_store.dart`
  - 既にnull検査済みの最初のcleanup error／stack traceを非nullとして再送出するよう修正。
- `lib/core/pipeline/milky_way_pipeline.dart`
  - 文字列内容を変えずlintのみ修正。

RAW decode、black/white level、saturation、demosaic、registration、rejection、CFA Drizzle、DNG色／headroomの数値処理は変更していない。

### regression / contract tests

- `test/file_backed_saturation_mask_test.dart`
  - RAW mosaic本体とsaturation sidecarの両方を `dispose()` が削除する回帰試験を追加。
- `integration_test/real_raw_camera_corpus_test.dart`
  - opt-in実ARW/NEF/NRW corpusをproduction FFIで全画素decodeし、形式、寸法、画素数、active area、black/white level、有限非負sampleをファイル単位で検証する試験を追加。
- 次のNode source-contractを現在のWork264実装名／streaming構造へ更新。期待条件の削除、skip化、品質閾値緩和は行っていない。
  - `tool/quality/reference_viability_quality.test.mjs`
  - `tool/quality/cfa_drizzle_dng_validity_source_contract.test.mjs`
  - `tool/quality/current_handoff_baseline_exposure_contract.test.mjs`
  - `tool/quality/focus_stack_dng_mask_memory_contract.test.mjs`
  - `tool/quality/focus_temp_cleanup_order_contract.test.mjs`
  - `tool/quality/linear_dng_float_range_source_contract.test.mjs`
  - `tool/quality/linear_dng_transparency_export_contract.test.mjs`

## 4. 自動試験結果

| Gate | 結果 | 証拠 |
|---|---|---|
| 最終 `flutter analyze` | PASS、問題0件 | `work187_logs/28_flutter_analyze_final.log` |
| focused sidecar cleanup regression | PASS、3/3 | `work187_logs/05_focused_regression_test.log` |
| Flutter unit/widget全試験 | PASS、834/834 | `work187_logs/26_flutter_test_full_final.log` |
| Node全試験 | PASS、671/671、135 files | `work187_logs/27_node_tests_full_final.log` |
| Android arm64 debug build | PASS | `work187_logs/10_android_arm64_debug_exact.log` |
| Android arm64 release build | PASS、23.9MB | `work187_logs/29_android_arm64_release_final.log` |
| release native ABI exports | PASS、expected 10 / actual 10 | `work187_logs/31_android_arm64_release_final_abi.log` |
| Android x86_64 native FFI conformance | PASS、23/23 | `work187_logs/16_emulator_raw_ffi_conformance.log` |
| host native CMake / CTest | NOT RUN | configureがNMake／host C/C++ compiler不在でFAIL。`work187_logs/15_native_release_configure.log` |
| ASan / UBSan | NOT RUN | repository gateがLinux限定、実行環境はWindows |

最初のrelease試行に限り `--no-pub` を追加したため、古いintegration plugin参照で失敗した。この引数はWork187の正規コマンドに無く、正規コマンドを再実行してPASSした。プロジェクトsourceの不良としては扱っていない。

## 5. 実RAW decode試験

すべてAndroid API 36 x86_64 emulator上で、最終production native libraryと `FfiRawNativeBridge` を使用した。単なるheader probeではなく、全sensor planeをFP32へdecodeして検証した。

### Sony — PASS

| カメラ | 実ファイル結果 |
|---|---|
| α7 III / ILCE-7M3 | compressed ARW、6048×4024、PASS |
| α7 IV / ILCE-7M4 | compressed 7040×4688、uncompressed 7040×4688、APS-C compressed 4736×3132、lossless compressed Large 7168×5120、PASS |
| α1 / ILCE-1 | 8672×5784、PASS |
| α6400 / ILCE-6400 | 6048×4024、PASS |
| α6700 / ILCE-6700 | 6656×4608、PASS |
| α7C / ILCE-7C | 6048×4024、PASS |
| α7C II / ILCE-7CM2 | 7040×4688、PASS |
| α7CR / ILCE-7CR | 9600×6376、PASS |
| α7R IVA / ILCE-7RM4A | 9600×6376、PASS |
| α7R V / ILCE-7RM5 | 9600×6376、PASS |
| α7S III / ILCE-7SM3 | 4288×2848、PASS |
| α9 III / ILCE-9M3 | 6048×4020、PASS |
| FX30 / ILME-FX30 | 6272×4168、PASS |
| ZV-E1 | 4608×3072、PASS |
| ZV-E10 | 6048×4024、PASS |
| RX100 VII / DSC-RX100M7 | 5504×3672、PASS |

証拠:

- `work187_logs/17_real_sony_a7iii_arw_emulator.log`
- `work187_logs/22_real_sony_current_14_camera_corpus_emulator.log`
- `work187_logs/23_real_sony_a7iv_5_format_corpus_emulator.log`
- `work187_logs/24_real_sony_a7iv_uncompressed_emulator.log`

### Sony — 明示的非対応

- α7 IV lossless compressed Medium: FAIL、native=4004。
- ファイルはsingle-plane 2x2 BayerではなくYCC/pseudo-RAW系。判定を外すとCFA処理の品質契約を壊すため、fallbackや強制decodeは追加していない。
- Medium/Small pseudo-RAWを「対応」とは主張しない。

### Nikon — PASS

| カメラ | 実ファイル結果 |
|---|---|
| D750 | 12bit compressed 6032×4032、14bit lossless 6032×4032、PASS |
| D800 | 14bit compressed 7378×4924、12bit uncompressed 7378×4924、PASS |
| Z 8 | 14bit lossless 8280×5520、PASS |
| Coolpix P7000 | NRW 3664×2742、PASS |

証拠:

- `work187_logs/18_real_nikon_z8_lossless_emulator.log`
- `work187_logs/25_real_nikon_supported_6_file_corpus_emulator.log`

### Nikon — 明示的非対応

- Z 8 High Efficiency Low: FAIL、native=4007。
- bundled LibRaw 0.22.2のNikon HE/HE* unpackerは未実装であり、JPEG XS payloadをsensor Bayer planeとして返せない。
- 品質fallbackを追加せず、HE/HE*を非対応として維持した。
- 証拠: `work187_logs/19_real_nikon_z8_high_efficiency_low_emulator.log`

### 実ファイル試験の範囲に関する注意

上表は手元に実ファイルが存在した機種／形式の結果である。Sony／Nikon全発売機種や、2026年時点の全現行モデルを網羅したという意味ではない。bundled LibRawのmodel listにあるだけで実ファイルが無い機種は、既存matrixどおり `SAMPLE_MISSING` であり対応済みとは断定しない。

## 6. 物理実機・画質readback

| 項目 | 結果 | 理由 |
|---|---|---|
| Pixel process-death / long-run | NOT RUN | 物理Pixel未接続 |
| α7 III 3/5/10枚 Milky Way stack | NOT RUN | 同一撮影列の実ARW複数枚と物理Pixelが無い |
| α7 III 3/5枚以上 star trail stack | NOT RUN | 同上 |
| α7 III full-resolution peak memory / OOM | NOT RUN | 物理Pixel未接続 |
| cancel / retry / temp accumulation実機確認 | NOT RUN | 物理Pixel未接続 |
| Linear DNG Adobe Lightroom / Camera Raw / Photoshop readback | NOT RUN | Adobe実運用環境と代表stack出力が無い |
| 画質A/B（星像、境界、色、detail、noise） | NOT RUN | 実stackとAdobe readbackが無い |

α7 III単一ARWのfull sensor decodeはPASSしたが、これを複数枚stackや物理実機試験のPASSへ読み替えていない。

## 7. APK

- build command:

```text
flutter build apk --release --target-platform android-arm64 --dart-define=MOBILE_STACK_ENABLE_DNG_METADATA=true
```

- application version: `0.8.6+160`
- output: `build/app/outputs/flutter-apk/app-release.apk`
- SHA-256: `A86440B2CEC137D4674CF8FE67ACB05BCAC3F6E584264AE0066F5BFEEEFBDB4A`
- native arm64 library: `lib/arm64-v8a/libmobile_stack_raw.so`
- native ABI: 10/10 expected exports、missing 0、unexpected 0

## 8. 最終判定

実行可能だった静的解析、Flutter、Node、Android build、APK ABI、emulator native conformance、手元のSony/Nikon実RAW decodeはPASSした。画質数値を変更する修正は無い。

ただし、Work264のrelease gateが要求する物理Pixel、α7 III 3/5/10枚stack、star trail、長時間/OOM/cancel/retry、Adobe Linear DNG readbackはNOT RUNである。そのため本成果物を **release-complete／完成** とは判定しない。
