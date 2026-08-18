# Workers KV PUT削減 第5段階

## 変更

- `functions/api/spot-search-finalize.ts` で、最終3D確認後の `complete` 状態をWorkers KVへ再保存する処理を廃止。
- `awaiting-3d` のレコードを復旧用として保持し、finalize APIは検証後に完了レスポンスだけを返す。
- 同じfinalize要求が通信再送されてもPUT 0回で同じ完了応答を返す。
- ジョブ未存在、失敗済み、最終確認前の状態は404/409で拒否する。

## PUT回数

通常成功検索:

1. `queued`
2. `awaiting-3d`

合計 最大2 PUT。

以下は0 PUT:

- 最終3D確認（finalize）
- finalize再送
- 時間軸・日時・±1分
- 三脚候補点更新
- 検索進捗更新
- DEM取得
- 人物・天体・軌跡更新
- 2D/3DマップおよびCesiumカメラ操作

## 復旧性

`awaiting-3d` レコードはTTLまで残るため、finalize応答が失われても同じ要求を再送できる。端末は成功応答後にActive Jobを解除するため、通常利用で`complete`のKV永続化は不要。
