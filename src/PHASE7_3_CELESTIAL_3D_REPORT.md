# Phase7-3 天体・3D統合検証

## 検証対象
- 天体通過日時検索の2モード
- 太陽・月・天の川
- 焦点距離・センサー寸法・画角
- 三脚・被写体間のKarney測地線と仰角
- Google Photorealistic 3D Tiles
- 2Dオーバーレイと3D天体表示の接続

## 結果
`npm run verify:phase7-3` は合格。

確認済み:
- `direction-crossing` と `in-frame` の両モードが存在
- 画角内判定はプレビュー共通の `createCameraProjection` と `isCelestialInCameraFrame` を使用
- 画角内検索は最接近時刻を細分化する処理を保持
- 太陽・月・天の川を検索対象として保持し、北極星を除外
- センサー寸法と焦点距離から水平・垂直画角を計算
- 三脚・被写体間はKarney測地線、上下方向は標高差を含む仰角計算を使用
- Google Photorealistic 3D Tilesはタイムアウトと1回再試行を実装

## 制約
依存パッケージがこの実行環境に完全配置されていないため、Cesium実レンダリング、天文計算ライブラリの数値実行、端末GPU上の表示は未実行。今回の合格はソース統合・接続構造の静的検証である。
