# 修正05 完了報告

## 修正内容

- 天体遮蔽判定を `checking` / `dem-only` / `dem-and-google-3d` / `failed` の4状態に分離。
- 地平線下、DEM地形遮蔽、Google 3Dメッシュ遮蔽、未検証を個別の理由として維持。
- DEM判定完了時点で中間結果を反映し、Google 3D判定完了後に最終状態へ更新。
- Google 3Dを取得・検証できない場合はDEM結果を維持し、未検証を遮蔽確定にしない。
- 判定中・失敗中は太陽と月の実円盤を隠さず、確定した遮蔽だけを位置表示へ切り替える。
- 天の川も判定中は表示を維持し、確定した遮蔽区間だけを非表示化。
- プレビューとCesium地図で同じ遮蔽確定ルールを使用。

## 対象ファイル

- `src/types/celestial.ts`
- `src/cesium/celestialOcclusion.ts`
- `server/celestialTerrainVisibility.ts`
- `src/App.tsx`
- `src/components/CelestialOverlay.tsx`
- `src/components/Map2DOverlay.tsx`
- `src/cesium/celestialMap.ts`
- `scripts/verify-occlusion-state.mjs`
- `package.json`

## 確認条件

- 通信が遅い環境で判定中に天体円盤を隠さない: 満たした
- DEMのみとDEM+Google 3Dの状態を区別: 満たした
- 未検証を遮蔽確定として扱わない: 満たした
- 地平線下・地形・3Dメッシュ遮蔽を区別: 満たした
- Google 3D取得失敗時にDEM結果を維持して処理を継続: 満たした
- TypeScriptエラーなし・本番ビルド成功: 満たした

## 未解決事項

- 実端末で通信速度を人工的に制限した長時間の表示観察は未確認。
- 指示書に従い修正09以降は未着手。
