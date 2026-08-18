# 修正01 完了報告

## 修正内容

- `viewCorrection` をゼロ初期値を持つ永続状態として確立。
- プレビューと日時検索へ同じ補正スナップショットを渡す経路を追加。
- 検索用カメラ投影を、プレビューが使う `createCameraProjection()` と `projectHorizontalToPreview()` へ統一。
- 横切り検索の対象方位へ方位補正を反映。
- 画角内検索のカメラ方位・仰角へ方位／仰角補正を反映。
- 9 / 35 / 100 / 400 / 800 / 1600mmと±5°・±10°・0°を確認する検証スクリプトを追加。

## 対象ファイル

- `src/types/camera.ts`
- `src/App.tsx`
- `src/components/CelestialTransitSearchDialog.tsx`
- `src/search/celestialTransitSearch.ts`
- `src/cesium/celestial.ts`
- `scripts/verify-view-correction.mjs`
- `package.json`

## 確認条件

- `viewCorrection=0`で従来式と一致: 満たした
- 方位補正±5°・±10°で検索とプレビューが同じ中心方位を使用: 満たした
- 仰角補正±5°・±10°で検索とプレビューが同じ中心仰角を使用: 満たした
- 9 / 35 / 100 / 400 / 800 / 1600mmで共通投影を使用: 満たした
- TypeScriptエラーなし: 満たした
- 本番ビルド成功: 満たした

## 未解決事項

- 現行UIには `viewCorrection` の編集操作が存在しないため、UI操作による非ゼロ値の目視確認は未確認。保存・復元・計算経路と数値検証は完了。
- 指示書に従い、修正02以降には未着手。
