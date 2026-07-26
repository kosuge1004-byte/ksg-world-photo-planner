# アプリアイコン差し替え

## 変更内容

- 指定画像を正方形のアプリアイコン用マスターへ整形
- PWA / Android / iPhoneホーム画面用に192pxと512pxを生成
- ブラウザのfaviconも同じ192px PNGへ統一
- 旧デザインの `app-icon.svg` を削除

## ファイル

- `public/app-icon-master.png`（1254 × 1254）
- `public/app-icon-192.png`（192 × 192）
- `public/app-icon-512.png`（512 × 512）

## 確認

- `manifest.webmanifest` の192px / 512px参照を確認
- `index.html` のfavicon / Apple Touch Icon参照を確認
- `npm run lint` 成功
- `npm run build` 成功

