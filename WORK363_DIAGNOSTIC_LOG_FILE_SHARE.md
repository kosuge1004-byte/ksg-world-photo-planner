# Work363: 診断ログをテキストファイルとして共有

## 背景
診断ログは「設定 → 診断ログをコピー」でクリップボードにコピーする方式のみ。長時間処理のログは
数千行になり、チャットなどへの貼り付けが途中で切れる。また新しい処理（自動再開を含む）を始めると
ログが上書きされ、失敗した回のログが消えていた。

## 変更
| ファイル | 内容 |
|---|---|
| lib/core/diagnostics/diagnostic_log.dart | 新しい処理開始時に、直前のログを `mobile_stack_diagnostic_log_previous.txt` に退避（1回分）。`exportForSharing()` で直近と1つ前のログを `mobile_stack_log_YYYYMMDD_HHMMSS.txt` / `..._previous_run.txt` として一時フォルダに複製 |
| lib/features/settings/settings_screen.dart | 「診断ログをファイルで共有」を追加（共有シートからファイル保存・メール・Drive・チャット添付など）。従来の「診断ログをコピー」は短いログ向けとして残す |
| lib/features/common/processing_failure_panel.dart | 失敗画面に「診断ログをファイルで共有」（エラー内容の文字列も本文に添付） |
| tool/work363_diagnostic_log_share_contract.test.mjs | 静的契約3件 |

share_plus は既存の依存（合成結果の共有で使用中）。画像処理には影響しない。

## 検査
実施: Node 全テスト PASS。未実施: flutter analyze / test、実機での共有シート動作。
