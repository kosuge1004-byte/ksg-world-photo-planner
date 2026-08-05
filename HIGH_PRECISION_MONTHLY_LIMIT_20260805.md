# 高精度モード月間利用制御

- Google課金月（America/Los_Angeles基準）ごとに高精度セッションを集計。
- 3時間以内の同一ブラウザセッションは再カウントしない。
- 800イベント到達時に一度だけ通知。
- 850イベント到達後は全端末で高精度モードを拒否し、標準モードは継続利用可能。
- `HIGH_PRECISION_ALERT_WEBHOOK_URL` を設定すると通知Webhookを送信。未設定時はWorkersログへ警告。
- `HIGH_PRECISION_LIMITS_ENABLED=false` で商用移行時に月間停止を無効化可能。
- 集計には既存の `SPOT_SEARCH_JOBS` KVを使用。

注意: Workers KVのリスト結果は結果整合性のため、非常に高い同時アクセス時には短時間の反映遅延があり得る。150イベントの安全余白を設けているが、厳密な原子カウンターが必要になった段階ではDurable ObjectsまたはD1へ移行する。
