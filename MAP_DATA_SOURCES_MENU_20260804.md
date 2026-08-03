# 地図データ出典元メニュー追加

## 変更内容
- ハンバーガーメニューに「地図出典」を追加。
- 展開すると、実装で使用している地図・標高データの出典元を用途別に表示。
- 各提供元の公式詳細ページへのリンクを追加。

## 表示する出典
- Google Maps
- Google Photorealistic 3D Tiles
- 国土地理院 標高タイル・ジオイド関連データ
- © OpenStreetMap contributors / Nominatim
- Cesium World Terrain

## 検査
- `npx tsc --noEmit --pretty false`: 成功
- `npm run build`: ZIPに `node_modules` が含まれず、`geo-tz` を取得できないため未完了
