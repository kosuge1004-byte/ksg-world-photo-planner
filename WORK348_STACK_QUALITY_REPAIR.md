# WORK348 天の川スタック画質修復 — Registration Hard Gate / Flat-sky Noise Gate

基準: `MobileStack_WORK347_registration-psf-quality-gate.zip`

## 目的

WORK347で最終PSF品質ゲートを追加したが、悪いフレームは最終画像完成後に初めて検出される構造が残っていた。また旧high-frequency proxyは全画面を対象とするため、星・前景・エッジ・ぼけをノイズと混同できた。

WORK348では、(1) 合成前に位置合わせ品質が悪いフレームを完全除外するHard Gate、(2) 星の存在する空領域に限定した同一座標のrobust noise比較を追加する。

## 実装内容

### 1. Registration Hard Gate

新規:
- `lib/core/registration/registration_hard_quality.dart`

各非Referenceフレームについて、Local Residual補正後に実際に使用される残差分布を評価し、品質不合格ならWeightを下げて残すのではなく`included=false`として完全除外する。

RMS上限は固定px値を新設せず、WORK347の最終PSF安全上限`median FWHM ratio <= 1.12`から導出する。

等方Gaussian近似で、Reference PSF sigmaを`s`、1軸registration jitterを`j`とすると、合成後sigmaは`sqrt(s^2+j^2)`。2D radial RMSは`sqrt(2)*j`、FWHMは`2.354820045*s`なので、許容radial RMS/FWHMは:

`(sqrt(2)/2.354820045) * sqrt(1.12^2 - 1) = 0.3029115458...`

したがってReferenceでPSF幅を5星以上測定できる場合:

`registration RMS limit = min(refined match radius, median reference FWHM * 0.3029115458...)`

追加tail条件:
- p95 residual <= refined match radius = `max(0.75, toleranceRadius/2)`
- max residual <= original match radius = `toleranceRadius`

PSF幅を十分測れない場合は、従来estimatorのmatching radius由来の上限へfallbackし、根拠のない固定値を作らない。

このHard GateはRollingの`buildMilkyWayRegistrationPlan()`とClassic/Kappa-Sigmaのregistration loopの両方へ適用。

### 2. Match spatial coverage診断

同ファイルに`RegistrationSpatialCoverage`を追加。

記録:
- matched reference starsのX方向span/image width
- Y方向span/image height
- 4象限のうち何象限にmatchが存在するか

現時点では実RAWでの閾値校正が無いため、coverage単独ではFAILさせない。ログ診断のみ。

### 3. Frame diagnostics拡張

`MilkyWayFrameDiagnostics`へ追加:
- `registrationRmsLimit`
- `matchSpanXFraction`
- `matchSpanYFraction`
- `matchOccupiedQuadrants`

Hard Gateで除外されたフレームも、RMS/p95/max/適用RMS limit/coverageを保持する。

### 4. Flat-sky robust noise measurement

新規:
- `lib/core/registration/flat_sky_noise_quality.dart`

旧全画面proxyを完成品質判定には使用しない。

方式:
1. Referenceで検出された星をanchorに96px gridのcandidate tileを作る
2. Reference星の周囲（最低4px、または2×FWHM）を除外
3. 各2×2 blockでG channelのcheckerboard係数
   `0.5 * (g00 + g11 - g10 - g01)`
   を計算
4. この係数は平面勾配を相殺し、white noiseに対してunit gain
5. MAD×1.4826でtile sigmaを得る
6. Referenceで最も平坦な最大8 tileを選択
7. Final Stackでも**全く同じ座標**を計測
8. tile sigmaのmedianでReference/Finalを比較

ReferenceとFinalで別領域を選ぶcherry-pickはしない。

### 5. Flat-sky Noise Gate

測定条件:
- selected tile >= 3
- checkerboard coefficient samples >= 1024

十分な測定ができない場合は`unverified`扱いで処理を止めない。

十分測定できた場合:
- `finalSigma/referenceSigma <= 1.10` を要求

