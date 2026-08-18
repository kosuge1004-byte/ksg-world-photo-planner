# 修正14 完了報告

## 修正内容

- Cesium Viewerを要求時描画モードへ変更し、カメラ移動・データ更新がない静止中の連続描画を停止しました。
- 2D地図表示中は、非表示のCesium天体Entityを更新しないようにしました。3Dへ切り替えた時点で最新状態へ同期します。
- プレビュー領域と地図領域のResizeObserverが同じ寸法を繰り返し通知した場合、同一React stateを再設定しないようにしました。
- 天体オーバーレイとタイムラインをmemo化し、親画面の無関係なstate更新による再描画を抑えました。
- タイムラインの検索ダイアログ起動コールバックを安定化しました。
- バックグラウンド検索待機とOSM再試行待機で、完了時・中止時にAbortSignalのイベントリスナーを確実に解除するようにしました。
- 地形標高、ジオイド高、タイムゾーンformatterのメモリキャッシュにLRU上限を設定しました。
- 気象屈折補正のlocalStorageキャッシュを、期限切れ削除と最大24件の上限付きにしました。
- 既存の遮蔽物判定キャッシュ、事前検索キャッシュ、サーバー地形・GSIタイルキャッシュに上限があることも確認しました。
- 3D Tilesの`maximumScreenSpaceError`と詳細度設定、DEM取得精度、座標計算、検索アルゴリズムは変更していません。

## 対象ファイル

- `src/App.tsx`
- `src/components/CelestialOverlay.tsx`
- `src/components/TimelinePanel.tsx`
- `src/cesium/createMapViewer.ts`
- `src/cesium/worldTerrain.ts`
- `src/search/backgroundSpotSearch.ts`
- `src/search/refractionWeather.ts`
- `src/time/zonedTime.ts`
- `server/osmSiteContext.ts`
- `scripts/verify-performance-lifecycle.mjs`
- `package.json`

## 確認結果

- `npm run verify:performance-lifecycle`: 合格
- ステージ03/04/05/09の回帰検証: 合格
- `npm run lint`: 合格
- `npm run build`: 合格
- `npm run android:sync`: 合格
- `npm run verify:android`: 合格

## 未確認事項

- 実Android端末での長時間連続検索時のメモリ推移、発熱、電池消費は未確認です。
- 実ネットワークで多数地点を長時間検索した場合の実測時間は、API応答や回線状況に左右されるため未確認です。
- ただし、検索ループ・候補評価数・DEM/3D Tilesの精度設定は変更しておらず、追加処理は定数時間のキャッシュ管理が中心です。
