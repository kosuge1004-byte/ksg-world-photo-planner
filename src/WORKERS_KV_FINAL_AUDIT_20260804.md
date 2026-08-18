# Workers KV PUT 最終監査（2026-08-04）

## 結論

Workers KVへの書き込み実装は、`server/spotSearchJobs.ts` 内の1か所だけです。

- 通常成功検索: 最大2 PUT
  1. `queued`
  2. `awaiting-3d`
- 同一開始要求の再送: 0 PUT
- 最終3D確認: 0 PUT
- 失敗終了: 状況に応じて `failed` の1 PUTを追加

## PUT 0回を確認した操作

- 時間軸スライダー変更
- 日時変更
- ±1分ボタン
- 焦点距離変更
- 三脚候補点更新・再描画
- 検索進捗率・進捗文言更新
- DEMタイル取得
- 人物配置・移動・高さ変更
- 天体・軌跡表示更新
- 2D/3Dマップ操作
- Cesiumカメラ操作
- プレビュー再描画

## 残したPUT

### queued

Queueへの二重投入防止、開始直後の状態照会、同一ジョブIDの冪等判定に必要です。

### awaiting-3d

サーバー検索結果を端末側の最終3D確認へ引き渡し、通信切断後も再開できるようにする復旧チェックポイントです。

### failed

Queue送信失敗や検索処理失敗を端末側へ返すための最終状態です。

## 削除済みPUT

- `running`状態保存
- 進捗率・進捗メッセージ更新
- `complete`状態保存
- DEMタイルのWorkers KV永続化
- 同一開始要求再送時の重複保存
- 最終3D確認再送時の保存

## 再発防止

`scripts/verify-workers-kv-writes.mjs` を追加しました。

次のコマンドで、許可していないWorkers KV書き込みが追加されていないか検査できます。

```bash
npm run verify:workers-kv-writes
```

現在の検査結果:

```text
Workers KV write audit passed.
Allowed Workers KV put locations: 1
server/spotSearchJobs.ts:184
```

Service Worker Cache APIとIndexedDBの`put()`はWorkers KVではないため、監査対象から区別しています。
