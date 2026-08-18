# Workers KV PUT 診断ログ追加

## 目的

Cloudflare Workers KV の書き込み回数が想定より多い場合に、実際に成功した PUT の発生元を Workers Logs で特定する。

## 対象

Workers KV 書き込みは `server/spotSearchJobs.ts` の1か所へ集約されている。

PUT成功後に、1書き込みにつき1件の構造化JSONログを出力する。

```json
{
  "event": "workers_kv_put",
  "outcome": "success",
  "namespace": "SPOT_SEARCH_JOBS",
  "key": "spot-search-jobs/v1/...",
  "source": "api/spot-search-start",
  "requestId": "Cloudflare Ray ID または Queue message ID",
  "queueAttempt": 1,
  "clientId": "...",
  "jobId": "...",
  "previousStatus": "queued",
  "nextStatus": "awaiting-3d",
  "storageStatus": "running",
  "resultCount": 10,
  "hasError": false,
  "updatedAt": "..."
}
```

PUT失敗時は `event: workers_kv_put_failed` を出力し、例外を再送出する。

## source の意味

- `api/spot-search-start`: 新規検索の queued 保存
- `api/spot-search-start:queue-send-failed`: Queue送信失敗後の failed 保存
- `queue/spot-search-consumer`: Queue Consumerによる awaiting-3d 保存
- `queue/spot-search-consumer:terminal-failure`: 再試行上限後の failed 保存

## Cloudflareでの確認

Workers & Pages の Logs で次を検索する。

```text
"event":"workers_kv_put"
```

`source`、`nextStatus`、`jobId`ごとに件数を確認すれば、どの経路が日次PUTを消費しているか判定できる。

通常成功検索では同一 `jobId` に対して以下の2件になる。

1. `source=api/spot-search-start`, `nextStatus=queued`
2. `source=queue/spot-search-consumer`, `nextStatus=awaiting-3d`

同じ `jobId` でこれを超える場合は、Queue再試行、異常終了、または別デプロイの書き込みを疑う。
