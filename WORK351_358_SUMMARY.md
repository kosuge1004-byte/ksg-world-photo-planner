# Work351〜358 まとめと実機確認手順

基準: Work350（0.8.45+201）。画質に関わる新機能はすべて既定OFF（OFF のとき Work350 と同じ計算）。
Work352・358 は常時有効の不具合修正（出力画像には影響しない）。

## 一覧
| 作業 | 対象 | 内容 | 既定 | 設定の場所 |
|---|---|---|---|---|
| 351 | 天の川 | 全視野の高精度位置合わせ（ホモグラフィ・格子状の星選択・隣接フレーム起点・分布ゲート・時系列中央の基準） | OFF | 合成設定 |
| 352 | 共通 | mediaProcessing 上限到達後の再開（:processor で一瞬 Activity を表示）、上限時の文言 | 常時 | — |
| 353 | 深度合成 | 写真間の明るさ・色の自動整合 | OFF | 深度合成の設定 |
| 354 | 深度合成 | ピラミッド（多重解像度）合成 | OFF | 深度合成の設定 |
| 355 | 星の軌跡 | ホットピクセル自動除去（時間方向の判定） | OFF | 合成設定 |
| 356 | 星の軌跡 | 流れ星を残す／空の背景をなめらかにする／地上部を全フレームの平均にする | OFF | 合成設定 |
| 357 | 流星 | 背景になじませる足し込み合成、放射点との整合表示 | OFF（表示は常時） | 候補選択画面 |
| 358 | 共通 | 進捗通知のプラットフォーム呼び出しに上限、ピラミッド合成の進捗 | 常時 | — |
| 364 | 星の軌跡 | 光跡候補のないフレームを解析中に先行合成し、2回目のデコードを削減（出力はビット一致、同値時は従来順へ自動切替） | 常時 | — |
| 363 | 共通 | 診断ログをテキストファイルで共有（設定・失敗画面）、前回分のログを保持 | 常時 | 設定 |
| 362 | 共通 | RAWのストリーム経路が使えない理由を診断ログに記録 | 常時 | — |
| 361 | 天の川 | 合成（κ-σ）のタイル並列化（出力はビット一致、コア数とメモリで自動調整） | 常時 | — |
| 360 | 共通 | 保存データ検証の SHA-256 をネイティブ化（結果・保存形式は同一、高速化） | 常時 | — |
| 359 | 共通 | 上限で止まったときの「タップしてアプリを開くと再開」通知（音あり・タップで起動） | 常時 | — |

## まず実行するもの（この作業環境では未実施）
1. `flutter analyze`（0 issues を確認。指摘があれば全文を共有）
2. `flutter test`（新規: guided_field_registration / focus_photometric_normalization / focus_pyramid_blend /
   star_trail_hot_pixels / star_trail_mean_background / meteor_additive_composite の各 _test.dart）
3. `bash tool/run_all_node_tests.sh`（この環境で 853/853 PASS）
4. APK ビルド

## 実機確認
### 既定OFFの不変確認
Work350 で処理したのと同じ RAW を各モードで処理し、出力のビット一致を確認（Work352・358 は出力に影響しない）。

### Work352（上限到達後の再開）
`adb shell device_config put activity_manager media_processing_fgs_timeout_duration 60000` で上限を1分にし、
処理開始 → 上限到達 → アプリを開いて「保存済み地点から再開」。logcat の `Requested :processor foreground reset`
と ProcessorService の起動成功を確認。終わったら `device_config delete activity_manager media_processing_fgs_timeout_duration`。

### Work351（天の川）
ON で同じ40枚を処理。ログの matchedStars（期待: 数百）、matchSpanX/Y（期待: 0.7以上）、localCorrectionApplied=true、
除外フレーム、最終PSFゲート、星検出段の時間増を記録。四隅を等倍で比較。

### Work353・354（深度合成）
マクロの段差が出やすい素材で、OFF／明るさ整合のみ／ピラミッドのみ／両方を比較。ログの `focus photometric gain`、
処理時間・メモリ、細い毛や重なった被写体の境界のハロ。

### Work355・356（星の軌跡）
20枚以上の長時間撮影で比較。ログの `starTrail hotPixel map ... hotPixels=`、`starTrail meanBackground`、
流れ星が写っている素材での飛行機除去の結果、地上部のノイズ。再開テスト（処理中にアプリを強制終了→再開）で
`starTrail rolling sum not in step` が出た場合は平均系が省略されたことを示す（結果は従来の最大値）。

### Work357（流星）
足し込み ON/OFF で流星周辺を等倍比較（帯・縁・二重星）。流星群の素材で「放射点と整合」表示の妥当性。
