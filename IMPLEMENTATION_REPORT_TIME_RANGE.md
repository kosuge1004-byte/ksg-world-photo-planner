# 時間帯指定 実装・検査報告

## 実装内容
- CelestialTransitSearchDialog の曜日UI直下に時間帯UIを追加
- Spot Search の曜日UI直下に同一時間帯UIを追加
- 共通コンポーネント `TimeRangeSelector` を使用
- 初期値: 開始 00:00 / 終了 23:59
- 開始 > 終了の場合は日付またぎとして判定
  - 例: 22:00〜02:00 → 22:00〜23:59 または 00:00〜02:00
- localStorage (`ksg-search-time-range-v1`) に共通保存し、ダイアログを閉じても保持
- Spot Search は曜日判定→時間帯判定の後に天体位置計算を実施
- Celestial Transit Search は曜日・時間帯外のサンプルで天体位置計算を実施しない
- 旧バックグラウンド検索データに時間帯項目がない場合は 00:00〜23:59 として扱う

## 変更ファイル
- src/components/SearchOptionControls.tsx
- src/components/CelestialTransitSearchDialog.tsx
- src/components/SpotSearchScreen.tsx
- src/search/searchTimeRange.ts（新規）
- src/search/celestialTransitSearch.ts
- src/search/spotPresetSearch.ts
- src/types/search.ts
- src/App.css

## 実行検査
- `npm run build` を実行
- npm依存パッケージが未導入の状態で、`vite/client` と `@types/node` が見つからず停止
- `npm install` を実行したが、内部npmレジストリから `@parcel/watcher-wasm@2.5.6` 取得時に HTTP 503 となり完了不能
- よって、この環境では完全なTypeScript型検査・Viteビルド完了までは確認できていない

## 未実施
- 本ZIPでは、今回明示された時間帯指定以外の大規模仕様変更は追加していない
