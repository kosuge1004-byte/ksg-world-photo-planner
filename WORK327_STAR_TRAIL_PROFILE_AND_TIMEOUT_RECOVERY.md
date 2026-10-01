# Work327 — 星の軌跡: 性能計測分解 + Android timeout時のCheckpoint件数修正

## 目的
Work326実機ログ（337枚 / ProcessingMode.starTrail / maximum）では、RAW decode自体は概ね5〜6秒なのに、1フレーム全体が約2分前後を要していた。推測で最適化せず、画質・検出ロジックを一切変更せずに時間を工程別へ分解する。またAndroid foreground-service timeout時に「正常確定済み0枚」と誤表示される状態を修正する。

## 変更1: 星の軌跡 1/2 の工程別計測
以下を `DiagnosticLog` に `starTrail profile` として記録する。

- decode
- green-plane
- streak-continuous
- streak-fragments
- streak-reconnect
- streak-total
- star-detection
- streak-brightness
- feature-total
- checkpoint-save
- journal-save
- resource-wait
- frame-total

ログ例:
`starTrail profile frame=12 stage=star-detection elapsedMs=12345`

検出閾値、解像度、補間、比較明合成式、RAWデコード、DNG出力には変更を加えていない。計測のみ。

## 変更2: recoverableCheckpointItems をdurable checkpoint直後にstatusへ反映
Work326では `StackJobReporter.update()` が `recoverableCheckpointItems` を受け取れず、Android `ProcessorService.onTimeout()` が既存status.jsonを保持しても値が0のままになり得た。

Work327では:
- `StackJobReporter.update(... recoverableCheckpointItems: ...)` を追加
- 軌跡解析1/2のcompact feature checkpoint確定直後に件数を反映
- 比較明合成2/2のrolling checkpoint確定後にも件数を反映
- 復旧開始時もrestoredCompactCountをstatusへ反映

Android側のtimeout処理は既存status.jsonを読み込んで必要項目だけ上書きするため、直前までpersistされたcheckpoint件数が保持される。

## 実行した検証
- `node tool/rolling_star_trail_recovery_contract.test.mjs` : 8/8 PASS
- `node tool/preflight_storage_capacity_contract.test.mjs` : 6/6 PASS
- `node tool/storage_capacity_recovery_contract.test.mjs` : 5/5 PASS
- 新規 `node tool/star_trail_profile_timeout_recovery_contract.test.mjs` : 2/2 PASS
- `bash tool/run_all_node_tests.sh` : 713/713 PASS

## 未実施
この環境にはFlutter/Dart SDKがないため、`dart analyze` / `flutter test` / Android APK build / 実機計測は未実施。Node契約テストは全件PASSしているが、最終的なAndroidビルド確認はCodex/ローカルAndroid開発環境で必要。

## 次の実機ログで見る箇所
同じRAW数枚だけでもよいので `starTrail profile` 行を採取する。各frameで最大の `elapsedMs` を持つstageを特定してから、画質を変えない最適化を実施する。