10%は「10%増加が良い」という意味ではなく、実RAW未校正の測定scatter用fail-only margin。正常スタックではrandom sky noiseは低下すべきため、10%以上増加した結果を成功扱いしない。

Blurでsigmaが下がって見える抜け道は、WORK347のPSF Gateを先にPASSする必要があるため、Noise Gate単独で画質成功とは判定しない。

### 6. Classic / Rolling双方へ適用

Classic:
- Final RGB commit
- WORK347 PSF gate
- WORK348 flat-sky noise gate
- contribution commit
- 成功返却

Rolling:
- rolling finalization
- WORK347 PSF gate
- WORK348 flat-sky noise gate
- その後にfinalized checkpoint publish

Noise/PSF FAIL画像をfinalized checkpointとして再利用しない。

### 7. Checkpoint revision

`algorithmRevision: 347 -> 348`

WORK347以前のpost-decode/rolling/compact stateとの混在を防止。

### 8. WORK347 contractの世代追従修正

`tool/work347_registration_psf_quality_contract.test.mjs`のrevision検査を「347固定」から「>=347」へ変更。
WORK348で正当にrevisionを上げてもWORK347の意味（WORK346を無効化する）が失われないため。

## テスト

### WORK348専用Node test

`node --test tool/work348_registration_noise_quality_contract.test.mjs`

- tests: 8
- pass: 8
- fail: 0

確認内容:
- 1.12 FWHM budget -> 0.3029115458×FWHM RMS derivation
- Hard Gateがweight計算前に配線される
- p95/maxが既存matching radiusを使用
- spatial coverageが診断のみ
- checkerboard係数のwhite-noise gain = 1
- Reference星周囲除外 + same-coordinate final comparison
- PSF gate後にNoise gateがClassic/Rolling双方で実行
- algorithmRevision 348

### 全Node suite

`bash tool/run_all_node_tests.sh`

- tests: 771
- pass: 767
- fail: 4

WORK347:
- tests: 763
- pass: 759
- fail: 4

したがってWORK348による新規FAILは **0**。

残存4 FAILはWORK345〜347から継続する既存4件:
1. `standard stack performs storage preflight before creating/staging a new job`
2. `split marking resampler preserves production bicubic sampling and green-channel extraction`
3. `file-backed focus result ownership is released on replacement and screen disposal`
4. `marking RGB stores use best-effort reverse disposal after score cleanup`

## 静的確認

主要変更Dartファイル:
- `milky_way_pipeline.dart`
- `standard_stack_background_worker.dart`
- `registration_hard_quality.dart`
- `flat_sky_noise_quality.dart`

について`()` `{}` `[]`の対応数一致を確認。

## 未検証

この環境にDart/Flutter SDKが無いため以下は未実行:
- `dart analyze`
- `flutter test`
- APK build
- Android実機RAW E2E

## 実機で必ず保存するログ

Frameごと:
- included / excludedReason
- matchedStars
- rmsResidualPx
- registrationRmsLimitPx
- residualP95Px
- residualMaxPx
- matchSpanX / matchSpanY / matchQuadrants
- localCorrectionApplied
- weight

Final:
- PSF medianFwhmRatio / p90FwhmRatio / medianRoundnessDelta
- flat-sky candidateTiles / selectedTiles / coefficients
- referenceSigma / finalSigma / noiseRatio

## 次段階

1. 実RAWでHard Gateにより何枚除外されるか確認
2. match spatial coverageを実測し、画面端だけ星がずれるケースが残るか確認
3. flat-sky noise ratioの実RAW分布を取得し、1.10閾値を再校正
4. PSF/Noise両方PASSした画像で、天の川微細構造・前景境界の実写A/B確認
5. 残存4 Node FAILは天の川画質修正とは別系統だが、release前には解消が必要

## 重要

WORK348では「位置合わせが悪いが5% weightで混ぜる」経路を、PSF幅から導いたHard Gateで止める。
また「全画面の高周波差分が下がったからノイズ改善」とは判定せず、星で空領域をanchorし、星を除外した同一座標の2x2 checkerboard MADでFinal/Referenceを比較する。
