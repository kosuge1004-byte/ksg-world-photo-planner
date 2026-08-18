# Workers KV PUT削減 第2段階

## 修正内容

### 1. DEMタイルのWorkers KV書き込みを廃止

対象: `server/gsiElevation.ts`

- 新規取得した国土地理院DEMタイルを `persistentCache.put()` で保存する処理を削除。
- 既存KVに保存済みのタイルを読む処理は互換性維持のため残した。
- 新規タイルはサーバープロセス内の `tileCache` のみで再利用する。

これにより、三脚候補検索・標高取得・日時変更に伴うDEMタイルのWorkers KV PUTは0回になる。

### 2. 検索ジョブの同一内容PUTを防止

対象: `server/spotSearchJobs.ts`

- 永続化対象を `status`、`results`、`error` に限定した署名で比較。
- 状態・結果・エラーが前回永続化時と同じならPUTしない。
- 完了APIの再送などで同一内容が送られた場合もPUTしない。
- 進捗メッセージと進捗率だけの変更は引き続きメモリ更新のみ。

## 修正後のWorkers KV PUT箇所

- `server/spotSearchJobs.ts` の検索ジョブ永続化1か所のみ。
- `server/gsiElevation.ts` のPUTは0か所。

## 想定PUT回数

通常検索:

1. queued
2. running
3. awaiting-3d
4. complete

最大4回。結果なしで端末最終確認を省略する設計へ変更しない限り、現仕様ではこの状態遷移を維持する。

以下の操作は0回:

- 時間軸変更
- 日時変更
- ±1分
- 三脚候補点の再描画・更新
- DEMタイル取得
- 検索進捗率・進捗文言更新
- 人物移動・高さ変更
- 2D/3Dマップ操作
- Cesiumカメラ操作

## 検証

- `npx tsc --noEmit`: 成功
- `npm run lint`: `node_modules`にoxlintがないため実行不能
- `npm run build`: lint連結実行が先に停止したため未実行。依存パッケージ復元環境での確認が必要。
