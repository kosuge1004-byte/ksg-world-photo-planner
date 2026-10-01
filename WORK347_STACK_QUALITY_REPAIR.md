# WORK347 天の川スタック画質修復 — Registration残差分布 / 最終星PSF品質ゲート

基準: `MobileStack_WORK346_dual-kappa-quality-repair.zip`

## 目的

WORK346までで、Dual Alignmentの孤立1px切替とKappa-SigmaのRGB別survivor/1枚survivor経路を修正した。
WORK347では、今回実機で確認された「星が線状/楕円状に伸びる」「元画像より解像度が落ちる」結果を、RMS平均値だけではなく残差分布と最終星像そのものから検出し、悪化した完成画像を正常成功として返さないことを目的とする。

## 実装内容

### 1. Local registration残差をRMSだけでなく分布として計測

対象:
- `lib/core/registration/local_residual_correction.dart`
- `lib/core/session/milky_way_pipeline.dart`

追加:
- `LocalResidualStatistics`
- RMS
- mean magnitude
- median magnitude
- p90 magnitude
- p95 magnitude
- max magnitude
- mean dx/dy
- mean residual vector magnitude
- directional coherence (0..1)

これにより、RMSが低くても一部の星だけ大きく外れているケースと、残差ベクトルが一方向へ偏るケースをログで確認できる。

### 2. Local Residual補正が「平均だけ改善してtailを悪化」する場合は採用しない

`fitLocalResidualCorrectionField()`は従来から、matched-star RMSが悪化するfitをzero fieldへ戻していた。
WORK347ではさらに、candidate local correctionについて、global-onlyと比較して以下が悪化しないことを要求する。

- RMS
- p95 residual magnitude
- max residual magnitude

いずれかが悪化した場合、そのlocal correctionを捨ててglobal transformへ戻す。

Directional coherenceは記録するが、この判定条件には使用しない。
理由: rigid least-squares fitはglobal residual mean vectorをほぼ0へ追い込むため、local fieldにそれ以下を要求すると有効なlocal correctionまでほぼ全て拒否し得るため。

### 3. 星検出へPSF FWHM測定を追加

対象:
- `lib/core/registration/gaussian_psf_centroid_refinement.dart`
- `lib/core/registration/star_detector.dart`

既存のGaussian marginal centroid refinementが使っている3点log-parabolaから、位置だけでなくGaussian sigmaを算出する。

Gaussianの対数が2次式であるため、unit pixel spacingの2階差分 `D` について:

`D = -1 / sigma^2`

したがって:

`sigma = sqrt(-1 / D)`

x/y marginalのsigmaからequivalent circular sigmaを作り、

`FWHM = 2.354820045 * sigma`

を `DetectedStar.psfFwhmPx` として保持する。

広いsecond-moment windowではなくピーク中央3サンプルのcurvatureを使うため、stack側で背景ノイズが減って微弱wingが見えるようになっただけでFWHMが大きくなるバイアスを避ける設計。

Gaussian fitが成立しない星は `psfFwhmPx=null` とし、無理に幅を捏造しない。

### 4. PSF widthをprocess-death checkpointにも保存

対象:
- `standard_stack_background_worker.dart`
- `meteor_candidate_analysis_checkpoint.dart`

compact star feature JSONに `psfFwhmPx` をoptionalで保存/復元する。
旧checkpointはoptional readなので読み込み互換性を維持するが、standard stack本体はalgorithm revision更新で旧画質checkpointを使用しない。

### 5. 最終StackとReferenceの同一星を比較するquality gateを追加

新規:
- `lib/core/registration/star_psf_quality.dart`

処理:
1. 最終stackを再度registration star detectorで測定
2. 最終画像はReference座標gridなので、Reference星とfinal星を2px以内で1対1nearest matching
3. 共通星についてfinal/reference FWHM ratioを計算
4. 同一星のroundness差も計測

既定安全閾値:
- minimum measured pairs: 8
- median FWHM ratio <= 1.12
- p90 FWHM ratio <= 1.30（ただしmedian > 1.05の場合のみtail単独FAIL）
- median roundness increase <= 0.12

根拠:
既存bicubic resamplerのsynthetic Gaussian worst-case testではFWHM wideningは約103%。
WORK347の12%/30%閾値は、3%という既存単体補間誤差より十分広い安全marginを取りつつ、今回のような明確な線状化/楕円化を正常成功させないための暫定safety limit。

これは「12%悪化しても理想」という意味ではない。
実RAW A/B結果が得られた後にさらに厳しく調整可能。

### 6. Referenceで測定可能なのにFinalで星が消えた場合はfail closed

