# Workers KV PUT削減 第3段階

## 変更内容

`server/spotSearchJobs.ts` の永続化方針を、外部プロセスとの受け渡しに必要な状態だけへ限定した。

Workers KVへ保存する状態:

- `queued`: Queue投入直前の初期状態
- `awaiting-3d`: サーバー検索結果を端末へ引き渡す状態
- `complete`: 完了状態
- `failed`: 失敗状態

Workers KVへ保存しない状態:

- `running`
- 進捗メッセージ変更
- 進捗率変更
- 検索中の候補更新

## 通常成功時のPUT回数

従来の最大4回:

1. queued
2. running
3. awaiting-3d
4. complete

第3段階後は最大3回:

1. queued
2. awaiting-3d
3. complete

## UI操作時

以下はPUT 0回:

- 時間軸変更
- 日時変更
- ±1分操作
- 三脚候補更新
- 2D/3Dマップ操作
- Cesiumカメラ操作
- 人物移動・高さ変更
- 天体・軌跡表示更新

## 補足

`running`をKVへ保存しないため、ポーリング中の表示はサーバー検索完了まで`queued`のままになる可能性がある。ただし検索処理そのもの、Queue再試行、最終結果受け渡しには影響しない。
