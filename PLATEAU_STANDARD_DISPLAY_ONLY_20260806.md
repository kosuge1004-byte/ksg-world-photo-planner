# 標準モード PLATEAU表示専用実装

## 実装内容
- 標準モードの国土地理院地図上に、PLATEAU全国建築物LOD1最新データをCesium 3D Tilesとして重ねて表示。
- 配信URL: `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-lod1-latest/tileset.json`
- PLATEAUの読込失敗時は、国土地理院地図のみで継続するフォールバックを実装。
- 標準モードの表示文言を「国土地理院地図＋PLATEAU建物（表示専用）」へ変更。

## 計算からの分離
PLATEAU tilesetは `viewer.scene.primitives` に表示レイヤーとして追加しただけであり、以下には接続していない。
- 標高取得
- 被写体高度
- 遮蔽・見通し判定
- 三脚候補検索
- 天体通過日時検索
- 画角・構図計算

上記の高精度計算系は変更していない。

## 変更ファイル
- `src/cesium/createMapViewer.ts`

## 検証上の制限
この作業環境のZIPには `node_modules` が含まれず、外部依存取得もできないため、実ビルドは未実行。TypeScript構造と既存Cesium APIに基づく静的確認を実施。
