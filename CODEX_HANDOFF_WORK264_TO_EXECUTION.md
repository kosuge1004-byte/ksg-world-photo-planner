# MobileStack — Codex 引き継ぎ指示書

## 0. 最重要

**最新基準は Work264 です。**
このZIP内のソース全体をそのまま基準にしてください。
Work263以前の文書は履歴・根拠資料です。古い文書に「latest baseline = Work240/Work246」等の記載が残っていても、**Work264を優先**してください。

今回の目的は、新しい画質アルゴリズムを考案することではありません。
**Work248〜264で静的に修正した内容を、実際のFlutter/Android環境で検証し、失敗が確認された箇所だけを根拠付きで修正して、実機α7 III ARWで最終確認すること**です。

---

## 1. ユーザー要求・絶対条件

- 最高画質を最優先する。
- 画質を落としてビルド・メモリ・速度問題を回避しない。
- 解像度低下、品質fallback、過度な閾値緩和、処理省略でPASSさせない。
- テスト削除、skip化、期待値緩和でPASSさせない。
- 未実行をPASSと書かない。
- 実RAW未検証を「対応済み」「正常」と断定しない。
- 長時間バックグラウンド処理では進捗率、経過時間、現在工程、処理枚数、稼働状態等を維持する。**ETA/残り時間は追加しない。**
- 画質変更を行う場合は、失敗再現・原因・A/B根拠が必須。根拠のない画質パラメータ変更は禁止。

特に以下は、ビルドを通すために変更しないこと:

- RAW decode / calibration / black-white levels / saturation semantics
- demosaic
- PSF centroiding
- global similarity registration
- local residual registration
- bicubic resampling
- frame weighting
- robust small-stack MAD initialization / kappa-sigma rejection
- CFA Drizzle numerical accumulation/rejection
- Linear DNG scene-referred Float32 semantics
- DNG D65/color metadata/headroom
- negative scene-referred valuesの保持

DNGVersion / DNGBackwardVersion は 1.4.0.0 を維持。
最終スタックDNGのBaselineExposureは0 EVを維持。
Native production demosaic requiredInputRadius=4、Dart reference=5。固定値へ統一しない。

---

## 2. カメラ基準

ユーザー実機の主対象は **Sony α7 III / ILCE-7M3**。
α7 Vではありません。

Work246ではSony ARW / Nikon NEF/NRWのLibRaw fallbackが導入され、A7 IIIのcompressed 14-bitサンプルはnative検証済みです。ただし、Work248〜264の最終コードでユーザー実機ARWを再検証したわけではありません。

したがって最終判定には、**Work264由来APK + 実α7 III ARW** が必要です。

---

## 3. Work248〜264で実施済みの主要修正

### Work248 — scheduler finalization race
3入力なのに2job完了時点でdownstream stackingへ入るraceを修正。
`JobScheduler._pump()`のFuture登録順と、UI側terminal count gateを修正。
「Missing final-render profile for successful source frame 2」の主要原因。

### Work249 — production stack path audit
通常UI経路で飽和影響マスクが後段stackへ渡っていなかった問題を修正。
RAW前処理内の偽registration/stack/noise/finalステージも除去。

### Work250 — deep stack audit
混在decoded raster dimensionsの早期reject、star detection cancellation、診断stage整合を修正。

### Work251 — edge coverage
stellar transform coverage=0時にidentity sampleへfallbackしていた危険な処理を廃止。
未registration skyが端部に混入する経路をfail-closed化。

### Work252 — small stack robust rejection
3〜7枚で通常mean/sigma初期化だけでは単一強outlierを除外できない数学的問題を修正。
production Milky Way/meteorでmedian/MAD seedを有効化。

### Work253 — local residual RGB registration
standard demosaiced RGB Milky Way経路へdegree-2 local residual correctionを接続。
foreground identity branchには適用しない。

### Work254 — effective registration quality
local residual適用後の実効RMSをframe weight/diagnosticsへ反映。
global acceptance gateは変更していない。

### Work255 — PSF anchor
Gaussian refinementがcentroid.round()をpeak anchorとして使っていた問題を修正。
実local maximumをanchorとして保持。

### Work256 — local fit conservatism
local polynomial fitの最低matches/係数をproductionで2→4へ戻し、degree-2 fitは最低24 matches必要とした。

