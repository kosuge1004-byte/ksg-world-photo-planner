# WORK344 天の川スタック画質問題 調査・修正 引き継ぎメモ

対象: `MobileStack_SOURCE_0.8.43_199_WORK344_checkpoint-integration.zip`
症状: スタック後の方が元画像よりノイズ・アーティファクトが増える。星が点にならず線状/楕円状に伸びる。前景が斑点状になる。

---

## 1. 症状の再現状況（実機ログより）

- 処理中に「処理システム応答待ち（UI正常）」が繰り返し発生し、`処理システムだけ再起動して続行`を複数回手動実行して完了させた
- 「基準写真を準備」ステージや「位置合わせ・スタック 2/2」ステージで15秒〜120秒以上の無応答が複数回発生
- 完成した画像は、単体プレビューと比べて明らかに粒状ノイズが多く、星が線状に流れている

この「処理中に何度も強制再起動が必要だった」という事実が、以下の根本原因調査の出発点になっている。

---

## 2. 実際にコードを検証して確認した根本原因（確度: 高）

### 2-1. チェックポイント再開が、フレーム構成の変化を検知できない【最重要】

- ファイル: `lib/core/background/standard_stack_background_worker.dart`
- `RollingWeightedAverageCheckpointStore`の`identity`は、元々は入力ファイル・モード・ダーク/フラットパスという**静的な設定**のみから生成されていた
- しかし各フレームのデコード/星検出成否（`decodeFailures`/`detectionFailures`）はリスタートのたびに空のMapから作り直され、**チェックポイントされていない**
- メモリ逼迫状況（`MemoryAdmissionController`）はリスタートごとに変動するため、同じフレームが「今回は失敗」「次回は成功」と揺れる余地が実際にある
- `buildMilkyWayRegistrationPlan`（`lib/core/session/milky_way_pipeline.dart`）は「基準フレーム（固定index）を先頭、残りは成功したものだけを元の昇順」で`plan.frames`を組み立てるため、途中のフレーム1枚の成否が変わるだけでリスト内の位置がずれる
- 再開処理は`restoredAccumulator.committedItems <= plan.frames.length`という**件数の範囲チェックのみ**で、フレーム構成が前回と同一かは検証していなかった
- 結果: クラッシュ→再起動をまたぐと、既に別のフレーム構成・幾何関係で積み上げた合成データに、ズレた対応関係の新しいフレームを混ぜ込む恐れがあった。星が線状に流れる症状と直接整合する

### 2-2. 露出・トーンカーブが基準フレーム1枚の統計だけで固定されていた

- `estimateFixedToneBaselineFromReferenceFrame`（`lib/core/export/export_result.dart`）は、正しく実装されている`estimateAutoToneParameters`（`lib/core/export/tone_map.dart`、JS参照実装21/21パス確認済み）に、**最終スタックではなく単一の基準フレームのピクセルデータ**を渡していた
- 単体プレビューと最終スタックで露出感を揃えるための意図的設計（コード内コメントに明記）だが、副作用として、スタックで本来下がっているはずの残存ノイズを、1枚基準の強めのシャドウ持ち上げでそのまま可視化してしまっていた

### 2-3. ホットピクセル検出・不良画素補正が配線されていなかった

- `enableHotPixelDetection`/`enableColdPixelDetection`はデフォルト`false`
- `RawDefectPixelCorrector`（JS参照実装5/5パス確認済み、実装自体は正しい）を駆動する`RawDefectMap`はこの2フラグからしか生成されないため、天の川モードでは常にスキップされていた

### 2-4. ドキュメント指摘・実コードで確認できた回帰：位置合わせ用星検出のダウンサンプリング

- `lib/core/session/milky_way_pipeline.dart` 591〜593行付近
- 16MP超のRAWで、星検出（位置合わせの基礎データ）を2×2画素平均で縦横1/2に縮小していた
- 過去のWork209では「Milky Way registration preview scale is fixed at 1」と明記されており、最高画質経路からの回帰と判断

---

## 3. 実装した修正（計8件、すべて`lib/core/background/standard_stack_background_worker.dart`および`lib/core/session/milky_way_pipeline.dart`）

| # | 内容 | 種別 |
|---|---|---|
| 1 | 位置合わせ用星検出のdownsample scaleを`2`固定から`1`固定に変更（`milky_way_pipeline.dart`） | 挙動変更 |
| 2 | `RollingWeightedAverageCheckpointStore`の`identity`に、実際に採用されたフレーム構成（`plan.frames`の`frameIndex`列）の指紋を追加。既存の「identity不一致で新規開始」機構が正しく働くようになる | 挙動変更（不整合修正） |
| 3 | `_decodeStarTrailFrameForRolling`内`runPhase2ValidatedJob`呼び出し2箇所に`enableHotPixelDetection: true`を追加（マスターダーク未設定時は無害） | 挙動変更（条件付き） |
| 4 | `buildMilkyWayRegistrationPlan`が生成する`MilkyWayFrameDiagnostics`（採用/除外・検出星数・マッチ数・回転角・オフセット・RMS残差・Weight）と、フレームごとのローカル残差補正の適用有無を`DiagnosticLog`へ出力 | 追加（読み取り専用） |
| 5 | 最終合成後、`finalized.contributions`からR/G/Bチャンネルごとの実効寄与枚数（min/mean/max）を`DiagnosticLog`へ出力 | 追加（読み取り専用） |
| 6 | 基準フレーム単体 vs 最終スタックの隣接ピクセル差分RMS（簡易ノイズ指標）を比較し、`verdict=reduced/INCREASED`としてログ出力 | 追加（読み取り専用） |
| 7 | 最終書き出しの露出・トーンカーブ（`exposureScale`/`whitePoint`）を、基準フレーム1枚ではなく最終スタック画像自体から再計算するよう変更 | 挙動変更 |
| 8 | 上記5のログにRGBチャンネル間の平均寄与枚数比が1.5倍を超える場合の警告フラグを追加（閾値は未検証の暫定値、処理は止めない） | 追加（読み取り専用） |

