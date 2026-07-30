# 修正03 完了報告

## キャッシュ一覧と確認結果

- 検索準備キャッシュ: `preparedSearchCache.ts`。最大120件、90日。旧キーは条件不足のためv3へ移行せず破棄。
- 地形標高キャッシュ: `worldTerrain.ts`。メモリ＋IndexedDB、座標・要求DEM詳細度をキー化。
- ジオイドキャッシュ: `worldTerrain.ts` / `server/gsiGeoid.ts`。地点地域または最高精度の地点座標がキー。
- 地形地平線キャッシュ: `celestialOcclusion.ts`。観測地点・ECEF原点・方位がキー。
- Google 3Dレイキャッシュ: `celestialOcclusion.ts`。Viewer・ECEF原点・方位・高度・距離がキー。
- 観測者3D表面キャッシュ: `celestialOcclusion.ts`。Viewer・三脚座標・レンズ高がキー。
- 気象屈折キャッシュ: `refractionWeather.ts`。地点・予報／平年種別・有効期限がキー。
- Cesium天体Entityキャッシュ: `celestialMap.ts`。投影済み軌跡座標全体をキーへ反映。
- サーバーDEM／地平線／ジオイドキャッシュ: 座標・詳細度等の既存キーと上限を確認。

## 修正内容

- 検索準備キーをv3へ更新し、三脚／被写体、日時、タイムゾーン、焦点距離、アスペクト比、検索条件、精度・屈折設定、`viewCorrection`を含む完全スナップショット化。
- DEMキャッシュキーへ要求詳細度（auto／1m／5m／10m）を追加し、低解像度取得後に高解像度要求が古い値を再利用する問題を修正。
- 遮蔽キャッシュの一元無効化関数を追加。
- ピン、日時、焦点距離、レンズ高、アスペクト比、精度設定、気象屈折、`viewCorrection`、マップ準備状態の変更時に遮蔽表示をクリアして再計算。
- Cesium日周軌跡Entityのキーへ投影済み全座標を含め、焦点距離・アスペクト比・補正変更後の古い軌跡を防止。

## 対象ファイル

- `src/types/backgroundSearch.ts`
- `src/search/backgroundSpotSearch.ts`
- `src/search/preparedSearchCache.ts`
- `src/cesium/worldTerrain.ts`
- `src/cesium/celestialOcclusion.ts`
- `src/cesium/celestialMap.ts`
- `src/App.tsx`
- `scripts/verify-cache-keys.mjs`
- `package.json`

## 確認条件

- ピン移動後に古い遮蔽結果が残らない: 満たした
- 焦点距離変更後に古い画角・軌跡結果が残らない: 満たした
- 日時変更後に古い天体・遮蔽結果が残らない: 満たした
- 精度・屈折・`viewCorrection`変更後に再計算される: 満たした
- 無関係な設定で地形永続キャッシュを全削除しない: 満たした
- TypeScriptエラーなし・本番ビルド成功: 満たした

## 未解決事項

- 実端末での連続的なピン移動・低速3D通信中の目視確認は未確認。
- 指示書に従い修正04以降は未着手。
