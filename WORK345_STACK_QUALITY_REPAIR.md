# WORK345 天の川スタック画質修復 — 構造回帰修正

基準: `MobileStack_WORK344_fixes.zip`

## この段階で修正した内容

1. **旧Work344チェックポイント混在防止**
   - `standard_stack_background_worker.dart`
   - `algorithmRevision` を `344 -> 345` へ更新。
   - Work344の星検出/合成結果をWork345が再利用しないよう世代を切った。

2. **Hot Pixel修正でStreamed RAWを無効化していた回帰を撤回**
   - Workerから無条件の `enableHotPixelDetection: true` を2箇所削除。
   - 現行のPhase2実装ではこのフラグが `true` だとStreamed RAWを使用できず、file-backed master dark経路では例外になるため。
   - 安全なfile-backed master-dark defect-map実装が無い現状では、自動Hot Pixel検出を無理に有効化しない。

3. **高画素RAWの位置合わせを「メモリ制限 + native centroid」に変更**
   - 16MP超では従来同様、粗い星候補探索だけ2x2平均の1/2解像度で行う。
   - ただし、その半解像度の座標を最終Transformには使わない。
   - 各候補を元のフル解像度座標へ戻し、17x17以下の小さなnative-resolution ROIを再読込。
   - ROI内で星を再検出/PSF refinementし、**最終registration座標はnative resolution由来**にした。
   - これにより、Work344 fixesの `scale=1` 全面Float32 plane（高画素で大メモリ化）を避けつつ、半解像度centroidをそのまま使う旧回帰も避ける。

4. **Rolling Contributionログの誤表示を修正**
   - Rolling weighted averageのsidecarは実フレーム枚数ではなく `0/1 validity`。
   - これを `min/mean/max frame count` と表示する誤診断を廃止。
   - Rolling側は `validity coverage (%)` と明示してログ出力。
   - Classic/Kappa-Sigma側は本物のper-channel survivor countなので、そちらはexact contribution countとしてログする。

5. **Classic/Kappa-Sigma経路にもregistration diagnosticsを接続**
   - `registerAndCombineDecodedFramesAndExport` に `onFrameDiagnostics` callbackを追加。
   - デフォルトの `automaticMovingObjectRemoval=true` で通るClassic経路でも、
     `included / excludedReason / detectedStars / matchedStars / rotation / offset / RMS / weight`
     をDiagnosticLogへ出す。

6. **Noise Proxyの誤った合否判定を廃止**
   - 旧 `adjacent-green-pixel RMS -> verdict=reduced/INCREASED` を削除。
   - 位置ズレでボケただけでも「reduced」と判定できるため、品質ゲートには使えなかった。
   - 代わりにbounded sampleのsecond-difference MAD由来 high-frequency proxyをログする。
   - ログ上も「diagnostic only; lower can also mean blur」と明記し、成功判定には使わない。

7. **Rolling最終出力のTone再推定を撤回**
   - Work344 fixesで追加された「final stackからAutoTone再計算」を削除。
   - PreviewとFinalで同じreference-frame fixed tone baselineを再利用する元設計へ戻した。
   - Tone変更によってノイズが減った/増えたように見える評価混入を防止。

8. **ZIP梱包欠落を修復**
   - `.github/` と `.gitignore` を保持した状態を基準にしている。

## 検証

### Node全テスト

`bash tool/run_all_node_tests.sh`

結果:
- tests: 748
- pass: 744
- fail: 4

残った4 FAILは、修正前の元Work344でも同じ名前で失敗している既存FAIL。
今回のWORK345変更で増えた新規FAILは **0**。

既存4 FAIL:
1. `standard stack performs storage preflight before creating/staging a new job`
2. `split marking resampler preserves production bicubic sampling and green-channel extraction`
3. `file-backed focus result ownership is released on replacement and screen disposal`
4. `marking RGB stores use best-effort reverse disposal after score cleanup`

### WORK345専用契約テスト

`tool/work345_stack_quality_repair_contract.test.mjs`

7/7 PASS。

確認項目:
- algorithmRevision=345
- workerに無条件 `enableHotPixelDetection: true` が残っていない
- 高画素登録が coarse 1/2 -> native ROI centroid refinement
- Rolling validityをexact contribution countと誤表示しない
- Classic pathのregistration diagnostics
- Noise proxyが成功/失敗判定をしない
- reference fixed tone baselineを維持

## 未検証

この環境にはDart/Flutter SDKが無いため、以下は未実施。
- `dart analyze`
- `flutter test`
- Android APK build
- 実機RAW E2E

したがって、Node/source-contract上の新規回帰は0だが、**Dart compile成功までは未確認**。

## 次の修正対象

この段階では、前回検査で見つけた「構造回帰」を先に修復した。
次は画質本体として以下が残る。

1. Adaptive Dual Alignmentのper-pixel独立判断を空間正則化する
2. Local Residualが不足/zeroFieldになる場合の扱い強化
3. Registration qualityを実測RMS/PSFに基づきhard rejectできる品質ゲート
4. Kappa-Sigmaの低Contribution領域を最終品質FAILへ接続
5. FWHM/eccentricity/SNRの実RAW回帰テスト
6. file-backed master darkで安全にHot Pixel defect mapを生成する経路（必要なら）

