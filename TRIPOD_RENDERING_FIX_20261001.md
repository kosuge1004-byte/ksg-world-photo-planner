# 三脚候補 2D/3D描画修正 (2026-10-01)

基準: `AstroSight-device-direct-terrain-20261001-tripod-candidate-fix.zip`

## 修正1: 3Dで三脚候補点が表示されない

- `src/cesium/tripodCandidateEntities.ts` を追加。
- 2Dと同じ `displayedTripodCandidates` をCesium Entityのpointとして3Dにも描画。
- 緯度・経度・楕円体高は候補計算結果をそのまま使用し、候補計算ロジックは変更しない。
- 天体の表示ON/OFFは2Dと同じ `celestialVisibility` を適用。
- 3Dタイル/地形に隠れて候補点を見失わないよう `disableDepthTestDistance = Number.POSITIVE_INFINITY` を指定。
- 3D以外へ切り替えたときは候補Entityを除去。

## 修正2: 2Dでズームすると点線が消える

旧実装は被写体位置から `画面対角線 x 4` の固定ピクセル長だけ線を延長していたため、ズームで被写体が大きく画面外へ出ると表示領域まで線が届かなかった。

- 固定長延長を廃止。
- 被写体から候補方向へ伸びる半直線と「現在の表示領域+40px余白」の交差区間だけを描画するslab clippingへ変更。
- 被写体が数万〜十数万px画面外でも、半直線が画面を横切る限り線を表示。
- 巨大なSVG座標を避け、Android WebViewでの描画精度悪化も抑える。

## 検証

PASS:
- 既存 `verify-map-line-candidate-20260830.mjs`
- 新規 `verify-tripod-rendering-fix-20261001.mjs`
  - 固定長延長が残っていない
  - viewport clippingが使用される
  - 被写体が x=-120000px のズームケースでも画面内線分を生成
  - 画面を横切らない半直線は描画しない
  - 3D候補Entityの生成/クリア経路
  - 3D候補座標が lon/lat/height をそのまま使用
  - 天体表示ON/OFFを3D候補にも適用
- TypeScript transpile構文検査
  - `src/App.tsx`
  - `src/components/Map2DOverlay.tsx`
  - `src/cesium/tripodCandidateEntities.ts`
- 前回修正の回帰検査
  - `verify-tripod-candidate-empty-complete-fix-20261001.mjs`
  - `verify-tripod-candidate-performance-resilience.mjs`

## ビルドについて

`npm ci` を試行したが、実行環境から `registry.npmjs.org` へのDNS解決が `EAI_AGAIN` で失敗し依存関係を完備できなかったため、完全な `npm run build` は未実施。
既存 `dist/` は基準ZIP由来であり、この修正を反映した再ビルド済みdistではない。実機用APK/配布物を作る際は依存関係が利用できる環境で `npm run build` / Android sync・buildを実行すること。
