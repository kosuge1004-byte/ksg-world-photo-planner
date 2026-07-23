# Stage 6A-14-2: 未使用Karney比較モジュール整理

## 実施内容

- `src/geodesy/compareGeodesic.ts` を削除した。
- このモジュールはプロジェクト内のどこからも参照されておらず、本番コードの実行経路には含まれていなかった。
- 旧球面計算とKarney計算の比較は `scripts/verify-geodesic-comparison.mjs` が独立して担当しているため、検証能力は維持される。
- 誤って旧球面計算を本番コードへ再導入する経路を減らした。
- Python実行時に生成された `scripts/__pycache__` も配布ZIPから除外した。

## 動作への影響

なし。UI、検索、三脚候補地、3Dプレビュー、DEM、遮蔽判定のロジックは変更していない。

## 確認

- `compareSphericalAndKarneyLineMetrics` の残存参照: 0件
- `calculateLegacySphericalLineMetrics` の残存参照: 0件
- 本番 `src` 配下の固定平均地球半径 `6371008.8`: 0件
