# PLATEAU標準表示 品質優先修正（第3分割）

## 変更
- 全国複合tilesetを `all-bldg-lod1-2025` から `all-bldg-maxlod2-latest` へ変更。
- 各地域でLOD2があればLOD2、なければLOD1を利用。
- 配信APIの既定動作に従い、テクスチャありを優先し、なければテクスチャなしを利用。
- 全建物を一律グレーで上書きしていた `Cesium3DTileStyle` を削除し、元データのマテリアル・テクスチャを保持。
- PLATEAU-Terrain、国土地理院地図、計算ロジック、高精度モードは変更なし。

## 注意
- 全国複合tilesetのLOD2優先はLOD1固定より通信量・GPU負荷が増える。
- PLATEAU未整備地域、LOD1しかない地域、テクスチャなし地域では外観の詳細度は上がらない。
