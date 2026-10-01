# WORK346 天の川スタック画質修復 — Dual Alignment / Kappa-Sigma 品質対策

基準: `MobileStack_WORK345_stack-quality-repair.zip`

## この段階で実装した内容

1. **Adaptive Dual Alignmentの孤立1px切替を抑制**
   - `lib/core/registration/adaptive_dual_alignment_resampler.dart`
   - 従来は各画素が完全独立に `stellar` / `identity` を選択していた。
   - WORK346では、identity候補が実際に採用されるために、8近傍に少なくとも1つidentity候補を要求する。
   - これは多数決や意味セグメンテーションではなく、孤立したsalt-and-pepper切替だけを除去する最小の空間正則化。
   - requested tile/band境界で判定結果が変わらないよう、判定時は1px haloを追加して評価し、最後に要求領域へcropする。
   - stellar transformがcoverage外の画素は従来通りfail closedで、identityで穴埋めしない。

2. **Kappa-SigmaのRGB独立rejectによる色斑を抑制**
   - `lib/core/stacking/tiled_kappa_sigma_combiner.dart`
   - 新規オプション `synchronizeRgbRejection` を追加（低レベルAPIの既定値はfalseで後方互換）。
   - true時、最終合成では1フレーム/1画素をRGB一体の観測として扱い、3chすべてがsurviveした場合のみ3chまとめて採用する。
   - これにより R=5枚 / G=4枚 / B=2枚 のように、異なるsource-frame集合から1つの色画素を組み立てる経路を止めた。

3. **rejectが1枚生存まで崩す経路を止めた**
   - Milky Way経路では、登録済みフレームが2枚以上なら `minimumSurvivingFrames=2`。
   - RGB同期後の共通survivorが2枚未満になる画素では、その画素だけrejectを無効化して全covered frameへfallbackする。
   - したがって「Kappa-Sigmaが原因で1枚だけ残り、スタックなのにノイズ低減ゼロ」という状態を避ける。
   - なお幾何学的な画面端など、そもそもcoverageが1枚しか存在しない場所は正直にcount=1のまま残る。

4. **Milky Way本番経路でRGB同期rejectを有効化**
   - `lib/core/session/milky_way_pipeline.dart`
   - `synchronizeRgbRejection: true`
   - `minimumSurvivingFrames: includedIndices.length >= 2 ? 2 : 1`
   - checkpoint bindInputsにもこの2設定を追加。

5. **Checkpoint世代を346へ更新**
   - `standard_stack_background_worker.dart`
   - `algorithmRevision: 345 -> 346`
   - WORK345以前の合成checkpointを新しいstack mathで誤再利用しない。

6. **Contribution診断を強化**
   - exact contribution countログに以下を追加。
     - `rgbCountMismatchPixels`
     - `pixelsAnyChannelBelow2`
     - `pixelsAnyChannelZero`
   - いずれも画素数と割合を出力。
   - 合否判定にはまだ使わず、実機RAWの実測値を得るための診断。

7. **将来CI向けDartテストを追加**
   - `test/tiled_kappa_sigma_combiner_test.dart`
     - RGB同期rejectで3chのcontribution countが一致すること
     - RGB共通survivorがminimum未満なら全coverageへfallbackすること
   - `test/adaptive_dual_alignment_resampler_test.dart`
     - 孤立identity candidateを抑制すること
     - requested tile境界の外側1pxにある隣接candidateをhaloで認識できること

## Node/source-contract検証

`bash tool/run_all_node_tests.sh`

結果:
- tests: 755
- pass: 751
- fail: 4

4 FAILはWORK345時点から存在する既存FAILと同一。WORK346による新規Node FAILは **0**。

既存4 FAIL:
1. `standard stack performs storage preflight before creating/staging a new job`
2. `split marking resampler preserves production bicubic sampling and green-channel extraction`
3. `file-backed focus result ownership is released on replacement and screen disposal`
4. `marking RGB stores use best-effort reverse disposal after score cleanup`

WORK346専用契約テスト: 7/7 PASS。
WORK345契約テストも revision>=345 として更新し、7/7 PASS。

## 重要な設計判断

### Dual Alignment
今回は、意味的なsky/foreground segmentationや多数決maskまでは入れていない。実RAW検証なしで強い領域処理を入れると、細い木・枝・稜線など正常な前景を消す危険があるため。

そこで、確実に問題だった「独立1px判断」をまず止め、**孤立したidentity decisionだけを除去**する最小変更に留めた。

### Kappa-Sigma
RGB別々のsource-frame集合を使うことは色斑の直接的な構造要因になるため、Milky WayではRGBを一体観測として扱う。

ただし共通survivorが不足する場合、根拠のない画素補間や1枚生存を選ばず、全covered frameへ戻す。移動体除去能力より画質・S/N保持を優先した。

## 未検証

この実行環境にはDart/Flutter SDKが無いため、以下は未実施。
- `dart analyze`
- `flutter test`
- Android APK build
- 実機RAW E2E

追加したDartテストはソースに含めたが、この環境では実行できていない。
括弧/波括弧の対応は変更対象ファイルで一致を確認済み。

## 次の修正対象

1. 実機ログで `rgbCountMismatchPixels` が0へ収束することを確認
2. `pixelsAnyChannelBelow2` が主に幾何学的edgeに限定されるか確認
3. Registration RMSだけでなくmatched-star residualの分布/方向性を記録し、線状化を検出できるquality gateへ進む
4. Local Residual `fitted=false` の頻度と、global-only時の残差を実測
5. 最終画像の星PSF/FWHM/eccentricityをReferenceと比較する実RAW quality gate
6. flat-sky領域を分離したrobust noise/SNR測定

WORK346では、前回残っていた「Dual Alignmentの画素モザイク化」と「Kappa-SigmaのRGB別生存/1枚生存」の2経路を優先して修正した。
