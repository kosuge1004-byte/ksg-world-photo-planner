# Workers KV PUT削減

## Workers KV書き込み箇所

### `server/spotSearchJobs.ts`
検索ジョブの状態保存。従来は検索進捗コールバックが最大750ms間隔で呼ばれるたびにPUTされていた。

修正後は次だけを保存する。

- queued（検索受付）
- running（Consumer開始）
- awaiting-3d（サーバー検索終了）
- complete（端末3D確認終了）
- failed（失敗）

進捗率・進捗メッセージだけの更新はConsumer内メモリに限定し、KVへ書き込まない。

### `server/gsiElevation.ts`
DEMタイル永続キャッシュ。検索や標高参照で未保存タイルごとにPUTされるため、1検索で多数のPUTが発生し得た。

修正後はCloudflare実行時にpersistentCacheを注入しない。DEMはサーバーのメモリキャッシュおよびクライアント側キャッシュを使用し、Workers KVへ書き込まない。

## 想定PUT回数

- 時間軸変更: 0回
- 日時変更・±1分: 0回
- 三脚候補点の再描画・更新: 0回
- 人物・カメラ・地図操作: 0回
- DEMタイル取得: 0回
- 通常の成功検索: 3〜4回（queued / running / awaiting-3d / complete）
- 失敗検索: 2〜3回（queued / running / failed）

## 非Workers KVの`.put()`

- `public/sw.js`: Cache API
- `src/cesium/worldTerrain.ts`: IndexedDB

これらはCloudflare Workers KV PUT回数には含まれない。