### Work257 — cancellation/temp lifecycle
Linear DNG contribution validity scanへcancellationを追加。
Navigator.push失敗時のresult temp directory ownership leakを修正。

### Work258 — streamed DNG validity
通常Milky Way Linear DNGのfull-frame validity Uint8Listを廃止し、contribution storeから128-row streamingへ変更。
α7 III 6048x4024で約23.2 MiBの追加mask常駐を除去。

### Work259 — export memory/I/O
DNG headroom scan + thumbnail scanを1 preflight passへ統合。
DNG encode内cancellationを追加。
CFA Drizzle direct-RGB DNG validityもstreaming化。

### Work260 — JPEG memory
standalone full-frame RGB8 buffer + Image.fromBytes再構築を廃止。
`img.Image` backing storeへ直接strip書込み。
JPEG encoderがUint8Listを返すため、encoded JPEG full bufferは残る。

### Work261 — final static hardening
CFA Drizzle coverage合算へcancellation。
CFA export multi-store cleanupをbest-effort化。
BMP partial output cleanup強化。

### Work262 — general TileStore cleanup
通常Milky Way / star trailのmulti-store disposeを、1件失敗しても残りをすべて試行する方式へ変更。

### Work263 — CFA Drizzle cleanup completeness
per-frame value/coverage/saturation/raw mosaic/combined storesのcleanupを完全化。
重複dispose防止、最初のcleanup errorを最後に再送出。

### Work264 — resource lifecycle final batch
以下を横断修正:
- tiled CFA Drizzle partial construction / abort cleanup
- robust CFA combine partial construction / abort cleanup
- TIFF/BigTIFF close失敗時でもpartial output deleteを試行
- meteor output/background cleanup
- focus stack / focus marking cleanup
- focus map regularizer / focus measure / high precision marking cleanup
- file-backed RAW mosaic main + saturation sidecar cleanup

**Work264では画質数値処理を変更していない。**

---

## 4. Codexが最初にすること

ソースを変更する前に、必ず以下を実行してください。

```bash
bash tool/work187_codex_preflight.sh
```

このスクリプトは少なくとも以下を要求・実行します。

- Flutter 3.44.7確認
- Java 17系環境確認
- `flutter clean`
- `flutter pub get`
- `flutter analyze`
- `flutter test`
- Android arm64 debug APK
- Android arm64 release APK
- Android native ABI exports
- Node regression suite
- native Release CTest
- native host ABI exports
- LinuxならASan/UBSan CTest

**preflightが失敗した場合、まず失敗ログを保存し、原因を分類すること。**
環境不一致をコード変更で誤魔化さないでください。

ログは `work187_logs/` に残すこと。

---

## 5. preflight PASS後の最優先実機試験

USB debugging接続済みPixelがある場合:

```bash
bash tool/work187_pixel_process_death_test.sh
```

その後、最低限以下を実施してください。

### A. Sony α7 III / ILCE-7M3 実ARW
1. 3枚 Milky Way/nightscape stack
2. 5枚 Milky Way/nightscape stack
3. 10枚前後 Milky Way/nightscape stack
4. 3枚 star trail stack
5. 5枚以上 star trail stack

確認点:
- 全input frameがdecode/phase2完了してからstack開始すること
- `CompletedJobs`不足状態でstackへ進まないこと
- 星が不自然な二重像/短い軌跡/端部複製にならないこと
- sky registrationとforeground preservationの境界に破綻がないこと
- saturated star/街灯周辺に異常な色・穴・ringがないこと
- 3〜7枚で単一異常frameがstackを支配しないこと
- local correctionで星像が悪化していないこと
- α7 III full resolutionでOOMしないこと
- cancel後に再実行可能なこと
- temp file/storeが繰り返し実行で蓄積しないこと

### B. 出力
各代表stackで:
- Linear DNG
- TIFF（設定経路があれば）
- JPEG

Linear DNGはLightroom / Camera Raw / Photoshopの少なくとも実運用対象でreadback。
確認:
- 全面白飛びしない
- highlight headroomが残る
- shadow/negative scene-referred処理が破綻しない
- transparency/coverage invalid edgeが正常
- 色が大きく転ばない
- 解像度が意図せず低下していない

---

## 6. 失敗時の修正ルール

