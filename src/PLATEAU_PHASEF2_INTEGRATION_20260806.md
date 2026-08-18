# PhaseF2へのPLATEAU表示専用統合

## 実装内容

- 最新基準 `AstroSight-full-project-phaseF2-final-lean.zip` に統合。
- 標準モードの国土地理院地図上へ、PLATEAU全国建築物LOD1（2025年度）の3D Tilesを表示。
- 使用URL:
  `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-lod1-2025/tileset.json`
- PLATEAUは表示専用。標高、遮蔽、見通し、三脚候補、天体検索、被写体高さ等の計算には接続していない。
- 高精度モードのGoogle Photorealistic 3D Tiles処理は変更していない。
- PLATEAU取得失敗時は国土地理院地図のみで継続する。

## 変更ファイル

- `src/cesium/createMapViewer.ts`
- `PLATEAU_PHASEF2_INTEGRATION_20260806.md`

## 検証状況

- ZIP構造検査: 実施
- ソース差分検査: 実施
- PLATEAU公式URL確認: 実施
- npm依存取得: `youch-core@0.3.3` が内部レジストリで404となり未完了
- TypeScript/Vite本番ビルド: 依存取得不能のため未実施
- 実機でのPLATEAU描画確認: 未実施
