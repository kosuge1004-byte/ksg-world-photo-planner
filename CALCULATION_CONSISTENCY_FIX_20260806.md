# 計算・補正整合修正（2026-08-06）

## 修正済み
- standard: 被写体仰角を幾何高度で統一（地表屈折なし）
- pro: 被写体仰角へ標準地表屈折 k=0.13 を適用
- 三脚候補探索、天体オーバーレイ、Cesiumプレビューカメラ、人物投影、日時検索、最高精度最終検証で同じ計算モードを使用
- 三脚候補の反復天体計算と最終判定へ RefractionWeatherContext を伝播
- 最高精度最終構図検証へ RefractionWeatherContext を伝播
- DEM取得失敗時に被写体高度を候補地点へ代用する処理を削除

## 変更ファイル
- src/cesium/geometry.ts
- src/cesium/camera.ts
- src/cesium/previewSnapshot.ts
- src/cesium/celestial.ts
- src/cesium/tripodCandidates.ts
- src/search/celestialTransitSearch.ts
- src/precision/highestPrecision.ts
- src/preview/foregroundProjection.ts
- src/components/ForegroundPreviewOverlay.tsx
- src/App.tsx

## 未検証
依存パッケージが同梱されておらず、geo-tz取得不能のため本環境では本番ビルド未実施。