**注意**: 実装時に一度、`accumulatorStore`という`final`ローカル変数が古い（fix前の）identityのインスタンスを先に束縛してしまい、修正2が実際には反映されない構造的ミスがあった。`final`を外して再代入するよう修正済み（該当箇所: `accumulatorStore`宣言）。

**ビルド未検証**: この環境にDart SDKが無いため、括弧・波括弧の対応チェックとインポート可視性の確認のみ行い、実際のコンパイル・実行はできていない。**実機/CIでのビルド確認が必須**。

---

## 4. あえて実装を見送った項目とその理由

| ドキュメント優先度 | 内容 | 見送り理由 |
|---|---|---|
| 3 | 品質の悪いフレームを軽い重みではなく完全除外に変更 | 具体的な除外閾値の設定が必要で、根拠なく数値を決めると逆に品質を落とす可能性がある。**上記ログ4・5・6の実測データを見てから閾値を決めるべき** |
| 4 | 回転＋平行移動のみのモデルを、レンズ歪み等を扱える一般的な位置合わせモデルに拡張 | 新規アルゴリズムの実装に相当し、ビルド・実行して検証できないこの環境で書くと、既存の検証済みコードより悪いものを混入させるリスクの方が高い |
| 6 | Dual Alignmentを画素単位から領域（マスク）単位の判定に変更 | 同上。セグメンテーション/マスク平滑化の新規実装が必要で、検証手段が無い状態でのリスクが高い |
| 9・10 | 完成画像のFWHM/eccentricity/SNRを基準フレームと比較し、悪化していたら処理失敗にする | 誤判定で正常な結果までブロックする恐れがあるため、まずは6の warningログ（`verdict=INCREASED`）で実測を積んでから閾値化すべき |
| 11 | 実機RAWでの回帰テスト整備 | この環境では実施不可。実機ビルドが通ってから着手 |

---

## 5. 次にやるべきこと（優先順）

1. **この状態で実機ビルドを通す**（未検証のためコンパイルエラーの可能性あり）
2. 天の川スタックを実際に1回実行し、`DiagnosticLog`に出力される以下を確認する
   - フレームごとの`included/excludedReason/detectedStars/matchedStars/rmsResidualPx/weight`
   - `fitted=true/false`（Local Residual補正が実際に効いたか）
   - Contribution mapのR/G/B別min/mean/maxと不均衡警告の有無
   - `Milky Way noise proxy`の`verdict`（reduced/INCREASED）
   - `Milky Way tone baseline (final-stack, WORK344)`と基準フレーム版の露出値の差
3. 上記の実測値をもとに、
   - RMS残差やWeightの分布を見て、優先度3（完全除外の閾値）を具体的に決める
   - `verdict=INCREASED`が再現するかどうかで、修正1・2・7がどれだけ効いたかを切り分ける
4. 処理中の強制再起動自体を減らすため、`MemoryAdmissionController`のメモリ予算（`_baselineRssBytes`が再起動のたびにリセットされる設計）が、この端末・この画素数で現実的かどうかを別途見直す
5. 優先度4・6（位置合わせモデルの拡張、Dual Alignmentの領域化）は、上記が落ち着いてから、テスト環境（`tool/raw_samples`のJS参照実装＋Node testパターン）を先に用意した上で着手する

---

## 6. 検証済みで異常なしと確認できた範囲（参考）

星検出（`star_detector.dart`）、変換推定（`star_transform_estimator.dart`）、ローカル残差補正（`local_residual_correction.dart`）、Dual Alignment resampler、RAW較正（ストリーム版・非ストリーム版双方、`raw_mosaic_calibrator.dart`/`dark_frame_subtraction.dart`/`flat_field_calibration.dart`/`raw_defect_pixel_corrector.dart`）、デモザイク（`native/src/mobile_stack_demosaic.c`、ネイティブテストを実際にビルド・実行して確認）、加重平均合成の算術（`tiled_weighted_average_combiner.dart`）、チェックポイントのファイル形式（タイルサイズ変化への耐性含む）、資源管理（`MemoryAdmissionController`/`AdaptiveResourceController`のロジック自体）、トーンマッピングの数式（`tone_map.dart`）は、いずれもJS/ネイティブ参照実装との突き合わせ、または実際のビルド・実行により確認済みで、これらの部品単体に実装ミスは見つかっていない。
