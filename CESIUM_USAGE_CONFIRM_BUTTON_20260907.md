# Cesium ion Usage確認ボタン追加（2026-09-07）

## 変更
- ハンバーガーメニュー → 3D表示選択 → Google Photorealistic 3D Tiles の接続欄に
  `Cesium ion公式Usageを確認` ボタンを追加。
- ボタンは Cesium ion 公式Usage Dashboard `https://ion.cesium.com/usage` を新しいタブで開く。
- 接続済みの場合、同じ欄にAstroSight端末内カウントを表示。
  - 500回: 注意
  - 800回: 新規Google root tileset取得停止
- 公式UsageはCesium ion側の実カウントであり、同一アカウントを複数端末で利用した分はion側で合算される旨を併記。

## 根拠
Cesium公式 Access Tokens ドキュメントの Tracking usage は、ion Dashboard の Usage page でアカウント全体とトークン別の使用量を確認できると説明している。

## 注意
Cesium ionの公式Usage値を取得する公開APIは確認できないため、ボタンは公式Dashboardへの導線である。AstroSight内の数値は端末内ミラーカウンター。