1. 再現手順を固定する。
2. どのWorkで導入/変更された経路か特定する。
3. 原因をコード行・ログ・テストで示す。
4. 最小変更で修正する。
5. regression testを追加する。
6. `work187_codex_preflight.sh`を再実行する。
7. 該当する実機ARWケースを再実行する。
8. 画質変更を含む場合はbefore/afterの客観比較を残す。

「たぶん」「念のため」でregistration/rejection/demosaic/color/DNG数値を変更しないこと。

---

## 7. 既知の未検証境界

Work264作成環境ではFlutter/Dart SDKが無かったため、Work248以降の修正について以下は未実行です。

- `flutter analyze`
- `flutter test`
- Work264由来Android APK build
- Work264由来APKでの実α7 III ARW
- Work264由来Linear DNGのAdobe readback
- Android実機ピークメモリ測定

過去Work246時点ではFlutter tests 807/807、Android arm64 release APK、A7 III compressed RAW native decode等のPASS記録がありますが、**それをWork264のPASSとして流用しないこと。**

---

## 8. リリース判定

次をすべて満たすまで「完成」「release-complete」と書かないこと。

- current Work264 sourceでpreflight全PASS
- current sourceからarm64 release APK build PASS
- native ABI PASS
- α7 III実ARW Milky Way 3/5/10枚代表ケース PASS
- α7 III実ARW star trail代表ケース PASS
- Pixel長時間/OOM/cancel/retry/temp cleanup PASS
- representative Linear DNG Adobe readback PASS
- 画質A/Bで星像、境界、色、detail、noiseに重大退行なし

---

## 9. Codexが最終的に返すもの

1. `CODEX_WORK264_EXECUTION_RESULTS.md`
   - 環境versions
   - 実行コマンド
   - PASS/FAIL/NOT RUNを項目別記載
   - FAILの場合はログとroot cause
   - 修正ファイル一覧
   - 画質影響の有無
   - 実α7 III ARWテスト結果
   - DNG readback結果
2. `work187_logs/`
3. 修正した場合は新しいWork番号のプロジェクト全体ZIP
4. 修正不要で全gate PASSなら、その事実を明示した検証結果ZIP

---

## 10. まず読むファイル

優先順位:
1. `CODEX_HANDOFF_WORK264_TO_EXECUTION.md`（このファイル）
2. `WORK264_RESOURCE_LIFECYCLE_FINAL_BATCH.md`
3. `WORK263_CFA_DRIZZLE_CLEANUP_COMPLETENESS.md`
4. `WORK262_GENERAL_TILESTORE_CLEANUP_HARDENING.md`
5. `WORK261_FINAL_STATIC_HARDENING.md`
6. `WORK260_JPEG_MEMORY_HARDENING.md`
7. `WORK259_EXPORT_MEMORY_IO_BATCH_AUDIT.md`
8. `WORK258_STREAMED_DNG_VALIDITY_MEMORY_AUDIT.md`
9. `WORK257_EXPORT_CANCELLATION_AND_TEMP_LIFECYCLE.md`
10. `WORK256_REGISTRATION_QUALITY_BATCH_AUDIT.md`
11. `WORK255_PSF_ANCHOR_INTEGRITY.md`
12. `WORK254_FINAL_REGISTRATION_WEIGHT_INTEGRITY.md`
13. `WORK253_LOCAL_RESIDUAL_REGISTRATION_RGB.md`
14. `WORK252_SMALL_STACK_ROBUST_REJECTION.md`
15. `WORK251_EDGE_COVERAGE_INTEGRITY.md`
16. `WORK250_DEEP_STACK_PIPELINE_AUDIT.md`
17. `WORK249_STACK_PIPELINE_AUDIT_FIXES.md`
18. `WORK248_SCHEDULER_FINALIZATION_RACE_FIX.md`
19. `WORK246_SONY_NIKON_LIBRAW_SUPPORT.md`
20. `RELEASE_GATES_CURRENT.md`（historical gate list。baseline表記はWork264へ読み替える）

---

## Codexへの一文指示

**Work264を唯一の最新基準として、コード変更前に`bash tool/work187_codex_preflight.sh`を実行してください。失敗した項目だけを原因特定・最小修正し、最高画質を維持したまま全gateを再実行してください。最後にSony α7 III実ARWでMilky Way 3/5/10枚とstar trailを実機検証し、Linear DNGをAdobe系でreadbackしてください。未実行をPASS扱いせず、全結果とログと変更済み全体ZIPを返してください。**
