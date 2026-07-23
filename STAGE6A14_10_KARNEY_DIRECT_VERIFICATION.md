# Stage 6A-14-10: Karney順測地線の独立検証追加

## 目的

`calculateKarneyDestinationPoint()`が使用するGeographicLibの順測地線計算について、逆測地線から得た既知の方位角・距離を入力し、元の終点座標へ戻ることを確認する。

## 追加内容

- `scripts/verify-geodesic-direct.mjs`
- npm script: `npm run verify:geodesic:direct`

## 検証ケース

1. 約213mの近距離
2. 名古屋から東京
3. 180度経線跨ぎ
4. 対蹠点付近

許容誤差は緯度・経度ともに `1e-11°`。

## 影響範囲

検証スクリプトのみ追加。本番コード、UI、検索条件、DEM、遮蔽判定は変更していない。

## 実行状況

JavaScript版は `geographiclib-geodesic` の取得が必要。現在の環境では依存本体が未取得のため実行未完了。基準終点は環境内のPython GeographicLibで再計算して一致を確認した。