Reference側にPSF測定可能な星が8個以上あるのに、final stackで共通PSF pairが8個未満しか得られない場合、quality gateを無効化せずFAILする。

大きなblurで星検出自体が崩れた時に「測定不能だからPASS」となる抜け道を防ぐ。

Reference自体に8星未満しかPSF測定値が無い場合は、PSF gateは `unverified` 相当として処理を止めない。ログで不足を明示する。

### 7. Classic/Kappa-SigmaとRolling Weighted Averageの両方へ適用

Classic path:
- full stackのRGB storeをcommitしてreadableにした後、PSF gateを実行
- gate PASS後にcontribution storeをcommitし、PipelineResultを返す
- FAIL時は正常結果を返さない

Rolling path:
- `finalizeRollingWeightedAverageWithContributions()`直後
- `postDecodeCheckpoints.publishCommitted()`より前にPSF gateを実行
- FAIL時はfinal RGB/contribution storeを削除してrethrow
- つまり品質FAIL画像を「finalized checkpoint」として再利用しない

### 8. Checkpoint世代更新

`standard_stack_background_worker.dart`

- `algorithmRevision: 346 -> 347`

PSF測定/quality gate/local residual selection semanticsが変わるため、WORK346以前のpost-decode/compact/rolling checkpointと混在させない。

### 9. Registration diagnostic log拡張

Rolling / Classic双方で追加:
- `globalRmsResidualPx`
- `residualP95Px`
- `residualMaxPx`
- `residualDirectionalCoherence`
- `localCorrectionApplied`

最終PSF log:
- reference/final detected star count
- reference/final PSF measurable count
- position matched count
- measured PSF pair count
- median FWHM ratio
- p90 FWHM ratio
- median roundness delta
- pass/fail reason

## テスト

### WORK347専用Node/source-contract

`node --test tool/work347_registration_psf_quality_contract.test.mjs`

結果:
- tests: 8
- pass: 8
- fail: 0

含むbehavioral mirror:
- sigma=1.5 Gaussianの3点log curvatureからsigmaを誤差1e-12未満で復元
- FWHM式確認
- 3%程度の小変化はPASS
- systematic 20% broadeningはFAIL
- Referenceで十分測定可能なのにfinal pairが不足した場合はFAIL

### 全Node suite

`bash tool/run_all_node_tests.sh`

結果:
- tests: 763
- pass: 759
- fail: 4

WORK346:
- tests: 755
- pass: 751
- fail: 4

したがってWORK347による新規Node FAILは **0**。

残存4 FAILはWORK345/346から存在する同一の既存FAIL:
1. `standard stack performs storage preflight before creating/staging a new job`
2. `split marking resampler preserves production bicubic sampling and green-channel extraction`
3. `file-backed focus result ownership is released on replacement and screen disposal`
4. `marking RGB stores use best-effort reverse disposal after score cleanup`

### Dart test追加

追加/拡張:
- `test/star_psf_quality_test.dart`
- `test/local_residual_statistics_test.dart`
- `test/gaussian_psf_centroid_refinement_test.dart` にsigma復元assert追加

この環境にDart/Flutter SDKが無いため未実行。

## 静的確認

変更主要Dartファイルについて `()`, `{}`, `[]` の対応数一致を確認。
Node source-contractで主要配線を確認。

ただしDart compiler/analyzerによる構文・型検査の代替ではない。

## 未検証 / 次段階

未検証:
- `dart analyze`
- `flutter test`
- Android APK build
- Sony実RAW E2E
- PSF gateの実RAW閾値calibration

次に確認する実機ログ:
- final PSF `medianFwhmRatio`
- `p90FwhmRatio`
- `medianRoundnessDelta`
- frameごとの `globalRmsResidualPx / rmsResidualPx / p95 / max`
- `residualDirectionalCoherence`
- `localCorrectionApplied`

次の修正候補:
1. 実RAWデータから、final gateで落ちる前に悪いframeを事前除外できるregistration hard gateをcalibrate
2. residualの画面内spatial coverage（星が一部領域に偏っていないか）を追加
3. flat-sky領域を分離したrobust noise/SNR測定
4. PSF quality gateのthresholdを実RAW A/Bから再調整

## 重要

WORK347は「位置合わせが多少悪くても重みを下げて最後まで出す」だけではなく、最終画像の星像がReferenceより明確に悪化した場合に成功扱いしないための最初のhard output quality gateである。

ただしPSF閾値はまだ実RAWで校正されていないため、実機テストではPASS/FAILだけでなく各数値ログを必ず保存すること。
