# Work351: 天の川 全視野位置合わせ（ガイド付きホモグラフィ）

基準: Work350（0.8.45+201）。本変更は **既定OFF**。OFF では Work350 とビット一致（下記「不変条件」参照）。

## 1. 背景（原因の特定）

Work350 実機ログ（40枚, Sony ARW, 約13分）:
- 基準から時間が離れるほど対応星数が 20 → 6〜12 に減り、1象限・matchSpanY 0.3〜9% に集中。
- 対応点が最も広く分布していたフレーム0/1（20〜21点・4象限）が p95 1.59/1.62px > 1.5px で除外。
- localCorrectionApplied=false が全フレーム（局所補正は 6係数×4 = 24点必要）。

ソース確認の結果、対応付け（回転不変 RANSAC）ではなく **大域モデルが剛体（回転＋平行移動）であること** が原因。
三脚固定・直線投影レンズでは日周運動は像面で射影変換（K R K^-1）＋歪曲になり、剛体で 3px 以内に収まるのは視野の帯状領域だけ。

`tool/raw_samples/synthetic_fixed_tripod_sky_reference.mjs`（天球を極軸回りに回転しレンズ投影する物理モデル）で再現:
剛体の全視野誤差 p95 は基準から 10 フレームで約 30px、30 フレームで約 100px。

## 2. 変更内容

| ファイル | 内容 |
|---|---|
| lib/core/registration/affine_sampling_transform.dart | 射影項 p20/p21（既定0）。0 のとき sourceX/sourceY/inverse は従来と同一式。checkpointCoefficients は非射影で従来の6要素 |
| lib/core/registration/local_residual_correction.dart | 残差計算を transform.sourceX/Y 経由に（アフィンでは同一式） |
| lib/core/registration/guided_field_registration.dart | 新規。ガイド付き全視野登録（アフィン→ホモグラフィ→ホモグラフィ＋2次残差で対応を視野全体へ成長、広い半径は比率テスト併用、最終対応は厳密半径3px）、格子分散星選択、妥当性検査（中心スケール0.8〜1.25、射影項上限、四隅 w∈(0.5,2)）、登録順序、時系列中央優先 |
| lib/core/registration/registration_hard_quality.dart | evaluateRegistrationCoverageGate（基準星分布に対する相対ゲート: 対応12点以上、スパン比0.7以上、基準星8%以上の象限すべてに対応）。ガイドモードのみ使用 |
| lib/core/session/milky_way_pipeline.dart | MilkyWayRegistrationModel{legacyRigid(既定), guidedWholeField}。ガイド時: プレビュー候補1200→格子選択400→原寸精緻化、基準から外側へ隣接フレームの結果を種に登録（失敗時は剛体推定を種に再試行）、被覆ゲート追加、自動基準は品質差3%以内で時系列中央寄り、最終PSFゲートの星検出も同モデル。compact(rolling)経路・classic経路・星検出Isolate両方に適用 |
| lib/core/session/export_pipeline_result.dart | registrationModel 引数の受け渡し |
| lib/core/background/standard_stack_background_worker.dart | payload 'milkyWayRegistrationModel'（無ければ legacyRigid。再開ジョブは開始時のモデルを維持）を4箇所へ |
| lib/core/background/background_stack_controller.dart | payload に 'milkyWayRegistrationModel' |
| lib/core/settings/app_settings.dart / lib/core/session/processing_session.dart / lib/features/common/raw_selection_screen.dart / lib/features/common/stack_settings_screen.dart | 設定「全視野の高精度位置合わせ（試験機能）」（天の川のみ表示、既定OFF） |
| tool/raw_samples/guided_field_registration_reference.mjs ほか | Node 参照実装・合成天球フィクスチャ・参照テスト15件 |
| tool/work351_whole_field_registration_contract.test.mjs | 静的契約8件 |
| test/guided_field_registration_test.dart | Dart テスト（射影拡張・逆変換往復・合成天球で全40フレーム p95≤1.2px・選択・ゲート・妥当性・モデル名） |

## 3. 不変条件（Work350 の条件を維持）

- 既定 legacyRigid: 剛体推定の呼び出し引数、detectStars の maxStars(200)、ゲート判定と理由文、チェックポイント束縛値はすべて従来と同一。
- kappa=2.5 / maximumIterations=3 / FP32 / 元解像度 / BaselineExposure 0 EV は無変更。
- ProcessorService の foregroundServiceType は mediaProcessing のまま（契約テストで確認）。
- 品質ゲートの閾値は緩めていない（ガイド時は被覆ゲートを追加で課すのみ）。

## 4. 検査の実施状況（実施と未実施の区別）

実施（Work351 作業環境）:
- Node 全テスト: 805/805 PASS（Work350 の 782 + 参照15 + 契約8）。
- 合成天球での Node 参照検証: 7条件（標準/地上部40%無星/広角/望遠・高仰角/南半球/重心ノイズ0.35px・脱落30%/40秒間隔26分）で全フレーム登録成功、全視野誤差 p95 0.5〜1.3px。

未実施（この環境に Flutter/Dart SDK が無いため）:
- flutter analyze / flutter test（test/guided_field_registration_test.dart を含む）。型検査未実施。指摘が出た場合は内容を報告のこと。
- 実機・実 RAW での処理時間と画質比較。

## 5. 実機での確認手順（提案）

1. 既定OFFで Work350 と同じ40枚を処理し、出力のビット一致を確認。
2. 設定ONで同じ40枚を処理し、ログの `matchedStars`（期待: 数百）、`matchSpanX/Y`（期待: 0.7以上）、`localCorrectionApplied=true`、除外フレーム数、最終PSFゲート、処理時間（星検出段の増分）を記録。
3. 出力の四隅を等倍で比較（星の伸び・二重化）。

## 6. 既知の限界

- 超広角＋強い樽型歪曲（合成で焦点1200px, k1=-0.05）では時間とともに残差が増える（p95 最大約4px）。この場合は既存の p95 ゲートで除外される。放射歪曲モデルの追加は別作業。
- 星検出の原寸精緻化は星数に比例（約150→400点）。星検出段の時間が増える。
