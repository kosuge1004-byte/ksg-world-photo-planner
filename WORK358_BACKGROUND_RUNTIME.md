# Work358: バックグラウンド処理（進捗通知・WorkManager・ストール監視）

## ソース確認の結果
- 高頻度の進捗（updateBestEffort）は元々非同期・まとめ書きで、処理を止めない。
- ただしフレーム境界などの `await reporter.update(...)` は、状態ファイル書込のあと
  `Workmanager().reportProgress` と通知更新（プラットフォーム呼び出し）を待つ。Android の重い処理は
  ProcessorService（:processor）で動き WorkManager のワーカーが存在しないため、この呼び出しが遅延し、
  実機ログの「background progress update failed or timed out (10 s)」として現れていた。待っている間は処理も止まる。
- Android では重い処理は WorkManager を使わない（RemoteProcessorBridge 経由で ProcessorService）。
  WorkManager の10分制限・dataSync の6時間制限は Android では関係しない（検査で懸念として挙げた点は該当なし）。
- ストール監視は状態ファイルの progressEpochMs を基準に30分。進捗率・工程・枚数が変わるたびに更新される。

## 変更
| ファイル | 内容 |
|---|---|
| lib/core/background/stack_job_reporter.dart | プラットフォーム呼び出し（WorkManager 進捗、実行中通知）に3秒の上限。WorkManager 進捗は WorkManager ホスト時のみ送る。状態ファイル（生存証明）は従来どおり先に書く |
| lib/core/background/background_task_dispatcher.dart | WorkManager ホストのエンジンでフラグを立てる |
| lib/core/focus_stack/focus_tiled_blender.dart / focus_stack_pipeline.dart | ピラミッド合成時のみタイルごとに進捗を報告（工程「深度合成（ピラミッド）」）。既定の深度マップ合成の工程表示は不変 |
| tool/work358_background_runtime_contract.test.mjs | 静的契約4件 |

出力画像には一切影響しない。

## 追加した長時間処理とストール監視（30分）
| 処理 | 進捗の更新 |
|---|---|
| 天の川 全視野位置合わせ | フレーム単位の既存更新内（計算は数秒） |
| 星の軌跡 ホットピクセル候補 | 1パス目のフレーム単位の既存更新内 |
| 星の軌跡 背景平均・合成 | 開始時に工程更新。全画面2〜3パスで数分の見込み |
| 深度合成 明るさ整合 | 推定は写真あたり1536ブロック読み出し。数分の見込み（進捗なし） |
| 深度合成 ピラミッド | タイルごとに進捗（今回追加） |

## 検査
実施: Node 全テスト 853/853 PASS（既存の状態ファイル・心拍契約も維持）。未実施: flutter analyze / flutter test、実機。
